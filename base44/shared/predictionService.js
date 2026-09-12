// サーバー側 同期+予想サービス。バックエンド関数から呼ばれる。
// client は createClientFromRequest(req) または asServiceRole。
import { runPrediction, judgeTrifecta } from "./predictionEngine.js";
import { buildRaceKey, parseRaceKey, mapRace, mapEntry, mapResult } from "./raceKey.js";
import { acquireLock, releaseLock, cleanupExpiredLocks } from "./concurrencyLock.js";
import { fetchBoatcastText } from "./boatcastClient.js";
import { normalizeTkz, normalizeStartExhibition, normalizeExhibitionData } from "./boatcastNormalizer.js";
import { mergeExhibition } from "./exhibitionMerger.js";

const VERSION = "v3";

// ============================================================
// BOATCAST直前情報取得(TKZ + STT)
// FINAL予想の前に呼ばれ、LOCAL展示データとマージされる
// 取得失敗時はnullを返し、LOCAL fallbackに任せる
// ============================================================
async function fetchBoatcastExhibition(race) {
  try {
    const venueCode = String(race?.venue_code || '').padStart(2, '0');
    const raceDate = String(race?.race_date || '').replace(/-/g, '');
    const raceNumber = Number(race?.race_number || 0);
    if (!venueCode || !raceDate || !raceNumber) return null;

    const [tkzResult, sttResult] = await Promise.all([
      fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'TKZ' }),
      fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'STT' }),
    ]);

    if (!tkzResult.ok && !sttResult.ok) return null;

    let tkzNormalized = null;
    let sttNormalized = null;
    if (tkzResult.ok) tkzNormalized = normalizeTkz(tkzResult.text, tkzResult.metadata);
    if (sttResult.ok) sttNormalized = normalizeStartExhibition(sttResult.text, sttResult.metadata);

    const metadata = {
      race_date: race.race_date,
      venue_code: venueCode,
      race_number: raceNumber,
      fetched_at: new Date().toISOString(),
    };
    return normalizeExhibitionData(tkzNormalized, sttNormalized, metadata);
  } catch (e) {
    console.error('fetchBoatcastExhibition error:', e.message);
    return null;
  }
}

// 選手×枠番の直近10走集計は予想中に毎Race検索しない。60秒キャッシュで1回だけ読む。
// raceId指定時はそのレース専用キャッシュを返す。未指定時は全件から最新を返す。
const laneRecentCacheMap = new Map();
async function getLaneRecentMap(client, raceId) {
  const now = Date.now();
  const cacheKey = raceId || '__all__';
  const cached = laneRecentCacheMap.get(cacheKey);
  if (cached && now - cached.at < 60000) return cached.map;
  const filter = raceId ? { race_id: raceId } : {};
  const rows = await client.asServiceRole.entities.RacerLaneRecentStats.filter(filter, '-updated_at', 5000).catch(() => []);
  const map = new Map();
  for (const x of rows || []) {
    const key = `${String(x.registration_number)}_${Number(x.lane)}`;
    if (!map.has(key)) map.set(key, x); // 最新(先頭)を優先保持
  }
  laneRecentCacheMap.set(cacheKey, { at: now, map });
  return map;
}

const DEFAULT_SETTINGS = {
  buy_ev_threshold: 150, strong_buy_ev_threshold: 200, watch_ev_threshold: 110,
  min_probability: 5, min_data_count: 5, min_confidence: 40, max_bets: 10,
  weights: { national_win: 1.0, local_win: 1.2, f2_rate: 1.0, f3_rate: 0.8, st: 1.0, motor: 1.1, boat: 0.9, exhibition: 1.3, local_fit: 1.0, section: 1.0 },
};

// 既存レコードを保護しつつマージ: incomingの非null/非空/非NaNだけ上書き。空配列で上書きしない。
function mergeProtect(existing, incoming) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue; // NaNをスキップ
    if (typeof v === "string" && v === "") continue; // 空文字で上書きしない
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

