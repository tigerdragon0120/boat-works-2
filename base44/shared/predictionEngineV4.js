// ============================================================
// Prediction Engine V4 HIT Candidate
// 的中率30%を最優先する予想ロジック
// V3とは完全独立。V3を一切変更しない。
//
// 核心思想:
// 1. Lane Prior(実績1着分布)をBayesian事前確率として使用
// 2. 条件付き確率 P(2着|1着), P(3着|1着,2着) を導入
// 3. 5/6号艇1着を厳格抑制(複数独立根拠が必要)
// 4. ST過大評価を修正(外枠はST単独で1着にしない)
// 5. 6点選択を的中率最大化目的に変更
// ============================================================

const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

// V4重み配分(V3と同一)
const V4_WEIGHTS = { past: 0.25, recent: 0.35, today: 0.40 };

// ============================================================
// Lane Prior: 実績1着分布(直近350R)
// 1号艇52%, 2号艇14.3%, 3号艇14.6%, 4号艇10.9%, 5号艇5.4%, 6号艇2.9%
// ============================================================
const LANE_PRIOR = {
  1: 0.52, 2: 0.143, 3: 0.146, 4: 0.109, 5: 0.054, 6: 0.029,
};

// ============================================================
// 条件付き確率 P(2着= j | 1着= i)
// 実績データから算出(350R)
// ============================================================
const COND_2ND_GIVEN_1ST = {
  1: { 2: 0.352, 3: 0.209, 4: 0.209, 5: 0.137, 6: 0.093 },
  2: { 1: 0.44,  3: 0.36,  4: 0.08,  5: 0.08,  6: 0.04 },
  3: { 1: 0.392, 2: 0.098, 4: 0.216, 5: 0.176, 6: 0.118 },
  4: { 1: 0.368, 2: 0.184, 3: 0.263, 5: 0.132, 6: 0.053 },
  5: { 1: 0.263, 2: 0.316, 3: 0.158, 4: 0.158, 6: 0.105 },
  6: { 1: 0.50,  2: 0.10,  3: 0.00,  4: 0.20,  5: 0.20 },
};

