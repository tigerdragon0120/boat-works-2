// BOAT WORKS 2 - 予想エンジン v5
// 選手個別分析型 + 6-8点買い目選定 + セット期待値判定
// 確率は選手能力・過去成績・展示から算出(オッズ不使用)
// オッズは期待値・合成オッズ・BUY/WATCH/SKIP判定のみに使用
// 最終買い目: 基本6点、最大8点、9点以上禁止

const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const normalize = (arr) => {
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum <= 0) return arr.map(() => 1 / arr.length);
  return arr.map((x) => x / sum);
};
const stToScore = (st, refSt = 0.15) => {
  if (!isValid(st)) return null;
  return clamp(70 + (refSt - st) * 300, 5, 100);
};

// 期間別重み付けスコア: 6m=45%, 1y=30%, 3y=15% (サンプル不足時は再正規化)
function periodWeightedScore(profile, metric) {
  if (!profile) return null;
  const s6m = profile.stats_6m, s1y = profile.stats_1y, s3y = profile.stats_3y, sAll = profile.stats_all;
  const use6m = s6m?.sample_size >= 5 ? 0.45 : 0;
  const use1y = s1y?.sample_size >= 5 ? 0.30 : 0;
  const use3y = s3y?.sample_size >= 5 ? 0.15 : 0;
  const v6m = use6m > 0 && s6m[metric] != null ? s6m[metric] : null;
  const v1y = use1y > 0 && s1y[metric] != null ? s1y[metric] : null;
  const v3y = use3y > 0 && s3y[metric] != null ? s3y[metric] : null;
  const pairs = [[v6m, use6m], [v1y, use1y], [v3y, use3y]].filter(([v]) => v != null);
  if (pairs.length) {
    const totalW = pairs.reduce((s, [, w]) => s + w, 0);
    return clamp(pairs.reduce((s, [v, w]) => s + v * w, 0) / totalW, 0, 100);
  }
  if (sAll?.sample_size >= 3 && sAll[metric] != null) return clamp(sAll[metric], 0, 100);
  return null;
}

function rollingWeightedScore(rolling, metric) {
  if (!rolling) return null;
  const s6m = rolling.stats_6m, s1y = rolling.stats_1y, s3y = rolling.stats_3y, sAll = rolling.stats_all;
  const use6m = s6m?.race_count >= 5 ? 0.45 : 0;
  const use1y = s1y?.race_count >= 5 ? 0.30 : 0;
  const use3y = s3y?.race_count >= 5 ? 0.15 : 0;
  const v6m = use6m > 0 && s6m[metric] != null ? s6m[metric] : null;
  const v1y = use1y > 0 && s1y[metric] != null ? s1y[metric] : null;
  const v3y = use3y > 0 && s3y[metric] != null ? s3y[metric] : null;
  const pairs = [[v6m, use6m], [v1y, use1y], [v3y, use3y]].filter(([v]) => v != null);
  if (pairs.length) {
    const totalW = pairs.reduce((s, [, w]) => s + w, 0);
    return clamp(pairs.reduce((s, [v, w]) => s + v * w, 0) / totalW, 0, 100);
  }
  if (sAll?.race_count >= 3 && sAll[metric] != null) return clamp(sAll[metric], 0, 100);
  return null;
}

function blendedPeriodScore(profile, rolling, metric) {
  const ps = periodWeightedScore(profile, metric);
  const rs = rollingWeightedScore(rolling, metric);
  if (ps != null && rs != null) return (ps + rs) / 2;
  return ps != null ? ps : rs;
}

function getCourseScore(profile, entry, metric, courseOverride) {
  if (!profile) return null;
  const course = courseOverride || entry.boat_number;
  if (!course) return null;
  const cs = profile.course_stats?.[String(course)];
  if (!cs || cs.sample_size < 3) return null;
  return cs[metric] != null ? clamp(cs[metric], 0, 100) : null;
}

function getKimariteScore(profile, course) {
  if (!profile?.winning_methods) return null;
  const wm = profile.winning_methods;
  if (wm.total_wins < 2) return null;
  if (course === 1) return wm.escape_rate;
  if (course === 2) return wm.sashi_rate;
  if (course === 3) return wm.makuri_rate;
  if (course === 4) return wm.makuri_sashi_rate;
  if (course === 5 || course === 6) return wm.nuki_rate;
  return null;
}

function getVenueScore(profile, entry, metric) {
  if (!profile?.venue_stats || !entry.venue_code) return null;
  const vs = profile.venue_stats[String(entry.venue_code)];
  if (!vs || vs.samples < 3) return null;
  return vs[metric] != null ? clamp(vs[metric], 0, 100) : null;
}

function computeExhibitionScore(entry) {
  const parts = [];
  if (isValid(entry.exhibition_time)) parts.push(clamp(50 + (1.4 - entry.exhibition_time) * 100, 5, 100));
  if (isValid(entry.exhibition_rank)) parts.push(clamp(110 - entry.exhibition_rank * 15, 0, 100));
  if (isValid(entry.exhibition_st)) parts.push(stToScore(entry.exhibition_st, 0.1));
  if (isValid(entry.exhibition_st_rank)) parts.push(clamp(110 - entry.exhibition_st_rank * 15, 0, 100));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
}

const weightedAverage = (pairs, fallback = 50) => {
  const valid = pairs.filter(([s]) => s !== null && isValid(s));
  if (!valid.length) return fallback;
  const denom = valid.reduce((a, [, w]) => a + w, 0);
  return denom > 0 ? valid.reduce((a, [s, w]) => a + s * w, 0) / denom : fallback;
};

