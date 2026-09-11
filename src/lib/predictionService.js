// 予想の保存・取得・照合をEntity経由で行うサービス層
import { base44 } from "@/api/base44Client";
import { runPrediction, judgeTrifecta } from "@/lib/predictionEngine";

const VERSION = "v3";

// 今日の日付(YYYY-MM-DD) — BOAT WORKSは日本時間基準。
// UTCのtoISOString()だと日本時間0:00〜8:59に前日扱いになるため、必ずAsia/Tokyoで算出する。
export const todayStr = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

// AppSettings取得(なければデフォルト)
export async function getSettings() {
  const list = await base44.entities.AppSettings.list();
  if (list && list.length) return list[0];
  const created = await base44.entities.AppSettings.create({
    name: "default",
    buy_ev_threshold: 150,
    strong_buy_ev_threshold: 200,
    watch_ev_threshold: 110,
    min_probability: 5,
    min_data_count: 5,
    min_confidence: 40,
    max_bets: 10,
    weights: {
      national_win: 1.0, local_win: 1.2, f2_rate: 1.0, f3_rate: 0.8,
      st: 1.0, motor: 1.1, boat: 0.9, exhibition: 1.3, local_fit: 1.0, section: 1.0,
    },
    target_venues: [],
  });
  return created;
}

// 今日のレース一覧(終了済みは別途)
export async function listTodayRaces({ includeFinished = false } = {}) {
  const races = await base44.entities.Race.filter({ race_date: todayStr() }, "-deadline", 500);
  if (!includeFinished) return (races || []).filter((r) => r.status !== "finished" && r.status !== "cancelled");
  return races || [];
};

// レース詳細(エントリー一覧)
export async function getRaceEntries(raceId) {
  return await base44.entities.RaceEntry.filter({ race_id: raceId }, "boat_number", 6);
}

// 既存予想取得(race_id+stage+versionで1件)
export async function getPrediction(raceId, stage) {
  const list = await base44.entities.RacePrediction.filter({
    race_id: raceId, stage, prediction_version: VERSION,
  }, "-computed_at", 1);
  return list && list[0];
}

export async function getBoatPredictions(predictionId) {
  return await base44.entities.BoatPrediction.filter({ prediction_id: predictionId }, "boat_number", 6);
}

export async function getTrifectaPredictions(predictionId) {
  return await base44.entities.TrifectaPrediction.filter({ prediction_id: predictionId }, "rank", 120);
}

