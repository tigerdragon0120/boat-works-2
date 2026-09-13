// ============================================================
// Prediction Engine V3 Candidate
// V2を基準とし、1着予測精度を中心に改善。
// 過去25% + 直近35% + 当日40% 重み維持 + 条件付き補正
// V2とは完全独立。V1/V2を一切変更しない。
//
// 主な改善点:
// 1. first_score / first_probability / first_confidence 独立計算
// 2. first_probability_gap による1着混戦判定
// 3. 1号艇イン逃げ信頼度 独立計算
// 4. 外枠攻撃力(まくり/差し)評価
// 5. 2着・3着適性の分離
// 6. 120通りのrace_probability正規化
// 7. 条件付き重み補正(展示ST差・進入変更・荒水面)
// 8. レースタイプ分類(A-G)
// 9. BUY6条件判定
// 10. データ完全性チェック
// ============================================================

const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

// V3基本重み(V2と同一。固定。自動変更禁止)
const V3_BASE_WEIGHTS = { past: 0.25, recent: 0.35, today: 0.40 };

// ST値→スコア
const stToScore = (st, refSt = 0.15) => {
  if (!isValid(st)) return null;
  return clamp(70 + (refSt - st) * 300, 5, 100);
};

const classToScore = (cls) => {
  if (!cls) return 50;
  const c = String(cls).toUpperCase();
  if (c === 'A1') return 100;
  if (c === 'A2') return 80;
  if (c === 'B1') return 60;
  if (c === 'B2') return 40;
  return 50;
};

const rankToScore = (rank, total = 6) => {
  if (!isValid(rank)) return null;
  return clamp(((total - rank + 1) / total) * 100, 0, 100);
};

const rankHigh = (values) => {
  const indexed = values.map((v, i) => ({ v, i })).filter(x => isValid(x.v));
  indexed.sort((a, b) => b.v - a.v);
  const ranks = new Array(values.length).fill(null);
  indexed.forEach((x, idx) => { ranks[x.i] = idx + 1; });
  return ranks;
};

const rankLow = (values) => {
  const indexed = values.map((v, i) => ({ v, i })).filter(x => isValid(x.v));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(null);
  indexed.forEach((x, idx) => { ranks[x.i] = idx + 1; });
  return ranks;
};

const weightedAvg = (pairs, fallback = 50) => {
  const valid = pairs.filter(([s]) => s !== null && isValid(s));
  if (!valid.length) return fallback;
  const denom = valid.reduce((a, [, w]) => a + w, 0);
  return denom > 0 ? valid.reduce((a, [s, w]) => a + s * w, 0) / denom : fallback;
};

// ============================================================
// 過去評価 25% (V2と同一ロジック)
// ============================================================
function computePastScore(entry, allEntries) {
  const profile = entry._profile;
  const rolling = entry._rollingStats;
  const course = entry.boat_number;

  const nationalWin = isValid(entry.national_win_rate) ? clamp(entry.national_win_rate * 10, 0, 100) : null;
  const nationalF2 = isValid(entry.national_f2_rate) ? clamp(entry.national_f2_rate, 0, 100) : null;
  const localWin = isValid(entry.local_win_rate) ? clamp(entry.local_win_rate * 10, 0, 100) : null;
  const localF2 = isValid(entry.local_f2_rate) ? clamp(entry.local_f2_rate, 0, 100) : null;
  const classScore = classToScore(entry.player_class || entry.grade_class);

  let courseWin = null;
  if (profile?.course_stats) {
    const cs = profile.course_stats[String(course)];
    if (cs && cs.sample_size >= 3 && isValid(cs.win_rate)) {
      courseWin = clamp(cs.win_rate, 0, 100);
    }
  }

  const rollingWin = rolling?.stats_6m?.win_rate != null && rolling.stats_6m.race_count >= 5
    ? clamp(rolling.stats_6m.win_rate, 0, 100) : null;

  const components = {
    national_win: nationalWin, national_f2: nationalF2,
    local_win: localWin, local_f2: localF2,
    class: classScore, course_win: courseWin, rolling_win: rollingWin,
  };

  const score = weightedAvg([
    [nationalWin, 0.20], [nationalF2, 0.10],
    [localWin, 0.20], [localF2, 0.10],
    [classScore, 0.10], [courseWin, 0.20], [rollingWin, 0.10],
  ]);

  return { score: round1(score), components };
}

// ============================================================
// 直近評価 35% (V2と同一ロジック)
// ============================================================
function computeRecentScore(entry, allEntries) {
  const laneRecent = entry._laneRecent;
  const rolling = entry._rollingStats;

  const waku10Win = isValid(laneRecent?.winning_rate) ? clamp(Number(laneRecent.winning_rate), 0, 100) : null;
  const waku10Top2 = isValid(laneRecent?.top2_rate) ? clamp(Number(laneRecent.top2_rate), 0, 100) : null;
  const waku10Top3 = isValid(laneRecent?.top3_rate) ? clamp(Number(laneRecent.top3_rate), 0, 100) : null;
  const waku10St = isValid(laneRecent?.avg_st) ? Number(laneRecent.avg_st) : null;
  const waku10StScore = waku10St != null ? stToScore(waku10St) : null;
  const waku10StRank = isValid(laneRecent?.avg_start_order) ? Number(laneRecent.avg_start_order) : null;
  const waku10StRankScore = waku10StRank != null ? clamp(116 - waku10StRank * 16, 20, 100) : null;

  const recentFormScore = rolling?.trend_scores?.recent_form_score != null
    ? clamp(rolling.trend_scores.recent_form_score, 0, 100) : null;
  const racerPowerScore = rolling?.trend_scores?.racer_power_score != null
    ? clamp(rolling.trend_scores.racer_power_score, 0, 100) : null;

  const sectionScore = isValid(entry.section_points) ? clamp(entry.section_points * 2, 0, 100) : null;
  const sectionMomentum = isValid(entry.section_momentum) ? clamp(50 + entry.section_momentum * 10, 0, 100) : null;

  const sampleCount = Number(laneRecent?.sample_count || 0);
  const sampleWeight = sampleCount >= 10 ? 1.0 : sampleCount >= 7 ? 0.8 : sampleCount >= 4 ? 0.6 : sampleCount >= 1 ? 0.3 : 0;

  const components = {
    waku10_win: waku10Win, waku10_top2: waku10Top2, waku10_top3: waku10Top3,
    waku10_st: waku10St, waku10_st_score: waku10StScore,
    waku10_st_rank: waku10StRank, waku10_st_rank_score: waku10StRankScore,
    recent_form: recentFormScore, racer_power: racerPowerScore,
    section: sectionScore, section_momentum: sectionMomentum,
    waku10_sample_count: sampleCount, waku10_sample_weight: sampleWeight,
  };

  const score = weightedAvg([
    [waku10Win, 0.30 * (sampleWeight > 0 ? 1 : 0.3)],
    [waku10StScore, 0.15 * sampleWeight],
    [waku10StRankScore, 0.10 * sampleWeight],
    [recentFormScore, 0.20],
    [racerPowerScore, 0.10],
    [sectionScore, 0.10],
    [sectionMomentum, 0.05],
  ]);

  return { score: round1(score), components };
}

