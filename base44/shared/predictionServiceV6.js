// ============================================================
// Prediction Service V6 (サーバー側)
// V6 PROFIT Candidate予想をDBへ保存・検証。V2〜V5とは完全独立。
//
// 保存:
//   - PredictionV6 (予想本体 + factor_snapshot)
//   - PredictionLearningSample (予想時点の特徴量 + 結果後追い更新)
//
// 検証:
//   - PredictionV6Verification
//   - outcome_class: HIT_PROFIT / HIT_LOW_VALUE / MISS_FIRST / MISS_SECOND / MISS_THIRD
//   - factor_snapshotを予想時点から検証レコードへコピー
// ============================================================
import { runPredictionV6 } from "./predictionEngineV6.js";

const V6_VERSION = "v6";

// 低配当判定: 投資額に対して払戻が小さい場合(HIT_LOW_VALUE)
// 回収率150%未満の的中はLOW_VALUEとする(投資100円×6点=600円 → 払戻900円未満)
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

// 既存V6予想取得(重複作成防止)
async function getOrCreateV6Prediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.PredictionV6.filter(
    { race_id: raceId, stage, prediction_version: V6_VERSION },
    "-computed_at", 1
  ).catch(() => []);
  if (list && list[0]) return { id: list[0].id, existing: list[0] };
  const created = await client.asServiceRole.entities.PredictionV6.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: V6_VERSION, status: "PENDING",
  }).catch(() => null);
  return { id: created?.id, existing: null };
}

