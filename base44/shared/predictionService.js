// サーバー側 同期+予想サービス。バックエンド関数から呼ばれる。
// client は createClientFromRequest(req) または asServiceRole。
import { runPrediction } from "./predictionEngine.js";
import { buildRaceKey, mapRace, mapEntry, mapResult } from "./raceKey.js";

const VERSION = "v3";

const DEFAULT_SETTINGS = {
  buy_ev_threshold: 150, strong_buy_ev_threshold: 200, watch_ev_threshold: 110,
  min_probability: 5, min_data_count: 5, min_confidence: 40, max_bets: 10,
  weights: { national_win: 1.0, local_win: 1.2, f2_rate: 1.0, f3_rate: 0.8, st: 1.0, motor: 1.1, boat: 0.9, exhibition: 1.3, local_fit: 1.0, section: 1.0 },
};

// 既存レコードを保護しつつマージ: incomingの非nullだけ上書き。空配列で上書きしない。
function mergeProtect(existing, incoming) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && Array.isArray(existing?.[k]) && existing[k].length > 0) continue;
    out[k] = v;
  }
  return out;
}

export async function getSettings(client) {
  const list = await client.asServiceRole.entities.AppSettings.list();
  if (list && list.length) return list[0];
  return await client.asServiceRole.entities.AppSettings.create({ name: "default", ...DEFAULT_SETTINGS });
}

// race_keyでRaceをupsert(保護付き)
export async function upsertRace(client, raceData) {
  const existing = await client.asServiceRole.entities.Race.filter({ race_key: raceData.race_key }, "-updated_date", 1);
  if (existing && existing[0]) {
    const merged = mergeProtect(existing[0], raceData);
    // FINAL確定後はstatusを後退させない
    if (existing[0].status === "final" && (merged.status === "scheduled" || merged.status === "pre")) merged.status = "final";
    if (existing[0].status === "finished") merged.status = "finished";
    return await client.asServiceRole.entities.Race.update(existing[0].id, merged);
  }
  return await client.asServiceRole.entities.Race.create(raceData);
}

// race_key+boat_numberでRaceEntryをupsert(保護付き)
export async function upsertEntry(client, entryData) {
  const existing = await client.asServiceRole.entities.RaceEntry.filter(
    { race_key: entryData.race_key, boat_number: entryData.boat_number }, "boat_number", 1
  );
  if (existing && existing[0]) {
    const merged = mergeProtect(existing[0], entryData);
    merged.race_id = existing[0].race_id;
    return await client.asServiceRole.entities.RaceEntry.update(existing[0].id, merged);
  }
  return await client.asServiceRole.entities.RaceEntry.create(entryData);
}

// race_key+stage+versionでRacePredictionを1件保証(重複作成しない)
export async function getOrCreatePrediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.RacePrediction.filter(
    { race_id: raceId, stage, prediction_version: VERSION }, "-computed_at", 1
  );
  if (list && list[0]) return { id: list[0].id, existing: list[0] };
  const created = await client.asServiceRole.entities.RacePrediction.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: VERSION, status: "PENDING",
  });
  return { id: created.id, existing: null };
}