// ============================================================
// 当日評価 40% (FINAL only) — V2ロジック + 条件付き補正
// ============================================================
function computeTodayScore(entry, allEntries, race, conditionalWeights) {
  const exTime = isValid(entry.exhibition_time) ? Number(entry.exhibition_time) : null;
  const exSt = isValid(entry.exhibition_st) ? Number(entry.exhibition_st) : null;
  const exStScore = exSt != null ? stToScore(exSt, 0.1) : null;
  const exCourse = isValid(entry.exhibition_course) ? Number(entry.exhibition_course) : null;
  const tilt = isValid(entry.tilt) ? Number(entry.tilt) : null;

  const exTimeRanks = rankLow(allEntries.map(e => isValid(e.exhibition_time) ? Number(e.exhibition_time) : null));
  const exTimeRank = exTimeRanks[allEntries.indexOf(entry)];
  const exTimeRankScore = rankToScore(exTimeRank, allEntries.filter(e => isValid(e.exhibition_time)).length || 6);

  const exStRanks = rankLow(allEntries.map(e => isValid(e.exhibition_st) ? Number(e.exhibition_st) : null));
  const exStRank = exStRanks[allEntries.indexOf(entry)];
  const exStRankScore = rankToScore(exStRank, allEntries.filter(e => isValid(e.exhibition_st)).length || 6);

  let entryAdjust = 0;
  if (exCourse != null && exCourse !== entry.boat_number) {
    entryAdjust = exCourse < entry.boat_number ? 8 : -8;
  }

  const motorScore = isValid(entry.motor_f2_rate) ? clamp(entry.motor_f2_rate, 0, 100) : null;
  const boatScore = isValid(entry.boat_f2_rate) ? clamp(entry.boat_f2_rate, 0, 100) : null;
  const exTimeAbsScore = exTime != null ? clamp(50 + (1.4 - exTime) * 100, 5, 100) : null;

  const components = {
    exhibition_time: exTime, exhibition_time_rank: exTimeRank, exhibition_time_rank_score: exTimeRankScore,
    exhibition_st: exSt, exhibition_st_score: exStScore, exhibition_st_rank: exStRank, exhibition_st_rank_score: exStRankScore,
    exhibition_course: exCourse, entry_adjust: entryAdjust,
    tilt, motor: motorScore, boat: boatScore, exhibition_time_abs: exTimeAbsScore,
  };

  const score = weightedAvg([
    [exTimeRankScore, 0.25], [exTimeAbsScore, 0.10],
    [exStScore, 0.20], [exStRankScore, 0.10],
    [motorScore, 0.15], [boatScore, 0.08],
    [clamp(50 + entryAdjust, 0, 100), 0.12],
  ]);

  return { score: round1(score), components };
}

// ============================================================
// 【V3新規】1号艇イン逃げ信頼度
// 1号艇自身の強さ + 2〜4号艇の攻撃力を減算
// ============================================================
function computeInsideEscapeReliability(entry, allEntries, stage) {
  if (entry.boat_number !== 1) return null;

  const profile = entry._profile;
  const rolling = entry._rollingStats;
  const laneRecent = entry._laneRecent;
  const reasons = [], notes = [];

  // 1コース過去成績
  let course1Win = null;
  if (profile?.course_stats?.["1"]) {
    const cs = profile.course_stats["1"];
    if (cs.sample_size >= 3 && isValid(cs.win_rate)) course1Win = clamp(cs.win_rate, 0, 100);
  }

  // WAKU10勝率(1枠)
  const waku10Win = isValid(laneRecent?.winning_rate) ? clamp(Number(laneRecent.winning_rate), 0, 100) : null;
  const waku10St = isValid(laneRecent?.avg_st) ? Number(laneRecent.avg_st) : null;
  const waku10StScore = waku10St != null ? stToScore(waku10St) : null;
  const waku10StRank = isValid(laneRecent?.avg_start_order) ? Number(laneRecent.avg_start_order) : null;

  // 平均ST(全体)
  const avgSt = isValid(entry.avg_st) ? Number(entry.avg_st) : null;
  const avgStScore = avgSt != null ? stToScore(avgSt) : null;

  // 今節ST
  const sectionSt = isValid(entry.section_st) ? Number(entry.section_st) : null;
  const sectionStScore = sectionSt != null ? stToScore(sectionSt) : null;

  // 展示ST(FINALのみ)
  const exSt = isValid(entry.exhibition_st) ? Number(entry.exhibition_st) : null;
  const exStScore = exSt != null ? stToScore(exSt, 0.1) : null;
  const exStRank = isValid(entry.exhibition_st_rank) ? Number(entry.exhibition_st_rank) : null;

  // モーター
  const motorScore = isValid(entry.motor_f2_rate) ? clamp(entry.motor_f2_rate, 0, 100) : null;

  // 当地成績
  const localWin = isValid(entry.local_win_rate) ? clamp(entry.local_win_rate * 10, 0, 100) : null;

  // F持ち
  const fCount = isValid(entry.f_count) ? Number(entry.f_count) : 0;
  const fPenalty = fCount > 0 ? clamp(100 - fCount * 15, 0, 100) : 100;

  // 2〜4号艇の攻撃力(1号艇を脅かす艇)
  const attackers = allEntries.filter(e => [2, 3, 4].includes(e.boat_number) && !e.is_absent);
  let maxAttackPower = 0;
  let attackerCount = 0;
  for (const atk of attackers) {
    const atkPower = computeAttackPower(atk, stage);
    if (atkPower != null && atkPower > 50) {
      attackerCount++;
      maxAttackPower = Math.max(maxAttackPower, atkPower);
    }
  }

  // イン逃げ信頼度 = 自身の強さ - 攻撃力減算
  const selfStrength = weightedAvg([
    [course1Win, 0.25], [waku10Win, 0.20],
    [avgStScore, 0.10], [exStScore, 0.15],
    [motorScore, 0.10], [localWin, 0.10],
    [fPenalty, 0.10],
  ]);

  // 攻撃力減算: 強い攻撃艇がいるほど1号艇信頼度低下
  const attackReduction = maxAttackPower > 60 ? (maxAttackPower - 60) * 0.3 : 0;
  const multiAttackerPenalty = attackerCount >= 2 ? 5 : 0;

  const reliability = clamp(selfStrength - attackReduction - multiAttackerPenalty, 0, 100);

  if (course1Win != null && course1Win >= 55) reasons.push(`1コース勝率${round1(course1Win)}%`);
  if (waku10Win != null && waku10Win >= 50) reasons.push(`1枠WAKU10勝率${round1(waku10Win)}%`);
  if (exStScore != null && exStScore >= 70) reasons.push(`展示ST良好`);
  if (attackerCount >= 2) notes.push(`強力な攻撃艇${attackerCount}艇`);
  if (maxAttackPower > 65) notes.push(`最大攻撃力${round1(maxAttackPower)}の脅威`);
  if (fCount > 0) notes.push(`F持ち(${fCount}回)`);

  return { score: round1(reliability), reasons, notes, attacker_count: attackerCount, max_attack_power: round1(maxAttackPower) };
}

