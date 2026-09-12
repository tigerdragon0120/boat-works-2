// ============================================================
// Prediction Service V2 (サーバー側)
// V2予想をDBへ保存。V1(predictionService.js)とは完全独立。
// V1の処理に影響を与えない。エラー時はV2のみスキップ。
// ============================================================
import { runPredictionV2 } from "./predictionEngineV2.js";

const V2_VERSION = "v2";

// 既存V2予想取得(重複作成防止)
async function getOrCreateV2Prediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.PredictionV2.filter(
    { race_id: raceId, stage, prediction_version: V2_VERSION },
    "-computed_at", 1
  ).catch(() => []);
  if (list && list[0]) return { id: list[0].id, existing: list[0] };
  const created = await client.asServiceRole.entities.PredictionV2.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: V2_VERSION, status: "PENDING",
  }).catch(() => null);
  return { id: created?.id, existing: null };
}

// V2予想を実行して保存
export async function runAndSavePredictionV2(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
  try {
    const sr = client.asServiceRole.entities;

    // プロファイル・ローリング統計補完(渡されていない場合)
    if (!profileByReg) {
      const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
      profileByReg = new Map(profiles.map(p => [p.registration_number, p]));
    }
    if (!rollingByReg) {
      const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
      rollingByReg = new Map(rolling.map(r => [r.registration_number, r]));
    }

    // RacerLaneRecentStats取得(WAKU10データ)
    const laneRecentRows = await sr.RacerLaneRecentStats.filter(
      { race_id: race.id }, '-updated_at', 5000
    ).catch(() => []);
    const laneRecentByKey = new Map();
    for (const x of laneRecentRows || []) {
      const key = `${String(x.registration_number)}_${Number(x.lane)}`;
      if (!laneRecentByKey.has(key)) laneRecentByKey.set(key, x);
    }

    // エントリにプロファイル等を付与(V1と同じ構造)
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

    // V2予想実行
    const result = runPredictionV2(entriesWithProfiles, race, settings, {
      stage, oddsMap,
    });

    // V2予想レコード保存
    const { id: predictionId, existing } = await getOrCreateV2Prediction(client, race.id, race.race_key, stage);
    if (!predictionId) {
      console.error("[V2] Failed to create prediction record");
      return { skipped: true, reason: "CREATE_FAILED" };
    }

    const record = {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: V2_VERSION,
      computed_at: new Date().toISOString(),
      data_confidence: result.data_confidence,
      final_judgment: result.final_judgment,
      judgment_reason: result.judgment_reason,
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
      boat_scores: result.boatScores.map(b => ({
        boat_number: b.boat_number,
        past_score: b.past_score,
        recent_score: b.recent_score,
        today_score: b.today_score,
        pre_score: b.pre_score,
        final_delta: b.final_delta,
        final_score: b.final_score,
        past_components: b.past_components,
        recent_components: b.recent_components,
        today_components: b.today_components,
        relative_ranks: b.relative_ranks,
        reasons: b.reasons, notes: b.notes,
      })),
      trifectas: result.trifectas.map(t => ({
        combination: t.combination, rank: t.rank, probability: t.probability,
        actual_odds: t.actual_odds, expected_value: t.expected_value,
        is_selected: t.is_selected, ticket_rank: t.ticket_rank,
      })),
      data_sources_used: result.data_sources_used,
      v2_weights: result.v2_weights,
      status: "COMPLETED",
    };

    await sr.PredictionV2.update(predictionId, record).catch(e => {
      console.error("[V2] Failed to save prediction:", e.message);
    });

    return { predictionId, result, skipped: false };
  } catch (e) {
    // V2エラーはV1に影響しない。ログのみ。
    console.error(`[V2] runAndSavePredictionV2 error race=${race?.id} stage=${stage}:`, e.message);
    return { skipped: true, reason: "V2_ERROR", error: e.message };
  }
}

