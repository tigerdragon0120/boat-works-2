// ============================================================
// Prediction Service V4 (サーバー側)
// V4 HIT Candidate予想をDBへ保存。V1/V2/V3とは完全独立。
// ============================================================
import { runPredictionV4 } from "./predictionEngineV4.js";
import { resolveProductionOdds, getActiveBoatCount, getExpectedOddsCount } from "./oddsResolver.js";

const V4_VERSION = "v4";

const averageScore = (rows, key) => {
  const values = (rows || []).map(row => Number(row?.[key])).filter(Number.isFinite);
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
};

function buildV4FactorSummary(record) {
  const boats = record?.boat_scores || [];
  const selected = (record?.trifectas || []).filter(t => t.is_selected);
  const evValues = selected.map(t => Number(t.expected_value)).filter(Number.isFinite);
  const avgEv = evValues.length
    ? Math.round((evValues.reduce((sum, value) => sum + value, 0) / evValues.length) * 10) / 10
    : null;
  const exhibitionValues = boats
    .map(b => Number.isFinite(Number(b.final_score)) && Number.isFinite(Number(b.pre_score))
      ? Math.max(0, Math.min(100, 50 + (Number(b.final_score) - Number(b.pre_score)) * 5))
      : null)
    .filter(Number.isFinite);

  return {
    long_term: averageScore(boats, "past_score"),
    mid_term: averageScore(boats, "pre_score"),
    recent: averageScore(boats, "recent_score"),
    course_venue: averageScore(boats.map(b => ({ value: Number(b.lane_prior) * 100 })), "value"),
    section: averageScore(boats, "today_score"),
    exhibition: exhibitionValues.length
      ? Math.round((exhibitionValues.reduce((sum, value) => sum + value, 0) / exhibitionValues.length) * 10) / 10
      : null,
    odds: avgEv == null ? null : Math.max(0, Math.min(100, avgEv)),
    confidence: Number.isFinite(Number(record?.first_confidence)) ? Number(record.first_confidence) : null,
  };
}

async function upsertV4FactorAnalysis(sr, race, predictionId, record) {
  const factorDoc = {
    race_id: race.id,
    race_key: race.race_key,
    prediction_id: predictionId,
    stage: "FINAL",
    final_judgment: record.final_judgment,
    selected_trifectas: record.selected_trifectas || [],
    factor_summary: buildV4FactorSummary(record),
    boat_factors: (record.boat_scores || []).map(b => ({
      boat_number: b.boat_number,
      long_term: b.past_score,
      mid_term: b.pre_score,
      recent: b.recent_score,
      course_venue: Number.isFinite(Number(b.lane_prior)) ? Number(b.lane_prior) * 100 : null,
      section: b.today_score,
      exhibition: Number.isFinite(Number(b.final_score)) && Number.isFinite(Number(b.pre_score))
        ? Math.max(0, Math.min(100, 50 + (Number(b.final_score) - Number(b.pre_score)) * 5))
        : null,
      confidence: b.first_probability,
    })),
    created_at: new Date().toISOString(),
  };
  const existing = await sr.PredictionFactorAnalysis.filter(
    { race_id: race.id, stage: "FINAL" }, "-created_at", 1
  ).catch(() => []);
  if (existing?.[0]) return sr.PredictionFactorAnalysis.update(existing[0].id, factorDoc);
  return sr.PredictionFactorAnalysis.create(factorDoc);
}

// ============================================================
// combination正規化(共通)
// 全角/半角・ハイフン種類・空白を吸収して "1-2-5" 形式へ統一
// ============================================================
function normalizeCombination(combo) {
  if (!combo) return null;
  return String(combo)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .replace(/[\s\u3000]/g, '') // 空白削除
    .replace(/[－‐–—ー]/g, '-') // ハイフン統一
    .trim();
}

// oddsMapのキーを正規化(OD3のcombination形式をV4形式へ統一)
function normalizeOddsMap(oddsMap) {
  if (!oddsMap || typeof oddsMap !== 'object') return {};
  const normalized = {};
  for (const [key, val] of Object.entries(oddsMap)) {
    const norm = normalizeCombination(key);
    if (norm && val != null && val > 0) normalized[norm] = val;
  }
  return normalized;
}

