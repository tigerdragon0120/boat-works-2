// BOAT WORKS 2 - 予想エンジン v4 (選手個別分析型)
// RacerPerformanceProfileを最重要データとし、期間別(6m/1y/3y)成績を主軸に着順予想。
// BUY/WATCH/SKIPは中心から外し、オッズは確率計算に使わない。
// FINALはPRE予想に展示補正を加える方式。

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
  // 期間別データ不足時は全期間統計をフォールバック
  if (sAll?.sample_size >= 3 && sAll[metric] != null) return clamp(sAll[metric], 0, 100);
  return null;
}

// ローリング統計からの期間別スコア(RacerRollingStats由来)
// race_countをサンプル数として使用。profile側と同じ重み付けロジック。
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

// プロファイル+ローリング統計のブレンドスコア
// 両方あれば平均、片方だけあればそれを採用
function blendedPeriodScore(profile, rolling, metric) {
  const ps = periodWeightedScore(profile, metric);
  const rs = rollingWeightedScore(rolling, metric);
  if (ps != null && rs != null) return (ps + rs) / 2;
  return ps != null ? ps : rs;
}

// コース別スコア
function getCourseScore(profile, entry, metric) {
  if (!profile || !entry.boat_number) return null;
  const cs = profile.course_stats?.[String(entry.boat_number)];
  if (!cs || cs.sample_size < 3) return null;
  return cs[metric] != null ? clamp(cs[metric], 0, 100) : null;
}

// 決まり手スコア: 艇番に応じた決まり手勝率
function getKimariteScore(profile, boatNumber) {
  if (!profile?.winning_methods) return null;
  const wm = profile.winning_methods;
  if (wm.total_wins < 2) return null;
  if (boatNumber === 1) return wm.escape_rate;
  if (boatNumber === 2) return wm.sashi_rate;
  if (boatNumber === 3) return wm.makuri_rate;
  if (boatNumber === 4) return wm.makuri_sashi_rate;
  if (boatNumber === 5 || boatNumber === 6) return wm.nuki_rate;
  return null;
}

// 競艇場別スコア
function getVenueScore(profile, entry, metric) {
  if (!profile?.venue_stats || !entry.venue_code) return null;
  const vs = profile.venue_stats[String(entry.venue_code)];
  if (!vs || vs.samples < 3) return null;
  return vs[metric] != null ? clamp(vs[metric], 0, 100) : null;
}

// 展示スコア(FINAL用)
function computeExhibitionScore(entry) {
  const parts = [];
  if (isValid(entry.exhibition_time)) parts.push(clamp(50 + (1.4 - entry.exhibition_time) * 100, 5, 100));
  if (isValid(entry.exhibition_rank)) parts.push(clamp(110 - entry.exhibition_rank * 15, 0, 100));
  if (isValid(entry.exhibition_st)) parts.push(stToScore(entry.exhibition_st, 0.1));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
}

const weightedAverage = (pairs, fallback = 50) => {
  const valid = pairs.filter(([s]) => s !== null && isValid(s));
  if (!valid.length) return fallback;
  const denom = valid.reduce((a, [, w]) => a + w, 0);
  return denom > 0 ? valid.reduce((a, [s, w]) => a + s * w, 0) / denom : fallback;
};

