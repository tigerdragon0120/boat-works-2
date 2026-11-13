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
import { createGenerationTrace, hasPartialExhibition } from "./v7GenerationTrace.js";
import { refreshRaceForGeneration } from "./v7RaceRefresh.js";
import { fetchAllPaged } from "./pagedFetch.js";

const DEFAULT_HORIZON_MINUTES = 25;
const MAX_RACES = 200;
const TIME_BUDGET_MS = 90000;
const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;

function jstToday() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
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
    // 生成対象が無い日でも、締切後の組を「生成対象外」として記録に残す
    const [savedPage, idleTraces] = await Promise.all([
      fetchAllPaged((query, options) => sr.PredictionV7.filter(query, options), { race_date: raceDate }),
      fetchAllPaged((query, options) => sr.V7GenerationTrace.filter(query, options), { race_date: raceDate }),
    ]);
    // 過去の未確認状態を読めなければ、別状態で上書きせず終了する。
    if (!idleTraces.complete) return { race_date: raceDate, targets: 0, saved: 0, reasons: { trace_read_unavailable: 1 } };
    const idle = createGenerationTrace({ races, traces: idleTraces.rows, raceDate, nowMs });
    idle.applySavedPredictions(savedPage.rows);
    idle.fillUntouched(new Set());
    await idle.flush(sr);
    return { race_date: raceDate, targets: 0, saved: 0, saved_pre: 0, saved_final: 0, reasons: {} };
  }

  const ids = targets.map((race) => race.id);
  const keys = [...new Set(targets.map((race) => race.race_key).filter(Boolean))];

  const [entriesById, entriesByKey, oddsById, oddsByKey, logs, existing, results, traceRows] = await Promise.all([
    sr.RaceEntry.filter({ race_id: { $in: ids } }, "boat_number", 2000).catch(() => []),
    sr.RaceEntry.filter({ race_key: { $in: keys } }, "boat_number", 2000).catch(() => []),
    sr.OddsSnapshot.filter({ race_id: { $in: ids } }, "-captured_at", 1000).catch(() => []),
    sr.OddsSnapshot.filter({ race_key: { $in: keys } }, "-captured_at", 1000).catch(() => []),
    sr.OnlineFetchLog.filter({ race_date: raceDate }, "-fetched_at", 1000).catch(() => []),
    // 同一レース・段階の記録は(生成元が違っても)二重登録しない。
    // 追跡記録にも保存結果を正しく反映するため、同日の予想を全件読む
    fetchAllPaged((query, options) => sr.PredictionV7.filter(query, options), { race_date: raceDate }),
    sr.RaceResult.filter({ race_id: { $in: ids } }, "-created_date", 1000).catch(() => []),
    // 追跡記録(診断専用)。無い場合や取得に失敗しても生成は続ける
    fetchAllPaged((query, options) => sr.V7GenerationTrace.filter(query, options), { race_date: raceDate }),
  ]);
  if (!traceRows.complete) return { race_date: raceDate, targets: targets.length, saved: 0, reasons: { trace_read_unavailable: 1 } };

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

  // 追跡記録(診断専用): 展示取得時刻・生成開始・失敗理由・保存結果を残す。
  // 予想の生成・保存の判定には使わない
  const trace = createGenerationTrace({
    races, entriesByKey: entriesByRaceKey, logs, traces: traceRows.rows, raceDate, nowMs,
  });
  trace.applySavedPredictions(existing.rows);
  trace.fillUntouched(new Set(targets.map((race) => race.id)));
  const raceByKey = new Map((races || []).map((race) => [race.race_key, race]));

  const takenPairs = new Set(existing.rows.map((row) => pairKey(row.race_key, row.stage)));
  const docs = [];
  const reasons = {};
  const bump = (key) => { reasons[key] = (reasons[key] || 0) + 1; };
  const startedAt = Date.now();

  for (const race of targets) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { bump("time_budget"); break; }
    let key;
    try { key = raceKey(race.race_key); } catch { bump("invalid_race_key"); continue; }
    if (confirmedRaceIds.has(race.id)) {
      bump("result_confirmed");
      trace.observe(race, "PRE", "BLOCKED", "result_confirmed");
      trace.observe(race, "FINAL", "BLOCKED", "result_confirmed");
      continue;
    }

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
    for (const stage of ["PRE", "FINAL"]) {
      if (takenPairs.has(pairKey(key, stage))) { bump("already"); continue; }

      if (!existing.complete) {
        bump('prediction_read_unavailable');
        trace.observe(race, stage, 'UNKNOWN', 'RETRY_REQUIRED', { reason_detail: 'prediction_read_unavailable' });
        continue;
      }
      // PRE/FINALそれぞれの直前に再取得。失敗・空応答・タイムアウト時は古い値を使わない。
      const refreshed = await refreshRaceForGeneration(sr, race);
      if (refreshed.status !== 'READY') {
        bump(refreshed.reason);
        trace.observe(refreshed.race || race, stage, refreshed.status, refreshed.status === 'UNKNOWN' ? 'RETRY_REQUIRED' : refreshed.reason,
          { reason_detail: refreshed.reason, deadline_passed: refreshed.status === 'UNKNOWN' ? null : refreshed.reason === 'deadline_passed' });
        continue;
      }
      const liveRace = refreshed.race;
      raceByKey.set(race.race_key, liveRace);
      const normalizedRace = { ...liveRace, updated_date: platformUtc(liveRace.updated_date) };
      if (stage === "FINAL" && !hasPartialExhibition(raceEntries, liveRace)) {
        // 出走表を読めていない場合は「展示が無い」と断定せず、理由を不明として区別する
        const unknown = !entriesByRaceKey.has(race.race_key);
        bump(unknown ? "exhibition_unknown" : "waiting_exhibition");
        trace.observe(race, stage, "PENDING", unknown ? "exhibition_unknown" : "exhibition_waiting");
        continue;
      }

      const attemptStartedAt = new Date().toISOString();
      // 再取得完了後も、エンジン実行時の時計で締切を確認する。
      if (timeMs(liveRace.deadline) <= Date.now()) {
        bump('deadline_passed');
        trace.observe(liveRace, stage, 'BLOCKED', 'deadline_passed', { deadline_passed: true });
        continue;
      }
      let snapshot;
      try {
        snapshot = buildSnapshot({ race: normalizedRace, entries: raceEntries, odds: raceOdds, observedAt: attemptStartedAt, quality }, stage);
      } catch {
        bump("input_incomplete");
        trace.observe(race, stage, "FAILED", "input_incomplete", { generation_started_at: attemptStartedAt });
        continue;
      }
      if (timeMs(liveRace.deadline) <= Date.now()) {
        bump('deadline_passed');
        trace.observe(liveRace, stage, 'BLOCKED', 'deadline_passed', { deadline_passed: true });
        continue;
      }
      const output = unifiedV7(snapshot, stage);
      if (!output || output.status !== "READY" || !output.model) {
        bump("engine_unavailable");
        trace.observe(race, stage, "FAILED", "engine_unavailable", { generation_started_at: attemptStartedAt });
        continue;
      }
      const plans = toPlans(output);
      if (!Object.keys(plans).length) {
        bump("no_plans");
        trace.observe(race, stage, "FAILED", "no_plans", { generation_started_at: attemptStartedAt });
        continue;
      }

      const top = (output.combinations || [])
        .filter((row) => row && typeof row.combination === "string" && Number.isFinite(Number(row.probability)))
        .sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination))[0] || null;

      const doc = {
        record_hash: `server:${key}:${stage}`,
        input_hash: await digest(fingerprintInput(snapshot)),
        race_id: liveRace.id,
        race_key: key,
        race_date: liveRace.race_date || key.slice(0, 10),
        venue_code: liveRace.venue_code != null ? String(liveRace.venue_code) : null,
        race_number: Number.isFinite(Number(liveRace.race_number)) ? Number(liveRace.race_number) : null,
        series_name: liveRace.series_name || null,
        is_womens: output.model === "WOMENS",
        model: output.model,
        stage,
        generated_at: attemptStartedAt,
        deadline: liveRace.deadline,
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
    const traced = await trace.flush(sr);
    return { race_date: raceDate, targets: targets.length, saved: 0, saved_pre: 0, saved_final: 0, traced: traced.tracked, reasons };
  }

  // === 共通の保存処理に委ねる ===
  // 締切・開催状態・確定結果の確認と、同一レース×段階の原子的な登録制御は、
  // 端末同期と共通の処理(v7PredictionStore)が保存の瞬間に行う。
  const writeResult = await saveV7Predictions(client, docs).catch(() => ({
    saved: 0, saved_pre: 0, saved_final: 0, reasons: { save_unconfirmed: docs.length },
  }));
  for (const [key, count] of Object.entries(writeResult.reasons || {})) {
    reasons[key] = (reasons[key] || 0) + Number(count || 0);
  }

  // 空の再読取は保存失敗の証拠ではない。応答不明時はUNKNOWNを維持する。
  const attemptedKeys = [...new Set(docs.map((doc) => doc.race_key))];
  const storedPage = await fetchAllPaged(
    (query, options) => sr.PredictionV7.filter(query, options),
    { race_key: { $in: attemptedKeys } },
  );
  const storedByPair = new Map(storedPage.rows.map((row) => [pairKey(row.race_key, row.stage), row]));
  for (const doc of docs) {
    const race = raceByKey.get(doc.race_key);
    if (!race) continue;
    const row = storedByPair.get(pairKey(doc.race_key, doc.stage)) || null;
    if (row) {
      trace.observe(race, doc.stage, "SAVED", "saved", {
        record_hash: row.record_hash || doc.record_hash || null,
        prediction_created_at: row.created_date || null,
        generation_started_at: doc.generated_at || null,
      });
    } else {
      trace.observe(race, doc.stage, 'UNKNOWN', 'save_unconfirmed', {
        generation_started_at: doc.generated_at || null,
        reason_detail: storedPage.complete ? '再読取で行が未可視。保存失敗とは断定しない' : '再読取未完了。保存結果は未確認',
      });
    }
  }
  const traced = await trace.flush(sr);

  return {
    race_date: raceDate,
    horizon_minutes: horizonMinutes,
    targets: targets.length,
    saved: writeResult.saved,
    saved_pre: writeResult.saved_pre,
    saved_final: writeResult.saved_final,
    traced: traced.tracked,
    reasons,
  };
}