function computeOtherScore(profile, entry, metric, isFinal) {
  const courseOverride = isFinal && isValid(entry.exhibition_course) ? entry.exhibition_course : null;
  const courseScore = getCourseScore(profile, entry, metric, courseOverride);
  const recentMetric = metric === 'win_rate' ? 'recent_win_rate' : 'recent_top3_rate';
  const recentForm = profile?.recent_form?.[recentMetric];
  const recentSt = profile?.recent_form?.recent_st || entry.avg_st;
  const stScore = stToScore(recentSt);
  const kimariteScore = getKimariteScore(profile, courseOverride || entry.boat_number);
  const venueScore = getVenueScore(profile, entry, metric);
  const sectionScore = isValid(entry.section_points) ? clamp(entry.section_points * 2, 0, 100) : null;
  const motorScore = isValid(entry.motor_f2_rate) ? clamp(entry.motor_f2_rate, 0, 100) : null;
  return weightedAverage([
    [courseScore, 0.25], [recentForm, 0.20], [stScore, 0.15],
    [kimariteScore, 0.15], [venueScore, 0.10], [sectionScore, 0.08], [motorScore, 0.07],
  ]);
}

// 選手個別分析型スコア計算
export function computeBoatScores(entry, settings) {
  const profile = entry._profile;
  const rolling = entry._rollingStats;
  const laneRecent = entry._laneRecent;
  const stage = settings?.stage || "PRE";
  const isFinal = stage === "FINAL";

  const profileWin = blendedPeriodScore(profile, rolling, 'win_rate');
  const profileF2 = blendedPeriodScore(profile, rolling, 'top2_rate');
  const profileF3 = blendedPeriodScore(profile, rolling, 'top3_rate');

  const officialWin = entry.national_win_rate != null ? clamp(entry.national_win_rate * 10, 0, 100) : null;
  const officialF2 = entry.national_f2_rate != null ? clamp(entry.national_f2_rate, 0, 100) : null;
  const officialF3 = entry.national_f3_rate != null ? clamp(entry.national_f3_rate, 0, 100) : null;

  const otherFirst = computeOtherScore(profile, entry, 'win_rate', isFinal);
  const otherSecond = computeOtherScore(profile, entry, 'top2_rate', isFinal);
  const otherThird = computeOtherScore(profile, entry, 'top3_rate', isFinal);

  const computePower = (profileScore, officialScore, otherScore) => {
    if (profileScore != null) return clamp(profileScore * 0.90 + (otherScore || 50) * 0.10, 5, 100);
    if (officialScore != null) return clamp(officialScore * 0.70 + (otherScore || 50) * 0.30, 5, 100);
    return clamp(otherScore || 50, 5, 100);
  };

  let first_power = computePower(profileWin, officialWin, otherFirst);
  let second_power = computePower(profileF2, officialF2, otherSecond);
  let third_power = computePower(profileF3, officialF3, otherThird);

  // トレンド補正(RacerRollingStats.trend_scores)
  const trend = rolling?.trend_scores;
  if (trend) {
    const formAdj = ((trend.recent_form_score ?? 50) - 50) * 0.06;
    first_power = clamp(first_power + formAdj, 5, 100);
    second_power = clamp(second_power + formAdj * 0.7, 5, 100);
    third_power = clamp(third_power + formAdj * 0.5, 5, 100);
  }

  // 現在の枠番と同じ枠で走った直近10走を補正に使う。
  // サンプル数に応じた重み付け(過小評価防止):
  //   10走=100%, 7-9走=80%, 4-6走=60%, 1-3走=30%, 0走=評価対象外
  const laneSample = Number(laneRecent?.sample_count || 0);
  const sampleWeight = laneSample >= 10 ? 1.0 : laneSample >= 7 ? 0.8 : laneSample >= 4 ? 0.6 : laneSample >= 1 ? 0.3 : 0;
  const laneWin = isValid(laneRecent?.win_rate) ? clamp(Number(laneRecent.win_rate), 0, 100) : null;
  const laneTop2 = isValid(laneRecent?.top2_rate) ? clamp(Number(laneRecent.top2_rate), 0, 100) : null;
  const laneTop3 = isValid(laneRecent?.top3_rate) ? clamp(Number(laneRecent.top3_rate), 0, 100) : null;
  const laneAvgSt = isValid(laneRecent?.avg_st) ? Number(laneRecent.avg_st) : null;
  const laneAvgStartOrder = isValid(laneRecent?.avg_start_order) ? Number(laneRecent.avg_start_order) : null;
  const laneStScore = laneAvgSt != null ? stToScore(laneAvgSt) : null;
  const laneOrderScore = laneAvgStartOrder != null ? clamp(116 - laneAvgStartOrder * 16, 20, 100) : null;
  // 1着率・2連対率・3連対率それぞれで独立スコア計算(予想エンジンv5)
  const laneScoreFrom = (mainMetric) => {
    const parts = [[mainMetric, 0.55], [laneStScore, 0.25], [laneOrderScore, 0.20]].filter(([v]) => v != null);
    const ws = parts.reduce((s, [,w]) => s + w, 0);
    return ws > 0 ? parts.reduce((s,[v,w]) => s + Number(v) * w, 0) / ws : null;
  };
  const laneRecentScore = laneScoreFrom(laneWin); // 互換用(1着率ベース)
  const laneSecondScore = laneScoreFrom(laneTop2);
  const laneThirdScore = laneScoreFrom(laneTop3);
  if (sampleWeight > 0) {
    // 最大15%の補正をサンプル数重みでスケーリング
    const blend = 0.15 * sampleWeight;
    if (laneRecentScore != null) first_power = clamp(first_power * (1 - blend) + laneRecentScore * blend, 5, 100);
    if (laneSecondScore != null) second_power = clamp(second_power * (1 - blend * 0.70) + laneSecondScore * (blend * 0.70), 5, 100);
    if (laneThirdScore != null) third_power = clamp(third_power * (1 - blend * 0.45) + laneThirdScore * (blend * 0.45), 5, 100);
  }

  // 枠番過去10走 追加指標(予想エンジンv5拡張)
  // first_power/second_powerはここで補正、start_powerは定義後に補正
  if (sampleWeight > 0 && laneRecent) {
    if (laneRecent.recent3_momentum != null) {
      const momAdj = laneRecent.recent3_momentum * 0.4 * sampleWeight;
      first_power = clamp(first_power + momAdj, 5, 100);
      second_power = clamp(second_power + momAdj * 0.7, 5, 100);
    }
    if (laneRecent.finish_stability != null) {
      const stabAdj = (laneRecent.finish_stability - 50) * 0.04 * sampleWeight;
      first_power = clamp(first_power + stabAdj, 5, 100);
    }
    if (laneRecent.course_lane_diff != null && laneRecent.course_lane_diff > 0.5) {
      first_power = clamp(first_power - laneRecent.course_lane_diff * 0.8 * sampleWeight, 5, 100);
    }
    if (laneRecent.special_count > 0) {
      const specPenalty = laneRecent.special_count * 1.2 * sampleWeight;
      first_power = clamp(first_power - specPenalty, 5, 100);
    }
  }

  // 展示補正(FINALのみ)
  let exhibition_delta = 0;
  let exhibition_score = 50;
  const final_adjustments = [];
  if (isFinal) {
    exhibition_score = computeExhibitionScore(entry);
    exhibition_delta = (exhibition_score - 50) * 0.3;
    // 進入変更検出: 展示進入が枠番と異なる場合
    if (isValid(entry.exhibition_course) && entry.exhibition_course !== entry.boat_number) {
      const courseDelta = entry.exhibition_course < entry.boat_number ? 3 : -3;
      exhibition_delta += courseDelta;
      final_adjustments.push(`進入変更(${entry.boat_number}→${entry.exhibition_course}): ${courseDelta > 0 ? '+' : ''}${courseDelta}`);
    }
    // 展示ST
    if (isValid(entry.exhibition_st)) {
      const stRankStr = entry.exhibition_st_rank ? `(${entry.exhibition_st_rank}位)` : '';
      final_adjustments.push(`展示ST ${entry.exhibition_st}${stRankStr}`);
    }
    // 展示タイム
    if (isValid(entry.exhibition_time)) {
      const rankStr = entry.exhibition_rank ? `(${entry.exhibition_rank}位)` : '';
      final_adjustments.push(`展示タイム ${entry.exhibition_time}${rankStr}`);
    }
    // 展示スコア
    final_adjustments.push(`展示スコア${round1(exhibition_score)}(delta${exhibition_delta > 0 ? '+' : ''}${round1(exhibition_delta)})`);
  }

  // 補助スコア
  let start_power = (() => {
    const recentSt = profile?.recent_form?.recent_st || entry.avg_st;
    const stScore = stToScore(recentSt);
    const fPenalty = isValid(entry.f_count) ? clamp(100 - entry.f_count * 8, 0, 100) : null;
    const parts = [stScore, fPenalty].filter((x) => x !== null);
    return parts.length ? round1(parts.reduce((a, b) => a + b, 0) / parts.length) : 50;
  })();
  if (sampleWeight > 0 && (laneStScore != null || laneOrderScore != null)) {
    const laneStart = [laneStScore, laneOrderScore].filter(v => v != null).reduce((a,b)=>a+b,0) / [laneStScore, laneOrderScore].filter(v => v != null).length;
    start_power = round1(clamp(start_power * (1 - 0.30 * sampleWeight) + laneStart * (0.30 * sampleWeight), 0, 100));
  }
  // 枠番過去10走 ST関連指標(start_power定義後に適用)
  if (sampleWeight > 0 && laneRecent) {
    if (laneRecent.st_stability != null) {
      const stStabAdj = (laneRecent.st_stability - 50) * 0.03 * sampleWeight;
      start_power = round1(clamp(start_power + stStabAdj, 0, 100));
    }
    if (laneRecent.special_count > 0) {
      const specPenalty = laneRecent.special_count * 1.2 * sampleWeight;
      start_power = round1(clamp(start_power - specPenalty, 0, 100));
    }
  }
  const motor_power = isValid(entry.motor_f2_rate) ? round1(clamp(entry.motor_f2_rate, 0, 100)) : 50;
  const exhibition_power = round1(exhibition_score);
  const local_fit = (() => {
    const vs = getVenueScore(profile, entry, 'win_rate');
    return vs != null ? round1(vs) : 50;
  })();
  const section_form = isValid(entry.section_points) ? round1(clamp(entry.section_points * 2, 0, 100)) : 50;
  const ana_potential = round1(clamp(exhibition_power * 0.4 + section_form * 0.3 + (100 - first_power) * 0.3, 0, 100));
  const total_power = round1((first_power + second_power + third_power) / 3);
  const effectiveCourse = isFinal && isValid(entry.exhibition_course) ? entry.exhibition_course : null;
  const course_strength = (() => {
    const cs = getCourseScore(profile, entry, 'win_rate', effectiveCourse);
    return cs != null ? round1(cs) : null;
  })();

  // 予想理由
  const reasons = [], notes = [];
  if (profileWin != null && profileWin >= 50) reasons.push(`直近勝率${round1(profileWin)}%`);
  if (profileF2 != null && profileF2 >= 55) reasons.push(`直近2連率${round1(profileF2)}%`);
  const courseWin = getCourseScore(profile, entry, 'win_rate');
  if (courseWin != null && courseWin >= 40) reasons.push(`${entry.boat_number}コース勝率${round1(courseWin)}%`);
  const wm = profile?.winning_methods;
  if (wm?.total_wins >= 3) {
    if (entry.boat_number === 1 && wm.escape_rate >= 50) reasons.push(`逃げ勝率${round1(wm.escape_rate)}%`);
    if (entry.boat_number === 2 && wm.sashi_rate >= 40) reasons.push(`差し勝率${round1(wm.sashi_rate)}%`);
    if (entry.boat_number === 3 && wm.makuri_rate >= 40) reasons.push(`まくり勝率${round1(wm.makuri_rate)}%`);
    if (entry.boat_number === 4 && wm.makuri_sashi_rate >= 30) reasons.push(`まくり差し${round1(wm.makuri_sashi_rate)}%`);
    if (entry.boat_number >= 5 && wm.nuki_rate >= 20) reasons.push(`抜き勝率${round1(wm.nuki_rate)}%`);
  }
  const momentum = profile?.recent_form?.momentum_score;
  if (momentum != null && momentum > 0.3) reasons.push("勢い上向き");
  if (momentum != null && momentum < -0.3) notes.push("最近調子落ち");
  if (profile?.recent_form?.recent_win_rate >= 30) reasons.push(`最近勝率${round1(profile.recent_form.recent_win_rate)}%`);
  if (isFinal && exhibition_score >= 65) reasons.push(`展示良好(${round1(exhibition_score)})`);
  if (isFinal && exhibition_score < 40) notes.push("展示低調");
  if (isFinal && isValid(entry.exhibition_course) && entry.exhibition_course !== entry.boat_number) {
    notes.push(`進入変更(${entry.boat_number}→${entry.exhibition_course})`);
  }
  if (profile?.winning_style?.st_stability >= 70) reasons.push("ST安定");
  if (profile?.winning_style?.st_stability < 40) notes.push("ST不安定");
  if (profile && profile.total_samples < 5) notes.push("プロファイルデータ少");
  if (profileWin == null && officialWin != null) notes.push("公式成績ベース予想");
  if (sampleWeight > 0 && laneSample > 0) {
    if (laneWin != null) reasons.push(`${entry.boat_number}枠直近${laneSample}走 1着率${round1(laneWin)}%`);
    if (laneTop2 != null) reasons.push(`同枠2連対率${round1(laneTop2)}%`);
    if (laneTop3 != null) reasons.push(`同枠3連対率${round1(laneTop3)}%`);
    if (laneAvgSt != null) reasons.push(`${entry.boat_number}枠平均ST ${Number(laneAvgSt).toFixed(3)}`);
    if (laneAvgStartOrder != null) reasons.push(`${entry.boat_number}枠平均ST順 ${round1(laneAvgStartOrder)}`);
    if (laneSample < 4) notes.push(`${entry.boat_number}枠直近${laneSample}走のみ(低サンプル)`);
  }

  // 枠番過去10走 追加指標の理由・注意点
  if (laneRecent?.recent3_momentum > 0.5) reasons.push("同枠直近3走上向き");
  if (laneRecent?.recent3_momentum < -0.5) notes.push("同枠直近3走下降");
  if (laneRecent?.finish_stability >= 70) reasons.push("同枠着順安定");
  if (laneRecent?.finish_stability < 30) notes.push("同枠着順バラツキ大");
  if (laneRecent?.st_stability >= 70) reasons.push("同枠ST安定");
  if (laneRecent?.special_count > 0) notes.push(`同枠${laneRecent.special_count}回特殊結果`);
  if (laneRecent?.course_lane_diff > 0.5) notes.push("同枠進入変更多発");

  if (trend) {
    if (trend.recent_form_score != null && trend.recent_form_score >= 65) reasons.push(`調子上向き(${Math.round(trend.recent_form_score)})`);
    if (trend.recent_form_score != null && trend.recent_form_score <= 35) notes.push("調子下降傾向");
    if (trend.class_trend_score != null && trend.class_trend_score >= 65) reasons.push("級別上昇中");
    if (trend.class_trend_score != null && trend.class_trend_score <= 35) notes.push("級別下降傾向");
    if (trend.st_trend_score != null && trend.st_trend_score >= 65) reasons.push("ST改善傾向");
    if (trend.st_trend_score != null && trend.st_trend_score <= 35) notes.push("ST悪化傾向");
  }

  return {
    boat_number: entry.boat_number,
    first_power: round1(first_power),
    second_power: round1(second_power),
    third_power: round1(third_power),
    total_power,
    current_power: total_power,
    start_power, motor_power, exhibition_power, local_fit, section_form, ana_potential,
    exhibition_score: round1(exhibition_score),
    course_strength,
    start_skill: start_power,
    lane_recent_score: laneRecentScore != null ? round1(laneRecentScore) : null,
    lane_recent_win_rate: laneWin != null ? round1(laneWin) : null,
    lane_recent_top2_rate: laneTop2 != null ? round1(laneTop2) : null,
    lane_recent_top3_rate: laneTop3 != null ? round1(laneTop3) : null,
    lane_recent_avg_st: laneAvgSt,
    lane_recent_avg_start_order: laneAvgStartOrder != null ? round1(laneAvgStartOrder) : null,
    lane_recent_sample_count: laneSample,
    recent_form_score: trend?.recent_form_score != null ? Math.round(trend.recent_form_score) : null,
    st_trend_score: trend?.st_trend_score != null ? Math.round(trend.st_trend_score) : null,
    class_trend_score: trend?.class_trend_score != null ? Math.round(trend.class_trend_score) : null,
    performance_trend: trend?.performance_trend != null ? Math.round(trend.performance_trend) : null,
    racer_power_score: trend?.racer_power_score != null ? Math.round(trend.racer_power_score) : null,
    exhibition_delta: round1(exhibition_delta),
    reasons, notes,
    final_adjustments: isFinal ? final_adjustments : null,
    exhibition_sources: entry._exhibition_sources || null,
    exhibition_st_rank: entry.exhibition_st_rank ?? null,
    dataCount: Math.max(profile?.total_samples || 0, rolling?.stats_all?.race_count || 0),
    _absent: !!entry.is_absent,
  };
}