// ST値→スコア(低い=良い)
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
// 1. 過去評価 25%
// ============================================================
function computePastScore(entry) {
  const profile = entry._profile;
  const rolling = entry._rollingStats;
  const course = entry.boat_number;

  const nationalWin = isValid(entry.national_win_rate) ? clamp(entry.national_win_rate * 10, 0, 100) : null;
  const nationalF2 = isValid(entry.national_f2_rate ?? entry.national_2rate) ? clamp(Number(entry.national_f2_rate ?? entry.national_2rate), 0, 100) : null;
  const localWin = isValid(entry.local_win_rate) ? clamp(entry.local_win_rate * 10, 0, 100) : null;
  const localF2 = isValid(entry.local_f2_rate ?? entry.local_2rate) ? clamp(Number(entry.local_f2_rate ?? entry.local_2rate), 0, 100) : null;
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
// 2. 直近評価 35%
// ============================================================
function computeRecentScore(entry) {
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
// 3. 当日評価 40% (FINAL only)
// V4修正: 外枠(5/6)のST weightを半減
// ============================================================
function computeTodayScore(entry, allEntries, race) {
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

  const motorScore = isValid(entry.motor_f2_rate ?? entry.motor_2rate) ? clamp(Number(entry.motor_f2_rate ?? entry.motor_2rate), 0, 100) : null;
  const boatScore = isValid(entry.boat_f2_rate ?? entry.boat_2rate) ? clamp(Number(entry.boat_f2_rate ?? entry.boat_2rate), 0, 100) : null;

  const exTimeAbsScore = exTime != null ? clamp(50 + (1.4 - exTime) * 100, 5, 100) : null;

  const components = {
    exhibition_time: exTime, exhibition_time_rank: exTimeRank, exhibition_time_rank_score: exTimeRankScore,
    exhibition_st: exSt, exhibition_st_score: exStScore, exhibition_st_rank: exStRank, exhibition_st_rank_score: exStRankScore,
    exhibition_course: exCourse, entry_adjust: entryAdjust,
    tilt, motor: motorScore, boat: boatScore,
    exhibition_time_abs: exTimeAbsScore,
  };

  // V4修正: 外枠(5/6)はST weightを半減し、展示タイム+モーターを重視
  const isOutside = entry.boat_number >= 5;
  const stWeight = isOutside ? 0.10 : 0.20;  // 外枠はST weight半減
  const stRankWeight = isOutside ? 0.05 : 0.10;
  const timeWeight = isOutside ? 0.30 : 0.25;  // 外枠は展示タイム重視
  const motorWeight = isOutside ? 0.20 : 0.15;  // 外枠はモーター重視

  const score = weightedAvg([
    [exTimeRankScore, timeWeight], [exTimeAbsScore, 0.10],
    [exStScore, stWeight], [exStRankScore, stRankWeight],
    [motorScore, motorWeight], [boatScore, 0.08],
    [clamp(50 + entryAdjust, 0, 100), 0.12],
  ]);

  return { score: round1(score), components, isOutside };
}

// ============================================================
// Boat Scores計算
// 欠場艇(is_scratched/is_absent/Race.scratched_boats)を完全除外
// ============================================================
function computeV4BoatScores(entries, race, stage) {
  const isFinal = stage === "FINAL";
  const scratchedBoats = race?.scratched_boats || [];
  const activeEntries = entries.filter(e =>
    !e.is_absent && !e.is_scratched && e.boat_number &&
    !(Array.isArray(scratchedBoats) && scratchedBoats.includes(e.boat_number))
  );

  const boats = activeEntries.map(entry => {
    const past = computePastScore(entry);
    const recent = computeRecentScore(entry);
    const today = isFinal ? computeTodayScore(entry, activeEntries, race) : { score: null, components: {}, isOutside: false };

    let pre_score;
    if (today.score != null) {
      pre_score = clamp(
        past.score * V4_WEIGHTS.past + recent.score * V4_WEIGHTS.recent + today.score * V4_WEIGHTS.today,
        0, 100
      );
    } else {
      const totalW = V4_WEIGHTS.past + V4_WEIGHTS.recent;
      pre_score = clamp(
        (past.score * V4_WEIGHTS.past + recent.score * V4_WEIGHTS.recent) / totalW,
        0, 100
      );
    }

    return {
      boat_number: entry.boat_number,
      entry,
      past_score: past.score,
      recent_score: recent.score,
      today_score: today.score,
      pre_score: round1(pre_score),
      final_delta: null,
      final_score: null,
      past_components: past.components,
      recent_components: recent.components,
      today_components: today.components,
      isOutside: today.isOutside || entry.boat_number >= 5,
      reasons: [],
      notes: [],
    };
  });

  if (isFinal) {
    for (const b of boats) {
      const finalScore = clamp(
        b.past_score * V4_WEIGHTS.past + b.recent_score * V4_WEIGHTS.recent + b.today_score * V4_WEIGHTS.today,
        0, 100
      );
      b.final_score = round1(finalScore);
      b.final_delta = round1(finalScore - b.pre_score);
    }
  }

  return boats;
}

// ============================================================
// 4. 1着確率計算: Lane Prior + Bayesian調整
// V4修正: Lane Priorを弱め(prior^0.3)、TEMP=20でスコア重視
// 1号艇-only補正(insideEscapeBonus)は廃止・過補正のため
// ============================================================
function computeFirstProbabilitiesWithPrior(boatScores, stage) {
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";

  // 1着適性スコア: base score + コース別勝ち方ボーナス(全艇共通)
  const firstAptitudes = boatScores.map(b => {
    const base = b[scoreField] ?? b.pre_score;
    const course = b.boat_number;
    const wm = b.entry?._profile?.winning_methods;
    let escapeBonus = 0;
    if (wm?.total_wins >= 2) {
      if (course === 1 && wm.escape_rate != null) escapeBonus = wm.escape_rate * 0.10;
      if (course === 2 && wm.sashi_rate != null) escapeBonus = wm.sashi_rate * 0.08;
      if (course === 3 && wm.makuri_rate != null) escapeBonus = wm.makuri_rate * 0.06;
      if (course >= 4 && (wm.makuri_rate || 0) + (wm.makuri_sashi_rate || 0) > 0) {
        escapeBonus = ((wm.makuri_rate || 0) + (wm.makuri_sashi_rate || 0)) * 0.06;
      }
    }
    b.first_score = round1(clamp(base + escapeBonus, 5, 100));
    return b.first_score;
  });

  // Lane Prior × スコア調整
  // PRIOR_STRENGTH = 0.3: priorを0.3乗して弱める(1号艇52%→27.5%)
  // TEMP = 20: スコア差20ptでe^1=2.7倍の調整(スコア重視)
  const TEMP = 20;
  const PRIOR_STRENGTH = 0.3;
  const rawProbs = boatScores.map((b, i) => {
    const prior = LANE_PRIOR[b.boat_number] || 0.05;
    const weakPrior = Math.pow(prior, PRIOR_STRENGTH);
    const multiplier = Math.exp((firstAptitudes[i] - 50) / TEMP);
    return weakPrior * multiplier;
  });

  const sum = rawProbs.reduce((a, b) => a + b, 0);
  const firstProbs = rawProbs.map(r => round2((r / sum) * 100));

  return firstProbs;
}

// ============================================================
// 5. 5/6号艇1着抑制チェック
// 複数の独立した根拠が必要
// ============================================================
function checkFiftySixSuppression(boatScores, firstProbs, stage) {
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";
  const sortedByFirst = [...boatScores].map((b, i) => ({ b, i, prob: firstProbs[i] }))
    .sort((a, b) => b.prob - a.prob);
  const topBoat = sortedByFirst[0];
  const secondBoat = sortedByFirst[1];
  const gap = topBoat.prob - secondBoat.prob;

  // 5/6号艇が1着候補でない場合は抑制不要
  if (topBoat.b.boat_number < 5) {
    return { suppressed: false, reason: null, conditions: null, adjustedProbs: firstProbs };
  }

  const boat = topBoat.b;
  const boatNum = boat.boat_number;

  // 展示ST順位
  const exStValues = boatScores.map(b => b.entry?.exhibition_st);
  const validSt = boatScores.filter(b => isValid(b.entry?.exhibition_st));
  const stSorted = [...validSt].sort((a, b) => Math.abs(a.entry.exhibition_st) - Math.abs(b.entry.exhibition_st));
  const stRank = stSorted.findIndex(b => b.boat_number === boatNum) + 1;
  const stRankOk = stRank >= 1 && stRank <= 2;

  // 過去/直近/当日のうち2系統以上で上位2位
  const pastRanks = rankHigh(boatScores.map(b => b.past_score));
  const recentRanks = rankHigh(boatScores.map(b => b.recent_score));
  const todayRanks = rankHigh(boatScores.map(b => b.today_score));
  const boatIdx = boatScores.indexOf(boat);
  const pastRank = pastRanks[boatIdx];
  const recentRank = recentRanks[boatIdx];
  const todayRank = todayRanks[boatIdx];
  const topCount = [pastRank, recentRank, todayRank].filter(r => r != null && r <= 2).length;
  const multiAxisOk = topCount >= 2;

  // 1号艇の弱さ
  const boat1 = boatScores.find(b => b.boat_number === 1);
  const boat1Weak = boat1 ? (boat1[scoreField] ?? boat1.pre_score) < 45 : false;
  const boat1WeakOk = boat1Weak;

  // 攻撃パターン(まくり/まくり差し)
  const wm = boat.entry?._profile?.winning_methods;
  const attackRate = (wm?.makuri_rate || 0) + (wm?.makuri_sashi_rate || 0);
  const attackPatternOk = attackRate >= 30;

  // 進入変更(内側へ)
  const exCourse = boat.entry?.exhibition_course;
  const entryChangeOk = isValid(exCourse) && exCourse < boatNum;

  // 確率条件
  const firstProbOk = topBoat.prob >= 35;
  const gapOk = gap >= 12;

  const conditions = {
    first_probability_ok: firstProbOk,
    gap_ok: gapOk,
    st_rank_ok: stRankOk,
    multi_axis_ok: multiAxisOk,
    boat1_weak_ok: boat1WeakOk,
    attack_pattern_ok: attackPatternOk,
    entry_change_ok: entryChangeOk,
    passed_count: [firstProbOk, gapOk, stRankOk, multiAxisOk, boat1WeakOk, attackPatternOk, entryChangeOk].filter(Boolean).length,
  };

  // 4条件以上で抑制解除、それ以外は抑制
  const threshold = 4;
  const suppressed = conditions.passed_count < threshold;

  if (suppressed) {
    // 5/6号艇の1着確率を70%カット→残りを再配分
    const adjustedProbs = [...firstProbs];
    const originalProb = adjustedProbs[boatIdx];
    adjustedProbs[boatIdx] = round2(originalProb * 0.3);
    const remaining = originalProb - adjustedProbs[boatIdx];
    // 残りを他艇へ比例配分
    const otherSum = adjustedProbs.reduce((s, p, i) => i === boatIdx ? s : s + p, 0);
    if (otherSum > 0) {
      for (let i = 0; i < adjustedProbs.length; i++) {
        if (i !== boatIdx) {
          adjustedProbs[i] = round2(adjustedProbs[i] + remaining * (adjustedProbs[i] / otherSum));
        }
      }
    }
    // 正規化
    const total = adjustedProbs.reduce((s, p) => s + p, 0);
    if (total > 0) {
      for (let i = 0; i < adjustedProbs.length; i++) {
        adjustedProbs[i] = round2(adjustedProbs[i] / total * 100);
      }
    }

    return {
      suppressed: true,
      reason: `5/${boatNum}号艇1着条件${conditions.passed_count}/${threshold}不十分→抑制`,
      conditions,
      adjustedProbs,
      suppressedBoatIdx: boatIdx,
    };
  }

  return { suppressed: false, reason: null, conditions, adjustedProbs: firstProbs };
}

// ============================================================
// 6. 条件付き3連単確率計算
// P(1着=i) × P(2着=j|1着=i) × P(3着=k|1着=i,2着=j)
// ============================================================
function computeConditionalTrifectas(boatScores, firstProbs, stage) {
  const boats = boatScores;
  const numbers = boats.map(b => b.boat_number);
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";

  // 2着適性: base score + top2_rate
  const secondAptitude = boats.map(b => {
    const base = b[scoreField] ?? b.pre_score;
    const top2 = b.recent_components?.waku10_top2;
    const adj = top2 != null ? (top2 - 50) * 0.10 : 0;
    return clamp(base + adj, 5, 100);
  });

  // 3着適性: base score + top3_rate
  const thirdAptitude = boats.map(b => {
    const base = b[scoreField] ?? b.pre_score;
    const top3 = b.recent_components?.waku10_top3;
    const adj = top3 != null ? (top3 - 50) * 0.08 : 0;
    return clamp(base + adj, 5, 100);
  });

  const softmax = (scores, temp) => {
    if (!scores.length) return [];
    const max = Math.max(...scores);
    const weights = scores.map(s => Math.exp((s - max) / temp));
    const sum = weights.reduce((a, b) => a + b, 0);
    return sum > 0 ? weights.map(w => w / sum) : weights.map(() => 1 / scores.length);
  };

  const results = [];

  for (const i of numbers) {
    const iIdx = boats.findIndex(b => b.boat_number === i);
    const firstP = firstProbs[iIdx] / 100;

    // 2着候補
    const secondBoats = boats.filter(b => b.boat_number !== i);
    // 条件付き確率ベース + スコア調整
    const secondRawProbs = secondBoats.map(b => {
      const histProb = COND_2ND_GIVEN_1ST[i]?.[b.boat_number] || (1 / 5);
      const idx = boats.indexOf(b);
      const scoreAdj = Math.exp((secondAptitude[idx] - 50) / 20);
      return histProb * scoreAdj;
    });
    const secondSum = secondRawProbs.reduce((a, b) => a + b, 0);
    const secondProbs = secondSum > 0 ? secondRawProbs.map(p => p / secondSum) : secondRawProbs.map(() => 1 / secondBoats.length);
    const secondP = {};
    secondBoats.forEach((b, k) => { secondP[b.boat_number] = secondProbs[k]; });

    for (const j of numbers) {
      if (j === i) continue;
      const thirdBoats = boats.filter(b => b.boat_number !== i && b.boat_number !== j);
      // 3着は条件付き歴史データがないため、3着適性のsoftmax
      const thirdScores = thirdBoats.map(b => {
        const idx = boats.indexOf(b);
        return thirdAptitude[idx];
      });
      const thirdProbsArr = softmax(thirdScores, 10);
      const thirdP = {};
      thirdBoats.forEach((b, k) => { thirdP[b.boat_number] = thirdProbsArr[k]; });

      for (const k of numbers) {
        if (k === i || k === j) continue;
        const prob = firstP * (secondP[j] || 0) * (thirdP[k] || 0);
        results.push({
          combination: `${i}-${j}-${k}`,
          first_boat: i, second_boat: j, third_boat: k,
          probability: Math.round(prob * 1000) / 10,
          rank: 0,
        });
      }
    }
  }

  // ランク付与
  results.sort((a, b) => b.probability - a.probability);
  results.forEach((r, idx) => { r.rank = idx + 1; });

  // 正規化
  const total = results.reduce((s, r) => s + r.probability, 0);
  if (total > 0 && Math.abs(total - 100) > 0.1) {
    const factor = 100 / total;
    results.forEach(r => { r.probability = Math.round(r.probability * factor * 10) / 10; });
  }

  return results;
}

// ============================================================
// 7. 6点選択: 的中率最大化
// 1着軸1〜2艇に絞り、2着3艇×3着2艇 = 6点
// 5/6号艇1着は抑制済みのもののみ軸に
// ============================================================
function selectHitTickets(trifectas, boatScores, firstProbs, suppressionResult, oddsMap) {
  const sortedByFirst = boatScores.map((b, i) => ({ b, i, prob: firstProbs[i] }))
    .sort((a, b) => b.prob - a.prob);

  // 1着候補: 抑制された5/6号艇はスキップ
  const firstCandidates = [];
  for (const { b, i, prob } of sortedByFirst) {
    if (b.boat_number >= 5 && suppressionResult.suppressed) {
      // 抑制された5/6号艇は1着軸にしない
      continue;
    }
    firstCandidates.push({ boat: b.boat_number, prob, idx: i });
  }

  // 戦略決定: 1軸 or 2軸
  const top1 = firstCandidates[0];
  const top2 = firstCandidates[1];
  let strategy = "1軸";
  let firstAxis = [top1.boat];

  // top1確率 >= 35% → 1軸
  // top1+top2確率 >= 50% → 2軸
  if (top1.prob < 35 && top2 && (top1.prob + top2.prob) >= 50) {
    strategy = "2軸";
    firstAxis = [top1.boat, top2.boat];
  }

  const selected = [];
  const selectedSet = new Set();

  if (strategy === "1軸") {
    // 1-ABC-ABC: 2着3艇 × 3着2艇 = 6点
    const firstBoat = top1.boat;
    // 2着候補: 条件付き確率順上位3艇(1着以外)
    const secondCandidates = trifectas
      .filter(t => t.first_boat === firstBoat)
      .sort((a, b) => b.probability - a.probability)
      .map(t => t.second_boat);
    const uniqueSecond = [...new Set(secondCandidates)].slice(0, 3);

    for (const secondBoat of uniqueSecond) {
      // 3着候補: 上位2艇
      const thirdCandidates = trifectas
        .filter(t => t.first_boat === firstBoat && t.second_boat === secondBoat)
        .sort((a, b) => b.probability - a.probability)
        .map(t => t.third_boat);
      const uniqueThird = [...new Set(thirdCandidates)].slice(0, 2);

      for (const thirdBoat of uniqueThird) {
        const combo = `${firstBoat}-${secondBoat}-${thirdBoat}`;
        if (!selectedSet.has(combo)) {
          selectedSet.add(combo);
          selected.push(combo);
        }
        if (selected.length >= 6) break;
      }
      if (selected.length >= 6) break;
    }

    // 6点に満たない場合: 次位の3連単で補完
    if (selected.length < 6) {
      for (const t of trifectas.sort((a, b) => b.probability - a.probability)) {
        if (t.first_boat === firstBoat && !selectedSet.has(t.combination)) {
          selectedSet.add(t.combination);
          selected.push(t.combination);
        }
        if (selected.length >= 6) break;
      }
    }
  } else {
    // 2軸: 各1着候補につき上位3組合せ = 6点
    for (const firstBoat of firstAxis) {
      const combos = trifectas
        .filter(t => t.first_boat === firstBoat)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, 3);
      for (const t of combos) {
        if (!selectedSet.has(t.combination)) {
          selectedSet.add(t.combination);
          selected.push(t.combination);
        }
        if (selected.length >= 6) break;
      }
      if (selected.length >= 6) break;
    }
    // 6点に満たない場合: 残りを確率順で補完
    if (selected.length < 6) {
      for (const t of trifectas.sort((a, b) => b.probability - a.probability)) {
        if (!selectedSet.has(t.combination)) {
          selectedSet.add(t.combination);
          selected.push(t.combination);
        }
        if (selected.length >= 6) break;
      }
    }
  }

  // 7-8点拡張: 確率だけで無条件に8点化しない。
  // 7点目は的中補強、8点目は十分な期待値がある場合だけ追加する。
  const extensionCandidates = trifectas
    .filter(t => !selectedSet.has(t.combination))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 2);

  const seventh = extensionCandidates[0];
  if (seventh) {
    const odds = oddsMap?.[seventh.combination];
    const ev = odds != null ? seventh.probability * odds : null;
    const qualifies = seventh.probability >= 2.5 &&
      (ev != null ? ev >= 100 : seventh.probability >= 3);
    if (qualifies) {
      selectedSet.add(seventh.combination);
      selected.push(seventh.combination);
    }
  }

  const eighth = extensionCandidates[1];
  if (selected.length === 7 && eighth) {
    const odds = oddsMap?.[eighth.combination];
    const ev = odds != null ? eighth.probability * odds : null;
    const qualifies = eighth.probability >= 2 && ev != null && ev >= 120;
    if (qualifies) {
      selectedSet.add(eighth.combination);
      selected.push(eighth.combination);
    }
  }

  return { selected, strategy, firstAxis };
}