// ============================================================
// V1/V2並行検証(結果確定後)
// V1の検証(PredictionVerification)は既存ロジックで行われる。
// ここではV2検証 + V1/V2比較をPredictionV2Verificationへ保存。
// ============================================================
export async function verifyV2Prediction(client, race, resultData) {
  try {
    const sr = client.asServiceRole.entities;
    const resultTrifecta = resultData.result_trifecta;
    if (!resultTrifecta) return null;

    // V1予想取得
    const v1Pre = await sr.RacePrediction.filter(
      { race_id: race.id, stage: "PRE", prediction_version: "v3" }, "-computed_at", 1
    ).catch(() => []);
    const v1Final = await sr.RacePrediction.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: "v3" }, "-computed_at", 1
    ).catch(() => []);

    // V2予想取得
    const v2Pre = await sr.PredictionV2.filter(
      { race_id: race.id, stage: "PRE", prediction_version: "v2" }, "-computed_at", 1
    ).catch(() => []);
    const v2Final = await sr.PredictionV2.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: "v2" }, "-computed_at", 1
    ).catch(() => []);

    const v1PrePred = v1Pre?.[0];
    const v1FinalPred = v1Final?.[0];
    const v2PrePred = v2Pre?.[0];
    const v2FinalPred = v2Final?.[0];

    // V1的中判定
    const v1PreHit = (v1PrePred?.selected_trifectas || []).includes(resultTrifecta) || v1PrePred?.top_trifecta === resultTrifecta;
    const v1FinalHit = (v1FinalPred?.selected_trifectas || []).includes(resultTrifecta) || v1FinalPred?.top_trifecta === resultTrifecta;

    // V1推奨買い目的中
    let v1RecommendedHit = false, v1Investment = 0;
    if (v1FinalPred) {
      v1RecommendedHit = (v1FinalPred.selected_trifectas || []).includes(resultTrifecta);
      if (v1FinalPred.final_judgment === "BUY") v1Investment = (v1FinalPred.ticket_count || 6) * 100;
    }
    const v1Payout = v1RecommendedHit ? (resultData.payout || 0) : 0;
    const v1Recovery = v1Investment > 0 ? Math.round(v1Payout / v1Investment * 100) : 0;

    // V2的中判定
    const v2PreHit = (v2PrePred?.selected_trifectas || []).includes(resultTrifecta) || v2PrePred?.top_trifecta === resultTrifecta;
    const v2FinalHit = (v2FinalPred?.selected_trifectas || []).includes(resultTrifecta) || v2FinalPred?.top_trifecta === resultTrifecta;

    // V2推奨買い目的中
    let v2RecommendedHit = false, v2Investment = 0;
    if (v2FinalPred) {
      v2RecommendedHit = (v2FinalPred.selected_trifectas || []).includes(resultTrifecta);
      if (v2FinalPred?.final_judgment === "BUY") v2Investment = (v2FinalPred.ticket_count || 6) * 100;
    }
    const v2Payout = v2RecommendedHit ? (resultData.payout || 0) : 0;
    const v2Recovery = v2Investment > 0 ? Math.round(v2Payout / v2Investment * 100) : 0;

    // 外れ原因分類
    const missAnalysis = analyzeMiss(v2FinalPred, resultTrifecta, race);

    // V2 boat_scores抽出(検証用)
    const v2BoatScores = (v2FinalPred?.boat_scores || v2PrePred?.boat_scores || []).map(b => ({
      boat_number: b.boat_number, past_score: b.past_score, recent_score: b.recent_score,
      today_score: b.today_score, pre_score: b.pre_score, final_delta: b.final_delta, final_score: b.final_score,
    }));

    const verifDoc = {
      race_id: race.id, race_key: race.race_key,
      race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number,
      actual_result: resultTrifecta,
      v1_pre_prediction: v1PrePred?.top_trifecta || "",
      v1_final_prediction: v1FinalPred?.top_trifecta || "",
      v1_pre_hit: v1PreHit, v1_final_hit: v1FinalHit, v1_recommended_hit: v1RecommendedHit,
      v1_final_judgment: v1FinalPred?.final_judgment || null,
      v1_ticket_count: v1FinalPred?.ticket_count || null,
      v1_selected_trifectas: v1FinalPred?.selected_trifectas || [],
      v1_payout: v1Payout, v1_investment: v1Investment, v1_recovery_rate: v1Recovery,
      v2_pre_prediction: v2PrePred?.top_trifecta || "",
      v2_final_prediction: v2FinalPred?.top_trifecta || "",
      v2_pre_hit: v2PreHit, v2_final_hit: v2FinalHit, v2_recommended_hit: v2RecommendedHit,
      v2_final_judgment: v2FinalPred?.final_judgment || null,
      v2_ticket_count: v2FinalPred?.ticket_count || null,
      v2_selected_trifectas: v2FinalPred?.selected_trifectas || [],
      v2_payout: v2Payout, v2_investment: v2Investment, v2_recovery_rate: v2Recovery,
      v2_boat_scores: v2BoatScores,
      miss_reason_primary: missAnalysis.primary,
      miss_reason_secondary: missAnalysis.secondary,
      miss_analysis: missAnalysis.details,
      verified_at: new Date().toISOString(),
    };

    // upsert
    const existing = await sr.PredictionV2Verification.filter({ race_id: race.id }, "-verified_at", 1).catch(() => []);
    let saved;
    if (existing?.[0]) saved = await sr.PredictionV2Verification.update(existing[0].id, verifDoc);
    else saved = await sr.PredictionV2Verification.create(verifDoc);

    return saved;
  } catch (e) {
    console.error(`[V2] verifyV2Prediction error race=${race?.id}:`, e.message);
    return null;
  }
}

