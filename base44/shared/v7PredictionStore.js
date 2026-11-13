// =====================================================
// V7 予想レコードの共通保存処理
// サーバー自動生成(SERVER)と端末同期(BROWSER)は、どちらもこの1本を通る。
//
//  1. 締切・開催状態・確定結果は「保存する瞬間」のDB値(Race / RaceResult)で確認する
//  2. 同一レース×段階の登録権(V7StageClaim)は常に1行だけを正とし、
//     free → writing → written の状態遷移を条件付き書込(CAS)で行う。
//     状態遷移が成立した1つの呼び出しだけが予想を書き込める
//  3. 予想を書き込む直前に、自分の登録権であることを
//     条件付き書込の成立(所有権の確認)で確かめてから書き込む
//  4. 応答が消えても増えない: 再送は登録権の状態とDBの予想で判定し、
//     保存済みなら確定させるだけで、予想を作り直さない
//  5. 予想を書き込んだ後は登録権を解放しない(結果不明は再読取して冪等に確定)
//  6. 既存レコードは決して更新しない(更新APIを一切呼ばない)
// =====================================================
import { timeMs } from "./liveV7Time.js";

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const RACE_KEY_RE = /^\d{4}-\d{2}-\d{2}_\d{1,2}_\d{1,2}$/;
const PLAN_KEY_RE = /^(hit|value)_(4|6|8|12)$/;
const CLAIM_ENTITY = "V7StageClaim";
// writing のまま応答が消えた場合に、別の要求が書き込みを引き継げるようになるまでの時間
const CLAIM_LEASE_MS = 2 * 60 * 1000;
// 確定済みの登録権(claimed は旧形式の確定状態)
const FINAL_CLAIM_STATES = new Set(["written", "claimed"]);
const MAX_DOCS = 200;

const pairOf = (key, stage) => `${key}::${stage}`;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

function sanitizePlans(raw) {
  const plans = {};
  for (const [key, plan] of Object.entries(raw || {})) {
    if (!PLAN_KEY_RE.test(key)) continue;
    const tickets = Array.isArray(plan && plan.tickets)
      ? [...new Set(plan.tickets.filter((ticket) => typeof ticket === "string" && COMBO_RE.test(ticket)))]
      : [];
    if (!tickets.length) continue;
    plans[key] = {
      tickets,
      probability: num(plan.probability),
      judgment: plan.judgment ? String(plan.judgment).slice(0, 60) : null,
    };
  }
  return plans;
}

// 外部(端末)から届いた値も、この形に正規化してから保存する
function sanitize(input) {
  if (!input || typeof input !== "object") return null;
  const raceKeyRaw = typeof input.race_key === "string" ? input.race_key.trim() : "";
  if (!RACE_KEY_RE.test(raceKeyRaw)) return null;
  const stage = input.stage === "PRE" || input.stage === "FINAL" ? input.stage : null;
  if (!stage) return null;
  const recordHash = typeof input.record_hash === "string" ? input.record_hash.trim().slice(0, 200) : "";
  if (!recordHash) return null;
  const plans = sanitizePlans(input.plans);
  if (!Object.keys(plans).length) return null;

  const order = Array.isArray(input.rank_order)
    ? input.rank_order.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
    : [];

  return {
    record_hash: recordHash,
    input_hash: typeof input.input_hash === "string" ? input.input_hash.slice(0, 200) : null,
    race_id: input.race_id ? String(input.race_id) : null,
    race_key: raceKeyRaw,
    stage,
    model: input.model === "WOMENS" || input.model === "OPEN" ? input.model : null,
    is_womens: input.model === "WOMENS",
    series_name: input.series_name ? String(input.series_name).slice(0, 200) : null,
    generated_at: typeof input.generated_at === "string" ? input.generated_at : null,
    top_combination: typeof input.top_combination === "string" && COMBO_RE.test(input.top_combination)
      ? input.top_combination
      : null,
    top_probability: num(input.top_probability),
    rank_order: order.length === 3 ? order : null,
    plans,
    coverage: num(input.coverage),
    judgment_reason: input.judgment_reason ? String(input.judgment_reason).slice(0, 500) : null,
    source: input.source === "SERVER" ? "SERVER" : "BROWSER",
  };
}

