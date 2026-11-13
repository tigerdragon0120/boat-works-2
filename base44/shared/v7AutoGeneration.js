// =====================================================
// V7 予想の自動生成(共通ロジック)
// 定期実行(generateV7Predictions)から呼ばれ、パネルを開かなくても
// 締切前のV7予想を PredictionV7 に保存する。
//
// 守るルール:
//  1. 展示データ到着時にもFINALを判定する
//     締切が近いレース(既定25分以内)に加え、展示データ(exhibition_ready)が
//     揃ったレースは締切までの残り時間に関係なく対象にする。
//  2. DB書込時に締切を確認する
//     保存直前に Race を読み直し、締切を過ぎた・終了/中止になったレースは書かない。
//  3. 同一レース・段階の二重登録を防ぐ
//     race_key × stage を一意とし、保存直前にもう一度DBを確認して重複を除外する。
//  4. 確定記録の更新を拒否する
//     既存レコードは決して更新しない(更新APIを一切呼ばない)。
//     race_key × stage の記録が既にあれば生成しない。確定結果が出たレースにも作らない。
// =====================================================
import { buildSnapshot, fingerprintInput } from "./liveV7Snapshot.js";
import { unifiedV7 } from "./liveV7Unified.js";
import { digest, raceKey, platformUtc, timeMs } from "./liveV7Time.js";
import { saveV7Predictions } from "./v7PredictionStore.js";

const DEFAULT_HORIZON_MINUTES = 25;
const MAX_RACES = 200;
const TIME_BUDGET_MS = 90000;
const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;

function jstToday() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// 暫定順位づけに足りる展示の有無(最終品質の証拠ではない)
function hasPartialExhibition(entries, race) {
  const scratched = new Set((race && race.scratched_boats ? race.scratched_boats : []).map(Number));
  const active = (entries || []).filter((e) => !e.is_absent && !e.is_scratched && !scratched.has(Number(e.boat_number)));
  if (active.length < 3 || active.length > 6) return false;
  const usable = active.filter((e) =>
    Number(e.exhibition_time) > 0 && Number.isFinite(Number(e.exhibition_time)) &&
    e.exhibition_st != null && Number.isFinite(Number(e.exhibition_st)) &&
    Number.isInteger(Number(e.exhibition_course)) && Number(e.exhibition_course) >= 1 && Number(e.exhibition_course) <= 6);
  return usable.length >= 3 && new Set(usable.map((e) => Number(e.exhibition_course))).size === usable.length;
}

