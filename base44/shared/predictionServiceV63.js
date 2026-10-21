// ============================================================
// Prediction Service V6.3 (サーバー側)
// V6.3(統合エンジン)予想をDBへ保存・検証する。
// 保存先はV6系と同じ PredictionV6 に prediction_version="v6.3" として1件。
//
// 保存:
//   - PredictionV6 (v6.3)
// 検証:
//   - PredictionV63Verification
// ============================================================
import { runPredictionV63 } from "./predictionEngineV63.js";

const V63_VERSION = "v6.3";
const LOW_VALUE_RECOVERY_THRESHOLD = 150;

function normalizeCombination(combo) {
  if (!combo) return null;
  return String(combo)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]/g, "")
    .replace(/[－‐–—ー]/g, "-")
    .trim();
}

function normalizeOddsMap(oddsMap) {
  if (!oddsMap || typeof oddsMap !== "object") return {};
  const out = {};
  for (const [key, val] of Object.entries(oddsMap)) {
    const norm = normalizeCombination(key);
    if (norm && val != null && Number(val) > 0) out[norm] = Number(val);
  }
  return out;
}

async function getOrCreateV63Prediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.PredictionV6.filter(
    { race_id: raceId, stage, prediction_version: V63_VERSION }, "-computed_at", 1,
  ).catch(() => []);
  if (list && list[0]) return { id: list[0].id };
  const created = await client.asServiceRole.entities.PredictionV6.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: V63_VERSION, status: "PENDING",
  }).catch(() => null);
  return { id: created?.id };
}

// ============================================================
// V6.3予想を実行して保存
// ============================================================
export async function runAndSavePredictionV63(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
  try {
    const sr = client.asServiceRole.entities;

    if (!profileByReg) {
      const profiles = await sr.RacerPerformanceProfile.filter({}, "-updated_at", 5000).catch(() => []);
      profileByReg = new Map(profiles.map((p) => [p.registration_number, p]));
    }
    if (!rollingByReg) {
      const rolling = await sr.RacerRollingStats.filter({}, "-calculated_at", 5000).catch(() => []);
      rollingByReg = new Map(rolling.map((r) => [r.registration_number, r]));
    }

    const laneRecentRows = await sr.RacerLaneRecentStats.filter({ race_id: race.id }, "-updated_at", 5000).catch(() => []);
    const laneRecentByKey = new Map();
    for (const x of laneRecentRows || []) {
      const key = `${String(x.registration_number)}_${Number(x.lane)}`;
      if (!laneRecentByKey.has(key)) laneRecentByKey.set(key, x);
    }

    const entriesWithProfiles = entries.map((e) => {
      const reg = String(e.registration_number || e.register_number || "").trim();
      return {
        ...e,
        _profile: reg ? profileByReg.get(reg) || null : null,
        _rollingStats: reg ? rollingByReg.get(reg) || null : null,
        _laneRecent: reg ? laneRecentByKey.get(`${reg}_${Number(e.boat_number)}`) || null : null,
      };
    });

    const effectiveOddsMap = normalizeOddsMap(oddsMap);
    const result = runPredictionV63(entriesWithProfiles, race, settings, { stage, oddsMap: effectiveOddsMap });
    if (result?.error) return { skipped: true, reason: result.error };

    const { id: predictionId } = await getOrCreateV63Prediction(client, race.id, race.race_key, stage);
    if (!predictionId) return { skipped: true, reason: "CREATE_FAILED" };

    const oddsComboCount = Object.keys(effectiveOddsMap).length;

    const record = {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: V63_VERSION,
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
      trifectas: result.trifectas,
      v6_weights: result.v6_weights,
      factor_snapshot: result.factor_snapshot,
      odds_source: oddsComboCount > 0 ? "LOCAL" : null,
      odds_combination_count: oddsComboCount,
      status: "COMPLETED",
    };

    await sr.PredictionV6.update(predictionId, record).catch((e) => {
      console.error("[V6.3] Failed to save prediction:", e.message);
    });

    return { predictionId, result, skipped: false };
  } catch (e) {
    console.error(`[V6.3] runAndSavePredictionV63 error race=${race?.id} stage=${stage}:`, e.message);
    return { skipped: true, reason: "V63_ERROR", error: e.message };
  }
}