// 3連単確率計算(オッズ不使用・選手プロファイル+展開から確率生成)
export function computeTrifectas(boatScores) {
  const boats = boatScores.filter((b) => !b._absent);
  const numbers = boats.map((b) => b.boat_number);
  const softmax = (scores, temperature) => {
    if (!scores.length) return [];
    const maxScore = Math.max(...scores);
    const weights = scores.map((s) => Math.exp((s - maxScore) / temperature));
    return normalize(weights);
  };
  const firstProb = softmax(boats.map((b) => b.first_power), 6.0);
  const firstP = {};
  boats.forEach((b, i) => (firstP[b.boat_number] = firstProb[i]));
  const results = [];
  for (const i of numbers) {
    const secondBoats = boats.filter((b) => b.boat_number !== i);
    const secondProb = softmax(secondBoats.map((b) => b.second_power), 8.0);
    const secondP = {};
    secondBoats.forEach((b, k) => (secondP[b.boat_number] = secondProb[k]));
    for (const j of numbers) {
      if (j === i) continue;
      const thirdBoats = boats.filter((b) => b.boat_number !== i && b.boat_number !== j);
      const thirdProb = softmax(thirdBoats.map((b) => b.third_power), 10.0);
      const thirdP = {};
      thirdBoats.forEach((b, k) => (thirdP[b.boat_number] = thirdProb[k]));
      for (const k of numbers) {
        if (k === i || k === j) continue;
        const prob = firstP[i] * secondP[j] * thirdP[k];
        results.push({
          combination: `${i}-${j}-${k}`,
          first_boat: i, second_boat: j, third_boat: k,
          probability: Math.round(prob * 1000) / 10,
          rank: 0,
        });
      }
    }
  }
  results.sort((a, b) => b.probability - a.probability);
  results.forEach((r, idx) => (r.rank = idx + 1));
  return results;
}

