// ============================================================
// Prediction Service V3 (サーバー側)
// V3 Candidate予想をDBへ保存。V1/V2とは完全独立。
// V1/V2の処理に影響を与えない。エラー時はV3のみスキップ。
// ============================================================
import { runPredictionV3 } from "./predictionEngineV3.js";

const V3_VERSION = "v3";

// 既存V3予想取得(重複作成防止)
async function getOrCreateV3Prediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.PredictionV3.filter(
    { race_id: raceId, stage, prediction_version: V3_VERSION },
    "-computed_at", 1
  ).catch(() => []);
  if (list && list[0]) return { id: list[0].id, existing: list[0] };
  const created = await client.asServiceRole.entities.PredictionV3.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: V3_VERSION, status: "PENDING",
  }).catch(() => null);
  return { id: created?.id, existing: null };
}

// V3予想を実行して保存
export async function runAndSavePredictionV3(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
  try {
    const sr = client.asServiceRole.entities;

    // プロファイル・ローリング統計補完
    if (!profileByReg) {
      const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
      profileByReg = new Map(profiles.map(p => [p.registration_number, p]));
    }
    if (!rollingByReg) {
      const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
      rollingByReg = new Map(rolling.map(r => [r.registration_number, r]));
    }

    // RacerLaneRecentStats取得
    const laneRecentRows = await sr.RacerLaneRecentStats.filter(
      { race_id: race.id }, '-updated_at', 5000
    ).catch(() => []);
    const laneRecentByKey = new Map();
    for (const x of laneRecentRows || []) {
      const key = `${String(x.registration_number)}_${Number(x.lane)}`;
      if (!laneRecentByKey.has(key)) laneRecentByKey.set(key, x);
    }

    const entriesWithProfiles = entries.map(e => {
      const reg = String(e.registration_number || e.register_number || '').trim();
      const laneKey = `${reg}_${Number(e.boat_number)}`;
      return {
        ...e,
        _profile: reg ? profileByReg.get(reg) || null : null,
        _rollingStats: reg ? rollingByReg.get(reg) || null : null,
        _laneRecent: reg ? laneRecentByKey.get(laneKey) || null : null,
      };
    });

    // 確率校正係数取得(直近検証データから算出。未実装時はnull)
    const calibrationFactors = await getCalibrationFactors(client).catch(() => null);

    // V3予想実行
    const result = runPredictionV3(entriesWithProfiles, race, settings, {
      stage, oddsMap, calibrationFactors,
    });

    // V3予想レコード保存
    const { id: predictionId, existing } = await getOrCreateV3Prediction(client, race.id, race.race_key, stage);
    if (!predictionId) {
      console.error("[V3] Failed to create prediction record");
      return { skipped: true, reason: "CREATE_FAILED" };
    }

    const record = {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: V3_VERSION,
      computed_at: new Date().toISOString(),
      data_confidence: result.data_confidence,
      data_completeness: result.data_completeness,
      race_type: result.race_type,
      race_type_reason: result.race_type_reason,
      final_judgment: result.final_judgment,
      judgment_reason: result.judgment_reason,
      buy_conditions: result.buy_conditions,
      ticket_count: result.ticket_count,
      selected_trifectas: result.selected_trifectas,
      set_probability: result.set_metrics?.set_probability,
      set_expected_recovery: result.set_metrics?.set_expected_recovery,
      synthetic_odds: result.set_metrics?.synthetic_odds,
      min_payout: result.set_metrics?.min_payout,
      avg_payout: result.set_metrics?.avg_payout,
      max_payout: result.set_metrics?.max_payout,
      best_ev_ticket: result.set_metrics?.best_ev_ticket,
      honmei_boat: result.honmei_boat, taiko_boat: result.taiko_boat,
      ana_boat: result.ana_boat, keshi_boat: result.keshi_boat,
      top_trifecta: result.top_trifecta, top_probability: result.top_probability,
      top_odds: result.top_odds, top_expected_value: result.top_expected_value,
      first_ranking: result.first_ranking, second_ranking: result.second_ranking,
      third_ranking: result.third_ranking,
      first_probability_gap: result.first_probability_gap,
      first_confidence: result.first_confidence,
      inside_escape_reliability: result.inside_escape_reliability,
      boat_scores: result.boatScores.map(b => ({
        boat_number: b.boat_number,
        past_score: b.past_score, recent_score: b.recent_score, today_score: b.today_score,
        pre_score: b.pre_score, final_delta: b.final_delta, final_score: b.final_score,
        first_score: b.first_score, first_probability: b.first_probability, first_confidence: b.first_confidence,
        second_score: b.second_score, second_probability: b.second_probability,
        third_score: b.third_score, third_probability: b.third_probability,
        attack_power: b.attack_power, inside_escape_score: b.inside_escape_score,
        past_components: b.past_components, recent_components: b.recent_components,
        today_components: b.today_components, relative_ranks: b.relative_ranks,
        reasons: b.reasons, notes: b.notes,
      })),
      trifectas: result.trifectas.map(t => ({
        combination: t.combination, rank: t.rank, race_probability: t.race_probability,
        actual_odds: t.actual_odds, expected_value: t.expected_value,
        is_selected: t.is_selected, ticket_rank: t.ticket_rank,
      })),
      conditional_weights: result.conditional_weights,
      calibration_applied: result.calibration_applied,
      data_sources_used: result.data_sources_used,
      v3_weights: result.v3_weights,
      status: "COMPLETED",
    };

    await sr.PredictionV3.update(predictionId, record).catch(e => {
      console.error("[V3] Failed to save prediction:", e.message);
    });

    return { predictionId, result, skipped: false };
  } catch (e) {
    console.error(`[V3] runAndSavePredictionV3 error race=${race?.id} stage=${stage}:`, e.message);
    return { skipped: true, reason: "V3_ERROR", error: e.message };
  }
}