// ============================================================
// 【V3新規】外枠攻撃力(まくり/まくり差し/差し)
// 2〜6号艇の1着奪取能力
// ============================================================
function computeAttackPower(entry, stage) {
  if (entry.boat_number === 1) return null;
  const profile = entry._profile;
  const laneRecent = entry._laneRecent;

  // 決まり手別勝率
  const wm = profile?.winning_methods;
  let kimariteScore = null;
  if (wm?.total_wins >= 2) {
    if (entry.boat_number === 2) kimariteScore = wm.sashi_rate != null ? clamp(wm.sashi_rate, 0, 100) : null;
    else if (entry.boat_number === 3) kimariteScore = wm.makuri_rate != null ? clamp(wm.makuri_rate, 0, 100) : null;
    else if (entry.boat_number === 4) kimariteScore = wm.makuri_sashi_rate != null ? clamp(wm.makuri_sashi_rate, 0, 100) : null;
    else if (entry.boat_number >= 5) kimariteScore = wm.nuki_rate != null ? clamp(wm.nuki_rate, 0, 100) : null;
  }

  // 展示ST(FINALのみ)
  const exSt = isValid(entry.exhibition_st) ? Number(entry.exhibition_st) : null;
  const exStScore = exSt != null ? stToScore(exSt, 0.1) : null;

  // 枠番ST(WAKU10)
  const waku10St = isValid(laneRecent?.avg_st) ? Number(laneRecent.avg_st) : null;
  const waku10StScore = waku10St != null ? stToScore(waku10St) : null;

  // ST順位
  const waku10StRank = isValid(laneRecent?.avg_start_order) ? Number(laneRecent.avg_start_order) : null;
  const stRankScore = waku10StRank != null ? clamp(116 - waku10StRank * 16, 20, 100) : null;

  // 実進入(FINALのみ)
  const exCourse = isValid(entry.exhibition_course) ? Number(entry.exhibition_course) : null;
  const entryBonus = (exCourse != null && exCourse < entry.boat_number) ? 10 : 0;

  // モーター
  const motorScore = isValid(entry.motor_f2_rate) ? clamp(entry.motor_f2_rate, 0, 100) : null;

  // 直近着順(WAKU10勝率)
  const waku10Win = isValid(laneRecent?.winning_rate) ? clamp(Number(laneRecent.winning_rate), 0, 100) : null;

  // 当地成績
  const localWin = isValid(entry.local_win_rate) ? clamp(entry.local_win_rate * 10, 0, 100) : null;

  const power = weightedAvg([
    [kimariteScore, 0.25], [exStScore, 0.15], [waku10StScore, 0.10],
    [stRankScore, 0.10], [motorScore, 0.10], [waku10Win, 0.15], [localWin, 0.15],
  ]);

  return clamp(power + entryBonus, 0, 100);
}

// ============================================================
// 【V3新規】条件付き重み補正
// 展示ST差・進入変更・荒水面に応じて重みを動的調整
// ============================================================
function computeConditionalWeights(allEntries, race, stage) {
  let past = V3_BASE_WEIGHTS.past;
  let recent = V3_BASE_WEIGHTS.recent;
  let today = V3_BASE_WEIGHTS.today;

  const adjustments = [];

  if (stage === "FINAL") {
    // 展示ST差(6艇内の最大ST - 最小ST)
    const exSts = allEntries
      .map(e => isValid(e.exhibition_st) ? Number(e.exhibition_st) : null)
      .filter(v => v != null);
    if (exSts.length >= 4) {
      const stSpread = Math.max(...exSts) - Math.min(...exSts);
      // ST差が大きい → 当日評価の信頼性UP
      if (stSpread >= 0.08) {
        today = Math.min(0.50, today + 0.05);
        past = Math.max(0.20, past - 0.03);
        recent = Math.max(0.28, recent - 0.02);
        adjustments.push(`展示ST差大(${stSpread.toFixed(2)}s)→当日重視`);
      }
      // 展示ほぼ横並び → 過去・直近重視
      else if (stSpread < 0.03) {
        past = Math.min(0.30, past + 0.03);
        recent = Math.min(0.40, recent + 0.03);
        today = Math.max(0.33, today - 0.06);
        adjustments.push(`展示ST横並び(${stSpread.toFixed(2)}s)→過去直近重視`);
      }
    }

    // 進入変更検出
    const entryChanges = allEntries.filter(e => {
      const exCourse = isValid(e.exhibition_course) ? Number(e.exhibition_course) : null;
      return exCourse != null && exCourse !== e.boat_number;
    });
    if (entryChanges.length > 0) {
      // 進入変更あり → 当日評価の進入補正を重視(既にtoday内で処理)
      adjustments.push(`進入変更${entryChanges.length}艇検出`);
    }

    // 荒水面判定
    const waveHeight = isValid(race?.wave_height) ? Number(race.wave_height) : null;
    const windSpeed = isValid(race?.wind_speed) ? Number(race.wind_speed) : null;
    const isRough = (waveHeight != null && waveHeight >= 5) || (windSpeed != null && windSpeed >= 10);
    if (isRough) {
      // 荒水面 → 当地・水面適性重視 = 直近(当地成績含む)の重みUP
      recent = Math.min(0.42, recent + 0.05);
      today = Math.max(0.33, today - 0.05);
      adjustments.push(`荒水面(波${waveHeight}cm/風${windSpeed}m)→当地適性重視`);
    }
  }

  // 正規化(合計=1.0)
  const total = past + recent + today;
  if (total > 0) {
    past = past / total;
    recent = recent / total;
    today = today / total;
  }

  return {
    weights: { past: round2(past), recent: round2(recent), today: round2(today) },
    exhibition_st_spread: stage === "FINAL" ? round2(Math.max(...(allEntries.map(e => isValid(e.exhibition_st) ? Number(e.exhibition_st) : null).filter(v => v != null))) - Math.min(...(allEntries.map(e => isValid(e.exhibition_st) ? Number(e.exhibition_st) : null).filter(v => v != null)))) || null : null,
    entry_change_detected: stage === "FINAL" && allEntries.some(e => {
      const exCourse = isValid(e.exhibition_course) ? Number(e.exhibition_course) : null;
      return exCourse != null && exCourse !== e.boat_number;
    }),
    rough_water: stage === "FINAL" && ((isValid(race?.wave_height) && Number(race.wave_height) >= 5) || (isValid(race?.wind_speed) && Number(race.wind_speed) >= 10)),
    adjustments,
  };
}