// 既存V4予想取得(重複作成防止)
async function getOrCreateV4Prediction(client, raceId, raceKey, stage) {
  const list = await client.asServiceRole.entities.PredictionV4.filter(
    { race_id: raceId, stage, prediction_version: V4_VERSION },
    "-computed_at", 1
  ).catch(() => []);
  if (list && list[0]) return { id: list[0].id, existing: list[0] };
  const created = await client.asServiceRole.entities.PredictionV4.create({
    race_id: raceId, race_key: raceKey, stage, prediction_version: V4_VERSION, status: "PENDING",
  }).catch(() => null);
  return { id: created?.id, existing: null };
}

// V4予想を実行して保存
export async function runAndSavePredictionV4(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
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

    // ============================================================
    // FINAL時: BOATCAST OD3ライブ取得(既存のoddsResolverを使用)
    // V4 FINAL正式パイプライン:
    //   展示取得 → exhibition_ready確認 → V4純粋確率計算 →
    //   BOATCAST OD3取得 → 120通りへ結合 → actual_odds保存 →
    //   EV計算 → selected_trifectas確定 → set_expected_recovery計算 →
    //   BUY/WATCH/SKIP判定 → 保存 → COMPLETED
    //
    // OD3未取得時は WAITING_ODDS(絶対にCOMPLETEDにしない)。
    // 予想確率・買い目は保持したまま保存(削除しない)。
    // ============================================================
    const expectedOddsCount = getExpectedOddsCount(race);
    let effectiveOddsMap = normalizeOddsMap(oddsMap);
    let oddsSource = null;
    let oddsFetchedAt = null;
    let oddsComboCount = 0;
    let oddsMissing = false;
    let od3Status = "WAITING";
    let od3Debug = {
      od3_requested: false,
      od3_source: null,
      od3_raw_received: false,
      od3_raw_length: 0,
      od3_parse_count: 0,
      od3_valid_count: 0,
      od3_match_count: 0,
      od3_selected_match_count: 0,
      od3_error: null,
      post_save_odds_count: 0,
      post_save_ev_count: 0,
      post_save_selected_with_odds: 0,
      post_save_selected_with_ev: 0,
    };

    if (stage === "FINAL" || stage === "PRE") {
      const deadlineMs = race.deadline ? new Date(race.deadline).getTime() : 0;
      const preDeadline = deadlineMs > 0 && deadlineMs > Date.now();
      od3Debug.od3_requested = preDeadline;

      if (preDeadline) {
        // 締切前: BOATCAST OD3ライブ取得(常に試行)
        try {
          const resolved = await resolveProductionOdds(race, client);
          od3Debug.od3_source = resolved.source || null;
          const rawCount = resolved.odds_map ? Object.keys(resolved.odds_map).length : 0;
          od3Debug.od3_raw_received = rawCount > 0;
          od3Debug.od3_raw_length = rawCount;

          if (resolved.odds_map && rawCount > 0) {
            const normalizedLive = normalizeOddsMap(resolved.odds_map);
            od3Debug.od3_parse_count = rawCount;
            od3Debug.od3_valid_count = Object.keys(normalizedLive).length;
            effectiveOddsMap = { ...effectiveOddsMap, ...normalizedLive };
            od3Status = "FETCHED";
            if (od3Debug.od3_parse_count === expectedOddsCount) od3Status = "PARSED";
            oddsSource = resolved.source;
            oddsFetchedAt = resolved.fetched_at;
            oddsComboCount = Object.keys(effectiveOddsMap).length;
          } else {
            // ライブ取得失敗時: OddsSnapshot fallback
            oddsComboCount = Object.keys(effectiveOddsMap).length;
            if (oddsComboCount > 0) {
              oddsSource = "LOCAL";
            } else {
              oddsMissing = true;
              od3Status = "ERROR";
              od3Debug.od3_error = resolved.source ? 'no valid odds' : 'BOATCAST fetch failed';
            }
          }
        } catch (e) {
          const errMsg = e?.message || String(e);
          console.warn(`[V4] OD3 fetch failed race=${race.race_key}:`, errMsg);
          od3Debug.od3_error = errMsg;
          oddsComboCount = Object.keys(effectiveOddsMap).length;
          if (oddsComboCount > 0) {
            oddsSource = "LOCAL";
            od3Status = "FETCHED";
          } else {
            oddsMissing = true;
            od3Status = "ERROR";
          }
        }
      } else {
        // 締切後: 引数のoddsMap(OddsSnapshot)のみ使用
        oddsComboCount = Object.keys(effectiveOddsMap).length;
        if (oddsComboCount === 0) {
          oddsMissing = true;
          od3Status = "ERROR";
          od3Debug.od3_error = 'past deadline, no OddsSnapshot';
        }
        oddsSource = effectiveOddsMap && oddsComboCount > 0 ? "LOCAL" : null;
        od3Debug.od3_source = oddsSource;
      }
    }

    // PREの場合、OD3未取得はERRORにしない(表示用のみ)
    if (stage === "PRE" && (od3Status === "ERROR" || od3Status === "WAITING")) {
      od3Status = null;
      oddsMissing = false;
    }

    // V4予想実行(純粋確率計算 — オッズはEV/Judgeのみに使用)
    const result = runPredictionV4(entriesWithProfiles, race, settings, {
      stage, oddsMap: effectiveOddsMap,
    });

    // OD3 combination一致カウント
    od3Debug.od3_match_count = (result.trifectas || []).filter(t => t.actual_odds != null).length;
    if (stage === "FINAL" && od3Debug.od3_match_count === expectedOddsCount) od3Status = "MATCHED";
    const selectedSet = new Set(result.selected_trifectas || []);
    od3Debug.od3_selected_match_count = (result.trifectas || []).filter(t => selectedSet.has(t.combination) && t.actual_odds != null).length;

    // OD3デバッグログ出力
    console.warn(`[V4 FINAL OD3] race_key=${race.race_key}`, JSON.stringify(od3Debug));

    // ============================================================
    // FINAL COMPLETED厳格条件チェック
    // exhibition_ready + selected>=6 + 全selectedにactual_odds +
    // 全selectedにexpected_value + set_expected_recovery!=null
    // ============================================================
    let finalStatus = "COMPLETED";
    if (stage === "FINAL") {
      const selectedTris = (result.trifectas || []).filter(t => selectedSet.has(t.combination));
      const allHaveOdds = selectedTris.length > 0 && selectedTris.every(t => t.actual_odds != null);
      const allHaveEv = selectedTris.length > 0 && selectedTris.every(t => t.expected_value != null);
      const hasRecovery = result.set_metrics?.set_expected_recovery != null;
      const selectedOk = (result.selected_trifectas || []).length >= 6;

      if (oddsMissing || !allHaveOdds || !allHaveEv || !hasRecovery || !selectedOk) {
        // OD3未取得 → WAITING_ODDS(絶対にCOMPLETEDにしない)
        // 買い目・確率は保持したまま保存(削除しない)
        finalStatus = "WAITING_ODDS";
        result.final_judgment = null;
        result.judgment_reason = "FINAL オッズ取得待ち — BOATCAST OD3未取得のためBUY/WATCH/SKIP判定不可。オッズ取得後に再実行してください。";
        if (od3Status === "WAITING") od3Status = "ERROR";
      } else {
        od3Status = "VERIFIED";
      }
    }

    // V4予想レコード保存
    const { id: predictionId, existing } = await getOrCreateV4Prediction(client, race.id, race.race_key, stage);
    if (!predictionId) {
      console.error("[V4] Failed to create prediction record");
      return { skipped: true, reason: "CREATE_FAILED" };
    }

    const record = {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: V4_VERSION,
      computed_at: new Date().toISOString(),
      data_confidence: result.data_confidence,
      final_judgment: result.final_judgment,
      judgment_reason: result.judgment_reason,
      ticket_count: result.ticket_count,
      ticket_strategy: result.ticket_strategy,
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
      lane_prior_applied: result.lane_prior_applied,
      fifty_six_suppressed: result.fifty_six_suppressed,
      fifty_six_suppression_reason: result.fifty_six_suppression_reason,
      fifty_six_conditions: result.fifty_six_conditions,
      boat_scores: result.boatScores.map(b => ({
        boat_number: b.boat_number,
        past_score: b.past_score, recent_score: b.recent_score, today_score: b.today_score,
        pre_score: b.pre_score, final_score: b.final_score,
        first_score: b.first_score, first_probability: b.first_probability,
        first_probability_raw: b.first_probability_raw,
        second_score: b.second_score, third_score: b.third_score,
        lane_prior: b.lane_prior, suppression_applied: b.suppression_applied,
        st_overvaluation_fix: b.st_overvaluation_fix,
        reasons: b.reasons, notes: b.notes,
      })),
      trifectas: result.trifectas.map(t => ({
        combination: t.combination, rank: t.rank, race_probability: t.probability,
        actual_odds: t.actual_odds, expected_value: t.expected_value,
        is_selected: t.is_selected, ticket_rank: t.ticket_rank,
      })),
      v4_weights: result.v4_weights,
      odds_source: oddsSource,
      odds_fetched_at: oddsFetchedAt,
      odds_combination_count: oddsComboCount,
      od3_debug: od3Debug,
      od3_status: od3Status,
      status: finalStatus,
    };

    await sr.PredictionV4.update(predictionId, record).catch(e => {
      console.error("[V4] Failed to save prediction:", e.message);
    });

    // V4 FINALの予想時点を学習用に固定保存する。
    // ここは「自動で重みを書き換える」機能ではなく、結果確定後に
    // 予想時点と結果を正しく照合するための immutable snapshot。
    if (stage === "FINAL" && finalStatus === "COMPLETED") {
      try {
        const existingLearning = await sr.PredictionLearningSample.filter(
          { race_id: race.id, stage: "FINAL", prediction_version: V4_VERSION }, "-created_at", 1
        ).catch(() => []);
        if (!existingLearning?.length) {
          await sr.PredictionLearningSample.create({
            race_id: race.id,
            stage: "FINAL",
            prediction_version: V4_VERSION,
            snapshot: {
              prediction_id: predictionId,
              final_judgment: result.final_judgment,
              selected_trifectas: result.selected_trifectas || [],
              ticket_count: result.ticket_count || 0,
              honmei_boat: result.honmei_boat,
              first_probability_gap: result.first_probability_gap,
              first_confidence: result.first_confidence,
              fifty_six_suppressed: result.fifty_six_suppressed || false,
              boat_scores: record.boat_scores,
              trifectas: record.trifectas,
              v4_weights: result.v4_weights,
              weather: {
                weather: race.weather || null,
                wind_dir: race.wind_dir || null,
                wind_speed: race.wind_speed ?? null,
                water_temp: race.water_temp ?? null,
                wave_height: race.wave_height ?? null,
              },
              odds_source: oddsSource,
              odds_fetched_at: oddsFetchedAt,
            },
            created_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn(`[V4] learning snapshot save skipped race=${race.id}:`, e.message);
      }

      // 検証画面の因子分析にも同じFINALスナップショットを保存する。
      try {
        await upsertV4FactorAnalysis(sr, race, predictionId, record);
      } catch (e) {
        console.warn(`[V4] factor snapshot save skipped race=${race.id}:`, e.message);
      }
    }

    // ============================================================
    // POST_SAVE検証 (FINALのみ)
    // DBへ保存後、必ず再READして実際の保存結果を確認。
    // post_save_odds_count=120,
    // post_save_selected_with_odds=ticket_count,
    // post_save_selected_with_ev=ticket_count
    // を満たして初めてREADY。満たさなければERROR+WAITING_ODDS。
    // ============================================================
    if (stage === "FINAL" && od3Status === "VERIFIED") {
      try {
        const reRead = await sr.PredictionV4.get(predictionId).catch(() => null);
        if (reRead) {
          const postSaveTrifectas = reRead.trifectas || [];
          const postSaveOddsCount = postSaveTrifectas.filter(t => t.actual_odds != null).length;
          const postSaveEvCount = postSaveTrifectas.filter(t => t.expected_value != null).length;
          const postSaveSelected = reRead.selected_trifectas || [];
          const postSaveSelectedWithOdds = postSaveSelected.filter(c => {
            const t = postSaveTrifectas.find(x => x.combination === c);
            return t?.actual_odds != null;
          }).length;
          const postSaveSelectedWithEv = postSaveSelected.filter(c => {
            const t = postSaveTrifectas.find(x => x.combination === c);
            return t?.expected_value != null;
          }).length;
          const ticketCount = reRead.ticket_count || postSaveSelected.length || 0;

          od3Debug.post_save_odds_count = postSaveOddsCount;
          od3Debug.post_save_ev_count = postSaveEvCount;
          od3Debug.post_save_selected_with_odds = postSaveSelectedWithOdds;
          od3Debug.post_save_selected_with_ev = postSaveSelectedWithEv;

          const postSaveOk = postSaveOddsCount === expectedOddsCount &&
                             postSaveSelectedWithOdds === ticketCount &&
                             postSaveSelectedWithEv === ticketCount;

          if (postSaveOk) {
            od3Status = "READY";
            await sr.PredictionV4.update(predictionId, {
              od3_status: "READY",
              od3_debug: od3Debug,
            }).catch(e => console.error("[V4] POST_SAVE READY update failed:", e.message));
          } else {
            od3Status = "ERROR";
            finalStatus = "WAITING_ODDS";
            od3Debug.od3_error = `POST_SAVE failed: odds=${postSaveOddsCount}/${expectedOddsCount}, sel_odds=${postSaveSelectedWithOdds}/${ticketCount}, sel_ev=${postSaveSelectedWithEv}/${ticketCount}`;
            await sr.PredictionV4.update(predictionId, {
              od3_status: "ERROR",
              status: "WAITING_ODDS",
              final_judgment: null,
              judgment_reason: "FINAL オッズ取得待ち — POST_SAVE検証失敗。OD3取得後に再実行してください。",
              od3_debug: od3Debug,
            }).catch(e => console.error("[V4] POST_SAVE ERROR update failed:", e.message));
            result.final_judgment = null;
            result.judgment_reason = "FINAL オッズ取得待ち — POST_SAVE検証失敗。";
          }

          console.warn(`[V4 FINAL POST_SAVE] race_key=${race.race_key}`, JSON.stringify({
            post_save_odds_count: postSaveOddsCount,
            post_save_ev_count: postSaveEvCount,
            post_save_selected_with_odds: postSaveSelectedWithOdds,
            post_save_selected_with_ev: postSaveSelectedWithEv,
            ticket_count: ticketCount,
            od3_status: od3Status,
          }));
        }
      } catch (e) {
        console.error(`[V4] POST_SAVE verification error race=${race.race_key}:`, e.message);
        od3Status = "ERROR";
      }
    }

    return { predictionId, result, skipped: false };
  } catch (e) {
    console.error(`[V4] runAndSavePredictionV4 error race=${race?.id} stage=${stage}:`, e.message);
    return { skipped: true, reason: "V4_ERROR", error: e.message };
  }
}

// ============================================================
// ensureOddsAndFinalizeV4 — 全場共通のOD3→V4 FINAL完成関数
// すべてのFINAL生成経路はこの関数を通す。
//
// 戻り値:
//   { ok: true, prediction, skipped: true }  → 既にREADY
//   { ok: true, prediction, skipped: false }  → 再生成成功
//   { ok: false, reason, prediction }         → 再生成不可(展示未公開/締切後)
// ============================================================
export async function ensureOddsAndFinalizeV4(client, raceKey) {
  const sr = client.asServiceRole.entities;

  // Race取得
  const races = await sr.Race.filter({ race_key: raceKey }, '-updated_date', 1).catch(() => []);
  const race = races?.[0];
  if (!race) return { ok: false, reason: 'RACE_NOT_FOUND' };

  // 展示データ確認
  if (!race.exhibition_ready) return { ok: false, reason: 'EXHIBITION_NOT_READY', race };

  // 締切確認
  const deadlineMs = race.deadline ? new Date(race.deadline).getTime() : 0;
  const preDeadline = deadlineMs > 0 && deadlineMs > Date.now();
  if (!preDeadline) return { ok: false, reason: 'PAST_DEADLINE', race };

  // V4 FINAL取得
  const existing = await sr.PredictionV4.filter(
    { race_key: raceKey, stage: 'FINAL', prediction_version: 'v4' }, '-computed_at', 1
  ).catch(() => []);
  const pred = existing?.[0];

  // COMPLETED + od3_status=READY → そのまま返す
  if (pred?.status === 'COMPLETED' && pred?.od3_status === 'READY') {
    return { ok: true, prediction: pred, skipped: true, race };
  }

  // WAITING_ODDS or 未生成 → 再生成必要
  return { ok: false, reason: 'NEEDS_REGENERATION', prediction: pred, race, needs_regeneration: true };
}

// ============================================================
// V4検証(結果確定後)
// ============================================================
export async function verifyV4Prediction(client, race, resultData) {
  try {
    const sr = client.asServiceRole.entities;
    const resultTrifecta = resultData.result_trifecta;
    if (!resultTrifecta) return null;

    const resultParts = resultTrifecta.split("-").map(Number);
    const actualFirst = resultParts[0];

    // V4予想取得(race_id優先、空ならrace_keyでフォールバック)
    let v4Final = await sr.PredictionV4.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: "v4" }, "-computed_at", 1
    ).catch(() => []);
    if (!v4Final?.length && race.race_key) {
      v4Final = await sr.PredictionV4.filter(
        { race_key: race.race_key, stage: "FINAL", prediction_version: "v4" }, "-computed_at", 1
      ).catch(() => []);
    }
    let v4Pre = await sr.PredictionV4.filter(
      { race_id: race.id, stage: "PRE", prediction_version: "v4" }, "-computed_at", 1
    ).catch(() => []);
    if (!v4Pre?.length && race.race_key) {
      v4Pre = await sr.PredictionV4.filter(
        { race_key: race.race_key, stage: "PRE", prediction_version: "v4" }, "-computed_at", 1
      ).catch(() => []);
    }

    const v4PrePred = v4Pre?.[0];
    const v4FinalPred = v4Final?.[0];

    // 的中判定
    const v4PreHit = (v4PrePred?.selected_trifectas || []).includes(resultTrifecta) || v4PrePred?.top_trifecta === resultTrifecta;
    const v4FinalHit = (v4FinalPred?.selected_trifectas || []).includes(resultTrifecta) || v4FinalPred?.top_trifecta === resultTrifecta;
    let v4RecommendedHit = false, v4Investment = 0;
    if (v4FinalPred) {
      v4RecommendedHit = (v4FinalPred.selected_trifectas || []).includes(resultTrifecta);
      if (v4FinalPred.final_judgment === "BUY") v4Investment = (v4FinalPred.ticket_count || 6) * 100;
    }
    const v4Payout = v4RecommendedHit ? (resultData.payout || 0) : 0;
    const v4Recovery = v4Investment > 0 ? Math.round(v4Payout / v4Investment * 100) : 0;

    // 外れ原因分類
    const missAnalysis = v4FinalPred ? analyzeV4Miss(v4FinalPred, resultTrifecta) : { primary: null, secondary: [], details: {} };

    const verifDoc = {
      race_id: race.id, race_key: race.race_key,
      race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number,
      actual_result: resultTrifecta,
      actual_first_boat: actualFirst,
      v4_pre_prediction: v4PrePred?.top_trifecta || "",
      v4_final_prediction: v4FinalPred?.top_trifecta || "",
      v4_pre_hit: v4PreHit, v4_final_hit: v4FinalHit, v4_recommended_hit: v4RecommendedHit,
      v4_final_judgment: v4FinalPred?.final_judgment || null,
      v4_ticket_count: v4FinalPred?.ticket_count || null,
      v4_selected_trifectas: v4FinalPred?.selected_trifectas || [],
      v4_payout: v4Payout, v4_investment: v4Investment, v4_recovery_rate: v4Recovery,
      v4_first_boat: v4FinalPred?.honmei_boat || v4PrePred?.honmei_boat || null,
      v4_fifty_six_honmei: (v4FinalPred?.honmei_boat || v4PrePred?.honmei_boat) >= 5,
      v4_fifty_six_suppressed: v4FinalPred?.fifty_six_suppressed || false,
      miss_reason_primary: missAnalysis.primary,
      miss_reason_secondary: missAnalysis.secondary,
      miss_analysis: missAnalysis.details,
      verified_at: new Date().toISOString(),
    };

    // upsert
    const existing = await sr.PredictionV4Verification.filter({ race_id: race.id }, "-verified_at", 1).catch(() => []);
    let saved;
    if (existing?.[0]) saved = await sr.PredictionV4Verification.update(existing[0].id, verifDoc);
    else saved = await sr.PredictionV4Verification.create(verifDoc);

    // FINAL時点に固定したV4学習サンプルへ確定結果を後追い接続する。
    // snapshot本体は変更せず、actual_result/payoutだけを付与する。
    const learningSamples = await sr.PredictionLearningSample.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: V4_VERSION }, "-created_at", 10
    ).catch(() => []);
    for (const sample of learningSamples || []) {
      await sr.PredictionLearningSample.update(sample.id, {
        actual_result: resultTrifecta,
        payout: resultData.payout || 0,
      }).catch(() => {});
    }

    // 因子スナップショットにも結果を接続し、検証画面で的中/外れ別に集計可能にする。
    const factorRows = await sr.PredictionFactorAnalysis.filter(
      { race_id: race.id, stage: "FINAL" }, "-created_at", 10
    ).catch(() => []);
    const missLayer = v4RecommendedHit ? null
      : missAnalysis.primary === "FIRST_WRONG" ? "1着"
      : missAnalysis.primary === "SECOND_WRONG" || missAnalysis.primary === "SECOND_CONDITIONAL_ERROR" ? "2着"
      : missAnalysis.primary === "THIRD_WRONG" ? "3着"
      : "その他";
    for (const factor of factorRows || []) {
      await sr.PredictionFactorAnalysis.update(factor.id, {
        actual_result: resultTrifecta,
        hit: v4RecommendedHit,
        miss_layer: missLayer,
        resolved_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return saved;
  } catch (e) {
    console.error(`[V4] verifyV4Prediction error race=${race?.id}:`, e.message);
    return null;
  }
}

// ============================================================
// 外れ原因分類
// ============================================================
function analyzeV4Miss(v4FinalPred, resultTrifecta) {
  if (!v4FinalPred || !resultTrifecta) return { primary: "OTHER", secondary: [], details: {} };

  const selected = v4FinalPred.selected_trifectas || [];
  if (selected.includes(resultTrifecta)) {
    return { primary: null, secondary: [], details: { hit: true } };
  }

  const resultParts = resultTrifecta.split("-").map(Number);
  const [actual1st, actual2nd, actual3rd] = resultParts;
  const predicted1st = v4FinalPred.honmei_boat;
  const firstRanking = v4FinalPred.first_ranking || [];
  const secondRanking = v4FinalPred.second_ranking || [];
  const thirdRanking = v4FinalPred.third_ranking || [];
  const predicted2nd = secondRanking[0];
  const predicted3rd = thirdRanking[0];

  const reasons = [];
  let primary = "OTHER";

  // 1着候補外れ
  if (predicted1st != null && actual1st !== predicted1st) {
    reasons.push("FIRST_WRONG");
    primary = "FIRST_WRONG";
    // 5/6号艇過大評価
    if (predicted1st >= 5) {
      reasons.push("FIFTY_SIX_OVERVALUED");
      primary = "FIFTY_SIX_OVERVALUED";
    }
    // ST見誤り
    const boatScores = v4FinalPred.boat_scores || [];
    const topBoat = boatScores.find(b => b.boat_number === predicted1st);
    if (topBoat?.st_overvaluation_fix) {
      reasons.push("ST_MISREAD");
      if (primary === "FIRST_WRONG") primary = "ST_MISREAD";
    }
    // イン過小評価(実際の1着が1号艇)
    if (actual1st === 1 && predicted1st >= 3) {
      reasons.push("INSIDE_UNDERVALUED");
      if (primary === "FIRST_WRONG") primary = "INSIDE_UNDERVALUED";
    }
    // 外枠過小評価
    if (actual1st >= 4 && predicted1st <= 2) {
      reasons.push("OUTSIDE_UNDERRATED");
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

  // データ不足
  if (v4FinalPred.data_confidence < 30) {
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
      fifty_six_suppressed: v4FinalPred.fifty_six_suppressed,
    },
  };
}