// 書込直前の再確認: 保存する瞬間のDB値で締切・開催状態・確定結果を判定する
async function readRaceGate(sr, raceKey) {
  const races = await sr.Race.filter({ race_key: raceKey }, "-created_date", 10).catch(() => []);
  let race = null;
  for (const row of races || []) {
    if (!race || (!race.deadline && row && row.deadline)) race = row;
  }
  if (!race || !race.id) return { reason: "race_missing" };
  if (["finished", "cancelled"].includes(race.status)) return { reason: "race_closed" };
  const deadline = timeMs(race.deadline);
  if (deadline == null || deadline <= Date.now()) return { reason: "deadline_passed" };

  const results = await sr.RaceResult.filter({ race_id: race.id }, "-created_date", 10).catch(() => []);
  const confirmed = (results || []).some((result) => {
    const combination = String((result && result.result_trifecta) || "");
    if (!COMBO_RE.test(combination)) return false;
    return result.is_finished === true || result.result_status === "RESULT_FINAL";
  });
  if (confirmed) return { reason: "result_confirmed" };

  return { race, reason: null };
}

// 登録権の行を「レース×段階ごとに1行」へ揃える
// DBに一意制約が無いため、同じ claim_key の行が複数できた場合は
//  - claimed の行があればそれを正とし、
//  - 残りの free 行は誰も保持していないので削除する。
// 以後の条件付き書込は、この1行(id指定)だけを対象にする。
async function ensureClaimRow(sr, pair, raceKey, stage) {
  const load = () => sr[CLAIM_ENTITY].filter({ claim_key: pair }, "created_date", 50).catch(() => null);
  let rows = await load();
  if (rows === null) return null;
  if (!rows.length) {
    await sr[CLAIM_ENTITY]
      .create({ claim_key: pair, race_key: raceKey, stage, state: "free", owner: null, record_hash: null, claimed_at: null })
      .catch(() => null);
    rows = await load();
    if (!rows || !rows.length) return null;
  }

  const sorted = [...rows].sort((a, b) =>
    String(a.created_date || "").localeCompare(String(b.created_date || "")) || String(a.id).localeCompare(String(b.id)));
  const canonical = sorted.find((row) => FINAL_CLAIM_STATES.has(row.state)) || sorted[0];
  for (const row of sorted) {
    if (row.id === canonical.id || FINAL_CLAIM_STATES.has(row.state) || row.state === "writing") continue;
    await sr[CLAIM_ENTITY].delete(row.id).catch(() => null);
  }
  return canonical;
}

const leaseExpired = (row) => {
  const at = Date.parse(String((row && row.claimed_at) || ""));
  return !Number.isFinite(at) || Date.now() - at > CLAIM_LEASE_MS;
};

// 同一レース×段階の予想を読む。読めなかった場合は unknown を返す
// (読めない状態を「無い」と扱うと、二重保存の原因になるため必ず区別する)
async function findPrediction(sr, doc) {
  const rows = await sr.PredictionV7
    .filter({ race_key: doc.race_key, stage: doc.stage }, "-created_date", 10)
    .catch(() => null);
  if (rows === null) return { status: "unknown", count: 0 };
  const found = (rows || []).filter((item) => item && item.id);
  const row = found[0] || null;
  return row
    ? { status: "found", row, count: found.length }
    : { status: "absent", count: 0 };
}