// ============================================================
// 【V3新規】1着適性スコア(独立計算)
// 基本スコア + コース別1着能力 + ST + 決まり手 + 攻撃力
// ============================================================
function computeFirstScore(entry, baseScore, allEntries, stage) {
  const profile = entry._profile;
  const course = entry.boat_number;

  // コース別1着能力
  let courseWin = null;
  if (profile?.course_stats?.[String(course)]) {
    const cs = profile.course_stats[String(course)];
    if (cs.sample_size >= 3 && isValid(cs.win_rate)) courseWin = clamp(cs.win_rate, 0, 100);
  }

  // 決まり手別1着能力
  const wm = profile?.winning_methods;
  let kimariteBonus = 0;
  if (wm?.total_wins >= 2) {
    if (course === 1 && wm.escape_rate != null) kimariteBonus = wm.escape_rate * 0.15;
    else if (course === 2 && wm.sashi_rate != null) kimariteBonus = wm.sashi_rate * 0.10;
    else if (course === 3 && wm.makuri_rate != null) kimariteBonus = wm.makuri_rate * 0.08;
    else if (course === 4 && wm.makuri_sashi_rate != null) kimariteBonus = wm.makuri_sashi_rate * 0.06;
    else if (course >= 5 && wm.nuki_rate != null) kimariteBonus = wm.nuki_rate * 0.05;
  }

  // ST能力(1着取得に重要)
  const avgSt = isValid(entry.avg_st) ? Number(entry.avg_st) : null;
  const stScore = avgSt != null ? stToScore(avgSt) : null;

  // 展示ST(FINALのみ、1着に直結)
  const exSt = isValid(entry.exhibition_st) ? Number(entry.exhibition_st) : null;
  const exStScore = exSt != null ? stToScore(exSt, 0.1) : null;

  // 1号艇: イン逃げ信頼度を特別考慮
  let insideBonus = 0;
  if (course === 1) {
    const ier = computeInsideEscapeReliability(entry, allEntries, stage);
    if (ier?.score != null) insideBonus = (ier.score - 50) * 0.20;
  }
  // 外枠: 攻撃力を考慮
  let attackBonus = 0;
  if (course >= 2) {
    const ap = computeAttackPower(entry, stage);
    if (ap != null) attackBonus = (ap - 50) * 0.15;
  }

  // 1着適性 = baseScore * 0.55 + courseWin * 0.20 + stScore * 0.10 + exStScore * 0.10 + 補正
  const firstScore = weightedAvg([
    [baseScore, 0.55], [courseWin, 0.20], [stScore, 0.10], [exStScore, 0.10],
  ]);

  return clamp(firstScore + kimariteBonus + insideBonus + attackBonus, 5, 100);
}

// ============================================================
// 【V3新規】2着適性スコア
// ============================================================
function computeSecondScore(entry, baseScore, stage) {
  const profile = entry._profile;
  const laneRecent = entry._laneRecent;

  // 2連率(WAKU10)
  const waku10Top2 = isValid(laneRecent?.top2_rate) ? clamp(Number(laneRecent.top2_rate), 0, 100) : null;
  // 全国2連率
  const nationalF2 = isValid(entry.national_f2_rate) ? clamp(entry.national_f2_rate, 0, 100) : null;
  // 当地2連率
  const localF2 = isValid(entry.local_f2_rate) ? clamp(entry.local_f2_rate, 0, 100) : null;

  // コース別2着率
  let courseSecond = null;
  if (profile?.course_stats?.[String(entry.boat_number)]) {
    const cs = profile.course_stats[String(entry.boat_number)];
    if (cs.sample_size >= 3 && isValid(cs.second_rate)) courseSecond = clamp(cs.second_rate, 0, 100);
  }

  const score = weightedAvg([
    [baseScore, 0.40], [waku10Top2, 0.20], [nationalF2, 0.15], [localF2, 0.15], [courseSecond, 0.10],
  ]);

  return clamp(score, 5, 100);
}

// ============================================================
// 【V3新規】3着適性スコア
// ============================================================
function computeThirdScore(entry, baseScore, stage) {
  const profile = entry._profile;
  const laneRecent = entry._laneRecent;

  const waku10Top3 = isValid(laneRecent?.top3_rate) ? clamp(Number(laneRecent.top3_rate), 0, 100) : null;
  const nationalF3 = isValid(entry.national_f3_rate) ? clamp(entry.national_f3_rate, 0, 100) : null;
  const localF3 = isValid(entry.local_f3_rate) ? clamp(entry.local_f3_rate, 0, 100) : null;

  let courseThird = null;
  if (profile?.course_stats?.[String(entry.boat_number)]) {
    const cs = profile.course_stats[String(entry.boat_number)];
    if (cs.sample_size >= 3 && isValid(cs.third_rate)) courseThird = clamp(cs.third_rate, 0, 100);
  }

  const score = weightedAvg([
    [baseScore, 0.40], [waku10Top3, 0.20], [nationalF3, 0.15], [localF3, 0.15], [courseThird, 0.10],
  ]);

  return clamp(score, 5, 100);
}

// ============================================================
// メイン: V3 Boat Scores計算
// ============================================================
export function computeV3BoatScores(entries, race, stage) {
  const isFinal = stage === "FINAL";
  const activeEntries = entries.filter(e => !e.is_absent && e.boat_number);

  // 条件付き重み
  const condWeights = computeConditionalWeights(activeEntries, race, stage);
  const weights = condWeights.weights;

  const boats = activeEntries.map(entry => {
    const past = computePastScore(entry, activeEntries);
    const recent = computeRecentScore(entry, activeEntries);
    const today = isFinal ? computeTodayScore(entry, activeEntries, race, condWeights) : { score: null, components: {} };

    // PRE score
    let pre_score;
    if (today.score != null) {
      pre_score = clamp(
        past.score * weights.past + recent.score * weights.recent + today.score * weights.today,
        0, 100
      );
    } else {
      const totalW = weights.past + weights.recent;
      pre_score = clamp(
        (past.score * weights.past + recent.score * weights.recent) / totalW,
        0, 100
      );
    }

    // FINAL score
    let final_score = null;
    let final_delta = null;
    if (isFinal) {
      final_score = clamp(
        past.score * weights.past + recent.score * weights.recent + today.score * weights.today,
        0, 100
      );
      final_delta = round1(final_score - pre_score);
    }

    const baseScore = isFinal ? (final_score ?? pre_score) : pre_score;

    // 【V3新規】1着・2着・3着適性スコア
    const first_score = computeFirstScore(entry, baseScore, activeEntries, stage);
    const second_score = computeSecondScore(entry, baseScore, stage);
    const third_score = computeThirdScore(entry, baseScore, stage);

    // 【V3新規】攻撃力・イン逃げ信頼度
    const attack_power = entry.boat_number >= 2 ? round1(computeAttackPower(entry, stage)) : null;
    const inside_escape_score = entry.boat_number === 1
      ? round1(computeInsideEscapeReliability(entry, activeEntries, stage)?.score)
      : null;

    const reasons = [], notes = [];
    if (isFinal && isValid(entry.exhibition_st)) reasons.push(`展示ST ${entry.exhibition_st}`);
    if (isFinal && isValid(entry.exhibition_course) && entry.exhibition_course !== entry.boat_number) {
      notes.push(`進入変更(${entry.boat_number}→${entry.exhibition_course})`);
    }

    return {
      boat_number: entry.boat_number,
      entry,
      past_score: past.score,
      recent_score: recent.score,
      today_score: today.score,
      pre_score: round1(pre_score),
      final_delta,
      final_score: final_score != null ? round1(final_score) : null,
      first_score: round1(first_score),
      second_score: round1(second_score),
      third_score: round1(third_score),
      attack_power,
      inside_escape_score,
      past_components: past.components,
      recent_components: recent.components,
      today_components: today.components,
      relative_ranks: {},
      reasons, notes,
    };
  });

  // 相対順位
  const firstRanks = rankHigh(boats.map(b => b.first_score));
  for (let i = 0; i < boats.length; i++) {
    boats[i].relative_ranks = { first_rank: firstRanks[i] };
  }

  return boats;
}