// ============================================================
// 確率校正係数取得(直近検証データから算出)
// 予測確率帯ごとに(実際的中率 / 予測平均確率)を計算
// 未実装時はnull(補正なし)
// ============================================================
async function getCalibrationFactors(client) {
  // 直近100件の検証データから算出
  // TODO: PredictionV3Verification蓄積後に実装
  return null;
}

// ============================================================
// V3検証(結果確定後)
// V2検証と同条件で評価。17種の外れ原因 + 勝ちパターン分析。
// ============================================================
export async function verifyV3Prediction(client, race, resultData) {
  try {
    const sr = client.asServiceRole.entities;
    const resultTrifecta = resultData.result_trifecta;
    if (!resultTrifecta) return null;

    // V2予想取得
    const v2Final = await sr.PredictionV2.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: "v2" }, "-computed_at", 1
    ).catch(() => []);
    const v2Pre = await sr.PredictionV2.filter(
      { race_id: race.id, stage: "PRE", prediction_version: "v2" }, "-computed_at", 1
    ).catch(() => []);

    // V3予想取得
    const v3Final = await sr.PredictionV3.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: "v3" }, "-computed_at", 1
    ).catch(() => []);
    const v3Pre = await sr.PredictionV3.filter(
      { race_id: race.id, stage: "PRE", prediction_version: "v3" }, "-computed_at", 1
    ).catch(() => []);

    const v2PrePred = v2Pre?.[0];
    const v2FinalPred = v2Final?.[0];
    const v3PrePred = v3Pre?.[0];
    const v3FinalPred = v3Final?.[0];

    // V2的中判定
    const v2PreHit = (v2PrePred?.selected_trifectas || []).includes(resultTrifecta) || v2PrePred?.top_trifecta === resultTrifecta;
    const v2FinalHit = (v2FinalPred?.selected_trifectas || []).includes(resultTrifecta) || v2FinalPred?.top_trifecta === resultTrifecta;
    let v2RecommendedHit = false, v2Investment = 0;
    if (v2FinalPred) {
      v2RecommendedHit = (v2FinalPred.selected_trifectas || []).includes(resultTrifecta);
      if (v2FinalPred.final_judgment === "BUY") v2Investment = (v2FinalPred.ticket_count || 6) * 100;
    }
    const v2Payout = v2RecommendedHit ? (resultData.payout || 0) : 0;
    const v2Recovery = v2Investment > 0 ? Math.round(v2Payout / v2Investment * 100) : 0;

    // V3的中判定
    const v3PreHit = (v3PrePred?.selected_trifectas || []).includes(resultTrifecta) || v3PrePred?.top_trifecta === resultTrifecta;
    const v3FinalHit = (v3FinalPred?.selected_trifectas || []).includes(resultTrifecta) || v3FinalPred?.top_trifecta === resultTrifecta;
    let v3RecommendedHit = false, v3Investment = 0;
    if (v3FinalPred) {
      v3RecommendedHit = (v3FinalPred.selected_trifectas || []).includes(resultTrifecta);
      if (v3FinalPred.final_judgment === "BUY") v3Investment = (v3FinalPred.ticket_count || 6) * 100;
    }
    const v3Payout = v3RecommendedHit ? (resultData.payout || 0) : 0;
    const v3Recovery = v3Investment > 0 ? Math.round(v3Payout / v3Investment * 100) : 0;

    // 外れ原因分類(17種)
    const missAnalysis = v3FinalPred ? analyzeV3Miss(v3FinalPred, resultTrifecta, race) : { primary: null, secondary: [], details: {} };

    // 勝ちパターン分析
    const winPattern = v3RecommendedHit ? analyzeWinPattern(v3FinalPred, resultTrifecta) : { pattern: null, factors: [] };

    // 予測確率帯
    const topProb = v3FinalPred?.top_probability || v3PrePred?.top_probability || 0;
    const probBand = getProbabilityBand(topProb);

    // V3 boat_scores抽出
    const v3BoatScores = (v3FinalPred?.boat_scores || v3PrePred?.boat_scores || []).map(b => ({
      boat_number: b.boat_number,
      first_score: b.first_score,
      first_probability: b.first_probability,
      final_score: b.final_score,
    }));

    const verifDoc = {
      race_id: race.id, race_key: race.race_key,
      race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number,
      actual_result: resultTrifecta,
      v2_pre_prediction: v2PrePred?.top_trifecta || "",
      v2_final_prediction: v2FinalPred?.top_trifecta || "",
      v2_pre_hit: v2PreHit, v2_final_hit: v2FinalHit, v2_recommended_hit: v2RecommendedHit,
      v2_final_judgment: v2FinalPred?.final_judgment || null,
      v2_ticket_count: v2FinalPred?.ticket_count || null,
      v2_selected_trifectas: v2FinalPred?.selected_trifectas || [],
      v2_payout: v2Payout, v2_investment: v2Investment, v2_recovery_rate: v2Recovery,
      v3_pre_prediction: v3PrePred?.top_trifecta || "",
      v3_final_prediction: v3FinalPred?.top_trifecta || "",
      v3_pre_hit: v3PreHit, v3_final_hit: v3FinalHit, v3_recommended_hit: v3RecommendedHit,
      v3_final_judgment: v3FinalPred?.final_judgment || null,
      v3_ticket_count: v3FinalPred?.ticket_count || null,
      v3_selected_trifectas: v3FinalPred?.selected_trifectas || [],
      v3_payout: v3Payout, v3_investment: v3Investment, v3_recovery_rate: v3Recovery,
      v3_race_type: v3FinalPred?.race_type || v3PrePred?.race_type || null,
      v3_first_probability_gap: v3FinalPred?.first_probability_gap || v3PrePred?.first_probability_gap || null,
      v3_first_confidence: v3FinalPred?.first_confidence || v3PrePred?.first_confidence || null,
      v3_boat_scores: v3BoatScores,
      miss_reason_primary: missAnalysis.primary,
      miss_reason_secondary: missAnalysis.secondary,
      miss_analysis: missAnalysis.details,
      win_pattern: winPattern.pattern,
      win_pattern_factors: winPattern.factors,
      predicted_probability_band: probBand,
      verified_at: new Date().toISOString(),
    };

    // upsert
    const existing = await sr.PredictionV3Verification.filter(
      race.race_key ? { race_key: race.race_key } : { race_id: race.id }, "-verified_at", 1
    ).catch(() => []);
    let saved;
    if (existing?.[0]) saved = await sr.PredictionV3Verification.update(existing[0].id, verifDoc);
    else saved = await sr.PredictionV3Verification.create(verifDoc);

    return saved;
  } catch (e) {
    console.error(`[V3] verifyV3Prediction error race=${race?.id}:`, e.message);
    return null;
  }
}

