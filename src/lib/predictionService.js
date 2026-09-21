// 予想の保存・取得・照合をEntity経由で行うサービス層
import { base44 } from "@/api/base44Client";
import { dedupeVerifications } from "@/lib/verificationUtils";
import { runPrediction, judgeTrifecta } from "@/lib/predictionEngine";

const VERSION = "v3";

// レート制限(429)対策: 指数バックオフ付きリトライ
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function withRetry(fn, max = 4) {
  let last;
  for (let i = 0; i <= max; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e?.message || e || "");
      if (!/rate\s*limit|429|too many requests/i.test(msg) || i === max) throw e;
      await sleep(Math.min(8000, 500 * 2 ** i));
    }
  }
  throw last;
}

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
function raceDisplayScore(r) {
  let score = 0;
  if (r?.has_final) score += 40;
  if (r?.exhibition_ready) score += 30;
  if (r?.has_pre) score += 20;
  if (r?.prediction_grade) score += 5;
  if (r?.deadline) score += 2;
  if (r?.status === "finished") score += 1;
  return score;
}

function dedupeRacesForDisplay(races) {
  const byKey = new Map();
  for (const race of races || []) {
    const key = race.race_key || `${race.race_date}_${String(race.venue_code || "").padStart(2, "0")}_${String(race.race_number || "").padStart(2, "0")}`;
    const current = byKey.get(key);
    if (!current || raceDisplayScore(race) > raceDisplayScore(current) ||
        (raceDisplayScore(race) === raceDisplayScore(current) &&
         String(race.updated_date || "") > String(current.updated_date || ""))) {
      byKey.set(key, race);
    }
  }
  return [...byKey.values()];
}

// 今日のレース一覧。同一race_keyが重複していても画面には1Rにつき1件だけ返す。
export async function listTodayRaces({ includeFinished = false } = {}) {
  const races = await withRetry(() => base44.entities.Race.filter({ race_date: todayStr() }, "-deadline", 500));
  const unique = dedupeRacesForDisplay(races || []);
  if (!includeFinished) return unique.filter((r) => r.status !== "finished" && r.status !== "cancelled");
  return unique;
};

function entryCompleteness(e) {
  return (e?.registration_number || e?.register_number ? 20 : 0) +
    (e?.player_name || e?.racer_name ? 10 : 0) +
    (e?.exhibition_time != null ? 8 : 0) +
    (e?.national_win_rate != null ? 4 : 0) +
    (e?.section_points != null || e?.section_finishes ? 2 : 0);
}