// 登録権の獲得と再送判定(状態遷移の条件付き書込で原子的に行う)
//   acquired      : 自分が書き込む番(1つの呼び出しだけが得る)
//   already_saved : 同じ要求が既に確定済み(増やさない)
//   in_flight     : 同じ要求が書き込み中(増やさない)
//   taken         : 別の要求が登録権を持つ(増やさない)
async function acquireClaim(sr, doc) {
  const pair = pairOf(doc.race_key, doc.stage);
  const row = await ensureClaimRow(sr, pair, doc.race_key, doc.stage);
  if (!row) return { status: "taken" };

  const sameRequest = row.record_hash === doc.record_hash;
  if (FINAL_CLAIM_STATES.has(row.state)) {
    return { status: sameRequest ? "already_saved" : "taken", row };
  }
  if (row.state === "writing" && !leaseExpired(row)) {
    return { status: sameRequest ? "in_flight" : "taken", row };
  }

  const owner = `${doc.record_hash}:${Math.random().toString(36).slice(2, 10)}`;
  const condition = row.state === "writing"
    ? { id: row.id, state: "writing", claimed_at: { $lt: new Date(Date.now() - CLAIM_LEASE_MS).toISOString() } }
    : { id: row.id, state: "free" };
  const result = await sr[CLAIM_ENTITY]
    .updateMany(condition, {
      $set: { state: "writing", owner, record_hash: doc.record_hash, claimed_at: new Date().toISOString(), prediction_id: null },
    })
    .catch(() => null);

  if (!result || Number(result.updated) !== 1) return { status: "taken", row };
  return { status: "acquired", row, owner };
}

// 書込直前の所有権確認: 条件付き書込が成立したときだけ「自分の登録権」と確定する
async function renewClaim(sr, claim) {
  const result = await sr[CLAIM_ENTITY]
    .updateMany(
      { id: claim.row.id, state: "writing", owner: claim.owner },
      { $set: { claimed_at: new Date().toISOString() } },
    )
    .catch(() => null);
  return !!result && Number(result.updated) === 1;
}

// 予想の保存まで確定したことを登録権に刻む(以後このレース×段階は増えない)
async function finalizeClaim(sr, claim, predictionId, recordHash) {
  await sr[CLAIM_ENTITY]
    .updateMany(
      { id: claim.row.id, record_hash: recordHash },
      { $set: { state: "written", prediction_id: predictionId || null, claimed_at: new Date().toISOString() } },
    )
    .catch(() => null);
}

// 予想を書き込む前の中断だけ解放する(書き込んだ後は解放しない)
async function releaseClaim(sr, claim) {
  await sr[CLAIM_ENTITY]
    .updateMany(
      { id: claim.row.id, state: "writing", owner: claim.owner },
      { $set: { state: "free", owner: null, record_hash: null, claimed_at: null } },
    )
    .catch(() => null);
}