// Raceの完全度スコア(重複整理時に保持候補を決める)
function raceCompleteness(r, entryCount, hasResult) {
  let s = 0;
  if (entryCount >= 6) s += 100;
  else s += entryCount * 10;
  if (r.exhibition_ready) s += 50;
  if (r.weather) s += 5;
  if (r.wind_speed != null) s += 3;
  if (r.wave_height != null) s += 3;
  if (r.deadline) s += 2;
  if (hasResult) s += 20;
  if (r.has_final) s += 15;
  if (r.has_pre) s += 5;
  if (r.prediction_grade) s += 5;
  return s;
}

// race_keyの重複Raceを安全に統合。子レコード(RaceEntry/RaceResult/RacePrediction等)のrace_idを正規Raceへ付け替え、重複を削除。
export async function dedupRace(client, raceKey) {
  const sr = client.asServiceRole.entities;
  const all = await sr.Race.filter({ race_key: raceKey }, "created_date", 50).catch(() => []);
  if (!all || all.length <= 1) return all[0] || null;
  // 子レコード数と結果の有無を集計
  const entryCounts = {};
  const hasResult = {};
  await Promise.all(all.map(async (r) => {
    const es = await sr.RaceEntry.filter({ race_id: r.id }, "boat_number", 10).catch(() => []);
    entryCounts[r.id] = es.length;
    const res = await sr.RaceResult.filter({ race_id: r.id }, "-finished_at", 1).catch(() => []);
    hasResult[r.id] = !!(res && res[0] && res[0].result_trifecta);
  }));
  // 完全度でソート→先頭が勝者(同点なら古いcreated_date優先で安定)
  const sorted = [...all].sort((a, b) => {
    const ca = raceCompleteness(a, entryCounts[a.id] || 0, hasResult[a.id]);
    const cb = raceCompleteness(b, entryCounts[b.id] || 0, hasResult[b.id]);
    if (cb !== ca) return cb - ca;
    return String(a.created_date).localeCompare(String(b.created_date));
  });
  const winner = sorted[0];
  const losers = sorted.slice(1);
  // loserの非nullフィールドをwinnerへ保護マージ(loser側にしか無い展示/天候等を救出)
  let winnerMerged = { ...winner };
  for (const l of losers) winnerMerged = mergeProtect(winnerMerged, l);
  // status後退防止
  if (winner.status === "final" && (winnerMerged.status === "scheduled" || winnerMerged.status === "pre")) winnerMerged.status = "final";
  if (winner.status === "finished") winnerMerged.status = "finished";
  await sr.Race.update(winner.id, winnerMerged);
  // 子レコードのrace_idをloser→winnerへ付け替え
  for (const l of losers) {
    await sr.RaceEntry.updateMany({ race_id: l.id }, { $set: { race_id: winner.id } }).catch(() => {});
    await sr.RaceResult.updateMany({ race_id: l.id }, { $set: { race_id: winner.id } }).catch(() => {});
    await sr.RacePrediction.updateMany({ race_id: l.id }, { $set: { race_id: winner.id } }).catch(() => {});
    await sr.OddsSnapshot.updateMany({ race_id: l.id }, { $set: { race_id: winner.id } }).catch(() => {});
    await sr.PredictionVerification.updateMany({ race_id: l.id }, { $set: { race_id: winner.id } }).catch(() => {});
    await sr.PredictionLearningSample.updateMany({ race_id: l.id }, { $set: { race_id: winner.id } }).catch(() => {});
    await sr.Race.delete(l.id).catch(() => {});
  }
  // winner側のRaceEntry重複(1〜6号艇各1件)も整理
  await dedupEntriesForRace(client, winner.id, raceKey);
  return winner;
}