// 予想を実行して保存(PRE/FINAL)。重複作成しない。
export async function generateAndSavePrediction(race, entries, settings, stage, oddsMap = {}) {
  const cfg = { ...settings, stage };

  // 選手プロファイル+ローリング統計を取得してエントリに付与
  const profiles = await base44.entities.RacerPerformanceProfile.list('-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map(p => [p.registration_number, p]));
  const rolling = await base44.entities.RacerRollingStats.list('-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map(r => [r.registration_number, r]));
  const entriesWithProfiles = entries.map(e => {
    const reg = String(e.registration_number || e.register_number || '').trim();
    return { ...e, _profile: reg ? profileByReg.get(reg) || null : null, _rollingStats: reg ? rollingByReg.get(reg) || null : null };
  });

  // FINAL時: PRE予想を基準に展示補正を適用
  let preBoatScores = null;
  if (stage === "FINAL") {
    const prePred = await getPrediction(race.id, "PRE");
    if (prePred) {
      preBoatScores = await getBoatPredictions(prePred.id);
    }
  }

  const result = runPrediction(entriesWithProfiles, cfg, { oddsMap, preBoatScores });

  // 既存確認(上書きしない方針だが、同一version/stageが無ければ新規作成)
  const existing = await getPrediction(race.id, stage);

  const predictionId = existing?.id;
  const predictionRecord = {
    race_id: race.id,
    race_key: race.race_key,
    stage,
    prediction_version: VERSION,
    computed_at: new Date().toISOString(),
    prediction_grade: result.prediction_grade,
    data_confidence: result.data_confidence,
    final_judgment: result.final_judgment,
    judgment_reason: result.judgment_reason,
    ticket_count: result.ticket_count,
    ticket_strategy: result.ticket_strategy,
    expand_reason: result.expand_reason,
    selected_trifectas: result.selected_trifectas,
    set_probability: result.set_metrics?.set_probability,
    set_expected_recovery: result.set_metrics?.set_expected_recovery,
    synthetic_odds: result.set_metrics?.synthetic_odds,
    min_payout: result.set_metrics?.min_payout,
    avg_payout: result.set_metrics?.avg_payout,
    max_payout: result.set_metrics?.max_payout,
    best_ev_ticket: result.set_metrics?.best_ev_ticket,
    worst_efficiency_ticket: result.set_metrics?.worst_efficiency_ticket,
    honmei_boat: result.honmei_boat,
    taiko_boat: result.taiko_boat,
    ana_boat: result.ana_boat,
    keshi_boat: result.keshi_boat,
    top_trifecta: result.top_trifecta,
    top_probability: result.top_probability,
    top_judgment: result.final_judgment,
    race_scenario: result.race_scenario,
    first_ranking: result.first_ranking,
    second_ranking: result.second_ranking,
    third_ranking: result.third_ranking,
    status: "COMPLETED",
  };

  let savedPred;
  if (predictionId) {
    savedPred = await base44.entities.RacePrediction.update(predictionId, predictionRecord);
    // 古い子レコード削除
    await base44.entities.BoatPrediction.deleteMany({ prediction_id: predictionId });
    await base44.entities.TrifectaPrediction.deleteMany({ prediction_id: predictionId });
  } else {
    savedPred = await base44.entities.RacePrediction.create(predictionRecord);
  }
  const pid = savedPred.id;

  // BoatPrediction保存
  const boatDocs = result.boatScores.map((s) => ({
    prediction_id: pid,
    race_id: race.id,
    race_key: race.race_key,
    stage,
    boat_number: s.boat_number,
    first_power: s.first_power,
    second_power: s.second_power,
    third_power: s.third_power,
    total_power: s.total_power,
    current_power: s.current_power,
    start_power: s.start_power,
    motor_power: s.motor_power,
    exhibition_power: s.exhibition_power,
    exhibition_score: s.exhibition_score,
    local_fit: s.local_fit,
    section_form: s.section_form,
    ana_potential: s.ana_potential,
    course_strength: s.course_strength,
    start_skill: s.start_skill,
    recent_form_score: s.recent_form_score,
    st_trend_score: s.st_trend_score,
    class_trend_score: s.class_trend_score,
    performance_trend: s.performance_trend,
    racer_power_score: s.racer_power_score,
    pre_score: s.pre_first,
    final_score: stage === "FINAL" ? s.first_power : null,
    delta: s.exhibition_delta,
    reasons: s.reasons,
    notes: s.notes,
  }));
  if (boatDocs.length) await base44.entities.BoatPrediction.bulkCreate(boatDocs);

  // TrifectaPrediction保存: 3連単120通りをすべて保持 + 選定6〜8点にマーク
  const maxBets = settings.max_bets || 10;
  const ticketInfoMap = new Map((result.ticket_selection?.selected || []).map((t) => [t.combination, t]));
  const selectedSet = new Set(result.selected_trifectas || []);
  const trifectaDocs = result.trifectas.map((t) => {
    const info = ticketInfoMap.get(t.combination);
    const isSelected = selectedSet.has(t.combination);
    const actualOdds = oddsMap?.[t.combination] || null;
    const estimatedOdds = Math.max(1.0, Math.round((100 / Math.max(t.probability, 0.1)) * 0.75 * 10) / 10);
    const ev = actualOdds ? Math.round(t.probability * actualOdds * 10) / 10 : null;
    const { judgment, basis } = judgeTrifecta({ ...t, expected_value: ev }, { settings, dataConfidence: result.data_confidence, stage });
    return {
      prediction_id: pid,
      race_id: race.id,
      race_key: race.race_key,
      stage,
      combination: t.combination,
      rank: t.rank,
      probability: t.probability,
      // UI/FINALでは推定オッズを使用しない。互換性のためフィールドは残すが常にnull。
      estimated_odds: null,
      actual_odds: actualOdds,
      current_odds: actualOdds,
      expected_value: ev,
      is_selected: isSelected,
      ticket_rank: info?.ticket_rank || null,
      set_group: info?.set_group || null,
      selection_reason: info?.selection_reason || null,
      judgment,
      basis,
    };
  });
  if (trifectaDocs.length) await base44.entities.TrifectaPrediction.bulkCreate(trifectaDocs);

  // 学習用スナップショット保存
  await base44.entities.PredictionLearningSample.create({
    race_id: race.id,
    stage,
    prediction_version: VERSION,
    snapshot: {
      boat_scores: result.boatScores.map((s) => ({
        boat: s.boat_number,
        first: s.first_power, second: s.second_power, third: s.third_power, total: s.total_power, delta: s.exhibition_delta,
      })),
      trifectas_top: result.trifectas.slice(0, maxBets).map((t) => ({
        c: t.combination, p: t.probability,
      })),
      race_scenario: result.race_scenario,
      weather: { weather: race.weather, wind_dir: race.wind_dir, wind_speed: race.wind_speed, water_temp: race.water_temp },
      odds: oddsMap,
      grade: result.prediction_grade,
      confidence: result.data_confidence,
    },
    created_at: new Date().toISOString(),
  });

  // Race更新
  const raceUpdate = {
    prediction_grade: result.prediction_grade,
    honmei_boat: result.honmei_boat,
    taiko_boat: result.taiko_boat,
    ana_boat: result.ana_boat,
    top_trifecta: result.top_trifecta,
    top_probability: result.top_probability,
    final_judgment: result.final_judgment,
    status: race.status === "finished" ? "finished" : (stage === "FINAL" ? "final" : "pre"),
  };
  if (stage === "PRE") raceUpdate.has_pre = true;
  if (stage === "FINAL") raceUpdate.has_final = true;
  await base44.entities.Race.update(race.id, raceUpdate);

  return { prediction: savedPred, result };
}

// 結果保存＋照合
export async function saveResultAndVerify(raceId, resultTrifecta, payout, finishOrder) {
  // 結果保存(既存があれば更新、FINAL確定後は欠落させない)
  const existing = await base44.entities.RaceResult.filter({ race_id: raceId }, "-finished_at", 1);
  const resultDoc = {
    race_id: raceId,
    result_trifecta: resultTrifecta,
    finish_order: finishOrder,
    payout,
    is_finished: true,
    finished_at: new Date().toISOString(),
  };
  let savedResult;
  if (existing && existing[0]) {
    savedResult = await base44.entities.RaceResult.update(existing[0].id, resultDoc);
  } else {
    savedResult = await base44.entities.RaceResult.create(resultDoc);
  }

  // Race状態更新
  await base44.entities.Race.update(raceId, { status: "finished" });

  // PRE/FINAL予想取得して照合
  const pre = await getPrediction(raceId, "PRE");
  const fin = await getPrediction(raceId, "FINAL");
  const preHit = (pre?.selected_trifectas || []).includes(resultTrifecta) || pre?.top_trifecta === resultTrifecta;
  const finalHit = (fin?.selected_trifectas || []).includes(resultTrifecta) || fin?.top_trifecta === resultTrifecta;

  // 推奨買い目 = 選定6〜8点(is_selected=true)。BUY判定時のみ投資計上。
  let recommendedHit = false;
  let investment = 0;
  if (fin) {
    const trifectas = await getTrifectaPredictions(fin.id);
    const recommended = trifectas.filter((t) => t.is_selected);
    investment = recommended.length * 100;
    recommendedHit = recommended.some((t) => t.combination === resultTrifecta);
    // BUY判定でない場合は投資0(買わない)
    if (fin.final_judgment !== "BUY") investment = 0;
  }
  const recovery = investment > 0 ? Math.round((recommendedHit ? payout : 0) / investment * 100) : 0;

  // 外れた理由(簡易)
  let missReason = "";
  if (!finalHit && fin) {
    const actualArr = resultTrifecta.split("-").map(Number);
    const predArr = (fin.top_trifecta || "").split("-").map(Number);
    if (actualArr[0] !== predArr[0]) missReason = `1着が${actualArr[0]}号艇(予想${predArr[0]})`;
    else if (actualArr[1] !== predArr[1]) missReason = `2着が${actualArr[1]}号艇(予想${predArr[1]})`;
    else if (actualArr[2] !== predArr[2]) missReason = `3着が${actualArr[2]}号艇(予想${predArr[2]})`;
  }

  const verifDoc = {
    race_id: raceId,
    pre_prediction: pre?.top_trifecta || "",
    final_prediction: fin?.top_trifecta || "",
    actual_result: resultTrifecta,
    pre_hit: preHit,
    final_hit: finalHit,
    recommended_hit: recommendedHit,
    final_judgment: fin?.final_judgment || null,
    ticket_count: fin?.ticket_count || null,
    selected_trifectas: fin?.selected_trifectas || [],
    payout,
    investment,
    recovery_rate: recovery,
    miss_reason: missReason,
    verified_at: new Date().toISOString(),
  };
  const existingVerif = await base44.entities.PredictionVerification.filter({ race_id: raceId }, "-verified_at", 1);
  let savedVerif;
  if (existingVerif && existingVerif[0]) {
    savedVerif = await base44.entities.PredictionVerification.update(existingVerif[0].id, verifDoc);
  } else {
    savedVerif = await base44.entities.PredictionVerification.create(verifDoc);
  }

  // 学習サンプルに結果を後追い更新
  const samples = await base44.entities.PredictionLearningSample.filter({ race_id: raceId }, "-created_at", 10);
  for (const s of samples) {
    await base44.entities.PredictionLearningSample.update(s.id, { actual_result: resultTrifecta, payout });
  }

  return { result: savedResult, verification: savedVerif };
}

// ---------- BOAT WORKS データ同期 ----------
// バックエンド関数 syncFromBoatWorks を呼び出す
export async function invokeSync(mode, payload = {}) {
  return await base44.functions.invoke("syncFromBoatWorks", { mode, ...payload });
}

// SyncStatus取得(最新1件)
export async function getSyncStatus() {
  const list = await base44.entities.SyncStatus.filter({ name: "default" }, "-last_sync_at", 1);
  return list && list[0];
}

// 今日のレース状況(同期状態表示用): no-data / pre / final / finished を判定
export async function listTodayRaceStatus() {
  const date = todayStr();
  const [races, allEntries] = await Promise.all([
    base44.entities.Race.filter({ race_date: date }, "-deadline", 500),
    base44.entities.RaceEntry.filter({ race_date: date }, "boat_number", 5000),
  ]);
  const entriesByRace = new Map();
  for (const e of allEntries || []) {
    if (!entriesByRace.has(e.race_id)) entriesByRace.set(e.race_id, []);
    entriesByRace.get(e.race_id).push(e);
  }
  return (races || []).map((r) => {
    const entries = entriesByRace.get(r.id) || [];
    const complete = entries.filter((e) => !e.is_scratched).length >= 6;
    return {
      id: r.id, race_key: r.race_key, venue: r.venue, venue_code: r.venue_code,
      race_number: r.race_number, race_name: r.race_name, status: r.status,
      entries: entries.length, complete, exhibition_ready: r.exhibition_ready,
      has_pre: r.has_pre, has_final: r.has_final,
      state: r.status === "finished" ? "finished" : (!complete ? "no-data" : (r.has_final ? "final" : (r.has_pre ? "pre" : "pending"))),
    };
  });
}

// 検証集計(BUY/WATCH/SKIP別・買い目数別)
export async function getVerificationSummary() {
  const verifs = await base44.entities.PredictionVerification.list("-verified_at", 500);
  const total = verifs.length;
  if (total === 0) return { total: 0 };
  const preHits = verifs.filter((v) => v.pre_hit).length;
  const finalHits = verifs.filter((v) => v.final_hit).length;
  const recHits = verifs.filter((v) => v.recommended_hit).length;

  // 判定別集計
  const byJudgment = (j) => {
    const list = verifs.filter((v) => v.final_judgment === j);
    if (!list.length) return { count: 0, hit_rate: 0, recovery_rate: 0 };
    const hits = list.filter((v) => v.recommended_hit).length;
    const invest = list.reduce((a, v) => a + (v.investment || 0), 0);
    const ret = list.filter((v) => v.recommended_hit).reduce((a, v) => a + (v.payout || 0), 0);
    return {
      count: list.length,
      hit_rate: Math.round((hits / list.length) * 1000) / 10,
      recovery_rate: invest > 0 ? Math.round((ret / invest) * 100) : 0,
    };
  };

  // 買い目数別集計
  const byTicketCount = (n) => {
    const list = verifs.filter((v) => v.ticket_count === n);
    if (!list.length) return { count: 0, hit_rate: 0, recovery_rate: 0 };
    const hits = list.filter((v) => v.recommended_hit).length;
    const invest = list.reduce((a, v) => a + (v.investment || 0), 0);
    const ret = list.filter((v) => v.recommended_hit).reduce((a, v) => a + (v.payout || 0), 0);
    return {
      count: list.length,
      hit_rate: Math.round((hits / list.length) * 1000) / 10,
      recovery_rate: invest > 0 ? Math.round((ret / invest) * 100) : 0,
    };
  };

  const totalInvest = verifs.reduce((a, v) => a + (v.investment || 0), 0);
  const totalReturn = verifs.filter((v) => v.recommended_hit).reduce((a, v) => a + (v.payout || 0), 0);
  const recovery = totalInvest > 0 ? Math.round((totalReturn / totalInvest) * 100) : 0;

  return {
    total,
    pre_hit_rate: Math.round((preHits / total) * 1000) / 10,
    final_hit_rate: Math.round((finalHits / total) * 1000) / 10,
    recommended_hit_rate: Math.round((recHits / total) * 1000) / 10,
    recovery_rate: recovery,
    buy: byJudgment("BUY"),
    watch: byJudgment("WATCH"),
    skip: byJudgment("SKIP"),
    tickets_6: byTicketCount(6),
    tickets_7: byTicketCount(7),
    tickets_8: byTicketCount(8),
    records: verifs,
  };
}