export async function saveV7Predictions(client, docs) {
  const sr = client.asServiceRole.entities;
  const reasons = {};
  const bump = (key) => { reasons[key] = (reasons[key] || 0) + 1; };
  const transient = new Set();

  const input = (Array.isArray(docs) ? docs : []).slice(0, MAX_DOCS);
  const clean = [];
  for (const doc of input) {
    const sanitized = sanitize(doc);
    if (!sanitized) { bump("invalid"); continue; }
    clean.push(sanitized);
  }
  const handledHashes = () => clean
    .map((doc) => doc.record_hash)
    .filter((hash) => !transient.has(hash));

  if (!clean.length) {
    return { saved: 0, saved_pre: 0, saved_final: 0, reasons, handled_hashes: [] };
  }

  const keys = [...new Set(clean.map((doc) => doc.race_key))];
  const races = await sr.Race.filter({ race_key: { $in: keys } }, "-created_date", 1000).catch(() => []);

  const raceByKey = new Map();
  for (const race of races || []) {
    const previous = raceByKey.get(race.race_key);
    if (!previous || (!previous.deadline && race.deadline)) raceByKey.set(race.race_key, race);
  }

  const raceIds = [...new Set([...raceByKey.values()].map((race) => race.id).filter(Boolean))];
  const results = raceIds.length
    ? await sr.RaceResult.filter({ race_id: { $in: raceIds } }, "-created_date", 1000).catch(() => [])
    : [];

  // 確定結果が出たレースには追記しない
  const confirmedRaceIds = new Set();
  for (const result of results || []) {
    const combination = String((result && result.result_trifecta) || "");
    if (!COMBO_RE.test(combination)) continue;
    if (result.is_finished === true || result.result_status === "RESULT_FINAL") confirmedRaceIds.add(result.race_id);
  }

  const nowMs = Date.now();
  const queue = [];
  for (const doc of clean) {
    const race = raceByKey.get(doc.race_key);
    if (!race) { bump("race_missing"); continue; }
    if (["finished", "cancelled"].includes(race.status)) { bump("race_closed"); continue; }
    const deadline = timeMs(race.deadline);
    if (deadline == null || deadline <= nowMs) { bump("deadline_passed"); continue; }
    if (confirmedRaceIds.has(race.id)) { bump("result_confirmed"); continue; }
    queue.push({
      ...doc,
      race_id: race.id || doc.race_id,
      race_date: race.race_date || doc.race_key.slice(0, 10),
      venue_code: race.venue_code != null ? String(race.venue_code) : null,
      race_number: Number.isFinite(Number(race.race_number)) ? Number(race.race_number) : null,
      deadline: race.deadline || null,
    });
  }

  const saved = [];
  const donePairs = new Set();
  for (const doc of queue) {
    const pair = pairOf(doc.race_key, doc.stage);
    if (donePairs.has(pair)) { bump("duplicate_rejected"); continue; }

    // 登録権の獲得と再送判定(条件付き書込なので、書き込む番は常に1つだけ)
    const claim = await acquireClaim(sr, doc);
    if (claim.status === "taken") { bump("duplicate_rejected"); continue; }
    if (claim.status === "already_saved") { bump("idempotent"); donePairs.add(pair); continue; }

    if (claim.status === "in_flight") {
      // 同じ要求が書き込み中: 予想が入っていれば確定させ、無ければ増やさず次回に回す
      const current = await findPrediction(sr, doc);
      if (current.status === "found") {
        await finalizeClaim(sr, claim, current.row.id, doc.record_hash);
        bump("idempotent");
        donePairs.add(pair);
        continue;
      }
      bump("write_pending");
      transient.add(doc.record_hash);
      continue;
    }

    // ここから先は、このレース×段階の登録権を持つ1つの呼び出しだけ
    const existing = await findPrediction(sr, doc);
    if (existing.status === "found") {
      // 別の経路で保存済み → 増やさず確定させる
      await finalizeClaim(sr, claim, existing.row.id, doc.record_hash);
      bump("idempotent");
      donePairs.add(pair);
      continue;
    }

    // 既存の有無を確認できない間は書き込まない(確認できないまま書くと二重登録になる)
    if (existing.status === "unknown") {
      bump("read_unavailable");
      await releaseClaim(sr, claim);
      continue;
    }

    const gate = await readRaceGate(sr, doc.race_key).catch(() => ({ reason: "gate_unavailable" }));
    if (gate.reason) { bump(gate.reason); await releaseClaim(sr, claim); continue; }

    // 所有権の確認と書込: 条件付き書込が成立(=自分の登録権)した場合だけ書き込む
    if (!(await renewClaim(sr, claim))) { bump("claim_lost"); continue; }

    const payload = { ...doc, race_id: gate.race.id, deadline: gate.race.deadline || null };
    let created = null;
    try {
      created = await sr.PredictionV7.create(payload);
    } catch {
      // 応答が消えた可能性がある。登録権は解放せず、DBを再読取して確定を試みる
    }

    const after = await findPrediction(sr, doc);
    if (after.status === "found") {
      // 保存直後に同じレース×段階が2件以上あれば重複。削除や統合はせず記録だけ返し、
      // 予想は検証側で全件保留(的中率・回収率から除外)とする
      if (Number(after.count) > 1) bump("duplicate_detected");
      await finalizeClaim(sr, claim, (created && created.id) || after.row.id, doc.record_hash);
      saved.push(payload);
      donePairs.add(pair);
      continue;
    }
    // 保存を確認できない間は登録権を解放しない(再送は冪等に確定するだけで増えない)
    bump(created ? "verify_pending" : "save_unconfirmed");
    transient.add(doc.record_hash);
  }

  return {
    saved: saved.length,
    saved_pre: saved.filter((doc) => doc.stage === "PRE").length,
    saved_final: saved.filter((doc) => doc.stage === "FINAL").length,
    reasons,
    handled_hashes: handledHashes(),
  };
}