// ============================================================
// V6予想を実行して保存
// ============================================================
export async function runAndSavePredictionV6(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
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

    const effectiveOddsMap = normalizeOddsMap(oddsMap);

    // V6予想実行
    const result = runPredictionV6(entriesWithProfiles, race, settings, {
      stage, oddsMap: effectiveOddsMap,
    });

    // V6予想レコード保存
    const { id: predictionId, existing } = await getOrCreateV6Prediction(client, race.id, race.race_key, stage);
    if (!predictionId) {
      console.error("[V6] Failed to create prediction record");
      return { skipped: true, reason: "CREATE_FAILED" };
    }

    const oddsComboCount = Object.keys(effectiveOddsMap).length;
    const oddsSource = oddsComboCount > 0 ? (effectiveOddsMap._source || "LOCAL") : null;

    const record = {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: V6_VERSION,
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
        combination: t.combination, rank: t.rank, race_probability: t.probability,
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
      console.error("[V6] Failed to save prediction:", e.message);
    });

    // ============================================================
    // 学習サンプル保存(FINAL + COMPLETED時)
    // 予想時点の特徴量を固定保存。結果確定後にactual_result/payoutを後追い付与。
    // ============================================================
    if (stage === "FINAL" && result.final_judgment === "BUY") {
      try {
        const existingLearning = await sr.PredictionLearningSample.filter(
          { race_id: race.id, stage: "FINAL", prediction_version: V6_VERSION }, "-created_at", 1
        ).catch(() => []);
        if (!existingLearning?.length) {
          await sr.PredictionLearningSample.create({
            race_id: race.id,
            stage: "FINAL",
            prediction_version: V6_VERSION,
            snapshot: {
              prediction_id: predictionId,
              final_judgment: result.final_judgment,
              selected_trifectas: result.selected_trifectas || [],
              ticket_count: result.ticket_count || 0,
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
              v6_weights: result.v6_weights,
              weather: {
                weather: race.weather || null,
                wind_dir: race.wind_dir || null,
                wind_speed: race.wind_speed ?? null,
                water_temp: race.water_temp ?? null,
                wave_height: race.wave_height ?? null,
              },
              odds_source: oddsSource,
            },
            created_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn(`[V6] learning snapshot save skipped race=${race.id}:`, e.message);
      }
    }

    return { predictionId, result, skipped: false };
  } catch (e) {
    console.error(`[V6] runAndSavePredictionV6 error race=${race?.id} stage=${stage}:`, e.message);
    return { skipped: true, reason: "V6_ERROR", error: e.message };
  }
}

// ============================================================
// V6検証(結果確定後)
// HIT_PROFIT / HIT_LOW_VALUE / MISS_FIRST / MISS_SECOND / MISS_THIRD 分類
// factor_snapshotを予想時点から検証レコードへコピー
// ============================================================
export async function verifyV6Prediction(client, race, resultData) {
  try {
    const sr = client.asServiceRole.entities;
    const resultTrifecta = normalizeCombination(resultData.result_trifecta);
    if (!resultTrifecta) return null;

    const resultParts = resultTrifecta.split("-").map(Number);
    const actualFirst = resultParts[0];
    const actualSecond = resultParts[1];
    const actualThird = resultParts[2];

    // V6予想取得(race_id優先、空ならrace_key)
    let v6Final = await sr.PredictionV6.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: "v6" }, "-computed_at", 1
    ).catch(() => []);
    if (!v6Final?.length && race.race_key) {
      v6Final = await sr.PredictionV6.filter(
        { race_key: race.race_key, stage: "FINAL", prediction_version: "v6" }, "-computed_at", 1
      ).catch(() => []);
    }
    let v6Pre = await sr.PredictionV6.filter(
      { race_id: race.id, stage: "PRE", prediction_version: "v6" }, "-computed_at", 1
    ).catch(() => []);
    if (!v6Pre?.length && race.race_key) {
      v6Pre = await sr.PredictionV6.filter(
        { race_key: race.race_key, stage: "PRE", prediction_version: "v6" }, "-computed_at", 1
      ).catch(() => []);
    }

    const v6PrePred = v6Pre?.[0];
    const v6FinalPred = v6Final?.[0];

    // 的中判定(表記揺れを正規化)
    const preSelected = (v6PrePred?.selected_trifectas || []).map(normalizeCombination).filter(Boolean);
    const finalSelected = (v6FinalPred?.selected_trifectas || []).map(normalizeCombination).filter(Boolean);
    const v6PreHit = preSelected.includes(resultTrifecta) || normalizeCombination(v6PrePred?.top_trifecta) === resultTrifecta;
    const v6FinalHit = finalSelected.includes(resultTrifecta) || normalizeCombination(v6FinalPred?.top_trifecta) === resultTrifecta;
    let v6RecommendedHit = false, v6Investment = 0;
    if (v6FinalPred) {
      v6RecommendedHit = finalSelected.includes(resultTrifecta);
      if (v6FinalPred.final_judgment === "BUY") v6Investment = (v6FinalPred.ticket_count || 6) * 100;
    }
    const v6Payout = v6RecommendedHit ? (resultData.payout || 0) : 0;
    const v6Recovery = v6Investment > 0 ? Math.round(v6Payout / v6Investment * 100) : 0;

    // ============================================================
    // outcome_class分類
    // HIT_PROFIT: 的中かつ回収率150%+
    // HIT_LOW_VALUE: 的中だが回収率150%未満(低配当)
    // MISS_FIRST: 1着予想外れ
    // MISS_SECOND: 1着正解・2着予想外れ
    // MISS_THIRD: 1・2着正解・3着予想外れ
    // MISS_OTHER: その他
    // ============================================================
    let outcomeClass = "MISS_OTHER";
    let missPrimary = null;
    const missSecondary = [];

    const selectedParts = finalSelected
      .map(combo => combo.split("-").map(Number))
      .filter(parts => parts.length === 3 && parts.every(Number.isFinite));
    const predictedFirsts = [...new Set(selectedParts.map(parts => parts[0]))];
    const actualFirstTickets = selectedParts.filter(parts => parts[0] === actualFirst);
    const predictedSeconds = [...new Set(actualFirstTickets.map(parts => parts[1]))];
    const actualFirstSecondTickets = actualFirstTickets.filter(parts => parts[1] === actualSecond);
    const predictedThirds = [...new Set(actualFirstSecondTickets.map(parts => parts[2]))];

    if (v6RecommendedHit) {
      // 的中
      outcomeClass = v6Recovery >= LOW_VALUE_RECOVERY_THRESHOLD ? "HIT_PROFIT" : "HIT_LOW_VALUE";
    } else if (v6FinalPred) {
      // 不的中 — ランキングではなく、実際に選んだ買い目のどの着で外れたかを判定
      if (!predictedFirsts.includes(actualFirst)) {
        outcomeClass = "MISS_FIRST";
        missPrimary = "MISS_FIRST";
        missSecondary.push(`1着買い目[${predictedFirsts.join("・") || "なし"}]→実際${actualFirst}`);
        if (predictedFirsts.some(boat => boat >= 5)) missSecondary.push("FIFTY_SIX_OVERVALUED");
        if (actualFirst === 1 && predictedFirsts.some(boat => boat >= 3)) missSecondary.push("INSIDE_UNDERVALUED");
      } else if (!predictedSeconds.includes(actualSecond)) {
        outcomeClass = "MISS_SECOND";
        missPrimary = "MISS_SECOND";
        missSecondary.push(`2着買い目[${predictedSeconds.join("・") || "なし"}]→実際${actualSecond}`);
      } else if (!predictedThirds.includes(actualThird)) {
        outcomeClass = "MISS_THIRD";
        missPrimary = "MISS_THIRD";
        missSecondary.push(`3着買い目[${predictedThirds.join("・") || "なし"}]→実際${actualThird}`);
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
      v6_pre_prediction: v6PrePred?.top_trifecta || "",
      v6_final_prediction: v6FinalPred?.top_trifecta || "",
      v6_pre_hit: v6PreHit, v6_final_hit: v6FinalHit, v6_recommended_hit: v6RecommendedHit,
      v6_final_judgment: v6FinalPred?.final_judgment || null,
      v6_ticket_count: v6FinalPred?.ticket_count || null,
      v6_selected_trifectas: v6FinalPred?.selected_trifectas || [],
      v6_payout: v6Payout, v6_investment: v6Investment, v6_recovery_rate: v6Recovery,
      v6_first_boat: v6FinalPred?.honmei_boat || v6PrePred?.honmei_boat || null,
      v6_escape_probability: v6FinalPred?.escape_probability ?? v6PrePred?.escape_probability ?? null,
      v6_winning_scenario: v6FinalPred?.winning_scenario || v6PrePred?.winning_scenario || null,
      outcome_class: outcomeClass,
      miss_reason_primary: missPrimary,
      miss_reason_secondary: missSecondary,
      miss_analysis: {
        predicted_1st: predictedFirsts, actual_1st: actualFirst,
        predicted_2nd: predictedSeconds, actual_2nd: actualSecond,
        predicted_3rd: predictedThirds, actual_3rd: actualThird,
        selected_trifectas: finalSelected,
        escape_probability: v6FinalPred?.escape_probability,
        winning_scenario: v6FinalPred?.winning_scenario,
      },
      factor_snapshot: v6FinalPred?.factor_snapshot || v6PrePred?.factor_snapshot || null,
      verified_at: new Date().toISOString(),
    };

    // upsert
    const existing = await sr.PredictionV6Verification.filter(
      race.race_key ? { race_key: race.race_key } : { race_id: race.id }, "-verified_at", 1
    ).catch(() => []);
    let saved;
    if (existing?.[0]) saved = await sr.PredictionV6Verification.update(existing[0].id, verifDoc);
    else saved = await sr.PredictionV6Verification.create(verifDoc);

    // ============================================================
    // 学習サンプルへ結果を後追い付与
    // snapshot本体は変更せず、actual_result/payoutだけ付与
    // ============================================================
    const learningSamples = await sr.PredictionLearningSample.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: V6_VERSION }, "-created_at", 10
    ).catch(() => []);
    for (const sample of learningSamples || []) {
      await sr.PredictionLearningSample.update(sample.id, {
        actual_result: resultTrifecta,
        payout: resultData.payout || 0,
      }).catch(() => {});
    }

    return saved;
  } catch (e) {
    console.error(`[V6] verifyV6Prediction error race=${race?.id}:`, e.message);
    return null;
  }
}