// ============================================================
// 外れ原因分類(17種)
// ============================================================
function analyzeV3Miss(v3FinalPred, resultTrifecta, race) {
  if (!v3FinalPred || !resultTrifecta) return { primary: "OTHER", secondary: [], details: {} };

  const selected = v3FinalPred.selected_trifectas || [];
  if (selected.includes(resultTrifecta)) {
    return { primary: null, secondary: [], details: { hit: true } };
  }

  const resultParts = resultTrifecta.split("-").map(Number);
  const [actual1st, actual2nd, actual3rd] = resultParts;
  const firstRanking = v3FinalPred.first_ranking || [];
  const secondRanking = v3FinalPred.second_ranking || [];
  const thirdRanking = v3FinalPred.third_ranking || [];
  const predicted1st = firstRanking[0];
  const predicted2nd = secondRanking[0];
  const predicted3rd = thirdRanking[0];

  const reasons = [];
  let primary = "OTHER";

  const boatScores = v3FinalPred.boat_scores || [];
  const topBoat = boatScores.find(b => b.boat_number === predicted1st);
  const actualTopBoat = boatScores.find(b => b.boat_number === actual1st);

  // 1着候補外れ
  if (predicted1st != null && actual1st !== predicted1st) {
    reasons.push("FIRST_WRONG");
    primary = "FIRST_WRONG";
    // 詳細分析
    if (topBoat?.today_score != null && topBoat.today_score >= 70) {
      reasons.push("EXHIBITION_OVERVALUED");
      primary = "EXHIBITION_OVERVALUED";
    }
    if (topBoat?.recent_score != null && topBoat.recent_score >= 70) {
      reasons.push("WAKU10_OVERVALUED");
      if (primary === "FIRST_WRONG") primary = "WAKU10_OVERVALUED";
    }
    // 1号艇過大評価
    if (predicted1st === 1) {
      reasons.push("INSIDE_OVERVALUED");
      if (primary === "FIRST_WRONG") primary = "INSIDE_OVERVALUED";
    }
    // 外枠過小評価(実際の1着が外枠)
    if (actual1st >= 4 && predicted1st <= 2) {
      reasons.push("OUTSIDE_UNDERRATED");
      if (primary === "FIRST_WRONG") primary = "OUTSIDE_UNDERRATED";
    }
    // ST見誤り
    if (topBoat?.today_components?.exhibition_st_score != null && topBoat.today_components.exhibition_st_score >= 70) {
      reasons.push("ST_MISREAD");
      if (primary === "FIRST_WRONG") primary = "ST_MISREAD";
    }
  }

  // 2着候補外れ
  if (predicted2nd != null && actual2nd !== predicted2nd && !reasons.includes("FIRST_WRONG")) {
    reasons.push("SECOND_WRONG");
    if (primary === "OTHER") primary = "SECOND_WRONG";
  }

  // 3着候補外れ
  if (predicted3rd != null && actual3rd !== predicted3rd && !reasons.includes("FIRST_WRONG")) {
    reasons.push("THIRD_WRONG");
    if (primary === "OTHER") primary = "THIRD_WRONG";
  }

  // 買い目絞り込み外れ
  if (!selected.includes(resultTrifecta) && reasons.length === 0) {
    reasons.push("TICKET_NARROW");
    primary = "TICKET_NARROW";
  }

  // 進入想定外れ
  const entryChanges = boatScores.filter(b => {
    const exCourse = b.today_components?.exhibition_course;
    return exCourse != null && exCourse !== b.boat_number;
  });
  if (entryChanges.length > 0) {
    reasons.push("ENTRY_MISMATCH");
    if (primary === "OTHER") primary = "ENTRY_MISMATCH";
  }

  // モーター評価外れ
  if (topBoat?.today_components?.motor != null && topBoat.today_components.motor >= 60 && actual1st !== predicted1st) {
    reasons.push("MOTOR_OVERVALUED");
  }
  if (actualTopBoat?.today_components?.motor != null && actualTopBoat.today_components.motor <= 40 && actual1st === actualTopBoat.boat_number) {
    reasons.push("MOTOR_UNDERVALUED");
  }

  // 展示評価不足
  if (topBoat?.today_score != null && topBoat.today_score <= 30 && actual1st === predicted1st) {
    reasons.push("EXHIBITION_UNDERVALUED");
  }

  // WAKU10評価不足
  if (topBoat?.recent_score != null && topBoat.recent_score <= 30 && actual1st === predicted1st) {
    reasons.push("WAKU10_UNDERVALUED");
  }

  // オッズ除外
  if (v3FinalPred.final_judgment === "SKIP" && v3FinalPred.judgment_reason?.includes("オッズ")) {
    reasons.push("ODDS_FILTER_ERROR");
  }

  // データ不足
  if (v3FinalPred.data_confidence < 30) {
    reasons.push("DATA_MISSING");
    if (primary === "OTHER") primary = "DATA_MISSING";
  }

  const secondary = reasons.filter(r => r !== primary);

  return {
    primary,
    secondary,
    details: {
      predicted_1st: predicted1st, actual_1st: actual1st,
      predicted_2nd: predicted2nd, actual_2nd: actual2nd,
      predicted_3rd: predicted3rd, actual_3rd: actual3rd,
      entry_changes: entryChanges.length,
      top_boat_today_score: topBoat?.today_score,
      top_boat_recent_score: topBoat?.recent_score,
      first_probability_gap: v3FinalPred.first_probability_gap,
      first_confidence: v3FinalPred.first_confidence,
    },
  };
}

