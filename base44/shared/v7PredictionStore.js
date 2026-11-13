// =====================================================
// V7 予想レコードの共通保存処理
// サーバー自動生成(SERVER)と端末同期(BROWSER)は、どちらもこの1本を通る。
//
//  1. 締切・開催状態・確定結果は「保存する瞬間」のDB値(Race / RaceResult)で確認する
//  2. 同一レース×段階の登録は、レース単位のリースロックで直列化し、
//     ロック内で既存確認 → 登録 の順に行う(原子的な登録制御)
//  3. 同時実行で重複が生じた場合は、同一レース×段階を1件(最も古い記録)に揃える
//  4. 既存レコードは決して更新しない(更新APIを一切呼ばない)
// =====================================================
import { acquireLock, releaseLock } from "./concurrencyLock.js";
import { timeMs } from "./liveV7Time.js";

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const RACE_KEY_RE = /^\d{4}-\d{2}-\d{2}_\d{1,2}_\d{1,2}$/;
const PLAN_KEY_RE = /^(hit|value)_(4|6|8|12)$/;
const LOCK_TTL_MS = 120000;
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
  const [races, existingRows] = await Promise.all([
    sr.Race.filter({ race_key: { $in: keys } }, "-created_date", 1000).catch(() => []),
    sr.PredictionV7.filter({ race_key: { $in: keys } }, "-created_date", 2000).catch(() => []),
  ]);

  const raceByKey = new Map();
  for (const race of races || []) {
    const previous = raceByKey.get(race.race_key);
    if (!previous || (!previous.deadline && race.deadline)) raceByKey.set(race.race_key, race);
  }
  const existingPairs = new Set((existingRows || []).map((row) => pairOf(row.race_key, row.stage)));

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
    if (existingPairs.has(pairOf(doc.race_key, doc.stage))) { bump("duplicate_rejected"); continue; }
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
  const writtenPairs = [];
  for (const doc of queue) {
    const pair = pairOf(doc.race_key, doc.stage);
    if (writtenPairs.some((row) => row.pair === pair)) { bump("duplicate_rejected"); continue; }

    // 同一レース×段階はロックで直列化し、ロック内で既存確認→登録する
    const lockId = await acquireLock(client, `v7save:${pair}`, "v7Save", LOCK_TTL_MS);
    if (!lockId) {
      bump("save_locked");
      transient.add(doc.record_hash);
      continue;
    }
    try {
      const rows = await sr.PredictionV7
        .filter({ race_key: doc.race_key, stage: doc.stage }, "-created_date", 10)
        .catch(() => []);
      if (rows && rows.length) { bump("duplicate_rejected"); continue; }
      await sr.PredictionV7.create(doc);
      saved.push(doc);
      writtenPairs.push({ pair, race_key: doc.race_key, stage: doc.stage });
    } catch {
      bump("save_failed");
      transient.add(doc.record_hash);
    } finally {
      await releaseLock(client, lockId);
    }
  }

  // 万一同時に登録された場合は、同一レース×段階を1件(最も古い記録)に揃える。
  // 保存済みの記録は書き換えない。
  for (const row of writtenPairs) {
    const rows = await sr.PredictionV7
      .filter({ race_key: row.race_key, stage: row.stage }, "created_date", 20)
      .catch(() => []);
    if (!rows || rows.length < 2) continue;
    const extra = rows.slice(1).map((item) => item.id).filter(Boolean);
    if (extra.length) await sr.PredictionV7.deleteMany({ id: { $in: extra } }).catch(() => {});
  }

  return {
    saved: saved.length,
    saved_pre: saved.filter((doc) => doc.stage === "PRE").length,
    saved_final: saved.filter((doc) => doc.stage === "FINAL").length,
    reasons,
    handled_hashes: handledHashes(),
  };
}