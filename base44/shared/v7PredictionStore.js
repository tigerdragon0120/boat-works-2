// =====================================================
// V7 予想レコードの共通保存処理
// サーバー自動生成(SERVER)と端末同期(BROWSER)は、どちらもこの1本を通る。
//
//  1. 締切・開催状態・確定結果は「保存する瞬間」のDB値(Race / RaceResult)で確認する
//  2. 同一レース×段階の事前配置済み登録枠(V7StageClaim)が1行と確認できる場合だけ進む。
//     free → writing → written の状態遷移を使い、writingを時間だけで再取得しない。
//     登録枠の欠損・重複・応答不明では新規保存を止める
//  3. 予想を書き込む直前に、自分の登録権であることを
//     条件付き書込の成立(所有権の確認)で確かめてから書き込む
//  4. 応答が消えても増えない: 再送は登録権の状態とDBの予想で判定し、
//     保存済みなら確定させるだけで、予想を作り直さない
//  5. 予想を書き込んだ後は登録権を解放しない(結果不明は再読取して冪等に確定)
//  6. 既存レコードは決して更新しない(更新APIを一切呼ばない)
// =====================================================
import { timeMs } from "./liveV7Time.js";
import { fetchAllPaged } from "./pagedFetch.js";
import { loadOfficialResultsByRace } from "./officialResultRead.js";

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const RACE_KEY_RE = /^\d{4}-\d{2}-\d{2}_\d{1,2}_\d{1,2}$/;
const PLAN_KEY_RE = /^(hit|value)_(4|6|8|12)$/;
const CLAIM_ENTITY = "V7StageClaim";
// writing の経過時間は保存失敗の証拠にならない。期限による再取得は禁止。
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
  const page = await fetchAllPaged((query, options) => sr.Race.filter(query, options), { race_key: raceKey });
  if (!page.complete || page.rows.length !== 1) return { reason: 'race_unconfirmed' };
  const race = page.rows[0];
  if (!['scheduled', 'pre', 'final', 'finished', 'cancelled'].includes(race.status)) return { reason: 'race_unconfirmed' };
  if (["finished", "cancelled"].includes(race.status)) return { reason: "race_closed" };
  const deadline = timeMs(race.deadline);
  if (deadline == null) return { reason: 'race_unconfirmed' };
  if (deadline <= Date.now()) return { reason: 'deadline_passed' };
  const results = await loadOfficialResultsByRace(sr, [race.id]);
  const resolution = results.byRace.get(race.id);
  if (!results.complete || resolution?.status === 'incomplete') return { reason: 'gate_unavailable' };
  if (resolution?.status === 'ready' || resolution?.status === 'conflict') return { reason: 'result_confirmed' };
  return { race, reason: null };
}

// 事前配置済みの登録枠だけを使う。欠損・複数・読み取り不明では書かない。
// この経路では登録枠の新規作成・整理削除はしない。
async function ensureClaimRow(sr, pair) {
  const page = await fetchAllPaged((query, options) => sr[CLAIM_ENTITY].filter(query, options), { claim_key: pair });
  return page.complete && page.rows.length === 1 ? page.rows[0] : null;
}

// 同一レース×段階の予想を読む。読めなかった場合は unknown を返す
// (読めない状態を「無い」と扱うと、二重保存の原因になるため必ず区別する)
async function findPrediction(sr, doc) {
  const page = await fetchAllPaged(
    (query, options) => sr.PredictionV7.filter(query, options),
    { race_key: doc.race_key, stage: doc.stage },
  );
  if (!page.complete) return { status: 'unknown', count: 0 };
  const found = page.rows;
  const row = found[0] || null;
  return row
    ? { status: "found", row, count: found.length }
    : { status: "absent", count: 0 };
}

