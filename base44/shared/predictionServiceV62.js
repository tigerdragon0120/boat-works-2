// ============================================================
// Prediction Service V6.2 (サーバー側)
// V6.2 PROFIT Candidate予想をDBへ保存・検証する。V2〜V6.1とは完全独立。
//
// 保存:
//   - PredictionV6 (prediction_version="v6.2", 予想本体 + factor_snapshot)
//   - PredictionLearningSample (BUY時のみ・予想時点の特徴量)
//
// 検証:
//   - PredictionV62Verification
//   - outcome_class: HIT_PROFIT / HIT_LOW_VALUE / MISS_FIRST / MISS_SECOND / MISS_THIRD
// ============================================================
import { runPredictionV62 } from "./predictionEngineV62.js";

const V62_VERSION = "v6.2";

// 低配当判定: 投資額に対して払戻が小さい場合(HIT_LOW_VALUE)
const LOW_VALUE_RECOVERY_THRESHOLD = 150;

function normalizeCombination(combo) {
  if (!combo) return null;
  return String(combo)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]/g, '')
    .replace(/[－‐–—ー]/g, '-')
    .trim();
}

function normalizeOddsMap(oddsMap) {
  if (!oddsMap || typeof oddsMap !== 'object') return {};
  const normalized = {};
  for (const [key, val] of Object.entries(oddsMap)) {
    const norm = normalizeCombination(key);
    if (norm && val != null && val > 0) normalized[norm] = val;
  }
  return normalized;
}

// 既存V6.2予想取得(重複作成防止)
async function getOrCreateV62Prediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.PredictionV6.filter(
    { race_id: raceId, stage, prediction_version: V62_VERSION },
    "-computed_at", 1
  ).catch(() => []);
  if (list && list[0]) return { id: list[0].id, existing: list[0] };
  const created = await client.asServiceRole.entities.PredictionV6.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: V62_VERSION, status: "PENDING",
  }).catch(() => null);
  return { id: created?.id, existing: null };
}