// 展開予測
export function computeRaceScenario(boatScores) {
  const sorted = [...boatScores].filter(b => !b._absent).sort((a, b) => b.first_power - a.first_power);
  if (!sorted.length) return { primary: "—", secondary: "—", confidence: 0, reasons: [] };
  const top = sorted[0];
  const second = sorted[1];
  const gap = top.first_power - (second?.first_power || 0);
  const reasons = [];
  let primary = "混戦", secondary = "—";
  let confidence = 30;

  const boat1 = sorted.find(b => b.boat_number === 1);
  const boat2 = sorted.find(b => b.boat_number === 2);
  const boat3 = sorted.find(b => b.boat_number === 3);
  const boat4 = sorted.find(b => b.boat_number === 4);
  const boat5 = sorted.find(b => b.boat_number === 5);
  const boat6 = sorted.find(b => b.boat_number === 6);

  if (boat1 && boat1.first_power >= 65 && top.boat_number === 1 && gap >= 5) {
    primary = "1逃げ濃厚";
    confidence = Math.min(90, 60 + gap * 2);
    reasons.push(`1号艇1着力${boat1.first_power}が突出`);
    reasons.push(`2位との差${gap.toFixed(1)}`);
  } else if (boat2 && boat2.first_power >= 62) {
    primary = "2差し警戒";
    confidence = 58;
    reasons.push(`2号艇1着力${boat2.first_power}`);
  } else if (boat3 && boat3.first_power >= 60) {
    primary = "3まくり警戒";
    confidence = 52;
    reasons.push(`3号艇1着力${boat3.first_power}`);
  } else if (boat4 && boat4.first_power >= 58) {
    primary = "4カド攻め警戒";
    confidence = 48;
    reasons.push(`4号艇1着力${boat4.first_power}`);
  } else if (top.boat_number >= 5) {
    primary = "外伸び";
    confidence = 45;
    reasons.push(`${top.boat_number}号艇が外から上位`);
  } else {
    primary = "混戦";
    confidence = 25;
    reasons.push("6艇の差が少なく予想困難");
  }

  if (boat3 && boat3.first_power >= 55 && primary !== "3まくり警戒") secondary = "3まくり差し警戒";
  else if (boat4 && boat4.first_power >= 54 && primary !== "4カド攻め警戒") secondary = "4カド差し警戒";
  else if (boat1 && boat1.first_power < 55 && primary !== "1逃げ濃厚") secondary = "内競り";
  else if (sorted.slice(0, 3).some(b => b.boat_number >= 5)) secondary = "外伸び警戒";
  else if (boat5 && boat5.first_power >= 52 || (boat6 && boat6.first_power >= 50)) secondary = "まくり差し展開";

  return { primary, secondary, confidence: Math.round(confidence), reasons };
}