// 指定RaceのRaceEntryを1〜6号艇各1件に整理(重複は完全度高い方を残し統合)
export async function dedupEntriesForRace(client, raceId, raceKey) {
  const sr = client.asServiceRole.entities;
  const entries = await sr.RaceEntry.filter({ race_id: raceId }, "boat_number", 50).catch(() => []);
  if (!entries || !entries.length) return;
  const byBoat = {};
  for (const e of entries) {
    const k = Number(e.boat_number);
    if (!byBoat[k]) byBoat[k] = [];
    byBoat[k].push(e);
  }
  for (const [boat, list] of Object.entries(byBoat)) {
    if (list.length <= 1) continue;
    // 完全度: 展示/登録番号/勝率/更新時刻
    const sorted = list.sort((a, b) => {
      const ca = (a.exhibition_time != null ? 10 : 0) + (a.registration_number ? 5 : 0) + (a.national_win_rate != null ? 3 : 0);
      const cb = (b.exhibition_time != null ? 10 : 0) + (b.registration_number ? 5 : 0) + (b.national_win_rate != null ? 3 : 0);
      if (cb !== ca) return cb - ca;
      return String(b.updated_date || "").localeCompare(String(a.updated_date || ""));
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);
    let merged = { ...winner };
    for (const l of losers) merged = mergeProtect(merged, l);
    await sr.RaceEntry.update(winner.id, merged).catch(() => {});
    for (const l of losers) await sr.RaceEntry.delete(l.id).catch(() => {});
  }
}

// race_keyでRaceをupsert(保護付き + 作成後デデアップ安全網)
export async function upsertRace(client, raceData) {
  const sr = client.asServiceRole.entities;
  const existing = await sr.Race.filter({ race_key: raceData.race_key }, "-updated_date", 1);
  if (existing && existing[0]) {
    const merged = mergeProtect(existing[0], raceData);
    if (existing[0].status === "final" && (merged.status === "scheduled" || merged.status === "pre")) merged.status = "final";
    if (existing[0].status === "finished") merged.status = "finished";
    return await sr.Race.update(existing[0].id, merged);
  }
  const created = await sr.Race.create(raceData);
  // 通常は作成したRaceをそのまま返す。旧実装では直後のdedupRaceが
  // レート制限等で検索失敗→nullを返し、呼出側でrace.id参照エラーになっていた。
  // 重複整理は既存の整合性ガード/専用処理に任せる。
  return created;
}

// race_key+boat_numberでRaceEntryをupsert(保護付き + 作成後デデアップ安全網)
export async function upsertEntry(client, entryData) {
  const sr = client.asServiceRole.entities;
  const existing = await sr.RaceEntry.filter(
    { race_key: entryData.race_key, boat_number: entryData.boat_number }, "boat_number", 10
  );
  if (existing && existing.length === 1) {
    const merged = mergeProtect(existing[0], entryData);
    // 親Raceは今回race_keyから解決した正規Raceに必ず合わせる。
    // 過去の重複Race整理後も古いrace_idを保持しない。
    merged.race_id = entryData.race_id;
    return await sr.RaceEntry.update(existing[0].id, merged);
  }
  if (existing && existing.length > 1) {
    // 既に重複→整理してからupsert
    await dedupEntriesForRace(client, existing[0].race_id, entryData.race_key);
    const re = await sr.RaceEntry.filter({ race_key: entryData.race_key, boat_number: entryData.boat_number }, "boat_number", 1);
    if (re && re[0]) {
      const merged = mergeProtect(re[0], entryData);
      merged.race_id = entryData.race_id;
      return await sr.RaceEntry.update(re[0].id, merged);
    }
  }
  const created = await sr.RaceEntry.create(entryData);
  // 作成後デデアップ安全網
  await dedupEntriesForRace(client, entryData.race_id, entryData.race_key);
  return created;
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
// profileByRegを外部から渡すことでDB呼び出しを削減(全レース分1回だけ取得)。
export async function runAndSavePrediction(client, race, entries, settings, stage, oddsMap = {}, profileByReg = null, rollingByReg = null) {
  const cfg = { ...settings, stage };
  // プロファイルが渡されていない場合は従来通り個別取得(フォールバック)
  if (!profileByReg) {
    const profiles = await client.asServiceRole.entities.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
    profileByReg = new Map(profiles.map(p => [p.registration_number, p]));
  }
  // ローリング統計が渡されていない場合は個別取得(フォールバック)
  if (!rollingByReg) {
    const rolling = await client.asServiceRole.entities.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
    rollingByReg = new Map(rolling.map(r => [r.registration_number, r]));
  }
  const laneRecentByKey = await getLaneRecentMap(client, race?.id);
  let entriesWithProfiles = entries.map(e => {
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
  // FINAL時: BOATCAST直前情報取得 + LOCAL展示データとマージ
  // 優先順位: 1. BOATCAST  2. LOCAL  3. 欠損
  // 展示READY判定: 有効艇すべてに exhibition_time + exhibition_st + exhibition_course がある
  // PARTIAL/WAITING時はFINAL予想を生成しない
  // ============================================================
  let exhibitionStatus = null;
  if (stage === "FINAL") {
    // 重複防止: 既にFINAL確定済みの場合はNO_OP
    const existingFinal = await client.asServiceRole.entities.RacePrediction.filter(
      { race_id: race.id, stage: "FINAL", prediction_version: VERSION, status: "COMPLETED" }, "-computed_at", 1
    ).catch(() => []);
    if (existingFinal?.[0]) {
      return { predictionId: existingFinal[0].id, result: null, skipped: true, reason: "FINAL_ALREADY_COMPLETED" };
    }

    // BOATCAST直前情報取得
    const boatcastExhibition = await fetchBoatcastExhibition(race);

    // LOCAL展示データとマージ(BOATCAST優先 / LOCAL fallback)
    const mergeResult = mergeExhibition(boatcastExhibition, entriesWithProfiles, race);
    exhibitionStatus = mergeResult.exhibition_status;

    // 展示READY判定: PARTIAL/WAITING時はFINAL生成スキップ
    if (mergeResult.exhibition_status !== "READY") {
      console.log(`[FINAL_SKIP] race=${race.id} key=${race.race_key} exhibition_status=${mergeResult.exhibition_status} ready=${mergeResult.ready_count}/${mergeResult.active_count}`);
      return {
        predictionId: null, result: null, skipped: true,
        reason: `EXHIBITION_NOT_READY:${mergeResult.exhibition_status}`,
        exhibition_status: mergeResult.exhibition_status,
        ready_count: mergeResult.ready_count,
        active_count: mergeResult.active_count,
      };
    }

    // マージ済みエントリで予想実行
    entriesWithProfiles = mergeResult.entries;
    console.log(`[FINAL_READY] race=${race.id} key=${race.race_key} status=${mergeResult.exhibition_status} boatcast=${mergeResult.boatcast_available}`);
  }

  // FINAL時: PRE予想を基準に展示補正のみ適用
  let preBoatScores = null;
  if (stage === "FINAL") {
    const prePred = await client.asServiceRole.entities.RacePrediction.filter({ race_id: race.id, stage: "PRE", prediction_version: VERSION }, "-computed_at", 1);
    if (prePred?.[0]) {
      preBoatScores = await client.asServiceRole.entities.BoatPrediction.filter({ prediction_id: prePred[0].id }, "boat_number", 6);
    }
  }

  // FINAL時: 対象Raceの最新OddsSnapshotを取得し、実オッズを最優先で使用
  let effectiveOddsMap = oddsMap || {};
  if (stage === "FINAL") {
    try {
      const snapshots = await client.asServiceRole.entities.OddsSnapshot.filter(
        { race_id: race.id }, "-captured_at", 1
      );
      if (snapshots?.[0]?.odds_map && typeof snapshots[0].odds_map === "object") {
        // OddsSnapshotの実オッズを最優先、引数のoddsMapで補完
        effectiveOddsMap = { ...oddsMap, ...snapshots[0].odds_map };
      }
    } catch {}
  }

  const result = runPrediction(entriesWithProfiles, cfg, { oddsMap: effectiveOddsMap, preBoatScores, exhibitionStatus });

  // FINAL時: 選択買い目の実オッズマッピングエラーチェック
  if (stage === "FINAL" && result.set_metrics?.odds_mapping_error) {
    const missing = result.set_metrics.missing_odds || [];
    console.error(`[ODDS_MAPPING_ERROR] race=${race.id} key=${race.race_key} missing=${missing.join(",")}`);
    const { id: errPredId } = await getOrCreatePrediction(client, race.id, race.race_key, stage);
    await client.asServiceRole.entities.RacePrediction.update(errPredId, {
      race_id: race.id, race_key: race.race_key, stage, prediction_version: VERSION,
      computed_at: new Date().toISOString(),
      status: "MISSING",
      judgment_reason: `ODDS_MAPPING_ERROR: 実オッズ未取得 ${missing.join(", ")}`,
      selected_trifectas: result.selected_trifectas,
      ticket_count: result.ticket_count,
      top_trifecta: result.top_trifecta,
      top_probability: result.top_probability,
      top_odds: result.top_odds,
    });
    return { predictionId: errPredId, result, odds_mapping_error: true, missing_odds: missing };
  }

  const { id: predictionId, existing: existingPred } = await getOrCreatePrediction(client, race.id, race.race_key, stage);

  const predictionRecord = {
    race_id: race.id, race_key: race.race_key, stage, prediction_version: VERSION,
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
    honmei_boat: result.honmei_boat, taiko_boat: result.taiko_boat, ana_boat: result.ana_boat, keshi_boat: result.keshi_boat,
    top_trifecta: result.top_trifecta, top_probability: result.top_probability,
    top_odds: result.top_odds,
    top_judgment: result.final_judgment,
    race_scenario: result.race_scenario,
    first_ranking: result.first_ranking, second_ranking: result.second_ranking, third_ranking: result.third_ranking,
    status: "COMPLETED",
  };
  await client.asServiceRole.entities.RacePrediction.update(predictionId, predictionRecord);

  // 子レコード再生成(新規予想の場合は削除不要=DB呼び出し削減)
  if (existingPred) {
    await client.asServiceRole.entities.BoatPrediction.deleteMany({ prediction_id: predictionId });
    await client.asServiceRole.entities.TrifectaPrediction.deleteMany({ prediction_id: predictionId });
  }

  const boatDocs = result.boatScores.map((s) => ({
    prediction_id: predictionId, race_id: race.id, race_key: race.race_key, stage,
    boat_number: s.boat_number,
    first_power: s.first_power, second_power: s.second_power, third_power: s.third_power, total_power: s.total_power,
    current_power: s.current_power,
    start_power: s.start_power, motor_power: s.motor_power, exhibition_power: s.exhibition_power,
    exhibition_score: s.exhibition_score,
    local_fit: s.local_fit, section_form: s.section_form, ana_potential: s.ana_potential,
    course_strength: s.course_strength, start_skill: s.start_skill,
    lane_recent_score: s.lane_recent_score,
    lane_recent_win_rate: s.lane_recent_win_rate,
    lane_recent_top2_rate: s.lane_recent_top2_rate,
    lane_recent_top3_rate: s.lane_recent_top3_rate,
    lane_recent_avg_st: s.lane_recent_avg_st,
    lane_recent_avg_start_order: s.lane_recent_avg_start_order,
    lane_recent_sample_count: s.lane_recent_sample_count,
    recent_form_score: s.recent_form_score, st_trend_score: s.st_trend_score,
    class_trend_score: s.class_trend_score, performance_trend: s.performance_trend,
    racer_power_score: s.racer_power_score,
    pre_score: s.pre_first, final_score: stage === "FINAL" ? s.first_power : null, delta: s.exhibition_delta,
    reasons: s.reasons, notes: s.notes,
    final_adjustments: s.final_adjustments || null,
    exhibition_sources: s.exhibition_sources || null,
  }));
  if (boatDocs.length) await client.asServiceRole.entities.BoatPrediction.bulkCreate(boatDocs);

  // 3連単確率 + 参考情報(オッズ・判定)を保存。確率は選手プロファイルから算出(オッズ不使用)
  // 選定6〜8点には is_selected, ticket_rank, set_group, selection_reason を付与
  const ticketInfoMap = new Map((result.ticket_selection?.selected || []).map((t) => [t.combination, t]));
  const selectedSet = new Set(result.selected_trifectas || []);
  const trifectaDocs = result.trifectas.map((t) => {
    const info = ticketInfoMap.get(t.combination);
    const isSelected = selectedSet.has(t.combination);
    // 実オッズのみ使用(effectiveOddsMap = OddsSnapshot最優先)
    const actualOdds = effectiveOddsMap?.[t.combination] || null;
    const estimatedOdds = Math.max(1.0, Math.round((100 / Math.max(t.probability, 0.1)) * 0.75 * 10) / 10);
    const ev = actualOdds ? Math.round(t.probability * actualOdds * 10) / 10 : null;
    // 個別BUY/WATCH/SKIPも、FINALでは実オッズから算出した期待値で判定する。
    // 以前はexpected_valueを付与する前にjudgeTrifectaを呼んでいたため、
    // 実オッズ取得済みでも確率ベースのWATCHになっていた。
    const { judgment, basis } = judgeTrifecta({ ...t, expected_value: ev }, { settings, dataConfidence: result.data_confidence, stage });
    return {
      prediction_id: predictionId, race_id: race.id, race_key: race.race_key, stage,
      combination: t.combination, rank: t.rank, probability: t.probability,
      estimated_odds: estimatedOdds, actual_odds: actualOdds, current_odds: actualOdds, expected_value: ev,
      is_selected: isSelected,
      ticket_rank: info?.ticket_rank || null,
      set_group: info?.set_group || null,
      selection_reason: info?.selection_reason || null,
      judgment, basis,
    };
  });
  if (trifectaDocs.length) await client.asServiceRole.entities.TrifectaPrediction.bulkCreate(trifectaDocs);

  // 学習スナップショットは別バッチで保存(DB呼び出し削減)
  // await client.asServiceRole.entities.PredictionLearningSample.create({...});

  // Race更新(保護: has_pre/has_finalはtrueにするだけ、statusは後退させない)
  const raceUpdate = {
    prediction_grade: result.prediction_grade,
    honmei_boat: result.honmei_boat, taiko_boat: result.taiko_boat, ana_boat: result.ana_boat, keshi_boat: result.keshi_boat,
    top_trifecta: result.top_trifecta, top_probability: result.top_probability,
    final_judgment: result.final_judgment,
  };
  if (stage === "PRE") { raceUpdate.has_pre = true; if (race.status !== "final" && race.status !== "finished") raceUpdate.status = "pre"; }
  if (stage === "FINAL") { raceUpdate.has_final = true; if (race.status !== "finished") raceUpdate.status = "final"; }
  await client.asServiceRole.entities.Race.update(race.id, raceUpdate);

  return { predictionId, result };
}

// 結果upsert + 照合(サーバー側)
export async function upsertResultOnly(client, race, resultData) {
  if (!resultData.result_trifecta) return null;
  const existing = await client.asServiceRole.entities.RaceResult.filter({ race_id: race.id }, "-finished_at", 1);
  const doc = { race_id: race.id, race_key: race.race_key, result_trifecta: resultData.result_trifecta, finish_order: resultData.finish_order, payout: resultData.payout || 0, is_finished: true, finished_at: new Date().toISOString() };
  let saved;
  if (existing && existing[0]) saved = await client.asServiceRole.entities.RaceResult.update(existing[0].id, doc);
  else saved = await client.asServiceRole.entities.RaceResult.create(doc);
  await client.asServiceRole.entities.Race.update(race.id, { status: "finished" });
  return saved;
}

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
  const preHit = (pre?.[0]?.selected_trifectas || []).includes(resultData.result_trifecta) || pre?.[0]?.top_trifecta === resultData.result_trifecta;
  const finalHit = (fin?.[0]?.selected_trifectas || []).includes(resultData.result_trifecta) || fin?.[0]?.top_trifecta === resultData.result_trifecta;

  // 推奨買い目 = 選定6〜8点(is_selected=true)。BUY判定時のみ投資計上。
  let recommendedHit = false, investment = 0;
  if (fin?.[0]) {
    const tri = await client.asServiceRole.entities.TrifectaPrediction.filter({ prediction_id: fin[0].id, is_selected: true }, "ticket_rank", 8);
    investment = tri.length * 100;
    recommendedHit = tri.some((t) => t.combination === resultData.result_trifecta);
    // BUY判定でない場合は投資0(買わない)
    if (fin[0].final_judgment !== "BUY") investment = 0;
  }
  const recovery = investment > 0 ? Math.round((recommendedHit ? (resultData.payout || 0) : 0) / investment * 100) : 0;

  const verifDoc = {
    race_id: race.id, race_key: race.race_key,
    pre_prediction: pre?.[0]?.top_trifecta || "", final_prediction: fin?.[0]?.top_trifecta || "",
    actual_result: resultData.result_trifecta, pre_hit: preHit, final_hit: finalHit, recommended_hit: recommendedHit,
    final_judgment: fin?.[0]?.final_judgment || null,
    ticket_count: fin?.[0]?.ticket_count || null,
    selected_trifectas: fin?.[0]?.selected_trifectas || [],
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

  // 排他ロック: 同一dateの同時処理を防止。取得失敗時は処理スキップ(再試行待ち)。
  const lockDate = races[0]?.race_date || new Date().toISOString().slice(0, 10);
  const lockKey = `sync_${lockDate}${opts.venue_code ? `_${opts.venue_code}` : ""}`;
  await cleanupExpiredLocks(client);
  const lockId = await acquireLock(client, lockKey, opts.mode || "sync");
  if (!lockId) {
    return { races_total: races.length, races_upserted: 0, entries_upserted: 0, pre_generated: 0, final_generated: 0, results_saved: 0, errors: [{ message: `別ワーカーが${lockDate}を処理中のためスキップ` }], skipped: true, lock_key: lockKey };
  }

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

  // 選手プロファイル+ローリング統計を一括取得(全レース分1回だけ=DB呼び出し削減)
  const allProfiles = await client.asServiceRole.entities.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(allProfiles.map(p => [p.registration_number, p]));
  const allRolling = await client.asServiceRole.entities.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(allRolling.map(r => [r.registration_number, r]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        // 親Raceを正としてキー情報を強制補完する。
        // BOAT WORKS側のRaceEntryフィールド欠落や古いexportが混じっても、race_keyだけでなく
        // race_date / venue_code / race_number を必ずBOAT WORKS 2側へ保存する。
        // race_keyから逆算してrace_date/venue_code/race_numberを必ず補完。
        // ソースの個別フィールドが欠けていても、race_keyが正しければ正しい値が入る。
        const parsedKey = parseRaceKey(raceData.race_key);
        const entryData = {
          ...mapEntry(bwEntry, seriesMap[skey] || {}),
          race_id: race.id,
          race_key: raceData.race_key,
          race_date: raceData.race_date || parsedKey?.race_date || null,
          venue_code: raceData.venue_code || parsedKey?.venue_code || null,
          race_number: raceData.race_number || parsedKey?.race_number || null,
        };
        const saved = await upsertEntry(client, entryData);
        entryDocs.push(saved);
        summary.entries_upserted++;
      }
      const complete = entryDocs.filter((e) => e && !e.is_scratched && e.boat_number).length >= 6;
      if (complete) addVenue(raceData.venue_code, "complete");

      // PRE予想(6艇揃っていれば展示データ不使用で生成)。
      // 既にPRE済みのレースは再生成しない。5分周期同期で全件を毎回再計算すると
      // DB APIレート制限を誘発するため、未生成レースだけを処理する。
      if (complete && !opts.skip_predictions) {
        if (race.has_pre === true && opts.force_predictions !== true) {
          addVenue(raceData.venue_code, "pre");
        } else {
          try {
            await runAndSavePrediction(client, race, entryDocs, settings, "PRE", {}, profileByReg, rollingByReg);
            summary.pre_generated++; addVenue(raceData.venue_code, "pre");
          } catch (e) { summary.errors.push({ race_key: raceData.race_key, message: "PRE予想失敗: " + e.message }); addVenue(raceData.venue_code, "errors"); }
        }
      }

      // FINAL予想(展示取得済みの場合のみ)
      if (complete && raceData.exhibition_ready && !opts.skip_predictions) {
        addVenue(raceData.venue_code, "exhibition");
        try {
          const finResult = await runAndSavePrediction(client, race, entryDocs, settings, "FINAL", oddsByRace[raceData.race_key] || {}, profileByReg, rollingByReg);
          if (!finResult?.skipped) { summary.final_generated++; addVenue(raceData.venue_code, "final"); }
        } catch (e) { summary.errors.push({ race_key: raceData.race_key, message: "FINAL予想失敗: " + e.message }); addVenue(raceData.venue_code, "errors"); }
      }

      // 結果: APIはresults配列またはraceオブジェクト直下(result_trifecta)に格納
      const res = results.find((r) => (r.race_key || buildRaceKey(r.race_date, r.venue_code, r.race_number)) === raceData.race_key);
      const raceResultData = res || (bwRace.result_trifecta ? bwRace : null);
      if (raceResultData && raceResultData.result_trifecta) {
        try {
          const mapped = mapResult(raceResultData);
          if (opts.skip_verification) await upsertResultOnly(client, race, mapped);
          else await upsertResultAndVerify(client, race, mapped);
          summary.results_saved++; addVenue(raceData.venue_code, "result");
        } catch (e) { summary.errors.push({ race_key: raceData.race_key, message: "結果保存失敗: " + e.message }); }
      }
    } catch (e) {
      summary.errors.push({ race_key: bwRace?.race_key, message: e.message });
    }
    // DB APIレート制限回避: レース間に短い遅延
    await sleep(600);
  }

  // SyncStatus保存
  const statusDoc = {
    name: "default", last_sync_at: new Date().toISOString(),
    status: summary.errors.length === 0 ? "success" : (summary.races_upserted > 0 ? "partial" : "failed"),
    mode: opts.mode || "ingest", error_count: summary.errors.length, errors: summary.errors.slice(0, 50),
    venue_summary: summary.venue_summary, synced_race_keys: summary.synced_race_keys,
  };
  try {
    const existStatus = await client.asServiceRole.entities.SyncStatus.filter({ name: "default" }, "-last_sync_at", 1);
    if (existStatus?.[0]) await client.asServiceRole.entities.SyncStatus.update(existStatus[0].id, statusDoc);
    else await client.asServiceRole.entities.SyncStatus.create(statusDoc);
  } catch (e) { summary.errors.push({ message: "SyncStatus保存失敗: " + e.message }); }

  await releaseLock(client, lockId);
  return summary;
}