// 登録枠の獲得と再送判定。未確認の保存を再試行の新規書込へ戻さない。
//   acquired      : 自分が書き込む番(1つの呼び出しだけが得る)
//   in_flight     : 書込履歴あり。DBの再照合だけを行う(増やさない)
//   taken         : 別の要求が登録権を持つ(増やさない)
async function acquireClaim(sr, doc) {
  const pair = pairOf(doc.race_key, doc.stage);
  const row = await ensureClaimRow(sr, pair);
  if (!row) return { status: 'taken' };
  // written/claimedもDB再読取で実在を確認するまで保存済みと断定しない。
  // writingはリース切れでも再取得しない。別hashの再送も同じ組の再照合だけを行う。
  if (FINAL_CLAIM_STATES.has(row.state) || row.state === 'writing') return { status: 'in_flight', row };
  if (row.state !== 'free') return { status: 'taken', row };

  const owner = `${doc.record_hash}:${Math.random().toString(36).slice(2, 10)}`;
  const result = await sr[CLAIM_ENTITY]
    .updateMany({ id: row.id, state: 'free' }, {
      $set: { state: 'writing', owner, record_hash: doc.record_hash, claimed_at: new Date().toISOString(), prediction_id: null },
    })
    .catch(() => null);

  if (!result || Number(result.updated) !== 1) return { status: 'taken', row };
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
      { id: claim.row.id, state: claim.row.state === 'free' ? 'writing' : claim.row.state },
      { $set: { state: "written", prediction_id: predictionId, record_hash: recordHash, claimed_at: new Date().toISOString() } },
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

  const saved = [];
  const donePairs = new Set();
  for (const doc of clean) {
    const pair = pairOf(doc.race_key, doc.stage);
    if (donePairs.has(pair)) { bump("duplicate_rejected"); continue; }

    // 事前配置済み登録枠の確認と再送判定
    const claim = await acquireClaim(sr, doc);
    if (claim.status === 'taken') { bump('claim_unconfirmed'); transient.add(doc.record_hash); continue; }

    if (claim.status === "in_flight") {
      // 別hash・リース切れも再読取だけ。行が見えなくても未確認のまま増やさない
      const current = await findPrediction(sr, doc);
      if (current.status === "found") {
        if (current.count > 1) { bump('duplicate_detected'); transient.add(doc.record_hash); continue; }
        await finalizeClaim(sr, claim, current.row.id, current.row.record_hash);
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
      if (existing.count > 1) { bump('duplicate_detected'); transient.add(doc.record_hash); continue; }
      await finalizeClaim(sr, claim, existing.row.id, existing.row.record_hash);
      bump("idempotent");
      donePairs.add(pair);
      continue;
    }

    // 既存の有無を確認できない間は書き込まない(確認できないまま書くと二重登録になる)
    if (existing.status === "unknown") {
      bump("read_unavailable");
      transient.add(doc.record_hash);
      await releaseClaim(sr, claim);
      continue;
    }

    const gate = await readRaceGate(sr, doc.race_key).catch(() => ({ reason: "gate_unavailable" }));
    if (gate.reason) {
      bump(gate.reason);
      if (['race_unconfirmed', 'gate_unavailable'].includes(gate.reason)) transient.add(doc.record_hash);
      await releaseClaim(sr, claim);
      continue;
    }

    // 所有権の確認と書込: 条件付き書込が成立(=自分の登録権)した場合だけ書き込む
    if (!(await renewClaim(sr, claim))) { bump('claim_lost'); transient.add(doc.record_hash); continue; }
    if (timeMs(gate.race.deadline) <= Date.now()) { bump('deadline_passed'); await releaseClaim(sr, claim); continue; }

    const payload = {
      ...doc, race_id: gate.race.id, race_date: gate.race.race_date || doc.race_key.slice(0, 10),
      venue_code: gate.race.venue_code != null ? String(gate.race.venue_code) : null,
      race_number: Number.isFinite(Number(gate.race.race_number)) ? Number(gate.race.race_number) : null,
      deadline: gate.race.deadline,
    };
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
      if (Number(after.count) > 1) { bump('duplicate_detected'); transient.add(doc.record_hash); continue; }
      await finalizeClaim(sr, claim, after.row.id, after.row.record_hash);
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