export function gradePrediction(boatScores) {
  const active = boatScores.filter(b => !b._absent);
  if (!active.length) return "C";
  const top = active.reduce((a, b) => (a.first_power > b.first_power ? a : b));
  const second = active.filter(b => b.boat_number !== top.boat_number).reduce((a, b) => (a.first_power > b.first_power ? a : b), active[0]);
  const gap = top.first_power - second.first_power;
  const conf = top.dataCount;
  if (gap >= 10 && top.first_power >= 75 && conf >= 20) return "S";
  if (gap >= 6 && top.first_power >= 65) return "A";
  if (top.first_power >= 55) return "B";
  return "C";
}

export function computeConfidence(boatScores) {
  const active = boatScores.filter(b => !b._absent);
  if (!active.length) return 0;
  const avgSamples = active.reduce((a, b) => a + (b.dataCount || 0), 0) / active.length;
  return clamp(Math.round((avgSamples / 50) * 100), 0, 100);
}

// =====================================================
// 6-8点買い目選定ロジック
// =====================================================
export function selectTickets(trifectas, boatScores, scenario, settings, options = {}) {
  const defaultCount = settings?.default_ticket_count || 6;
  const maxCount = settings?.max_ticket_count || 8;
  const oddsMap = options.oddsMap || {};

  const activeBoats = boatScores.filter(b => !b._absent);
  const firstRanking = [...activeBoats].sort((a, b) => b.first_power - a.first_power);

  if (firstRanking.length < 3 || trifectas.length < defaultCount) {
    // データ不足: 確率上位を返す
    const fallback = trifectas.slice(0, Math.min(defaultCount, trifectas.length)).map((t, i) => ({
      combination: t.combination,
      probability: t.probability,
      ticket_rank: i + 1,
      set_group: i < 2 ? "A" : i < 4 ? "B" : "C",
      selection_reason: "確率上位(データ不足)",
    }));
    return { selected: fallback, strategy: "データ不足", expandReason: "", ticketCount: fallback.length };
  }

  const triMap = new Map(trifectas.map(t => [t.combination, t]));
  const top = firstRanking[0];
  const second = firstRanking[1];
  const third = firstRanking[2];
  const fourth = firstRanking[3];
  const fifth = firstRanking[4];
  const gap = top.first_power - second.first_power;

  let selected = [];
  let strategy = "";
  let expandReason = "";

  // === 1着固定型: gap >= 8 and top is strong ===
  if (gap >= 8 && top.first_power >= 65) {
    strategy = "1着固定型";
    const honmei = top.boat_number;
    const candidates = firstRanking.slice(1, 4).map(b => b.boat_number);
    // 3P2 = 6通りの2着・3着組み合わせ
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        selected.push(`${honmei}-${candidates[i]}-${candidates[j]}`);
      }
    }
    // 6点完成

    // 拡張判定: 2着候補が割れている or 4th候補が接している
    if (fourth && selected.length < maxCount) {
      const secondGap = Math.abs(second.first_power - third.first_power);
      const fourthGap = third.first_power - fourth.first_power;
      const shouldExpand =
        secondGap < 2 ||                     // 2着候補が割れている
        fourthGap < 2 ||                     // 3着候補と4thが接近
        (fourth.racer_power_score != null && fourth.racer_power_score >= 60); // 強い穴候補
      if (shouldExpand) {
        selected.push(`${honmei}-${candidates[0]}-${fourth.boat_number}`);
        if (selected.length < maxCount) {
          selected.push(`${honmei}-${fourth.boat_number}-${candidates[0]}`);
        }
        expandReason = "2・3着候補が混戦、4th候補を追加";
      }
    }
  }
  // === 1着2頭型: gap < 4 ===
  else if (gap < 4) {
    strategy = "1着2頭型";
    const a = top.boat_number;
    const b = second.boat_number;
    const others = firstRanking.slice(2, 4).map(b2 => b2.boat_number);
    // 各1着から2P2=4通り → 合計8(others=2の場合)
    for (const first of [a, b]) {
      for (let i = 0; i < others.length; i++) {
        for (let j = 0; j < others.length; j++) {
          if (i === j) continue;
          selected.push(`${first}-${others[i]}-${others[j]}`);
        }
      }
    }
    if (selected.length > maxCount) {
      selected.sort((c1, c2) => (triMap.get(c2)?.probability || 0) - (triMap.get(c1)?.probability || 0));
      selected = selected.slice(0, maxCount);
    }
    expandReason = "1着候補が2艇でほぼ互角、両方から展開";
  }
  // === 確率上位型 (default) ===
  else {
    strategy = "確率上位型";
    selected = trifectas.slice(0, defaultCount).map(t => t.combination);

    // 拡張判定: 3着候補が混戦 or 強い穴候補
    if (fourth && selected.length < maxCount) {
      const fourthGap = third.first_power - fourth.first_power;
      const fifthGap = fourth.first_power - (fifth?.first_power || 0);
      const shouldExpand =
        fourthGap < 3 ||                      // 3着候補混戦
        (fifth && fifthGap < 3) ||            // さらに混戦
        (scenario?.confidence < 40);          // 展開不確実
      if (shouldExpand) {
        const extra = trifectas
          .filter(t => !selected.includes(t.combination))
          .slice(0, maxCount - defaultCount)
          .map(t => t.combination);
        selected.push(...extra);
        if (selected.length > defaultCount) {
          expandReason = "3着候補が混戦、押さえを追加";
        }
      }
    }
  }

  // 安全策: 最低6点確保
  if (selected.length < defaultCount) {
    for (const t of trifectas) {
      if (selected.length >= defaultCount) break;
      if (!selected.includes(t.combination)) selected.push(t.combination);
    }
  }
  // 安全策: 最大8点
  if (selected.length > maxCount) {
    selected.sort((c1, c2) => (triMap.get(c2)?.probability || 0) - (triMap.get(c1)?.probability || 0));
    selected = selected.slice(0, maxCount);
  }

  // 確率順でランキング
  const ranked = selected.map(c => ({
    combination: c,
    probability: triMap.get(c)?.probability || 0,
    ticket_rank: 0,
  })).sort((a, b) => b.probability - a.probability);
  ranked.forEach((t, i) => { t.ticket_rank = i + 1; });

  // セットグループ割当: A=本線 B=対抗 C=押さえ
  const n = ranked.length;
  const groups = assignSetGroups(n);

  // 選定理由
  const result = ranked.map((t, i) => ({
    ...t,
    set_group: groups[i],
    selection_reason: buildSelectionReason(t, strategy, i, n, firstRanking, scenario),
  }));

  return { selected: result, strategy, expandReason, ticketCount: result.length };
}