// 予想を実行して保存(サーバー側)。既存子レコードは置換。
export async function runAndSavePrediction(client, race, entries, settings, stage, oddsMap = {}) {
  const cfg = { ...settings, stage };
  const result = runPrediction(entries, cfg, { oddsMap });

  const { id: predictionId } = await getOrCreatePrediction(client, race.id, race.race_key, stage);

  const predictionRecord = {
    race_id: race.id, race_key: race.race_key, stage, prediction_version: VERSION,
    computed_at: new Date().toISOString(),
    prediction_grade: result.prediction_grade,
    data_confidence: result.data_confidence,
    honmei_boat: result.honmei_boat, taiko_boat: result.taiko_boat, ana_boat: result.ana_boat, keshi_boat: result.keshi_boat,
    top_trifecta: result.top_trifecta, top_probability: result.top_probability,
    top_odds: result.top_odds, top_expected_value: result.top_expected_value, top_judgment: result.top_judgment,
    status: "COMPLETED",
  };
  await client.asServiceRole.entities.RacePrediction.update(predictionId, predictionRecord);

  // 子レコード再生成
  await client.asServiceRole.entities.BoatPrediction.deleteMany({ prediction_id: predictionId });
  await client.asServiceRole.entities.TrifectaPrediction.deleteMany({ prediction_id: predictionId });

  const boatDocs = result.boatScores.map((s) => ({
    prediction_id: predictionId, race_id: race.id, race_key: race.race_key, stage,
    boat_number: s.boat_number,
    first_power: s.first_power, second_power: s.second_power, third_power: s.third_power, total_power: s.total_power,
    start_power: s.start_power, motor_power: s.motor_power, exhibition_power: s.exhibition_power,
    local_fit: s.local_fit, section_form: s.section_form, ana_potential: s.ana_potential,
    reasons: s.reasons, notes: s.notes,
  }));
  if (boatDocs.length) await client.asServiceRole.entities.BoatPrediction.bulkCreate(boatDocs);

  const trifectaDocs = result.trifectas.map((t) => ({
    prediction_id: predictionId, race_id: race.id, race_key: race.race_key, stage,
    combination: t.combination, rank: t.rank, probability: t.probability,
    estimated_odds: t.estimated_odds, actual_odds: t.actual_odds, expected_value: t.expected_value,
    judgment: t.judgment, basis: t.basis,
  }));
  if (trifectaDocs.length) await client.asServiceRole.entities.TrifectaPrediction.bulkCreate(trifectaDocs);

  // 学習スナップショット
  await client.asServiceRole.entities.PredictionLearningSample.create({
    race_id: race.id, race_key: race.race_key, stage, prediction_version: VERSION,
    snapshot: {
      boat_scores: result.boatScores.map((s) => ({ boat: s.boat_number, first: s.first_power, second: s.second_power, third: s.third_power, total: s.total_power })),
      trifectas_top: result.trifectas.slice(0, 10).map((t) => ({ c: t.combination, p: t.probability, ev: t.expected_value, j: t.judgment })),
      grade: result.prediction_grade, confidence: result.data_confidence, bet_plan: result.bet_plan,
    },
    created_at: new Date().toISOString(),
  });

  // Race更新(保護: has_pre/has_finalはtrueにするだけ、statusは後退させない)
  const raceUpdate = {
    prediction_grade: result.prediction_grade,
    honmei_boat: result.honmei_boat, taiko_boat: result.taiko_boat, ana_boat: result.ana_boat, keshi_boat: result.keshi_boat,
    top_trifecta: result.top_trifecta, top_probability: result.top_probability, final_judgment: result.top_judgment,
  };
  if (stage === "PRE") { raceUpdate.has_pre = true; if (race.status !== "final" && race.status !== "finished") raceUpdate.status = "pre"; }
  if (stage === "FINAL") { raceUpdate.has_final = true; if (race.status !== "finished") raceUpdate.status = "final"; }
  await client.asServiceRole.entities.Race.update(race.id, raceUpdate);

  return { predictionId, result };
}