// その他要素(10%)のスコア
function computeOtherScore(profile, entry, metric) {
  const courseScore = getCourseScore(profile, entry, metric);
  const recentMetric = metric === 'win_rate' ? 'recent_win_rate' : 'recent_top3_rate';
  const recentForm = profile?.recent_form?.[recentMetric];
  const recentSt = profile?.recent_form?.recent_st || entry.avg_st;
  const stScore = stToScore(recentSt);
  const kimariteScore = getKimariteScore(profile, entry.boat_number);
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
  const stage = settings?.stage || "PRE";
  const isFinal = stage === "FINAL";

  // === 期間別スコア(主軸): プロファイル+ローリング統計のブレンド ===
  const profileWin = blendedPeriodScore(profile, rolling, 'win_rate');
  const profileF2 = blendedPeriodScore(profile, rolling, 'top2_rate');
  const profileF3 = blendedPeriodScore(profile, rolling, 'top3_rate');

  // === 公式成績(フォールバック) ===
  const officialWin = entry.national_win_rate != null ? clamp(entry.national_win_rate * 10, 0, 100) : null;
  const officialF2 = entry.national_f2_rate != null ? clamp(entry.national_f2_rate, 0, 100) : null;
  const officialF3 = entry.national_f3_rate != null ? clamp(entry.national_f3_rate, 0, 100) : null;

  // === その他要素(10%) ===
  const otherFirst = computeOtherScore(profile, entry, 'win_rate');
  const otherSecond = computeOtherScore(profile, entry, 'top2_rate');
  const otherThird = computeOtherScore(profile, entry, 'top3_rate');

  // === 着力計算 ===
  // プロファイル/ローリングあり: 90%ブレンド + 10%その他
  // プロファイルなし: 70%公式 + 30%その他
  const computePower = (profileScore, officialScore, otherScore) => {
    if (profileScore != null) return clamp(profileScore * 0.90 + (otherScore || 50) * 0.10, 5, 100);
    if (officialScore != null) return clamp(officialScore * 0.70 + (otherScore || 50) * 0.30, 5, 100);
    return clamp(otherScore || 50, 5, 100);
  };

  let first_power = computePower(profileWin, officialWin, otherFirst);
  let second_power = computePower(profileF2, officialF2, otherSecond);
  let third_power = computePower(profileF3, officialF3, otherThird);

  // === トレンド補正(RacerRollingStats.trend_scores) ===
  // recent_form_score(0-100, 50=平均)から着力に±3pt補正
  const trend = rolling?.trend_scores;
  if (trend) {
    const formAdj = ((trend.recent_form_score ?? 50) - 50) * 0.06; // ±3pt
    first_power = clamp(first_power + formAdj, 5, 100);
    second_power = clamp(second_power + formAdj * 0.7, 5, 100);
    third_power = clamp(third_power + formAdj * 0.5, 5, 100);
  }

  // === 展示補正(FINALのみ) ===
  let exhibition_delta = 0;
  let exhibition_score = 50;
  if (isFinal) {
    exhibition_score = computeExhibitionScore(entry);
    exhibition_delta = (exhibition_score - 50) * 0.3; // -15〜+15
  }

  // === 補助スコア ===
  const start_power = (() => {
    const recentSt = profile?.recent_form?.recent_st || entry.avg_st;
    const stScore = stToScore(recentSt);
    const fPenalty = isValid(entry.f_count) ? clamp(100 - entry.f_count * 8, 0, 100) : null;
    const parts = [stScore, fPenalty].filter((x) => x !== null);
    return parts.length ? round1(parts.reduce((a, b) => a + b, 0) / parts.length) : 50;
  })();
  const motor_power = isValid(entry.motor_f2_rate) ? round1(clamp(entry.motor_f2_rate, 0, 100)) : 50;
  const exhibition_power = round1(exhibition_score);
  const local_fit = (() => {
    const vs = getVenueScore(profile, entry, 'win_rate');
    return vs != null ? round1(vs) : 50;
  })();
  const section_form = isValid(entry.section_points) ? round1(clamp(entry.section_points * 2, 0, 100)) : 50;
  const ana_potential = round1(clamp(exhibition_power * 0.4 + section_form * 0.3 + (100 - first_power) * 0.3, 0, 100));
  const total_power = round1((first_power + second_power + third_power) / 3);

  // === 予想理由 ===
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
  if (profile?.winning_style?.st_stability >= 70) reasons.push("ST安定");
  if (profile?.winning_style?.st_stability < 40) notes.push("ST不安定");
  if (profile && profile.total_samples < 5) notes.push("プロファイルデータ少");
  if (profileWin == null && officialWin != null) notes.push("公式成績ベース予想");

  // === トレンド理由(RacerRollingStats) ===
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
    start_power, motor_power, exhibition_power, local_fit, section_form, ana_potential,
    exhibition_delta: round1(exhibition_delta),
    reasons, notes,
    dataCount: Math.max(profile?.total_samples || 0, rolling?.stats_all?.race_count || 0),
    racer_power_score: trend?.racer_power_score != null ? Math.round(trend.racer_power_score) : null,
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

// 予想実行
export function runPrediction(entries, settings, options = {}) {
  const stage = settings?.stage || "PRE";
  const isFinal = stage === "FINAL";
  const preBoatScores = options.preBoatScores || null;

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

  // ランキング(1着候補・2着候補・3着候補)
  const firstRanking = [...activeScores].sort((a, b) => b.first_power - a.first_power).map(b => b.boat_number);
  const secondRanking = [...activeScores].sort((a, b) => b.second_power - a.second_power).map(b => b.boat_number);
  const thirdRanking = [...activeScores].sort((a, b) => b.third_power - a.third_power).map(b => b.boat_number);

  const honmei = firstRanking[0];
  const taiko = secondRanking[0];
  const ana = [...activeScores].sort((a, b) => b.ana_potential - a.ana_potential)[0]?.boat_number;
  const keshi = firstRanking[firstRanking.length - 1];

  const topTrifecta = trifectas[0];
  const grade = gradePrediction(activeScores);

  return {
    stage, boatScores, trifectas,
    race_scenario: raceScenario,
    prediction_grade: grade,
    data_confidence: dataConfidence,
    honmei_boat: honmei, taiko_boat: taiko, ana_boat: ana, keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination, top_probability: topTrifecta?.probability,
    first_ranking: firstRanking, second_ranking: secondRanking, third_ranking: thirdRanking,
    exhibition_ready: activeScores.some(s => s.exhibition_delta !== 0),
  };
}

// 互換用: 判定は参考情報として残す
export function judgeTrifecta(trifecta, ctx = {}) {
  const { settings = {}, dataConfidence = 50 } = ctx;
  const prob = trifecta.probability || 0;
  if (prob < (settings.min_probability || 5)) return { judgment: "SKIP", basis: `確率${prob}%不足` };
  if (dataConfidence < (settings.min_confidence || 40)) return { judgment: "SKIP", basis: "データ信頼度不足" };
  if (prob >= 15 && dataConfidence >= 60) return { judgment: "STRONG_BUY", basis: `確率${prob}%・信頼度${dataConfidence}` };
  if (prob >= 10) return { judgment: "BUY", basis: `確率${prob}%` };
  if (prob >= 6) return { judgment: "WATCH", basis: `確率${prob}%` };
  return { judgment: "SKIP", basis: `確率${prob}%低` };
}