function assignSetGroups(n) {
  const groups = [];
  if (n <= 6) {
    for (let i = 0; i < n; i++) {
      if (i < 2) groups.push("A");
      else if (i < 4) groups.push("B");
      else groups.push("C");
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (i < 3) groups.push("A");
      else if (i < 6) groups.push("B");
      else groups.push("C");
    }
  }
  return groups;
}

function buildSelectionReason(ticket, strategy, idx, total, firstRanking, scenario) {
  const [a, b, c] = ticket.combination.split("-").map(Number);
  const group = ticket.set_group;
  if (group === "A") {
    if (strategy === "1着固定型") return `${a}着固定・${b}-${c}の本線`;
    if (strategy === "1着2頭型") return `${a}着軸・${b}-${c}本線`;
    return `確率上位・${a}-${b}-${c}本線`;
  }
  if (group === "B") return `${a}着軸・${b}-${c}対抗`;
  return `${a}-${b}-${c}押さえ`;
}

// =====================================================
// 合成オッズ・セット期待値計算
// =====================================================
export function computeSetMetrics(selectedTickets, oddsMap, settings) {
  if (!selectedTickets || !selectedTickets.length) return null;

  let setProbability = 0;
  let totalInverseOdds = 0;
  let hasOdds = false;
  let minPayout = Infinity;
  let maxPayout = 0;
  let totalPayout = 0;
  let oddsCount = 0;
  let bestEV = -Infinity;
  let bestEVTicket = null;
  let worstEfficiency = Infinity;
  let worstEfficiencyTicket = null;
  const missingOdds = [];

  for (const ticket of selectedTickets) {
    const prob = ticket.probability / 100;
    setProbability += ticket.probability;

    // 実オッズのみ使用(推定オッズ・仮オッズは不使用)
    const odds = oddsMap?.[ticket.combination] || null;
    if (odds != null && odds > 1) {
      hasOdds = true;
      const payout = odds * 100;
      const ev = prob * odds * 100;

      totalInverseOdds += 1 / odds;
      if (payout < minPayout) minPayout = payout;
      if (payout > maxPayout) maxPayout = payout;
      totalPayout += payout;
      oddsCount++;

      if (ev > bestEV) { bestEV = ev; bestEVTicket = ticket.combination; }
      if (ev < worstEfficiency) { worstEfficiency = ev; worstEfficiencyTicket = ticket.combination; }
    } else {
      missingOdds.push(ticket.combination);
    }
  }

  const investment = selectedTickets.length * 100;
  const syntheticOdds = hasOdds && totalInverseOdds > 0 ? round1(1 / totalInverseOdds) : null;
  const avgPayout = hasOdds && oddsCount > 0 ? round1(totalPayout / oddsCount) : null;
  // セット期待回収率 = (セット的中確率 × 平均払戻) / 投資額 × 100
  const setEV = hasOdds && avgPayout != null
    ? round1((setProbability / 100) * avgPayout / investment * 100)
    : null;

  return {
    ticket_count: selectedTickets.length,
    set_probability: round1(setProbability),
    synthetic_odds: syntheticOdds,
    min_payout: hasOdds ? round1(minPayout) : null,
    avg_payout: avgPayout,
    max_payout: hasOdds ? round1(maxPayout) : null,
    best_ev_ticket: bestEVTicket,
    worst_efficiency_ticket: worstEfficiencyTicket,
    set_expected_recovery: setEV,
    investment,
    odds_mapping_error: missingOdds.length > 0,
    missing_odds: missingOdds,
  };
}