// ============================================================
// 【V3新規】1着確率・2着確率・3着確率計算
// softmax + 正規化
// ============================================================
export function computeV3Probabilities(boatScores) {
  const boats = boatScores.filter(b => !b.entry?.is_absent);
  const numbers = boats.map(b => b.boat_number);

  const softmax = (scores, temp) => {
    if (!scores.length) return [];
    const max = Math.max(...scores);
    const weights = scores.map(s => Math.exp((s - max) / temp));
    const sum = weights.reduce((a, b) => a + b, 0);
    return sum > 0 ? weights.map(w => w / sum) : weights.map(() => 1 / scores.length);
  };

  // 1着確率(first_score使用、温度低め=差が出やすい)
  const firstProb = softmax(boats.map(b => b.first_score), 5.0);
  const firstP = {};
  boats.forEach((b, i) => { firstP[b.boat_number] = firstProb[i]; });

  // 2着確率(second_score使用)
  const secondAptitude = boats.map(b => b.second_score);
  const secondProbRaw = softmax(secondAptitude, 7.0);

  // 3着確率(third_score使用)
  const thirdAptitude = boats.map(b => b.third_score);
  const thirdProbRaw = softmax(thirdAptitude, 9.0);

  // 各艇の確率を保存
  const firstProbMap = {};
  const secondProbMap = {};
  const thirdProbMap = {};
  boats.forEach((b, i) => {
    firstProbMap[b.boat_number] = firstProb[i];
    secondProbMap[b.boat_number] = secondProbRaw[i];
    thirdProbMap[b.boat_number] = thirdProbRaw[i];
  });

  return { firstP: firstProbMap, secondP: secondProbMap, thirdP: thirdProbMap, boats, numbers };
}

// ============================================================
// 120通りのrace_probability計算(オッズ不使用)
// 合計100%に正規化
// ============================================================
export function computeV3Trifectas(boatScores) {
  const { firstP, secondP, thirdP, boats, numbers } = computeV3Probabilities(boatScores);

  const results = [];
  for (const i of numbers) {
    // 2着は1着以外の艇
    const secondBoats = boats.filter(b => b.boat_number !== i);
    // 条件付き2着確率(1着がiで固定された場合の残り艇の2着確率)
    const secondProbs = secondBoats.map(b => secondP[b.boat_number]);
    const secondSum = secondProbs.reduce((a, b) => a + b, 0);
    const secondNorm = secondSum > 0 ? secondProbs.map(p => p / secondSum) : secondProbs.map(() => 1 / secondBoats.length);
    const secondPCond = {};
    secondBoats.forEach((b, k) => { secondPCond[b.boat_number] = secondNorm[k]; });

    for (const j of numbers) {
      if (j === i) continue;
      // 3着は1着・2着以外の艇
      const thirdBoats = boats.filter(b => b.boat_number !== i && b.boat_number !== j);
      const thirdProbs = thirdBoats.map(b => thirdP[b.boat_number]);
      const thirdSum = thirdProbs.reduce((a, b) => a + b, 0);
      const thirdNorm = thirdSum > 0 ? thirdProbs.map(p => p / thirdSum) : thirdProbs.map(() => 1 / thirdBoats.length);
      const thirdPCond = {};
      thirdBoats.forEach((b, k) => { thirdPCond[b.boat_number] = thirdNorm[k]; });

      for (const k of numbers) {
        if (k === i || k === j) continue;
        const prob = firstP[i] * secondPCond[j] * thirdPCond[k];
        results.push({
          combination: `${i}-${j}-${k}`,
          first_boat: i, second_boat: j, third_boat: k,
          race_probability: Math.round(prob * 1000) / 10,
          rank: 0,
        });
      }
    }
  }

  results.sort((a, b) => b.race_probability - a.race_probability);
  results.forEach((r, idx) => { r.rank = idx + 1; });

  // 正規化(合計100%)
  const total = results.reduce((s, r) => s + r.race_probability, 0);
  if (total > 0 && Math.abs(total - 100) > 0.1) {
    const factor = 100 / total;
    results.forEach(r => { r.race_probability = Math.round(r.race_probability * factor * 10) / 10; });
  }

  return results;
}

// ============================================================
// 【V3新規】1着信頼度・確率ギャップ計算
// ============================================================
function computeFirstConfidence(boatScores, probabilities, stage) {
  const boats = boatScores.filter(b => !b.entry?.is_absent);
  const sorted = [...boats].sort((a, b) => (probabilities.firstP[b.boat_number] || 0) - (probabilities.firstP[a.boat_number] || 0));

  if (sorted.length < 2) return { confidence: 0, gap: 0, top1_prob: 0, top2_prob: 0 };

  const top1 = sorted[0];
  const top2 = sorted[1];
  const top1Prob = (probabilities.firstP[top1.boat_number] || 0) * 100;
  const top2Prob = (probabilities.firstP[top2.boat_number] || 0) * 100;
  const gap = round1(top1Prob - top2Prob);

  // 信頼度: gap大 + top1確率高 + データ十分 → 高信頼
  let confidence = 30;
  confidence += gap * 1.0; // gap 20pt → +20
  confidence += (top1Prob - 30) * 0.5; // top1確率30%超 → 加点
  // データ完全性
  const hasWaku10 = boats.filter(b => b.recent_components?.waku10_win != null).length;
  confidence += hasWaku10 * 2;
  if (stage === "FINAL") {
    const hasExhibition = boats.filter(b => b.today_components?.exhibition_time != null).length;
    confidence += hasExhibition * 3;
  }
  // 1号艇の場合、イン逃げ信頼度を加味
  if (top1.boat_number === 1 && top1.inside_escape_score != null) {
    confidence += (top1.inside_escape_score - 50) * 0.2;
  }

  return {
    confidence: clamp(Math.round(confidence), 0, 100),
    gap,
    top1_boat: top1.boat_number,
    top1_prob: round1(top1Prob),
    top2_boat: top2.boat_number,
    top2_prob: round1(top2Prob),
  };
}