// 結果upsert + 照合(サーバー側)
export async function upsertResultAndVerify(client, race, resultData) {
  if (!resultData.result_trifecta) return null;
  const existing = await client.asServiceRole.entities.RaceResult.filter({ race_id: race.id }, "-finished_at", 1);
  const doc = { race_id: race.id, race_key: race.race_key, result_trifecta: resultData.result_trifecta, finish_order: resultData.finish_order, payout: resultData.payout || 0, is_finished: true, finished_at: new Date().toISOString() };
  let saved;
  if (existing && existing[0]) saved = await client.asServiceRole.entities.RaceResult.update(existing[0].id, doc);
  else saved = await client.asServiceRole.entities.RaceResult.create(doc);
  await client.asServiceRole.entities.Race.update(race.id, { status: "finished" });

  const pre = await client.asServiceRole.entities.RacePrediction.filter({ race_id: race.id, stage: "PRE", prediction_version: VERSION }, "-computed_at", 1);
  const fin = await client.asServiceRole.entities.RacePrediction.filter({ race_id: race.id, stage: "FINAL", prediction_version: VERSION }, "-computed_at", 1);
  const preHit = pre?.[0]?.top_trifecta === resultData.result_trifecta;
  const finalHit = fin?.[0]?.top_trifecta === resultData.result_trifecta;

  let recommendedHit = false, investment = 0;
  if (fin?.[0]) {
    const tri = await client.asServiceRole.entities.TrifectaPrediction.filter({ prediction_id: fin[0].id }, "rank", 120);
    const rec = tri.filter((t) => t.judgment === "STRONG_BUY" || t.judgment === "BUY");
    investment = rec.length * 100;
    recommendedHit = rec.some((t) => t.combination === resultData.result_trifecta);
  }
  const recovery = investment > 0 ? Math.round((recommendedHit ? (resultData.payout || 0) : 0) / investment * 100) : 0;

  const verifDoc = {
    race_id: race.id, race_key: race.race_key,
    pre_prediction: pre?.[0]?.top_trifecta || "", final_prediction: fin?.[0]?.top_trifecta || "",
    actual_result: resultData.result_trifecta, pre_hit: preHit, final_hit: finalHit, recommended_hit: recommendedHit,
    payout: resultData.payout || 0, investment, recovery_rate: recovery, verified_at: new Date().toISOString(),
  };
  const existV = await client.asServiceRole.entities.PredictionVerification.filter({ race_id: race.id }, "-verified_at", 1);
  let savedV;
  if (existV?.[0]) savedV = await client.asServiceRole.entities.PredictionVerification.update(existV[0].id, verifDoc);
  else savedV = await client.asServiceRole.entities.PredictionVerification.create(verifDoc);
  return { result: saved, verification: savedV };
}