// =====================================================
// BUY / WATCH / SKIP 判定(セット期待値ベース)
// =====================================================
export function judgePrediction(setMetrics, dataConfidence, scenario, settings, stage) {
  if (!setMetrics) return { judgment: "SKIP", reason: "予想データ不足" };

  const buyThreshold = settings?.buy_set_ev_threshold ?? 120;
  const watchThreshold = settings?.watch_set_ev_threshold ?? 90;
  const minConfidence = settings?.min_confidence ?? 40;
  const minSetProb = settings?.min_set_probability ?? 25;

  const setProb = setMetrics.set_probability || 0;
  const setEV = setMetrics.set_expected_recovery;
  const conf = dataConfidence || 0;
  const scenarioConf = scenario?.confidence || 0;

  // SKIP条件
  if (conf < minConfidence) {
    return { judgment: "SKIP", reason: `データ信頼度不足(信頼度${conf}%が基準${minConfidence}%未満)` };
  }
  if (setProb < minSetProb) {
    return { judgment: "SKIP", reason: `セット的中確率${setProb}%が基準${minSetProb}%不足` };
  }
  if (setEV != null && setEV < watchThreshold) {
    return { judgment: "SKIP", reason: `セット期待回収率${setEV}%が低い(基準${watchThreshold}%)` };
  }

  // BUY条件: セット期待回収率・信頼度・セット確率すべて基準以上 + 展開安定
  if (setEV != null && setEV >= buyThreshold && conf >= minConfidence && setProb >= minSetProb) {
    if (stage === "FINAL") {
      if (scenarioConf >= 45) {
        return { judgment: "BUY", reason: `展示後も安定、セット確率${setProb}%・期待回収率${setEV}%・展開信頼度${scenarioConf}%` };
      }
      return { judgment: "WATCH", reason: `期待回収率${setEV}%だが展開信頼度${scenarioConf}%が不十分` };
    }
    // PRE
    return { judgment: "BUY", reason: `予想信頼度高、セット確率${setProb}%・期待回収率${setEV}%` };
  }

  // WATCH条件: 予想は悪くないが期待値ギリギリ
  if (setEV != null && setEV >= watchThreshold) {
    return { judgment: "WATCH", reason: `期待回収率${setEV}%・オッズ妙味待ち(基準${buyThreshold}%でBUY)` };
  }
  if (setProb >= minSetProb && conf >= minConfidence) {
    return { judgment: "WATCH", reason: `予想は安定(セット確率${setProb}%)だが期待値${setEV ?? "—"}%がギリギリ` };
  }

  return { judgment: "SKIP", reason: "期待値・信頼度ともに基準不足" };
}