// ============================================================
// 【V3新規】レースタイプ分類
// ============================================================
function classifyRaceType(boatScores, probabilities, firstConfidence, dataConfidence, stage) {
  const boats = boatScores.filter(b => !b.entry?.is_absent);
  const sorted = [...boats].sort((a, b) => (probabilities.firstP[b.boat_number] || 0) - (probabilities.firstP[a.boat_number] || 0));
  const top1 = sorted[0];
  const top1Prob = (probabilities.firstP[top1.boat_number] || 0) * 100;
  const gap = firstConfidence.gap;

  // データ不足
  if (dataConfidence < 30) return { type: "DATA_INSUFFICIENT", reason: "データ信頼度不足" };

  // 進入変更
  const entryChanges = boats.filter(b => {
    const exCourse = b.entry?.exhibition_course;
    return isValid(exCourse) && exCourse !== b.boat_number;
  });
  if (stage === "FINAL" && entryChanges.length >= 2) {
    return { type: "ENTRY_CHANGE", reason: `進入変更${entryChanges.length}艇` };
  }

  // イン信頼型: 1号艇1着確率40%以上 + gap 15pt以上
  if (top1.boat_number === 1 && top1Prob >= 40 && gap >= 15) {
    return { type: "INSIDE_CONFIDENT", reason: `1号艇1着確率${round1(top1Prob)}%・gap${gap}pt` };
  }

  // イン不安型: 1号艇1着確率25%未満
  const boat1 = boats.find(b => b.boat_number === 1);
  const boat1Prob = boat1 ? (probabilities.firstP[1] || 0) * 100 : 0;
  if (boat1Prob < 25) {
    return { type: "INSIDE_WEAK", reason: `1号艇1着確率${round1(boat1Prob)}%が低い` };
  }

  // センター攻撃型: 3/4号艇が1着候補
  if ([3, 4].includes(top1.boat_number) && top1Prob >= 30) {
    return { type: "CENTER_ATTACK", reason: `${top1.boat_number}号艇センター攻撃(${round1(top1Prob)}%)` };
  }

  // 混戦型: gap 5pt未満
  if (gap < 5) {
    return { type: "MIXED", reason: `1着混戦(gap${gap}pt)` };
  }

  // 高配当期待型: トップ確率が低く(20%未満)
  if (top1Prob < 20) {
    return { type: "HIGH_VALUE", reason: `トップ確率${round1(top1Prob)}%が低い` };
  }

  // デフォルト: イン信頼型(条件緩和)
  return { type: "INSIDE_CONFIDENT", reason: `1着軸${top1.boat_number}号(${round1(top1Prob)}%)` };
}

// ============================================================
// 【V3新規】買い目選定(原則6点、7-8点は例外)
// 1着が不安ならWATCH/SKIP。7-8点拡張は1着軸明確時のみ。
// ============================================================
export function selectV3Tickets(trifectas, boatScores, probabilities, firstConfidence, raceType, oddsMap, settings) {
  const maxTickets = 8;
  const defaultTickets = 6;

  // EV計算
  const withEv = trifectas.map(t => {
    const odds = oddsMap?.[t.combination] || null;
    const ev = odds != null ? Math.round(t.race_probability * odds * 10) / 10 : null;
    return { ...t, actual_odds: odds, expected_value: ev, probability: t.race_probability };
  });

  // 1着候補
  const sorted = [...boatScores].sort((a, b) => (probabilities.firstP[b.boat_number] || 0) - (probabilities.firstP[a.boat_number] || 0));
  const top1 = sorted[0];
  const top2 = sorted[1];
  const top3 = sorted[2];
  const top1Prob = (probabilities.firstP[top1.boat_number] || 0) * 100;
  const gap = firstConfidence.gap;

  let selected = [];
  let strategy = "";
  let expandReason = "";

  // 1着軸明確判定: gap >= 10pt かつ top1Prob >= 30%
  const isFirstClear = gap >= 10 && top1Prob >= 30;

  if (isFirstClear) {
    // 1着軸明確: 1着固定型
    strategy = "1着固定型";
    const honmei = top1.boat_number;
    // 2着・3着候補: 確率上位3艇から6通り
    const candidates = sorted.slice(1, 4).map(b => b.boat_number);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        const combo = `${honmei}-${candidates[i]}-${candidates[j]}`;
        const tri = withEv.find(t => t.combination === combo);
        if (tri) selected.push(tri);
      }
    }

    // 7-8点拡張: 2着または3着が混戦の場合のみ
    if (selected.length >= 6 && selected.length < maxTickets) {
      // 2着候補の2位と3位の確率差
      const secondSorted = [...boatScores].sort((a, b) => (probabilities.secondP[b.boat_number] || 0) - (probabilities.secondP[a.boat_number] || 0));
      const secondGap = ((probabilities.secondP[secondSorted[0].boat_number] || 0) - (probabilities.secondP[secondSorted[1].boat_number] || 0)) * 100;
      // 3着候補の2位と3位の確率差
      const thirdSorted = [...boatScores].sort((a, b) => (probabilities.thirdP[b.boat_number] || 0) - (probabilities.thirdP[a.boat_number] || 0));
      const thirdGap = ((probabilities.thirdP[thirdSorted[0].boat_number] || 0) - (probabilities.thirdP[thirdSorted[1].boat_number] || 0)) * 100;

      // 2着または3着が混戦(gap < 3pt) → 拡張可
      if (secondGap < 3 || thirdGap < 3) {
        const fourth = sorted[3];
        if (fourth) {
          // 4位候補を2着・3着に組み込む
          const extra1 = withEv.find(t => t.combination === `${honmei}-${candidates[0]}-${fourth.boat_number}`);
          const extra2 = withEv.find(t => t.combination === `${honmei}-${fourth.boat_number}-${candidates[0]}`);
          if (extra1 && selected.length < maxTickets) { selected.push(extra1); expandReason = "2・3着混戦→4位候補追加"; }
          if (extra2 && selected.length < maxTickets) { selected.push(extra2); }
        }
      }
    }
  } else {
    // 1着混戦: 確率上位6点(1着固定しない)
    strategy = "確率上位型(1着混戦)";
    // EV降順ソート(EV nullは確率順)
    withEv.sort((a, b) => {
      if (a.expected_value != null && b.expected_value != null) return b.expected_value - a.expected_value;
      if (a.expected_value != null) return -1;
      if (b.expected_value != null) return 1;
      return b.race_probability - a.race_probability;
    });
    selected = withEv.slice(0, defaultTickets);
    // 1着混戦時は拡張しない(7-8点禁止)
    expandReason = "1着混戦のため6点固定(拡張なし)";
  }

  // 安全策: 最低6点
  if (selected.length < defaultTickets) {
    for (const t of withEv) {
      if (selected.length >= defaultTickets) break;
      if (!selected.find(s => s.combination === t.combination)) selected.push(t);
    }
  }
  // 安全策: 最大8点
  if (selected.length > maxTickets) {
    selected.sort((a, b) => (b.expected_value || 0) - (a.expected_value || 0));
    selected = selected.slice(0, maxTickets);
  }

  // ランク付与
  selected.sort((a, b) => (b.expected_value || b.race_probability) - (a.expected_value || a.race_probability));
  selected.forEach((t, i) => {
    t.is_selected = true;
    t.ticket_rank = i + 1;
  });

  // 選択外にis_selected=false
  for (const t of withEv) {
    if (!selected.find(s => s.combination === t.combination)) {
      t.is_selected = false;
      t.ticket_rank = null;
    }
  }

  return { selected, all: withEv, strategy, expandReason, ticketCount: selected.length };
}