// ============================================================
// 外れ原因分類
// ============================================================
function analyzeMiss(v2FinalPred, resultTrifecta, race) {
  if (!v2FinalPred) return { primary: "other", secondary: [], details: {} };
  if (!resultTrifecta) return { primary: "other", secondary: [], details: {} };

  // 的中時は全てnull
  const selected = v2FinalPred.selected_trifectas || [];
  if (selected.includes(resultTrifecta)) {
    return { primary: null, secondary: [], details: { hit: true } };
  }

  const resultParts = resultTrifecta.split("-").map(Number);
  const firstRanking = v2FinalPred.first_ranking || [];
  const secondRanking = v2FinalPred.second_ranking || [];
  const thirdRanking = v2FinalPred.third_ranking || [];

  const [actual1st, actual2nd, actual3rd] = resultParts;
  const predicted1st = firstRanking[0];
  const predicted2nd = secondRanking[0];
  const predicted3rd = thirdRanking[0];

  const reasons = [];
  let primary = "other";

  // 1着候補外れ
  if (predicted1st != null && actual1st !== predicted1st) {
    reasons.push("first_miss");
    primary = "first_miss";
  }

  // 2着候補外れ
  if (predicted2nd != null && actual2nd !== predicted2nd) {
    reasons.push("second_miss");
    if (primary === "other") primary = "second_miss";
  }

  // 3着候補外れ
  if (predicted3rd != null && actual3rd !== predicted3rd) {
    reasons.push("third_miss");
    if (primary === "other") primary = "third_miss";
  }

  // 買い目絞り込み外れ
  if (!selected.includes(resultTrifecta) && reasons.length === 0) {
    reasons.push("ticket_narrow");
    if (primary === "other") primary = "ticket_narrow";
  }

  // 進入想定外れ(展示進入と実際の進入が違う可能性)
  const boatScores = v2FinalPred.boat_scores || [];
  const entryChanges = boatScores.filter(b => {
    const exCourse = b.today_components?.exhibition_course;
    return exCourse != null && exCourse !== b.boat_number;
  });
  if (entryChanges.length > 0) {
    reasons.push("entry_mismatch");
  }

  // 展示評価過大/不足
  const topBoat = boatScores.find(b => b.boat_number === predicted1st);
  if (topBoat?.today_score != null) {
    if (topBoat.today_score >= 70 && actual1st !== predicted1st) reasons.push("exhibition_over");
    if (topBoat.today_score <= 30 && actual1st === predicted1st) reasons.push("exhibition_under");
  }

  // WAKU10評価過大/不足
  if (topBoat?.recent_score != null) {
    if (topBoat.recent_score >= 70 && actual1st !== predicted1st) reasons.push("waku10_over");
    if (topBoat.recent_score <= 30 && actual1st === predicted1st) reasons.push("waku10_under");
  }

  // オッズ条件による除外
  if (v2FinalPred.final_judgment === "SKIP" && v2FinalPred.judgment_reason?.includes("オッズ")) {
    reasons.push("odds_exclusion");
  }

  // primaryは最初の重要原因、secondaryは残り
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
    },
  };
}