function rankOrder(output) {
  const order = (output && output.marginals ? output.marginals : [])
    .map((marginal) => Object.entries(marginal || {}).sort((a, b) => b[1] - a[1] || +a[0] - +b[0])[0]?.[0])
    .map(Number);
  return order.length === 3 && order.every((n) => Number.isInteger(n)) ? order : null;
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pairKey = (key, stage) => `${key}::${stage}`;

function toPlans(output) {
  const plans = {};
  const groups = [["hit", "ticketPlans"], ["value", "recoveryPlans"]];
  for (const group of groups) {
    const mode = group[0];
    const source = group[1];
    for (const count of [4, 6, 8, 12]) {
      const plan = output && output[source] ? output[source][count] : null;
      const tickets = plan && Array.isArray(plan.tickets) ? plan.tickets.filter((t) => typeof t === "string") : [];
      if (!tickets.length) continue;
      plans[`${mode}_${count}`] = { tickets, probability: num(plan.probability), judgment: plan.judgment || null };
    }
  }
  return plans;
}

export async function runV7AutoGeneration(client, options = {}) {
  const sr = client.asServiceRole.entities;
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const raceDate = typeof options.race_date === "string" && options.race_date ? options.race_date : jstToday();
  const horizonMinutes = Number.isFinite(Number(options.horizon_minutes))
    ? Math.min(180, Math.max(1, Number(options.horizon_minutes)))
    : DEFAULT_HORIZON_MINUTES;
  const onlyKeys = Array.isArray(options.race_keys) && options.race_keys.length
    ? options.race_keys.map(String)
    : null;

  const races = await sr.Race.filter({ race_date: raceDate }, "race_number", 500).catch(() => []);
  const targets = (races || []).filter((race) => {
    if (!race || !race.id || !race.race_key) return false;
    const deadline = timeMs(race.deadline);
    if (deadline == null || deadline <= nowMs) return false;
    if (["finished", "cancelled"].includes(race.status)) return false;
    if (onlyKeys) return onlyKeys.includes(race.race_key);
    // 展示データが到着済みなら、締切が遠くてもFINALを判定する
    if (race.exhibition_ready === true) return true;
    return deadline - nowMs <= horizonMinutes * 60000;
  }).slice(0, MAX_RACES);

  if (!targets.length) {
    return { race_date: raceDate, targets: 0, saved: 0, saved_pre: 0, saved_final: 0, reasons: {} };
  }

  const ids = targets.map((race) => race.id);
  const keys = [...new Set(targets.map((race) => race.race_key).filter(Boolean))];

  const [entriesById, entriesByKey, oddsById, oddsByKey, logs, existing, results] = await Promise.all([
    sr.RaceEntry.filter({ race_id: { $in: ids } }, "boat_number", 2000).catch(() => []),
    sr.RaceEntry.filter({ race_key: { $in: keys } }, "boat_number", 2000).catch(() => []),
    sr.OddsSnapshot.filter({ race_id: { $in: ids } }, "-captured_at", 1000).catch(() => []),
    sr.OddsSnapshot.filter({ race_key: { $in: keys } }, "-captured_at", 1000).catch(() => []),
    sr.OnlineFetchLog.filter({ race_date: raceDate }, "-fetched_at", 1000).catch(() => []),
    // 同一レース・段階の記録は(生成元が違っても)二重登録しない
    sr.PredictionV7.filter({ race_key: { $in: keys } }, "-created_date", 2000).catch(() => []),
    sr.RaceResult.filter({ race_id: { $in: ids } }, "-created_date", 1000).catch(() => []),
  ]);

  const dedupe = (rows) => {
    const map = new Map();
    for (const row of rows || []) if (row && row.id && !map.has(row.id)) map.set(row.id, row);
    return [...map.values()];
  };
  const entryRows = dedupe([...(entriesById || []), ...(entriesByKey || [])]);
  const oddsRows = dedupe([...(oddsById || []), ...(oddsByKey || [])]);

  const entriesByRaceKey = new Map();
  for (const row of entryRows) {
    const owner = targets.find((race) => race.id === row.race_id);
    const key = row.race_key || (owner ? owner.race_key : null);
    if (!key) continue;
    const list = entriesByRaceKey.get(key) || [];
    list.push(row);
    entriesByRaceKey.set(key, list);
  }
  for (const list of entriesByRaceKey.values()) list.sort((a, b) => Number(a.boat_number) - Number(b.boat_number));

  const oddsByRaceId = new Map();
  for (const row of oddsRows) {
    const list = oddsByRaceId.get(row.race_id) || [];
    list.push(row);
    oddsByRaceId.set(row.race_id, list);
  }

  // 確定結果が出たレースは予想を作らない(結果確定後の追記を拒否)
  const confirmedRaceIds = new Set();
  for (const result of results || []) {
    const combination = String((result && result.result_trifecta) || "");
    const finished = result && (result.is_finished === true || result.result_status === "RESULT_FINAL");
    if (finished && COMBO_RE.test(combination)) confirmedRaceIds.add(result.race_id);
  }

  const takenPairs = new Set((existing || []).map((row) => pairKey(row.race_key, row.stage)));
  const docs = [];
  const reasons = {};
  const bump = (key) => { reasons[key] = (reasons[key] || 0) + 1; };
  const startedAt = Date.now();

  for (const race of targets) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { bump("time_budget"); break; }
    let key;
    try { key = raceKey(race.race_key); } catch { bump("invalid_race_key"); continue; }
    if (confirmedRaceIds.has(race.id)) { bump("result_confirmed"); continue; }

    const raceEntries = (entriesByRaceKey.get(race.race_key) || []).map((row) => ({
      ...row, updated_date: platformUtc(row.updated_date),
    }));
    const raceOdds = (oddsByRaceId.get(race.id) || []).map((row) => ({
      ...row, captured_at: platformUtc(row.captured_at), updated_date: platformUtc(row.updated_date),
    }));
    const raceLogs = (logs || []).filter((log) =>
      (!log.venue_code || String(log.venue_code) === String(race.venue_code)) &&
      (!log.race_number || Number(log.race_number) === Number(race.race_number)) &&
      (!log.race_id || log.race_id === race.id));
    const oddsLogs = raceLogs
      .filter((log) => log.fetch_type === "odds" && timeMs(platformUtc(log.fetched_at)) != null)
      .sort((a, b) => String(b.fetched_at).localeCompare(String(a.fetched_at)));
    const quality = { rows: [{ key: "odds", failed: !!oddsLogs[0] && oddsLogs[0].status !== "success" }] };
    const normalizedRace = { ...race, updated_date: platformUtc(race.updated_date) };

    for (const stage of ["PRE", "FINAL"]) {
      if (takenPairs.has(pairKey(key, stage))) { bump("already"); continue; }
      if (stage === "FINAL" && !hasPartialExhibition(raceEntries, race)) { bump("waiting_exhibition"); continue; }

      let snapshot;
      try {
        snapshot = buildSnapshot({ race: normalizedRace, entries: raceEntries, odds: raceOdds, observedAt: nowIso, quality }, stage);
      } catch {
        bump("input_incomplete");
        continue;
      }
      const output = unifiedV7(snapshot, stage);
      if (!output || output.status !== "READY" || !output.model) { bump("engine_unavailable"); continue; }
      const plans = toPlans(output);
      if (!Object.keys(plans).length) { bump("no_plans"); continue; }

      const top = (output.combinations || [])
        .filter((row) => row && typeof row.combination === "string" && Number.isFinite(Number(row.probability)))
        .sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination))[0] || null;

      const doc = {
        record_hash: `server:${key}:${stage}`,
        input_hash: await digest(fingerprintInput(snapshot)),
        race_id: race.id,
        race_key: key,
        race_date: race.race_date || key.slice(0, 10),
        venue_code: race.venue_code != null ? String(race.venue_code) : null,
        race_number: Number.isFinite(Number(race.race_number)) ? Number(race.race_number) : null,
        series_name: race.series_name || null,
        is_womens: output.model === "WOMENS",
        model: output.model,
        stage,
        generated_at: nowIso,
        deadline: race.deadline,
        top_combination: top ? top.combination : null,
        top_probability: top ? num(top.probability) : null,
        rank_order: rankOrder(output),
        plans,
        coverage: num(output.coverage),
        judgment_reason: output.judgment_reason ? String(output.judgment_reason).slice(0, 500) : null,
        source: "SERVER",
      };
      docs.push(doc);
      takenPairs.add(pairKey(key, stage));
    }
  }

  if (!docs.length) {
    return { race_date: raceDate, targets: targets.length, saved: 0, saved_pre: 0, saved_final: 0, reasons };
  }

  // === 共通の保存処理に委ねる ===
  // 締切・開催状態・確定結果の確認と、同一レース×段階の原子的な登録制御は、
  // 端末同期と共通の処理(v7PredictionStore)が保存の瞬間に行う。
  const writeResult = await saveV7Predictions(client, docs);
  for (const [key, count] of Object.entries(writeResult.reasons || {})) {
    reasons[key] = (reasons[key] || 0) + Number(count || 0);
  }

  return {
    race_date: raceDate,
    horizon_minutes: horizonMinutes,
    targets: targets.length,
    saved: writeResult.saved,
    saved_pre: writeResult.saved_pre,
    saved_final: writeResult.saved_final,
    reasons,
  };
}