// ============================================================
// セット期待値計算
// ============================================================
export function computeV3SetMetrics(selectedTickets, oddsMap, settings) {
  if (!selectedTickets.length) return null;

  const setProbability = selectedTickets.reduce((s, t) => s + t.race_probability, 0);
  const oddsValues = selectedTickets
    .map(t => oddsMap?.[t.combination] || t.actual_odds)
    .filter(o => o != null && o > 0);

  const minPayout = oddsValues.length ? Math.min(...oddsValues) * 100 : null;
  const maxPayout = oddsValues.length ? Math.max(...oddsValues) * 100 : null;
  const avgPayout = oddsValues.length
    ? (oddsValues.reduce((s, o) => s + o, 0) / oddsValues.length) * 100
    : null;

  const syntheticOdds = setProbability > 0 ? Math.round(100 / setProbability * 10) / 10 : null;
  const investment = selectedTickets.length * 100;
  const expectedRecovery = avgPayout != null
    ? Math.round((avgPayout * (setProbability / 100)) / investment * 100 * 10) / 10
    : null;

  const bestEv = selectedTickets.reduce((best, t) => {
    const ev = t.expected_value || 0;
    return ev > (best?.expected_value || 0) ? t : best;
  }, selectedTickets[0]);

  return {
    set_probability: round2(setProbability),
    set_expected_recovery: expectedRecovery,
    synthetic_odds: syntheticOdds,
    min_payout: minPayout, avg_payout: avgPayout, max_payout: maxPayout,
    best_ev_ticket: bestEv?.combination || null,
    investment,
  };
}

// ============================================================
// 【V3新規】データ完全性チェック
// ============================================================
function computeDataCompleteness(boatScores, stage, oddsMap) {
  const boats = boatScores.filter(b => !b.entry?.is_absent);
  const hasEntry = boats.length >= 6;
  const hasWaku10 = boats.filter(b => b.recent_components?.waku10_win != null).length >= 4;
  const hasProfile = boats.filter(b => b.past_components?.national_win != null).length >= 4;
  const hasExhibition = stage === "FINAL" && boats.filter(b => b.today_components?.exhibition_time != null).length >= 4;
  const hasOdds = oddsMap && Object.keys(oddsMap).length >= 50;

  const is_complete = hasEntry && hasWaku10 && hasProfile && (stage !== "FINAL" || hasExhibition);

  return {
    has_entry: hasEntry,
    has_exhibition: hasExhibition || stage !== "FINAL",
    has_waku10: hasWaku10,
    has_odds: hasOdds,
    has_profile: hasProfile,
    is_complete,
  };
}

// ============================================================
// 【V3新規】BUY6条件判定
// A: 1着信頼度, B: セット確率, C: オッズ, D: 期待回収率, E: 展示信頼度, F: データ完全性
// ============================================================
function judgeV3(setMetrics, firstConfidence, dataCompleteness, raceType, settings, stage) {
  const recovery = setMetrics?.set_expected_recovery;
  const setProb = setMetrics?.set_probability;
  const buyThreshold = settings?.buy_set_ev_threshold || 120;
  const watchThreshold = settings?.watch_set_ev_threshold || 90;
  const minProb = settings?.min_set_probability || 25;
  const minFirstConfidence = 50;

  // 6条件チェック
  const conditions = {
    A_first_confidence: firstConfidence.confidence >= minFirstConfidence,
    B_set_probability: setProb != null && setProb >= minProb,
    C_odds_available: recovery != null,
    D_expected_recovery: recovery != null && recovery >= buyThreshold,
    E_exhibition_confidence: stage !== "FINAL" || (firstConfidence.confidence >= 45),
    F_data_completeness: dataCompleteness.is_complete,
  };
  const passedCount = Object.values(conditions).filter(Boolean).length;

  // データ不足 → SKIP
  if (!dataCompleteness.is_complete) {
    return { judgment: "SKIP", reason: "DATA_INCOMPLETE: データ完全性不足", conditions, passedCount };
  }

  // 1着信頼度不足 → WATCH/SKIP
  if (!conditions.A_first_confidence) {
    if (firstConfidence.confidence < 30) {
      return { judgment: "SKIP", reason: `1着信頼度${firstConfidence.confidence}不足`, conditions, passedCount };
    }
    return { judgment: "WATCH", reason: `1着信頼度${firstConfidence.confidence}が基準${minFirstConfidence}未満`, conditions, passedCount };
  }

  // オッズ未取得 → SKIP
  if (!conditions.C_odds_available) {
    return { judgment: "SKIP", reason: "オッズ未取得", conditions, passedCount };
  }

  // セット確率不足 → SKIP
  if (!conditions.B_set_probability) {
    return { judgment: "SKIP", reason: `セット確率${setProb}%が最低値${minProb}%未満`, conditions, passedCount };
  }

  // 期待回収率判定
  if (recovery >= buyThreshold && conditions.E_exhibition_confidence) {
    return { judgment: "BUY", reason: `6条件中${passedCount}条件通過・期待回収率${recovery}%≥${buyThreshold}%`, conditions, passedCount };
  }
  if (recovery >= watchThreshold) {
    return { judgment: "WATCH", reason: `期待回収率${recovery}%≥${watchThreshold}%・BUY基準${buyThreshold}%未満`, conditions, passedCount };
  }
  return { judgment: "SKIP", reason: `期待回収率${recovery}%<${watchThreshold}%`, conditions, passedCount };
}

// ============================================================
// 確率校正(予測確率帯ごとの補正係数)
// 過去の検証データから算出。本番予想への補正係数としてのみ使用。
// ============================================================
export function applyCalibration(raceProbability, calibrationFactor) {
  if (!calibrationFactor || !isValid(calibrationFactor) || calibrationFactor <= 0) return raceProbability;
  return Math.round(raceProbability * calibrationFactor * 10) / 10;
}