// ============================================================
// V6.2予想を実行して保存
// ============================================================
export async function runAndSavePredictionV62(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
  try {
    const sr = client.asServiceRole.entities;

    if (!profileByReg) {
      const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
      profileByReg = new Map(profiles.map(p => [p.registration_number, p]));
    }
    if (!rollingByReg) {
      const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
      rollingByReg = new Map(rolling.map(r => [r.registration_number, r]));
    }

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

    const effectiveOddsMap = normalizeOddsMap(oddsMap);

    const result = runPredictionV62(entriesWithProfiles, race, settings, {
      stage, oddsMap: effectiveOddsMap,
    });

    const { id: predictionId } = await getOrCreateV62Prediction(client, race.id, race.race_key, stage);
    if (!predictionId) {
      console.error("[V6.2] Failed to create prediction record");
      return { skipped: true, reason: "CREATE_FAILED" };
    }

    const oddsComboCount = Object.keys(effectiveOddsMap).length;
    const oddsSource = oddsComboCount > 0 ? "LOCAL" : null;

    const record = {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: V62_VERSION,
      computed_at: new Date().toISOString(),
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
      honmei_boat: result.honmei_boat, taiko_boat: result.taiko_boat,
      ana_boat: result.ana_boat, keshi_boat: result.keshi_boat,
      top_trifecta: result.top_trifecta, top_probability: result.top_probability,
      top_odds: result.top_odds, top_expected_value: result.top_expected_value,
      first_ranking: result.first_ranking, second_ranking: result.second_ranking,
      third_ranking: result.third_ranking,
      first_probability_gap: result.first_probability_gap,
      first_confidence: result.first_confidence,
      escape_probability: result.escape_probability,
      winning_scenario: result.winning_scenario,
      scenario_scores: result.scenario_scores,
      boat_scores: result.boatScores,
      trifectas: result.trifectas.map(t => ({
        combination: t.combination, rank: t.rank, race_probability: t.race_probability,
        actual_odds: t.actual_odds, expected_value: t.expected_value,
        is_selected: t.is_selected, ticket_rank: t.ticket_rank,
      })),
      v6_weights: result.v6_weights,
      factor_snapshot: result.factor_snapshot,
      odds_source: oddsSource,
      odds_combination_count: oddsComboCount,
      status: "COMPLETED",
    };

    await sr.PredictionV6.update(predictionId, record).catch(e => {
      console.error("[V6.2] Failed to save prediction:", e.message);
    });

    if (stage === "FINAL" && result.final_judgment === "BUY") {
      try {
        const existingLearning = await sr.PredictionLearningSample.filter(
          { race_id: race.id, stage: "FINAL", prediction_version: V62_VERSION }, "-created_at", 1
        ).catch(() => []);
        if (!existingLearning?.length) {
          await sr.PredictionLearningSample.create({
            race_id: race.id,
            stage: "FINAL",
            prediction_version: V62_VERSION,
            snapshot: {
              prediction_id: predictionId,
              final_judgment: result.final_judgment,
              selected_trifectas: result.selected_trifectas || [],
              ticket_count: result.ticket_count || 0,
              axis_count: result.axis_count,
              axis_boats: result.axis_boats,
              expand_reason: result.expand_reason,
              honmei_boat: result.honmei_boat,
              first_probability_gap: result.first_probability_gap,
              first_confidence: result.first_confidence,
              escape_probability: result.escape_probability,
              winning_scenario: result.winning_scenario,
              scenario_scores: result.scenario_scores,
              boat_scores: record.boat_scores,
              trifectas: record.trifectas,
              factor_snapshot: result.factor_snapshot,
              market_calibration_applied: result.market_calibration_applied,
              set_expected_recovery: result.set_metrics?.set_expected_recovery,
              v6_weights: result.v6_weights,
            },
            created_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn(`[V6.2] learning snapshot save skipped race=${race.id}:`, e.message);
      }
    }

    return { predictionId, result, skipped: false };
  } catch (e) {
    console.error(`[V6.2] runAndSavePredictionV62 error race=${race?.id} stage=${stage}:`, e.message);
    return { skipped: true, reason: "V62_ERROR", error: e.message };
  }
}

// ============================================================
// V6.2検証(結果確定後)
// ============================================================
export async function verifyV62Prediction(client, race, resultData) {
  try {
    const sr = client.asServiceRole.entities;
    const resultTrifecta = resultData.result_trifecta;
    if (!resultTrifecta) return null;

    const resultParts = resultTrifecta.split("-").map(Number);
    const actualFirst = resultParts[0];
    const actualSecond = resultParts[1];
    const actualThird = resultParts[2];

    let v62Final = await sr.PredictionV6.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: V62_VERSION }, "-computed_at", 1
    ).catch(() => []);
    if (!v62Final?.length && race.race_key) {
      v62Final = await sr.PredictionV6.filter(
        { race_key: race.race_key, stage: "FINAL", prediction_version: V62_VERSION }, "-computed_at", 1
      ).catch(() => []);
    }
    let v62Pre = await sr.PredictionV6.filter(
      { race_id: race.id, stage: "PRE", prediction_version: V62_VERSION }, "-computed_at", 1
    ).catch(() => []);
    if (!v62Pre?.length && race.race_key) {
      v62Pre = await sr.PredictionV6.filter(
        { race_key: race.race_key, stage: "PRE", prediction_version: V62_VERSION }, "-computed_at", 1
      ).catch(() => []);
    }

    const v62PrePred = v62Pre?.[0];
    const v62FinalPred = v62Final?.[0];

    const selected = v62FinalPred?.selected_trifectas || [];
    const v62PreHit = (v62PrePred?.selected_trifectas || []).includes(resultTrifecta) || v62PrePred?.top_trifecta === resultTrifecta;
    const v62FinalHit = selected.includes(resultTrifecta) || v62FinalPred?.top_trifecta === resultTrifecta;

    let v62RecommendedHit = false, v62Investment = 0;
    if (v62FinalPred) {
      v62RecommendedHit = selected.includes(resultTrifecta);
      if (v62FinalPred.final_judgment === "BUY") v62Investment = (v62FinalPred.ticket_count || 6) * 100;
    }
    const v62Payout = v62RecommendedHit ? (resultData.payout || 0) : 0;
    const v62Recovery = v62Investment > 0 ? Math.round(v62Payout / v62Investment * 100) : 0;

    // 軸構成(selected_trifectasの1着艇から復元)
    const axisBoats = [...new Set(selected.map(c => Number(String(c).split("-")[0])))].filter(Number.isFinite);
    const axisCount = axisBoats.length || 0;
    const axis2 = axisBoats.length > 1 ? axisBoats[1] : null;

    // 校正前の期待回収率(モデル確率×オッズ)を再計算して保存する
    const triMap = new Map((v62FinalPred?.trifectas || []).map(t => [t.combination, t]));
    const selectedRows = selected.map(c => triMap.get(c)).filter(Boolean);
    const withOdds = selectedRows.filter(t => Number.isFinite(t.actual_odds) && t.actual_odds > 0);
    const modelRecovery = selectedRows.length && withOdds.length === selectedRows.length
      ? Math.round(selectedRows.reduce((s, t) => s + (t.race_probability || 0) * t.actual_odds, 0) / selectedRows.length * 10) / 10
      : null;
    const calibratedRecovery = v62FinalPred?.set_expected_recovery ?? null;

    let outcomeClass = "MISS_OTHER";
    let missPrimary = null;
    const missSecondary = [];

    if (v62RecommendedHit) {
      outcomeClass = v62Recovery >= LOW_VALUE_RECOVERY_THRESHOLD ? "HIT_PROFIT" : "HIT_LOW_VALUE";
    } else if (v62FinalPred) {
      const predicted1st = v62FinalPred.honmei_boat;
      const predicted2nd = v62FinalPred.second_ranking?.[0];
      const predicted3rd = v62FinalPred.third_ranking?.[0];

      if (predicted1st != null && actualFirst !== predicted1st) {
        outcomeClass = "MISS_FIRST";
        missPrimary = "MISS_FIRST";
        missSecondary.push(`1着予想${predicted1st}→実際${actualFirst}`);
        if (predicted1st >= 5) missSecondary.push("OUTER_OVER_VALUED");
        if (actualFirst === 1 && predicted1st >= 3) missSecondary.push("INSIDE_UNDERVALUED");
      } else if (predicted2nd != null && actualSecond !== predicted2nd) {
        outcomeClass = "MISS_SECOND";
        missPrimary = "MISS_SECOND";
        missSecondary.push(`2着予想${predicted2nd}→実際${actualSecond}`);
      } else if (predicted3rd != null && actualThird !== predicted3rd) {
        outcomeClass = "MISS_THIRD";
        missPrimary = "MISS_THIRD";
        missSecondary.push(`3着予想${predicted3rd}→実際${actualThird}`);
      } else {
        outcomeClass = "MISS_OTHER";
        missPrimary = "TICKET_NARROW";
        missSecondary.push("買い目枠外");
      }
    }

    const verifDoc = {
      race_id: race.id, race_key: race.race_key,
      race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number,
      actual_result: resultTrifecta,
      actual_first_boat: actualFirst,
      v62_pre_prediction: v62PrePred?.top_trifecta || "",
      v62_final_prediction: v62FinalPred?.top_trifecta || "",
      v62_pre_hit: v62PreHit, v62_final_hit: v62FinalHit, v62_recommended_hit: v62RecommendedHit,
      v62_final_judgment: v62FinalPred?.final_judgment || null,
      v62_ticket_count: v62FinalPred?.ticket_count || null,
      v62_selected_trifectas: selected,
      v62_payout: v62Payout, v62_investment: v62Investment, v62_recovery_rate: v62Recovery,
      v62_first_boat: v62FinalPred?.honmei_boat || v62PrePred?.honmei_boat || null,
      v62_first_boat_2: axis2,
      v62_axis_count: axisCount,
      v62_escape_probability: v62FinalPred?.escape_probability ?? v62PrePred?.escape_probability ?? null,
      v62_winning_scenario: v62FinalPred?.winning_scenario || v62PrePred?.winning_scenario || null,
      v62_calibrated_recovery: calibratedRecovery,
      v62_model_recovery: modelRecovery,
      outcome_class: outcomeClass,
      miss_reason_primary: missPrimary,
      miss_reason_secondary: missSecondary,
      miss_analysis: {
        predicted_1st: v62FinalPred?.honmei_boat, actual_1st: actualFirst,
        predicted_2nd: v62FinalPred?.second_ranking?.[0], actual_2nd: actualSecond,
        predicted_3rd: v62FinalPred?.third_ranking?.[0], actual_3rd: actualThird,
        axis_boats: axisBoats,
        escape_probability: v62FinalPred?.escape_probability,
        winning_scenario: v62FinalPred?.winning_scenario,
      },
      factor_snapshot: v62FinalPred?.factor_snapshot || v62PrePred?.factor_snapshot || null,
      verified_at: new Date().toISOString(),
    };

    const existing = await sr.PredictionV62Verification.filter(
      race.race_key ? { race_key: race.race_key } : { race_id: race.id }, "-verified_at", 1
    ).catch(() => []);
    let saved;
    if (existing?.[0]) saved = await sr.PredictionV62Verification.update(existing[0].id, verifDoc);
    else saved = await sr.PredictionV62Verification.create(verifDoc);

    const learningSamples = await sr.PredictionLearningSample.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: V62_VERSION }, "-created_at", 10
    ).catch(() => []);
    for (const sample of learningSamples || []) {
      await sr.PredictionLearningSample.update(sample.id, {
        actual_result: resultTrifecta,
        payout: resultData.payout || 0,
      }).catch(() => {});
    }

    return saved;
  } catch (e) {
    console.error(`[V6.2] verifyV62Prediction error race=${race?.id}:`, e.message);
    return null;
  }
}