// ============================================================
// 勝ちパターン分析
// ============================================================
function analyzeWinPattern(v3FinalPred, resultTrifecta) {
  if (!v3FinalPred || !resultTrifecta) return { pattern: null, factors: [] };

  const factors = [];
  const resultParts = resultTrifecta.split("-").map(Number);
  const [actual1st] = resultParts;
  const boatScores = v3FinalPred.boat_scores || [];
  const topBoat = boatScores.find(b => b.boat_number === actual1st);

  // イン信頼
  if (actual1st === 1 && v3FinalPred.inside_escape_reliability != null && v3FinalPred.inside_escape_reliability >= 60) {
    factors.push("INSIDE_CONFIDENCE");
  }
  // WAKU10シグナル
  if (topBoat?.recent_components?.waku10_win != null && topBoat.recent_components.waku10_win >= 55) {
    factors.push("WAKU10_SIGNAL");
  }
  // 展示シグナル
  if (topBoat?.today_score != null && topBoat.today_score >= 65) {
    factors.push("EXHIBITION_SIGNAL");
  }
  // STシグナル
  if (topBoat?.today_components?.exhibition_st_score != null && topBoat.today_components.exhibition_st_score >= 70) {
    factors.push("ST_SIGNAL");
  }
  // モーターシグナル
  if (topBoat?.today_components?.motor != null && topBoat.today_components.motor >= 60) {
    factors.push("MOTOR_SIGNAL");
  }
  // 進入シグナル
  if (topBoat?.today_components?.entry_adjust != null && topBoat.today_components.entry_adjust > 0) {
    factors.push("ENTRY_SIGNAL");
  }
  // バリューオッズ
  const topOdds = v3FinalPred.top_odds;
  if (topOdds != null && topOdds >= 50 && v3FinalPred.final_judgment === "BUY") {
    factors.push("VALUE_ODDS");
  }
  // 複数要因一致
  if (factors.length >= 3) {
    factors.push("MULTI_FACTOR_CONFIRMATION");
  }

  const pattern = factors[0] || "MULTI_FACTOR_CONFIRMATION";
  return { pattern, factors };
}

function getProbabilityBand(prob) {
  if (prob == null) return null;
  if (prob < 5) return "0-5";
  if (prob < 10) return "5-10";
  if (prob < 15) return "10-15";
  if (prob < 20) return "15-20";
  if (prob < 30) return "20-30";
  return "30+";
}