// ============================================================
// V6.3検証(結果確定後)
// ============================================================
export async function verifyV63Prediction(client, race, resultData) {
  try {
    const sr = client.asServiceRole.entities;
    const resultTrifecta = resultData?.result_trifecta;
    if (!resultTrifecta) return null;

    const [actualFirst, actualSecond, actualThird] = resultTrifecta.split("-").map(Number);

    const findPred = async (stage) => {
      let rows = await sr.PredictionV6.filter(
        { race_id: race.id, stage, prediction_version: V63_VERSION }, "-computed_at", 1,
      ).catch(() => []);
      if (!rows?.length && race.race_key) {
        rows = await sr.PredictionV6.filter(
          { race_key: race.race_key, stage, prediction_version: V63_VERSION }, "-computed_at", 1,
        ).catch(() => []);
      }
      return rows?.[0] || null;
    };
    const [prePred, finalPred] = await Promise.all([findPred("PRE"), findPred("FINAL")]);

    const selected = finalPred?.selected_trifectas || [];
    const recommendedHit = selected.includes(resultTrifecta);
    const preHit = (prePred?.selected_trifectas || []).includes(resultTrifecta) || prePred?.top_trifecta === resultTrifecta;
    const finalHit = recommendedHit || finalPred?.top_trifecta === resultTrifecta;

    const investment = finalPred?.final_judgment === "BUY" ? (finalPred.ticket_count || 6) * 100 : 0;
    const payout = recommendedHit ? (resultData.payout || 0) : 0;
    const recovery = investment > 0 ? Math.round((payout / investment) * 100) : 0;

    const axisBoats = [...new Set(selected.map((c) => Number(String(c).split("-")[0])))].filter(Number.isFinite);
    const selectedParts = selected.map((c) => String(c).split("-").map(Number));

    let outcomeClass = "MISS_OTHER";
    let missPrimary = null;
    const missSecondary = [];

    if (recommendedHit) {
      outcomeClass = recovery >= LOW_VALUE_RECOVERY_THRESHOLD ? "HIT_PROFIT" : "HIT_LOW_VALUE";
    } else if (finalPred) {
      if (!axisBoats.includes(actualFirst)) {
        outcomeClass = "MISS_FIRST";
        missPrimary = "MISS_FIRST";
        missSecondary.push(`1着軸${axisBoats.join("・") || "—"}→実際${actualFirst}`);
        if (axisBoats.some((b) => b >= 5)) missSecondary.push("OUTER_OVER_VALUED");
        if (actualFirst === 1 && axisBoats.some((b) => b >= 3)) missSecondary.push("INSIDE_UNDERVALUED");
      } else if (!selectedParts.some((p) => p[0] === actualFirst && p[1] === actualSecond)) {
        outcomeClass = "MISS_SECOND";
        missPrimary = "MISS_SECOND";
        missSecondary.push(`1着${actualFirst}は軸内・2着${actualSecond}が買い目外`);
      } else {
        outcomeClass = "MISS_THIRD";
        missPrimary = "MISS_THIRD";
        missSecondary.push(`1着${actualFirst}-2着${actualSecond}は買い目内・3着${actualThird}が買い目外`);
      }
    }

    const doc = {
      race_id: race.id, race_key: race.race_key,
      race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number,
      actual_result: resultTrifecta, actual_first_boat: actualFirst,
      v63_pre_prediction: prePred?.top_trifecta || "",
      v63_final_prediction: finalPred?.top_trifecta || "",
      v63_pre_hit: preHit, v63_final_hit: finalHit, v63_recommended_hit: recommendedHit,
      v63_final_judgment: finalPred?.final_judgment || null,
      v63_ticket_count: finalPred?.ticket_count || null,
      v63_ticket_strategy: finalPred?.ticket_strategy || null,
      v63_selected_trifectas: selected,
      v63_payout: payout, v63_investment: investment, v63_recovery_rate: recovery,
      v63_first_boat: finalPred?.honmei_boat || prePred?.honmei_boat || null,
      v63_axis_count: axisBoats.length || null,
      v63_escape_probability: finalPred?.escape_probability ?? prePred?.escape_probability ?? null,
      v63_winning_scenario: finalPred?.winning_scenario || prePred?.winning_scenario || null,
      v63_set_expected_recovery: finalPred?.set_expected_recovery ?? null,
      v63_min_payout: finalPred?.min_payout ?? null,
      outcome_class: outcomeClass,
      miss_reason_primary: missPrimary,
      miss_reason_secondary: missSecondary,
      miss_analysis: {
        predicted_1st: finalPred?.honmei_boat, actual_1st: actualFirst,
        predicted_2nd: finalPred?.second_ranking?.[0], actual_2nd: actualSecond,
        predicted_3rd: finalPred?.third_ranking?.[0], actual_3rd: actualThird,
        axis_boats: axisBoats,
        ticket_strategy: finalPred?.ticket_strategy || null,
        judgment_reason: finalPred?.judgment_reason || null,
      },
      factor_snapshot: finalPred?.factor_snapshot || prePred?.factor_snapshot || null,
      verified_at: new Date().toISOString(),
    };

    const existing = await sr.PredictionV63Verification.filter(
      race.race_key ? { race_key: race.race_key } : { race_id: race.id }, "-verified_at", 1,
    ).catch(() => []);
    if (existing?.[0]) return await sr.PredictionV63Verification.update(existing[0].id, doc);
    return await sr.PredictionV63Verification.create(doc);
  } catch (e) {
    console.error(`[V6.3] verifyV63Prediction error race=${race?.id}:`, e.message);
    return null;
  }
}