function dedupeEntries(entries) {
  const byBoat = new Map();
  for (const entry of entries || []) {
    const boat = Number(entry.boat_number);
    if (!Number.isFinite(boat) || boat < 1 || boat > 6) continue;
    const current = byBoat.get(boat);
    if (!current || entryCompleteness(entry) > entryCompleteness(current) ||
        (entryCompleteness(entry) === entryCompleteness(current) &&
         String(entry.updated_date || "") > String(current.updated_date || ""))) {
      byBoat.set(boat, entry);
    }
  }
  return [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
}

// レース詳細。race_idに紐づく行が欠けている場合は共通race_keyから6艇を復元する。
export async function getRaceEntries(raceId, raceKey = null) {
  const byId = await withRetry(() => base44.entities.RaceEntry.filter({ race_id: raceId }, "boat_number", 50));
  const uniqueById = dedupeEntries(byId);
  if (uniqueById.length >= 6 || !raceKey) return uniqueById;
  const byKey = await withRetry(() => base44.entities.RaceEntry.filter({ race_key: raceKey }, "-updated_date", 100));
  return dedupeEntries([...(byId || []), ...(byKey || [])]);
}

// 既存予想取得(race_id+stage+versionで1件)
export async function getPrediction(raceId, stage) {
  const list = await withRetry(() => base44.entities.RacePrediction.filter({
    race_id: raceId, stage, prediction_version: VERSION,
  }, "-computed_at", 1));
  return list && list[0];
}

export async function getBoatPredictions(predictionId) {
  return await withRetry(() => base44.entities.BoatPrediction.filter({ prediction_id: predictionId }, "boat_number", 6));
}

export async function getTrifectaPredictions(predictionId) {
  return await withRetry(() => base44.entities.TrifectaPrediction.filter({ prediction_id: predictionId }, "rank", 120));
}

// 予想を実行して保存(PRE/FINAL)。重複作成しない。
export async function generateAndSavePrediction(race, entries, settings, stage, oddsMap = {}) {
  const cfg = { ...settings, stage };

  // 選手プロファイル+ローリング統計を取得してエントリに付与
  const profiles = await base44.entities.RacerPerformanceProfile.list('-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map(p => [p.registration_number, p]));
  const rolling = await base44.entities.RacerRollingStats.list('-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map(r => [r.registration_number, r]));
  const laneRecent = await base44.entities.RacerLaneRecentStats.list('-updated_at', 5000).catch(() => []);
  const laneRecentByKey = new Map(laneRecent.map(x => [`${String(x.registration_number)}_${Number(x.lane)}`, x]));
  const entriesWithProfiles = entries.map(e => {
    const reg = String(e.registration_number || e.register_number || '').trim();
    return {
      ...e,
      _profile: reg ? profileByReg.get(reg) || null : null,
      _rollingStats: reg ? rollingByReg.get(reg) || null : null,
      _laneRecent: reg ? laneRecentByKey.get(`${reg}_${Number(e.boat_number)}`) || null : null,
    };
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
    lane_recent_score: s.lane_recent_score,
    lane_recent_win_rate: s.lane_recent_win_rate,
    lane_recent_avg_st: s.lane_recent_avg_st,
    lane_recent_avg_start_order: s.lane_recent_avg_start_order,
    lane_recent_sample_count: s.lane_recent_sample_count,
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
        factors: s.factor_scores || null,
        recent_form_score: s.recent_form_score,
        st_trend_score: s.st_trend_score,
        class_trend_score: s.class_trend_score,
        performance_trend: s.performance_trend,
        racer_power_score: s.racer_power_score,
        lane_recent_score: s.lane_recent_score,
        lane_recent_win_rate: s.lane_recent_win_rate,
        lane_recent_avg_st: s.lane_recent_avg_st,
        lane_recent_avg_start_order: s.lane_recent_avg_start_order,
        lane_recent_sample_count: s.lane_recent_sample_count,
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

  // 要因分析スナップショット。過去/直近/コース・場/節間/展示/オッズを分離して保存し、
  // 結果確定後に「どの層が効いた/外した」を検証できるようにする。
  try {
    const activeFactorBoats = result.boatScores.filter((s) => !s._absent);
    const avgFactor = (key) => {
      const vals = activeFactorBoats.map((s) => s.factor_scores?.[key]).filter((v) => Number.isFinite(v));
      return vals.length ? Math.round((vals.reduce((a,b) => a+b, 0) / vals.length) * 10) / 10 : 50;
    };
    const selectedOdds = (result.selected_trifectas || []).map((c) => oddsMap?.[c]).filter((v) => Number.isFinite(v));
    const oddsScore = selectedOdds.length
      ? Math.round(Math.min(100, Math.max(0, selectedOdds.reduce((a,b) => a+b,0) / selectedOdds.length * 2)) * 10) / 10
      : 50;
    const factorDoc = {
      race_id: race.id,
      race_key: race.race_key,
      prediction_id: pid,
      stage,
      final_judgment: result.final_judgment || null,
      selected_trifectas: result.selected_trifectas || [],
      factor_summary: {
        long_term: avgFactor('long_term'),
        mid_term: avgFactor('mid_term'),
        recent: avgFactor('recent'),
        course_venue: avgFactor('course_venue'),
        section: avgFactor('section'),
        exhibition: avgFactor('exhibition'),
        odds: oddsScore,
        confidence: result.data_confidence || 0,
      },
      boat_factors: activeFactorBoats.map((s) => ({
        boat: s.boat_number,
        first_power: s.first_power,
        total_power: s.total_power,
        ...(s.factor_scores || {}),
      })),
      created_at: new Date().toISOString(),
    };
    const oldFactors = await base44.entities.PredictionFactorAnalysis.filter({ race_id: race.id, stage }, '-created_at', 1);
    if (oldFactors?.[0]) await base44.entities.PredictionFactorAnalysis.update(oldFactors[0].id, factorDoc);
    else await base44.entities.PredictionFactorAnalysis.create(factorDoc);
  } catch (e) {
    console.warn('PredictionFactorAnalysis save skipped', e);
  }

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

  // 要因分析にも結果を付与して学習ループを閉じる
  try {
    const factors = await base44.entities.PredictionFactorAnalysis.filter({ race_id: raceId }, '-created_at', 10);
    const actualArr = resultTrifecta.split('-').map(Number);
    for (const f of factors || []) {
      const selected = f.selected_trifectas || [];
      const hit = selected.includes(resultTrifecta);
      let missLayer = '';
      if (!hit) {
        const top = fin?.top_trifecta?.split('-').map(Number) || [];
        if (top.length === 3 && actualArr[0] !== top[0]) missLayer = '1着';
        else if (top.length === 3 && actualArr[1] !== top[1]) missLayer = '2着';
        else if (top.length === 3 && actualArr[2] !== top[2]) missLayer = '3着';
        else missLayer = '買い目構成';
      }
      await base44.entities.PredictionFactorAnalysis.update(f.id, {
        actual_result: resultTrifecta,
        hit,
        miss_layer: missLayer,
        resolved_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn('PredictionFactorAnalysis result link skipped', e);
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

// 検証集計: 「BUYしたレースが当たったか」を中心に、次の予想ロジック改善へ繋げる
export async function getVerificationSummary() {
  // レース画面と同じ現行V4 FINALだけを検証対象にする。
  // 旧PredictionVerification(V1)を混ぜると、画面の買い目と検証の買い目が別物になる。
  const raw = await base44.entities.PredictionV4Verification.list("-verified_at", 500);
  const verifs = dedupeVerifications(raw)
    .filter((v) => /^([1-6])-([1-6])-([1-6])$/.test(String(v.actual_result || "")))
    .map((v) => ({
      ...v,
      final_judgment: v.v4_final_judgment,
      recommended_hit: !!v.v4_recommended_hit,
      investment: Number(v.v4_investment || 0),
      payout: Number(v.v4_payout || 0),
      recovery_rate: Number(v.v4_recovery_rate || 0),
      ticket_count: Number(v.v4_ticket_count || 0),
      selected_trifectas: v.v4_selected_trifectas || [],
      pre_prediction: v.v4_pre_prediction || "",
      final_prediction: v.v4_final_prediction || "",
      pre_hit: !!v.v4_pre_hit,
      final_hit: !!v.v4_final_hit,
      miss_reason: v.miss_reason_primary || null,
    }));
  const total = verifs.length;
  if (total === 0) return { total: 0, records: [] };

  const buyRecords = verifs.filter((v) => v.final_judgment === "BUY");
  const buyHits = buyRecords.filter((v) => v.recommended_hit).length;
  const buyInvest = buyRecords.reduce((a, v) => a + (v.investment || 0), 0);
  const buyReturn = buyRecords.filter((v) => v.recommended_hit).reduce((a, v) => a + (v.payout || 0), 0);
  const buyHitRate = buyRecords.length ? Math.round((buyHits / buyRecords.length) * 1000) / 10 : 0;
  const buyRecoveryRate = buyInvest > 0 ? Math.round((buyReturn / buyInvest) * 100) : 0;

  const byTicketCount = (n) => {
    const list = buyRecords.filter((v) => Number(v.ticket_count) === n);
    const hits = list.filter((v) => v.recommended_hit).length;
    const invest = list.reduce((a, v) => a + (v.investment || 0), 0);
    const ret = list.filter((v) => v.recommended_hit).reduce((a, v) => a + (v.payout || 0), 0);
    return {
      count: list.length,
      hits,
      hit_rate: list.length ? Math.round((hits / list.length) * 1000) / 10 : 0,
      recovery_rate: invest > 0 ? Math.round((ret / invest) * 100) : 0,
    };
  };

  const missBreakdown = { first: 0, second: 0, third: 0, other: 0 };
  for (const v of buyRecords.filter((x) => !x.recommended_hit)) {
    const reason = String(v.miss_reason || "");
    if (reason === "FIRST_WRONG" || reason === "INSIDE_UNDERVALUED" || reason === "OUTSIDE_UNDERRATED" || reason === "FIFTY_SIX_OVERVALUED" || reason === "ST_MISREAD") missBreakdown.first += 1;
    else if (reason === "SECOND_WRONG" || reason === "SECOND_CONDITIONAL_ERROR") missBreakdown.second += 1;
    else if (reason === "THIRD_WRONG") missBreakdown.third += 1;
    else missBreakdown.other += 1;
  }

  const [learningSamples, factorRows, profiles, rollingStats] = await Promise.all([
    base44.entities.PredictionLearningSample.list("-created_at", 1000).catch(() => []),
    base44.entities.PredictionFactorAnalysis.list("-created_at", 1000).catch(() => []),
    base44.entities.RacerPerformanceProfile.list("-updated_at", 5000).catch(() => []),
    base44.entities.RacerRollingStats.list("-calculated_at", 5000).catch(() => []),
  ]);
  const v4LearnedRaceIds = new Set((learningSamples || [])
    .filter((s) => s.prediction_version === "v4" && s.stage === "FINAL" && s.actual_result)
    .map((s) => s.race_id));
  const learningLinked = buyRecords.filter((v) => v4LearnedRaceIds.has(v.race_id)).length;
  const v4LearningLinked = learningLinked;
  const v4LearningLinkRate = buyRecords.length ? Math.round((v4LearningLinked / buyRecords.length) * 1000) / 10 : 0;

  // 旧V4レコードはPredictionFactorAnalysis未作成だったため、
  // 保存済みのPredictionLearningSampleから因子を復元して0件表示を解消する。
  const avgField = (rows, key) => {
    const values = (rows || []).map(row => Number(row?.[key])).filter(Number.isFinite);
    return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
  };
  const persistedFactors = (factorRows || []).filter((f) => f.stage === 'FINAL' && f.actual_result && f.factor_summary);
  const persistedRaceIds = new Set(persistedFactors.map(f => f.race_id));
  const derivedFactors = (learningSamples || [])
    .filter(s => s.prediction_version === 'v4' && s.stage === 'FINAL' && s.actual_result &&
      !persistedRaceIds.has(s.race_id) && Array.isArray(s.snapshot?.boat_scores))
    .map(s => {
      const boats = s.snapshot.boat_scores || [];
      const selected = new Set(s.snapshot.selected_trifectas || []);
      const selectedTrifectas = (s.snapshot.trifectas || []).filter(t => selected.has(t.combination));
      const evValues = selectedTrifectas.map(t => Number(t.expected_value)).filter(Number.isFinite);
      const exhibitionValues = boats
        .map(b => Number.isFinite(Number(b.final_score)) && Number.isFinite(Number(b.pre_score))
          ? Math.max(0, Math.min(100, 50 + (Number(b.final_score) - Number(b.pre_score)) * 5))
          : null)
        .filter(Number.isFinite);
      return {
        race_id: s.race_id,
        stage: 'FINAL',
        actual_result: s.actual_result,
        hit: selected.has(s.actual_result),
        factor_summary: {
          long_term: avgField(boats, 'past_score'),
          mid_term: avgField(boats, 'pre_score'),
          recent: avgField(boats, 'recent_score'),
          course_venue: avgField(boats.map(b => ({ value: Number(b.lane_prior) * 100 })), 'value'),
          section: avgField(boats, 'today_score'),
          exhibition: exhibitionValues.length
            ? Math.round((exhibitionValues.reduce((sum, value) => sum + value, 0) / exhibitionValues.length) * 10) / 10
            : null,
          odds: evValues.length
            ? Math.max(0, Math.min(100, Math.round((evValues.reduce((sum, value) => sum + value, 0) / evValues.length) * 10) / 10))
            : null,
          confidence: Number.isFinite(Number(s.snapshot.first_confidence)) ? Number(s.snapshot.first_confidence) : null,
        },
      };
    });
  const resolvedFactors = [...persistedFactors, ...derivedFactors];
  const factorKeys = ['long_term','mid_term','recent','course_venue','section','exhibition','odds','confidence'];
  const factorImpact = factorKeys.map((key) => {
    const hitVals = resolvedFactors.filter((f) => f.hit).map((f) => Number(f.factor_summary?.[key])).filter(Number.isFinite);
    const missVals = resolvedFactors.filter((f) => !f.hit).map((f) => Number(f.factor_summary?.[key])).filter(Number.isFinite);
    const avg = (arr) => arr.length ? Math.round((arr.reduce((a,b) => a+b,0) / arr.length) * 10) / 10 : null;
    const hitAvg = avg(hitVals), missAvg = avg(missVals);
    return {
      key,
      hit_avg: hitAvg,
      miss_avg: missAvg,
      gap: hitAvg != null && missAvg != null ? Math.round((hitAvg - missAvg) * 10) / 10 : null,
      samples: hitVals.length + missVals.length,
    };
  });

  const factorCoverage = {
    resolved: resolvedFactors.length,
    hit: resolvedFactors.filter((f) => f.hit).length,
    miss: resolvedFactors.filter((f) => !f.hit).length,
  };
  const dataCoverage = {
    performance_profiles: (profiles || []).length,
    rolling_stats: (rollingStats || []).length,
    learning_samples: (learningSamples || []).length,
    factor_samples: resolvedFactors.length,
  };

  return {
    total,
    buy_count: buyRecords.length,
    buy_hits: buyHits,
    buy_misses: Math.max(0, buyRecords.length - buyHits),
    buy_hit_rate: buyHitRate,
    buy_recovery_rate: buyRecoveryRate,
    buy_investment: buyInvest,
    buy_return: buyReturn,
    learning_linked: learningLinked,
    learning_link_rate: buyRecords.length ? Math.round((learningLinked / buyRecords.length) * 1000) / 10 : 0,
    v4_learning_linked: v4LearningLinked,
    v4_learning_total: buyRecords.length,
    v4_learning_link_rate: v4LearningLinkRate,
    tickets_6: byTicketCount(6),
    tickets_7: byTicketCount(7),
    tickets_8: byTicketCount(8),
    miss_breakdown: missBreakdown,
    factor_impact: factorImpact,
    factor_coverage: factorCoverage,
    data_coverage: dataCoverage,
    records: buyRecords,
  };
}

// ============================================================
// V4予想取得・UIマッピング
// PredictionV4エンティティからV4予想を取得し、UI表示用にマッピングする
// V4はboat_scores/trifectasを埋め込み配列として保持するため
// BoatPrediction/TrifectaPredictionの個別取得は不要
// ============================================================
export async function getV4Prediction(raceId, stage, raceKey) {
  let list = await withRetry(() => base44.entities.PredictionV4.filter({
    race_id: raceId, stage, prediction_version: "v4",
  }, "-computed_at", 1));
  if ((!list || !list.length) && raceKey) {
    list = await withRetry(() => base44.entities.PredictionV4.filter({
      race_key: raceKey, stage, prediction_version: "v4",
    }, "-computed_at", 1));
  }
  return list && list[0];
}

// V4予想レコードをUI表示用にマッピング
// pred: V4レコード本体(final_judgment, selected_trifectas等を保持)
// boats: boat_scoresをBoatPrediction互換形状へマッピング
// trifectas: trifectas配列をTrifectaPrediction互換形状へマッピング
export function mapV4ToUI(v4Pred, stage) {
  if (!v4Pred) return null;
  const isFinal = stage === "FINAL";
  const scoreField = isFinal ? "final_score" : "pre_score";

  const boats = (v4Pred.boat_scores || []).map(b => ({
    boat_number: b.boat_number,
    total_power: b[scoreField] ?? b.pre_score ?? 0,
    first_power: b.first_score ?? 0,
    second_power: b.second_score ?? 0,
    third_power: b.third_score ?? 0,
    start_power: null,
    motor_power: null,
    exhibition_power: null,
    exhibition_score: null,
    racer_power_score: null,
    recent_form_score: null,
    st_trend_score: null,
    class_trend_score: null,
    ana_potential: null,
    reasons: b.reasons || [],
    notes: b.notes || [],
  }));

  const trifectas = (v4Pred.trifectas || []).map(t => ({
    combination: t.combination,
    rank: t.rank,
    probability: t.race_probability,
    actual_odds: t.actual_odds,
    current_odds: t.actual_odds,
    expected_value: t.expected_value,
    is_selected: t.is_selected,
    ticket_rank: t.ticket_rank,
    set_group: null,
    selection_reason: null,
    judgment: null,
  }));

  return { pred: v4Pred, boats, trifectas };
}

// V6予想取得。V4とは別レコードを読み、画面切替時だけ表示する。
export async function getV6Prediction(raceId, stage, raceKey) {
  let list = await withRetry(() => base44.entities.PredictionV6.filter({
    race_id: raceId, stage, prediction_version: "v6",
  }, "-computed_at", 1)).catch(() => []);
  if ((!list || !list.length) && raceKey) {
    list = await withRetry(() => base44.entities.PredictionV6.filter({
      race_key: raceKey, stage, prediction_version: "v6",
    }, "-computed_at", 1)).catch(() => []);
  }
  return list && list[0];
}

// V6もV4と同じ埋め込み形式なので、共通のUI形状へ変換できる。
export function mapV6ToUI(v6Pred, stage) {
  return mapV4ToUI(v6Pred, stage);
}

// V6はFINAL優先、なければPREを表示する。V4への自動フォールバックはしない。
export async function resolveV6Prediction(raceId, raceKey) {
  const finalV6 = await getV6Prediction(raceId, "FINAL", raceKey);
  if (finalV6 && (finalV6.status === "COMPLETED" || !finalV6.status)) {
    const mapped = mapV6ToUI(finalV6, "FINAL");
    if (mapped) return { stage: "FINAL", ...mapped };
  }

  const preV6 = await getV6Prediction(raceId, "PRE", raceKey);
  if (preV6 && (preV6.status === "COMPLETED" || !preV6.status)) {
    const mapped = mapV6ToUI(preV6, "PRE");
    if (mapped) return { stage: "PRE", ...mapped };
  }

  return { stage: null, pred: null, boats: [], trifectas: [] };
}

// ============================================================
// V4予想生成(単一レース) — UIからの「PRE/FINAL再実行」「更新」で呼ぶ
// バックエンド関数 generateV4PredictionForRace を呼び出す
// ============================================================
export async function generateV4PredictionForRace(raceId, stage, force = false) {
  const res = await base44.functions.invoke("generateV4PredictionForRace", {
    race_id: raceId, stage, force,
  });
  return res?.data || res;
}

// ============================================================
// V4 FINAL自動生成保証
// exhibition_ready=true かつ V4 FINAL未生成 かつ 締切前なら生成
// WAITING_ODDSのFINALがあれば再生成を試行(OD3再取得)
// UIのload時に呼び出し、FINALが自動で揃うようにする
// ============================================================
export async function ensureV4Final(race) {
  if (!race || !race.id) return null;
  if (!race.exhibition_ready) return null;
  if (race.deadline) {
    const deadlineMs = new Date(race.deadline).getTime();
    if (deadlineMs < Date.now()) return null; // 締切後はスキップ
  }
  // V4 FINAL既存確認
  const existing = await getV4Prediction(race.id, "FINAL", race.race_key);
  if (existing && existing.status === "COMPLETED") return existing;
  // WAITING_ODDS or 未生成 → 再生成を試行(OD3再取得)
  try {
    return await generateV4PredictionForRace(race.id, "FINAL", !existing);
  } catch (e) {
    console.warn("[ensureV4Final] generation failed:", e?.message || e);
    return null;
  }
}

// ============================================================
// Current Prediction Resolver
// FINAL優先で予想を1本化して返す。UIの唯一の表示ソース。
// 優先順位:
//   1. PredictionV4 FINAL COMPLETED → FINAL表示
//   2. PredictionV4 FINAL WAITING_ODDS → PRE内容表示 +「FINAL オッズ取得待ち」
//   3. PredictionV4 PRE COMPLETED → PRE表示
//   4. V4予想生成待ち
// Race旧予想をfallbackにしない。
// ============================================================
// ============================================================
// ensurePreOdds — PREレコードのオッズが未付与ならOD3をアタッチ
// 予想ロジックは変更しない。actual_odds/expected_valueのみ付与。
// 同じprediction_idへ保存→再READ→同じIDを返す。
// ============================================================
async function ensurePreOdds(preV4, raceId) {
  if (!preV4) return preV4;
  const trifectas = preV4.trifectas || [];
  const oddsCount = trifectas.filter(t => t.actual_odds != null).length;
  if (oddsCount >= 120) return preV4; // 既にオッズあり

  try {
    const res = await base44.functions.invoke("attachOddsToV4Prediction", {
      prediction_id: preV4.id,
      race_id: raceId,
      stage: "PRE",
    });
    if (res?.ok && res?.prediction_id === preV4.id) {
      // 同じIDで再READ
      const updated = await withRetry(() => base44.entities.PredictionV4.get(preV4.id));
      if (updated) return updated;
    }
  } catch (e) {
    console.warn("[ensurePreOdds] attach failed:", e?.message || e);
  }
  return preV4; // 失敗時はそのまま返す
}

// PRE予想が欠場艇を含む場合は再生成する(欠場検知後の古いPREを表示しない)
async function ensurePreExcludesScratched(raceId, raceKey) {
  const race = await withRetry(() => base44.entities.Race.get(raceId)).catch(() => null);
  if (!race) return null;
  // 結果確定後の後付け変更は禁止
  if (race.status === 'finished') return race;
  const scratchedBoats = race.scratched_boats || [];
  if (!scratchedBoats.length) return race;

  const preV4 = await getV4Prediction(raceId, "PRE", raceKey);
  if (!preV4) return race;

  const selected = preV4.selected_trifectas || [];
  const includesScratched = selected.some(combo => {
    const boats = combo.split("-").map(Number);
    return boats.some(b => scratchedBoats.includes(b));
  });

  if (includesScratched) {
    try {
      await generateV4PredictionForRace(raceId, "PRE", true);
    } catch (e) {
      console.warn("[ensurePreExcludesScratched] regeneration failed:", e?.message || e);
    }
  }

  return race;
}

export async function resolveCurrentPrediction(raceId, raceKey) {
  // 0. PREが欠場艇を含む場合は再生成(欠場検知後の古いPREを表示しない)
  await ensurePreExcludesScratched(raceId, raceKey);

  // 1. V4 FINAL取得
  const finV4 = await getV4Prediction(raceId, "FINAL", raceKey);

  if (finV4) {
    // 1a. FINAL COMPLETED → FINAL表示
    if (finV4.status === "COMPLETED" || !finV4.status) {
      const mapped = mapV4ToUI(finV4, "FINAL");
      if (mapped) return { stage: "FINAL", ...mapped, pendingOdds: false };
    }
    // 1b. FINAL WAITING_ODDS / FINAL_PENDING_ODDS → PRE内容 + バナー
    if (finV4.status === "WAITING_ODDS" || finV4.status === "FINAL_PENDING_ODDS") {
      let preV4 = await getV4Prediction(raceId, "PRE", raceKey);
      if (preV4 && (preV4.status === "COMPLETED" || !preV4.status)) {
        // PREのオッズが未付与ならOD3をアタッチ(同じIDへ保存)
        preV4 = await ensurePreOdds(preV4, raceId);
        const mapped = mapV4ToUI(preV4, "PRE");
        if (mapped) return { stage: "PRE", ...mapped, pendingOdds: true, waitingFinalOdds: true };
      }
      // PREもなければFINAL自体の確率を表示(オッズなし)
      const mappedFin = mapV4ToUI(finV4, "FINAL");
      if (mappedFin) return { stage: "FINAL", ...mappedFin, pendingOdds: true, waitingFinalOdds: true };
    }
  }

  // 2. V4 PRE COMPLETED → PRE表示
  let preV4 = await getV4Prediction(raceId, "PRE", raceKey);
  if (preV4 && (preV4.status === "COMPLETED" || !preV4.status)) {
    // PREのオッズが未付与ならOD3をアタッチ(同じIDへ保存)
    preV4 = await ensurePreOdds(preV4, raceId);
    const mapped = mapV4ToUI(preV4, "PRE");
    if (mapped) return { stage: "PRE", ...mapped };
  }

  // 3. 予想なし
  return { stage: null, pred: null, boats: [], trifectas: [] };
}

// selected_trifectasを第一ソースとして買い目リストを構築
// selected_trifectasが空の場合のみtrifectas.filter(is_selected)にフォールバック
export function buildSelectedTickets(activePred, allTri) {
  const selectedTrifectas = activePred?.selected_trifectas || [];
  if (selectedTrifectas.length > 0) {
    const triMap = new Map((allTri || []).map(t => [t.combination, t]));
    return selectedTrifectas.map((combo, idx) => {
      const tri = triMap.get(combo) || {};
      return {
        combination: combo,
        ticket_rank: tri.ticket_rank || idx + 1,
        is_selected: true,
        actual_odds: tri.actual_odds ?? null,
        current_odds: tri.current_odds ?? null,
        expected_value: tri.expected_value ?? null,
        probability: tri.probability ?? null,
        rank: tri.rank ?? null,
        set_group: tri.set_group ?? null,
        selection_reason: tri.selection_reason ?? null,
        judgment: tri.judgment ?? null,
      };
    });
  }
  return (allTri || []).filter(t => t.is_selected).sort((a, b) => (a.ticket_rank || 99) - (b.ticket_rank || 99));
}

// ============================================================
// V6 PROFIT Candidate検証サマリー
// PredictionV6VerificationからV6予想の成績を集計
// BUY/WATCH/SKIP別・チケット数別・HIT_PROFIT/HIT_LOW_VALUE/MISS分類
// ============================================================
export async function getV6VerificationSummary() {
  const raw = await base44.entities.PredictionV6Verification.list("-verified_at", 1000).catch(() => []);

  // バックテストサマリー取得
  const summaryRecord = (raw || []).find((v) => v.race_id === "BACKTEST_SUMMARY_V6" && v.factor_snapshot);
  const backtestSummary = summaryRecord?.factor_snapshot || null;

  const verifs = (raw || []).filter((v) => /^([1-6])-([1-6])-([1-6])$/.test(String(v.actual_result || "")));
  const total = verifs.length;
  if (total === 0 && !backtestSummary) return { total: 0, backtest_summary: null };

  const buyRecords = verifs.filter((v) => v.v6_final_judgment === "BUY");
  const watchRecords = verifs.filter((v) => v.v6_final_judgment === "WATCH");
  const skipRecords = verifs.filter((v) => v.v6_final_judgment === "SKIP");
  const buyHits = buyRecords.filter((v) => v.v6_recommended_hit).length;
  const buyInvest = buyRecords.reduce((a, v) => a + (v.v6_investment || 0), 0);
  const buyReturn = buyRecords.filter((v) => v.v6_recommended_hit).reduce((a, v) => a + (v.v6_payout || 0), 0);
  const buyHitRate = buyRecords.length ? Math.round((buyHits / buyRecords.length) * 1000) / 10 : 0;
  const buyRecoveryRate = buyInvest > 0 ? Math.round((buyReturn / buyInvest) * 100) : 0;
  const avgTickets = buyRecords.length
    ? Math.round(buyRecords.reduce((a, v) => a + (Number(v.v6_ticket_count) || 6), 0) / buyRecords.length * 10) / 10
    : 0;

  // チケット数別
  const byTicketCount = (n) => {
    const list = buyRecords.filter((v) => Number(v.v6_ticket_count) === n);
    const hits = list.filter((v) => v.v6_recommended_hit).length;
    const invest = list.reduce((a, v) => a + (v.v6_investment || 0), 0);
    const ret = list.filter((v) => v.v6_recommended_hit).reduce((a, v) => a + (v.v6_payout || 0), 0);
    return {
      count: list.length, hits,
      hit_rate: list.length ? Math.round((hits / list.length) * 1000) / 10 : 0,
      recovery_rate: invest > 0 ? Math.round((ret / invest) * 100) : 0,
    };
  };

  // outcome分類
  const outcome = { HIT_PROFIT: 0, HIT_LOW_VALUE: 0, MISS_FIRST: 0, MISS_SECOND: 0, MISS_THIRD: 0, MISS_OTHER: 0 };
  for (const v of buyRecords) {
    const oc = v.outcome_class || "MISS_OTHER";
    if (outcome[oc] != null) outcome[oc]++;
  }

  // 要因接続率
  const factorLinked = buyRecords.filter((v) => v.factor_snapshot && Object.keys(v.factor_snapshot).length > 0).length;
  const factorLinkRate = buyRecords.length ? Math.round((factorLinked / buyRecords.length) * 1000) / 10 : 0;

  return {
    total,
    buy_count: buyRecords.length,
    watch_count: watchRecords.length,
    skip_count: skipRecords.length,
    hit_count: buyHits,
    hit_rate: buyHitRate,
    recovery_rate: buyRecoveryRate,
    total_investment: buyInvest,
    total_return: buyReturn,
    avg_ticket_count: avgTickets,
    tickets_6: byTicketCount(6).count,
    tickets_7: byTicketCount(7).count,
    tickets_8: byTicketCount(8).count,
    tickets_detail: { 6: byTicketCount(6), 7: byTicketCount(7), 8: byTicketCount(8) },
    outcome,
    factor_linked: factorLinked,
    factor_link_rate: factorLinkRate,
    backtest_summary: backtestSummary,
    records: buyRecords.slice(0, 100),
  };
}

// ============================================================
// V1 vs V2 比較検証サマリー
// PredictionV2VerificationからV1/V2並行検証結果を集計
// ============================================================
export async function getV2VerificationSummary() {
  const raw = await base44.entities.PredictionV2Verification.list("-verified_at", 500).catch(() => []);
  const verifs = (raw || []).filter((v) => /^([1-6])-([1-6])-([1-6])$/.test(String(v.actual_result || "")));
  const total = verifs.length;
  if (total === 0) return { total: 0, v1: {}, v2: {}, comparison: {}, records: [] };

  // V1集計
  const v1Buy = verifs.filter((v) => v.v1_final_judgment === "BUY");
  const v1Hits = v1Buy.filter((v) => v.v1_recommended_hit).length;
  const v1Invest = v1Buy.reduce((a, v) => a + (v.v1_investment || 0), 0);
  const v1Return = v1Buy.filter((v) => v.v1_recommended_hit).reduce((a, v) => a + (v.v1_payout || 0), 0);
  const v1HitRate = v1Buy.length ? Math.round((v1Hits / v1Buy.length) * 1000) / 10 : 0;
  const v1Recovery = v1Invest > 0 ? Math.round((v1Return / v1Invest) * 100) : 0;

  // V2集計
  const v2Buy = verifs.filter((v) => v.v2_final_judgment === "BUY");
  const v2Hits = v2Buy.filter((v) => v.v2_recommended_hit).length;
  const v2Invest = v2Buy.reduce((a, v) => a + (v.v2_investment || 0), 0);
  const v2Return = v2Buy.filter((v) => v.v2_recommended_hit).reduce((a, v) => a + (v.v2_payout || 0), 0);
  const v2HitRate = v2Buy.length ? Math.round((v2Hits / v2Buy.length) * 1000) / 10 : 0;
  const v2Recovery = v2Invest > 0 ? Math.round((v2Return / v2Invest) * 100) : 0;

  // チケット数別集計
  const byTicketCount = (verifs, prefix, n) => {
    const list = verifs.filter((v) => v[`${prefix}_final_judgment`] === "BUY" && Number(v[`${prefix}_ticket_count`]) === n);
    const hits = list.filter((v) => v[`${prefix}_recommended_hit`]).length;
    const invest = list.reduce((a, v) => a + (v[`${prefix}_investment`] || 0), 0);
    const ret = list.filter((v) => v[`${prefix}_recommended_hit`]).reduce((a, v) => a + (v[`${prefix}_payout`] || 0), 0);
    return {
      count: list.length, hits,
      hit_rate: list.length ? Math.round((hits / list.length) * 1000) / 10 : 0,
      recovery_rate: invest > 0 ? Math.round((ret / invest) * 100) : 0,
    };
  };

  // 外れ原因集計(V2)
  const missReasons = {};
  for (const v of v2Buy.filter((x) => !x.v2_recommended_hit)) {
    const reason = v.miss_reason_primary || "other";
    missReasons[reason] = (missReasons[reason] || 0) + 1;
  }

  return {
    total,
    v1: {
      buy_count: v1Buy.length, buy_hits: v1Hits, buy_hit_rate: v1HitRate,
      buy_recovery_rate: v1Recovery, buy_investment: v1Invest, buy_return: v1Return,
      tickets_6: byTicketCount(verifs, "v1", 6),
      tickets_7: byTicketCount(verifs, "v1", 7),
      tickets_8: byTicketCount(verifs, "v1", 8),
    },
    v2: {
      buy_count: v2Buy.length, buy_hits: v2Hits, buy_hit_rate: v2HitRate,
      buy_recovery_rate: v2Recovery, buy_investment: v2Invest, buy_return: v2Return,
      tickets_6: byTicketCount(verifs, "v2", 6),
      tickets_7: byTicketCount(verifs, "v2", 7),
      tickets_8: byTicketCount(verifs, "v2", 8),
      miss_reasons: missReasons,
    },
    comparison: {
      hit_rate_diff: Math.round((v2HitRate - v1HitRate) * 10) / 10,
      recovery_rate_diff: Math.round((v2Recovery - v1Recovery) * 10) / 10,
      buy_count_diff: v2Buy.length - v1Buy.length,
    },
    records: verifs.slice(0, 100),
  };
}