// ============================================================
// メイン: V3予想実行
// ============================================================
export function runPredictionV3(entries, race, settings, options = {}) {
  const stage = options.stage || settings?.stage || "PRE";
  const oddsMap = options.oddsMap || {};
  const calibrationFactors = options.calibrationFactors || null;

  // Boat Scores計算
  const boatScores = computeV3BoatScores(entries, race, stage);

  // 確率計算
  const probabilities = computeV3Probabilities(boatScores);

  // 1着信頼度
  const firstConfidence = computeFirstConfidence(boatScores, probabilities, stage);

  // 120通りrace_probability
  const trifectas = computeV3Trifectas(boatScores);

  // 確率校正(補正係数がある場合)
  if (calibrationFactors) {
    for (const t of trifectas) {
      const band = getProbabilityBand(t.race_probability);
      const factor = calibrationFactors[band];
      t.race_probability = applyCalibration(t.race_probability, factor);
    }
    // 再正規化
    const total = trifectas.reduce((s, r) => s + r.race_probability, 0);
    if (total > 0) {
      const factor = 100 / total;
      trifectas.forEach(r => { r.race_probability = Math.round(r.race_probability * factor * 10) / 10; });
    }
    trifectas.sort((a, b) => b.race_probability - a.race_probability);
    trifectas.forEach((r, idx) => { r.rank = idx + 1; });
  }

  // データ信頼度
  const dataConfidence = computeDataConfidence(boatScores, stage);

  // データ完全性
  const dataCompleteness = computeDataCompleteness(boatScores, stage, oddsMap);

  // レースタイプ分類
  const raceType = classifyRaceType(boatScores, probabilities, firstConfidence, dataConfidence, stage);

  // 買い目選定
  const ticketSelection = selectV3Tickets(trifectas, boatScores, probabilities, firstConfidence, raceType, oddsMap, settings);
  const selected = ticketSelection.selected;

  // セット期待値
  const setMetrics = computeV3SetMetrics(selected, oddsMap, settings);

  // 判定
  const judgment = judgeV3(setMetrics, firstConfidence, dataCompleteness, raceType, settings, stage);

  // ランキング
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";
  const firstRanking = [...boatScores].sort((a, b) => (probabilities.firstP[b.boat_number] || 0) - (probabilities.firstP[a.boat_number] || 0)).map(b => b.boat_number);
  const secondRanking = [...boatScores].sort((a, b) => (probabilities.secondP[b.boat_number] || 0) - (probabilities.secondP[a.boat_number] || 0)).map(b => b.boat_number);
  const thirdRanking = [...boatScores].sort((a, b) => (probabilities.thirdP[b.boat_number] || 0) - (probabilities.thirdP[a.boat_number] || 0)).map(b => b.boat_number);

  // 本命・対抗・穴・消し
  const honmei = firstRanking[0];
  const taiko = firstRanking[1];
  const ana = firstRanking[2];
  const keshi = firstRanking[firstRanking.length - 1];

  // トップ3連単
  const topTrifecta = trifectas[0];
  const topOdds = oddsMap?.[topTrifecta.combination] || null;
  const topEv = topOdds != null ? Math.round(topTrifecta.race_probability * topOdds * 10) / 10 : null;

  // 各艇のfirst_probabilityをboatScoresに反映
  for (const b of boatScores) {
    b.first_probability = round1((probabilities.firstP[b.boat_number] || 0) * 100);
    b.second_probability = round1((probabilities.secondP[b.boat_number] || 0) * 100);
    b.third_probability = round1((probabilities.thirdP[b.boat_number] || 0) * 100);
    b.first_confidence = firstConfidence.confidence;
  }

  // 条件付き重み
  const condWeights = computeConditionalWeights(entries.filter(e => !e.is_absent && e.boat_number), race, stage);

  // データソース使用状況
  const dataSources = {
    national: boatScores.some(b => b.past_components?.national_win != null),
    local: boatScores.some(b => b.past_components?.local_win != null),
    waku10: boatScores.some(b => b.recent_components?.waku10_win != null),
    section: boatScores.some(b => b.recent_components?.section != null),
    motor: boatScores.some(b => b.today_components?.motor != null),
    exhibition: stage === "FINAL" && boatScores.some(b => b.today_components?.exhibition_time != null),
    entry: stage === "FINAL" && boatScores.some(b => b.today_components?.exhibition_course != null),
    weather: isValid(race?.wind_speed) || isValid(race?.wave_height),
  };

  return {
    boatScores,
    trifectas: ticketSelection.all,
    selected_trifectas: selected.map(t => t.combination),
    ticket_count: selected.length,
    ticket_selection: { selected, strategy: ticketSelection.strategy, expandReason: ticketSelection.expandReason },
    set_metrics: setMetrics,
    data_confidence: dataConfidence,
    data_completeness: dataCompleteness,
    race_type: raceType.type,
    race_type_reason: raceType.reason,
    final_judgment: judgment.judgment,
    judgment_reason: judgment.reason,
    buy_conditions: judgment.conditions,
    buy_conditions_passed: judgment.passedCount,
    first_confidence: firstConfidence.confidence,
    first_probability_gap: firstConfidence.gap,
    first_confidence_detail: firstConfidence,
    inside_escape_reliability: boatScores.find(b => b.boat_number === 1)?.inside_escape_score,
    prediction_grade: dataConfidence >= 70 ? "S" : dataConfidence >= 50 ? "A" : dataConfidence >= 30 ? "B" : "C",
    honmei_boat: honmei, taiko_boat: taiko, ana_boat: ana, keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination, top_probability: topTrifecta?.race_probability,
    top_odds: topOdds, top_expected_value: topEv,
    first_ranking: firstRanking, second_ranking: secondRanking, third_ranking: thirdRanking,
    data_sources_used: dataSources,
    conditional_weights: {
      past: condWeights.weights.past,
      recent: condWeights.weights.recent,
      today: condWeights.weights.today,
      exhibition_st_spread: condWeights.exhibition_st_spread,
      entry_change_detected: condWeights.entry_change_detected,
      rough_water: condWeights.rough_water,
    },
    v3_weights: V3_BASE_WEIGHTS,
    calibration_applied: calibrationFactors ? { source: "historical_verification", factors: calibrationFactors } : null,
  };
}

// 確率帯判定
function getProbabilityBand(prob) {
  if (prob < 5) return "0-5";
  if (prob < 10) return "5-10";
  if (prob < 15) return "10-15";
  if (prob < 20) return "15-20";
  if (prob < 30) return "20-30";
  return "30+";
}

// データ信頼度計算(V2と同一)
function computeDataConfidence(boatScores, stage) {
  let conf = 50;
  const hasWaku10 = boatScores.filter(b => b.recent_components?.waku10_win != null).length;
  conf += hasWaku10 * 5;
  const hasProfile = boatScores.filter(b => b.past_components?.course_win != null).length;
  conf += hasProfile * 3;
  if (stage === "FINAL") {
    const hasExhibition = boatScores.filter(b => b.today_components?.exhibition_time != null).length;
    conf += hasExhibition * 5;
  }
  return clamp(conf, 0, 100);
}