// ============================================================
// セット期待値計算
// ============================================================
function computeV4SetMetrics(selectedTrifectas, trifectas, oddsMap, settings) {
  if (!selectedTrifectas.length) return null;

  const selectedData = selectedTrifectas.map(combo => {
    const t = trifectas.find(x => x.combination === combo);
    return { combination: combo, probability: t?.probability || 0 };
  });

  const setProbability = selectedData.reduce((s, t) => s + t.probability, 0);
  const oddsValues = selectedData
    .map(t => oddsMap?.[t.combination])
    .filter(o => o != null && o > 0);

  const minPayout = oddsValues.length ? Math.min(...oddsValues) * 100 : null;
  const maxPayout = oddsValues.length ? Math.max(...oddsValues) * 100 : null;
  const avgPayout = oddsValues.length
    ? (oddsValues.reduce((s, o) => s + o, 0) / oddsValues.length) * 100
    : null;

  const syntheticOdds = setProbability > 0 ? Math.round(100 / setProbability * 10) / 10 : null;
  // 各買い目の確率×オッズを合算し、点数で割った実投資ベースの期待回収率。
  // 「平均オッズ×合計確率」は高確率と高オッズを誤って組み合わせるため使わない。
  const expectedRecovery = oddsValues.length === selectedData.length
    ? Math.round((selectedData.reduce((sum, t) => {
        const odds = oddsMap?.[t.combination];
        return sum + (Number.isFinite(odds) ? t.probability * odds : 0);
      }, 0) / selectedData.length) * 10) / 10
    : null;

  const bestEv = selectedData.reduce((best, t) => {
    const odds = oddsMap?.[t.combination];
    const ev = odds != null ? Math.round(t.probability * odds * 10) / 10 : 0;
    return ev > (best?.ev || 0) ? { combination: t.combination, ev } : best;
  }, { combination: selectedData[0]?.combination, ev: 0 });

  return {
    set_probability: round2(setProbability),
    set_expected_recovery: expectedRecovery,
    synthetic_odds: syntheticOdds,
    min_payout: minPayout, avg_payout: avgPayout, max_payout: maxPayout,
    best_ev_ticket: bestEv?.combination || null,
  };
}