// =====================================================
// 予想実行(メイン)
// =====================================================
export function runPrediction(entries, settings, options = {}) {
  const stage = settings?.stage || "PRE";
  const isFinal = stage === "FINAL";
  const preBoatScores = options.preBoatScores || null;
  const oddsMap = options.oddsMap || {};

  const boats = entries.map((e) => ({ ...e, _absent: !!e.is_absent }));
  let boatScores = boats.map((e) => computeBoatScores(e, settings));

  // FINAL: PRE予想を基準に展示補正のみ適用
  if (isFinal && preBoatScores && preBoatScores.length) {
    for (const s of boatScores) {
      const pre = preBoatScores.find(p => p.boat_number === s.boat_number);
      if (pre) {
        s.first_power = clamp(pre.first_power + s.exhibition_delta, 5, 100);
        s.second_power = clamp(pre.second_power + s.exhibition_delta * 0.7, 5, 100);
        s.third_power = clamp(pre.third_power + s.exhibition_delta * 0.5, 5, 100);
        s.total_power = round1((s.first_power + s.second_power + s.third_power) / 3);
        s.current_power = s.total_power;
        s.pre_first = pre.first_power;
        s.pre_second = pre.second_power;
        s.pre_third = pre.third_power;
      }
    }
  }

  const activeScores = boatScores.filter(b => !b._absent);
  const trifectas = computeTrifectas(activeScores);
  const raceScenario = computeRaceScenario(activeScores);
  const dataConfidence = computeConfidence(activeScores);

  // ランキング
  const firstRanking = [...activeScores].sort((a, b) => b.first_power - a.first_power).map(b => b.boat_number);
  const secondRanking = [...activeScores].sort((a, b) => b.second_power - a.second_power).map(b => b.boat_number);
  const thirdRanking = [...activeScores].sort((a, b) => b.third_power - a.third_power).map(b => b.boat_number);

  // 役割は必ず別艇にする。
  // 本命 = 1着力トップ
  // 対抗 = 本命を除いた中で「2着力を主軸に、総合力も加味」した最上位
  // 穴   = 本命・対抗を除いた中で穴ポテンシャル最上位
  const honmei = firstRanking[0];
  const taikoCandidate = [...activeScores]
    .filter((b) => b.boat_number !== honmei)
    .sort((a, b) => ((b.second_power * 0.7 + b.total_power * 0.3) - (a.second_power * 0.7 + a.total_power * 0.3)))[0];
  const taiko = taikoCandidate?.boat_number ?? firstRanking.find((n) => n !== honmei);
  const anaCandidate = [...activeScores]
    .filter((b) => b.boat_number !== honmei && b.boat_number !== taiko)
    .sort((a, b) => ((b.ana_potential * 0.7 + b.first_power * 0.3) - (a.ana_potential * 0.7 + a.first_power * 0.3)))[0];
  const ana = anaCandidate?.boat_number ?? firstRanking.find((n) => n !== honmei && n !== taiko);
  const keshi = [...firstRanking].reverse().find((n) => n !== honmei && n !== taiko && n !== ana) ?? firstRanking[firstRanking.length - 1];

  // === 6-8点買い目選定 ===
  const ticketSelection = selectTickets(trifectas, activeScores, raceScenario, settings, { oddsMap });
  const selectedTickets = ticketSelection.selected;

  // === 合成オッズ・セット期待値 ===
  const setMetrics = computeSetMetrics(selectedTickets, oddsMap, settings);

  // === BUY/WATCH/SKIP判定 ===
  const judgment = judgePrediction(setMetrics, dataConfidence, raceScenario, settings, stage);

  const topTrifecta = trifectas[0];
  const grade = gradePrediction(activeScores);
  // top_odds: 実オッズのみ使用
  const topOdds = topTrifecta ? (oddsMap?.[topTrifecta.combination] || null) : null;

  return {
    stage, boatScores, trifectas,
    race_scenario: raceScenario,
    prediction_grade: grade,
    data_confidence: dataConfidence,
    honmei_boat: honmei, taiko_boat: taiko, ana_boat: ana, keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination, top_probability: topTrifecta?.probability,
    top_odds: topOdds,
    first_ranking: firstRanking, second_ranking: secondRanking, third_ranking: thirdRanking,
    exhibition_ready: activeScores.some(s => s.exhibition_delta !== 0),
    exhibition_status: options.exhibitionStatus || null,
    // 新: 買い目・判定
    ticket_selection: ticketSelection,
    set_metrics: setMetrics,
    final_judgment: judgment.judgment,
    judgment_reason: judgment.reason,
    selected_trifectas: selectedTickets.map(t => t.combination),
    ticket_count: ticketSelection.ticketCount,
    ticket_strategy: ticketSelection.strategy,
    expand_reason: ticketSelection.expandReason,
  };
}

// 互換用: judgeTrifecta(旧API互換。新判定はjudgePredictionを使用)
export function judgeTrifecta(trifecta, ctx = {}) {
  const { settings = {} } = ctx;
  const prob = trifecta.probability || 0;
  const buyThreshold = settings?.buy_set_ev_threshold ?? 120;
  const watchThreshold = settings?.watch_set_ev_threshold ?? 90;
  const ev = trifecta.expected_value;
  if (ev != null && ev >= buyThreshold) return { judgment: "BUY", basis: `期待値${ev}%` };
  if (ev != null && ev >= watchThreshold) return { judgment: "WATCH", basis: `期待値${ev}%` };
  if (ev != null) return { judgment: "SKIP", basis: `期待値${ev}%不足` };
  // オッズ不明時は確率ベース(参考)
  if (prob < (settings.min_probability || 5)) return { judgment: "SKIP", basis: `確率${prob}%不足` };
  return { judgment: "WATCH", basis: `確率${prob}%・オッズ待ち` };
}