// メイン: 同期+予想。payload = { races, entries, series, results, odds }
export async function syncAndPredict(client, payload, opts = {}) {
  const settings = await getSettings(client);
  const races = payload.races || [];
  const entries = payload.entries || [];
  const series = payload.series || [];
  const results = payload.results || [];
  const odds = payload.odds || [];

  // seriesはBOAT WORKS側で race_key + registration_number 単位で出力される。
  // 旧実装は存在しない boat_number で索引していたため、節間成績が全件マージされていなかった。
  const seriesMap = {};
  for (const s of series) {
    const rk = s.race_key || buildRaceKey(s.race_date, s.venue_code, s.race_number);
    const reg = String(s.registration_number || s.register_number || "").trim();
    if (!rk || !reg) continue;
    seriesMap[`${rk}_${reg}`] = s;
  }
  // oddsをrace_keyで索引
  const oddsByRace = {};
  for (const o of odds) {
    const rk = o.race_key || buildRaceKey(o.race_date, o.venue_code, o.race_number);
    if (!oddsByRace[rk]) oddsByRace[rk] = {};
    if (o.all_trifecta_odds && typeof o.all_trifecta_odds === "object") Object.assign(oddsByRace[rk], o.all_trifecta_odds);
    if (o.odds_map && typeof o.odds_map === "object") Object.assign(oddsByRace[rk], o.odds_map);
    else if (o.combination) oddsByRace[rk][o.combination] = Number(o.odds);
  }

  const summary = {
    races_total: races.length, races_upserted: 0, entries_upserted: 0,
    pre_generated: 0, final_generated: 0, results_saved: 0, errors: [],
    venue_summary: {}, synced_race_keys: [],
  };
  const addVenue = (code, k) => {
    if (!code) return;
    if (!summary.venue_summary[code]) summary.venue_summary[code] = { races: 0, complete: 0, exhibition: 0, result: 0, pre: 0, final: 0, errors: 0 };
    summary.venue_summary[code][k] = (summary.venue_summary[code][k] || 0) + 1;
  };

  for (const bwRace of races) {
    try {
      const raceData = mapRace(bwRace);
      if (!raceData.race_key || !raceData.race_number) { summary.errors.push({ race_key: raceData.race_key, message: "race_key/number不正" }); continue; }
      const race = await upsertRace(client, { ...raceData, sync_source: opts.mode || "ingest" });
      summary.races_upserted++; summary.synced_race_keys.push(raceData.race_key); addVenue(raceData.venue_code, "races");

      // 6艇取得
      const raceEntries = entries.filter((e) => {
        const ek = e.race_key || buildRaceKey(e.race_date, e.venue_code, e.race_number);
        return ek === raceData.race_key;
      });
      const entryDocs = [];
      for (const bwEntry of raceEntries) {
        const reg = String(bwEntry.registration_number || bwEntry.register_number || "").trim();
        const skey = `${raceData.race_key}_${reg}`;
        const entryData = { ...mapEntry(bwEntry, seriesMap[skey] || {}), race_id: race.id };
        const saved = await upsertEntry(client, entryData);
        entryDocs.push(saved);
        summary.entries_upserted++;
      }
      const complete = entryDocs.filter((e) => e && !e.is_scratched && e.boat_number).length >= 6;
      if (complete) addVenue(raceData.venue_code, "complete");

      // PRE予想(6艇揃っていれば展示データ不使用で生成)
      if (complete) {
        try {
          await runAndSavePrediction(client, race, entryDocs, settings, "PRE", {});
          summary.pre_generated++; addVenue(raceData.venue_code, "pre");
        } catch (e) { summary.errors.push({ race_key: raceData.race_key, message: "PRE予想失敗: " + e.message }); addVenue(raceData.venue_code, "errors"); }
      }

      // FINAL予想(展示取得済みの場合のみ)
      if (complete && raceData.exhibition_ready) {
        addVenue(raceData.venue_code, "exhibition");
        try {
          await runAndSavePrediction(client, race, entryDocs, settings, "FINAL", oddsByRace[raceData.race_key] || {});
          summary.final_generated++; addVenue(raceData.venue_code, "final");
        } catch (e) { summary.errors.push({ race_key: raceData.race_key, message: "FINAL予想失敗: " + e.message }); addVenue(raceData.venue_code, "errors"); }
      }

      // 結果
      const res = results.find((r) => (r.race_key || buildRaceKey(r.race_date, r.venue_code, r.race_number)) === raceData.race_key);
      if (res) {
        try {
          await upsertResultAndVerify(client, race, mapResult(res));
          summary.results_saved++; addVenue(raceData.venue_code, "result");
        } catch (e) { summary.errors.push({ race_key: raceData.race_key, message: "結果保存失敗: " + e.message }); }
      }
    } catch (e) {
      summary.errors.push({ race_key: bwRace?.race_key, message: e.message });
    }
  }

  // SyncStatus保存
  const statusDoc = {
    name: "default", last_sync_at: new Date().toISOString(),
    status: summary.errors.length === 0 ? "success" : (summary.races_upserted > 0 ? "partial" : "failed"),
    mode: opts.mode || "ingest", error_count: summary.errors.length, errors: summary.errors.slice(0, 50),
    venue_summary: summary.venue_summary, synced_race_keys: summary.synced_race_keys,
  };
  const existStatus = await client.asServiceRole.entities.SyncStatus.filter({ name: "default" }, "-last_sync_at", 1);
  if (existStatus?.[0]) await client.asServiceRole.entities.SyncStatus.update(existStatus[0].id, statusDoc);
  else await client.asServiceRole.entities.SyncStatus.create(statusDoc);

  return summary;
}