// ============================================================
// BUY/WATCH/SKIP判定: 的中率重視
// ============================================================
function judgeV4(setMetrics, firstProbs, boatScores, suppressionResult, stage) {
  const topProb = Math.max(...firstProbs);
  const sorted = [...firstProbs].sort((a, b) => b - a);
  const gap = sorted[0] - sorted[1];
  const setProb = setMetrics?.set_probability;
  const recovery = setMetrics?.set_expected_recovery;

  // 1着信頼度
  const firstConfidence = clamp(topProb + gap * 0.5, 0, 100);

  // BUY条件: 的中率30%目標
  // 1着信頼度高 + セット確率十分 + データ完全
  const conditions = {
    first_confident: firstConfidence >= 50,
    set_prob_ok: setProb != null && setProb >= 25,
    gap_ok: gap >= 8,
    not_suppressed: !suppressionResult.suppressed,
  };
  const passedCount = Object.values(conditions).filter(Boolean).length;

  if (recovery != null && recovery < 80 && stage === "FINAL") {
    if (passedCount >= 3 && firstConfidence >= 55 && setProb >= 30) {
      return { judgment: "BUY", reason: `的中率優先BUY(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%・回収率${recovery}%WARNING)` };
    }
    if (firstConfidence >= 40 && setProb >= 20) {
      return { judgment: "WATCH", reason: `回収率${recovery}%<80%WARNING・1着信頼度${round1(firstConfidence)}・セット確率${setProb}%` };
    }
    return { judgment: "SKIP", reason: `回収率${recovery}%<80%・1着信頼度不足` };
  }

  if (passedCount >= 3 && firstConfidence >= 50 && setProb >= 25) {
    return { judgment: "BUY", reason: `的中率型BUY(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%・Gap${round1(gap)}pt)` };
  }
  if (firstConfidence >= 35 && setProb >= 15) {
    return { judgment: "WATCH", reason: `1着信頼度${round1(firstConfidence)}・セット確率${setProb}%` };
  }
  return { judgment: "SKIP", reason: `1着信頼度${round1(firstConfidence)}不足・セット確率${setProb}%` };
}

// ============================================================
// メイン: V4予想実行
// ============================================================
export function runPredictionV4(entries, race, settings, options = {}) {
  const stage = options.stage || "PRE";
  const oddsMap = options.oddsMap || {};

  // 1. Boat Scores計算
  const boatScores = computeV4BoatScores(entries, race, stage);

  // 2. 1着確率計算(Lane Prior適用)
  const firstProbsRaw = computeFirstProbabilitiesWithPrior(boatScores, stage);

  // 3. 5/6号艇抑制チェック
  const suppressionResult = checkFiftySixSuppression(boatScores, firstProbsRaw, stage);
  const firstProbs = suppressionResult.adjustedProbs;

  // boatScoresへfirst_probabilityを設定
  boatScores.forEach((b, i) => {
    b.first_probability = firstProbs[i];
    b.first_probability_raw = firstProbsRaw[i];
    b.lane_prior = LANE_PRIOR[b.boat_number];
    b.suppression_applied = suppressionResult.suppressed && b.boat_number >= 5;
    if (b.isOutside && b.today_components?.exhibition_st_score != null) {
      b.st_overvaluation_fix = true;
      b.notes.push("ST過大評価補正: 外枠ST weight半減");
    }
  });

  // 4. 条件付き3連単確率計算
  const trifectas = computeConditionalTrifectas(boatScores, firstProbs, stage);

  // 5. 6点選択(的中率最大化)
  const { selected, strategy, firstAxis } = selectHitTickets(trifectas, boatScores, firstProbs, suppressionResult, oddsMap);

  // 6. セット期待値
  const setMetrics = computeV4SetMetrics(selected, trifectas, oddsMap, settings);

  // 7. 判定
  const { judgment, reason } = judgeV4(setMetrics, firstProbs, boatScores, suppressionResult, stage);

  // ランキング
  const sortedByFirst = boatScores.map((b, i) => ({ b, i, prob: firstProbs[i] }))
    .sort((a, b) => b.prob - a.prob);
  const firstRanking = sortedByFirst.map(x => x.b.boat_number);

  // 2着ランキング: 条件付き確率の平均
  const secondRankingScores = boatScores.map(b => {
    const secondProbsForBoat = trifectas
      .filter(t => t.second_boat === b.boat_number)
      .reduce((s, t) => s + t.probability, 0);
    return { boat: b.boat_number, score: secondProbsForBoat };
  }).sort((a, b) => b.score - a.score);
  const secondRanking = secondRankingScores.map(x => x.boat);

  // 3着ランキング
  const thirdRankingScores = boatScores.map(b => {
    const thirdProbsForBoat = trifectas
      .filter(t => t.third_boat === b.boat_number)
      .reduce((s, t) => s + t.probability, 0);
    return { boat: b.boat_number, score: thirdProbsForBoat };
  }).sort((a, b) => b.score - a.score);
  const thirdRanking = thirdRankingScores.map(x => x.boat);

  // 本命・対抗・穴・消し
  const honmei = firstRanking[0];
  const taiko = firstRanking[1];
  const ana = firstRanking[2];
  const keshi = firstRanking[firstRanking.length - 1];

  // トップ3連単
  const topTrifecta = trifectas[0];
  const topOdds = oddsMap?.[topTrifecta.combination] || null;
  const topEv = topOdds != null ? Math.round(topTrifecta.probability * topOdds * 10) / 10 : null;

  // 1着信頼度
  const topProb = firstProbs[0];
  const firstProbSorted = [...firstProbs].sort((a, b) => b - a);
  const firstConfidence = clamp(firstProbSorted[0] + (firstProbSorted[0] - firstProbSorted[1]) * 0.5, 0, 100);
  const firstProbabilityGap = round2(firstProbSorted[0] - firstProbSorted[1]);

  // データ信頼度
  const dataConfidence = computeDataConfidence(boatScores, stage);

  // trifectasにodds/EV付与
  const trifectasWithOdds = trifectas.map(t => {
    const actualOdds = oddsMap?.[t.combination] || null;
    const ev = actualOdds != null ? Math.round(t.probability * actualOdds * 10) / 10 : null;
    const isSelected = selected.includes(t.combination);
    const ticketRank = isSelected ? selected.indexOf(t.combination) + 1 : null;
    return {
      ...t,
      actual_odds: actualOdds,
      expected_value: ev,
      is_selected: isSelected,
      ticket_rank: ticketRank,
    };
  });

  return {
    boatScores: boatScores.map((b, i) => ({
      ...b,
      first_probability: firstProbs[i],
      first_probability_raw: firstProbsRaw[i],
      lane_prior: LANE_PRIOR[b.boat_number],
      suppression_applied: suppressionResult.suppressed && b.boat_number >= 5,
      st_overvaluation_fix: b.isOutside && b.today_components?.exhibition_st_score != null,
    })),
    trifectas: trifectasWithOdds,
    selected_trifectas: selected,
    ticket_count: selected.length,
    ticket_strategy: strategy,
    set_metrics: setMetrics,
    data_confidence: dataConfidence,
    final_judgment: judgment,
    judgment_reason: reason,
    honmei_boat: honmei,
    taiko_boat: taiko,
    ana_boat: ana,
    keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination,
    top_probability: topTrifecta?.probability,
    top_odds: topOdds,
    top_expected_value: topEv,
    first_ranking: firstRanking,
    second_ranking: secondRanking,
    third_ranking: thirdRanking,
    first_probability_gap: firstProbabilityGap,
    first_confidence: round1(firstConfidence),
    lane_prior_applied: LANE_PRIOR,
    fifty_six_suppressed: suppressionResult.suppressed,
    fifty_six_suppression_reason: suppressionResult.reason,
    fifty_six_conditions: suppressionResult.conditions,
    v4_weights: V4_WEIGHTS,
  };
}

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