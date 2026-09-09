// 選手ローリング統計エンジン（6m/1y/3y/all + トレンドスコア）
// RacerTermStats + RacerRaceHistory から RacerRollingStats を計算

// === 数値ユーティリティ ===
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const round3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);
const pct = (a, b) => (b > 0 ? round1((a / b) * 100) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 級別を数値化（A1=4, A2=3, B1=2, B2=1, 不明=0）
function classToNum(cls) {
  const c = String(cls || "").trim().toUpperCase();
  if (c === "A1") return 4;
  if (c === "A2") return 3;
  if (c === "B1") return 2;
  if (c === "B2") return 1;
  return 0;
}

// === 期別データから指定期間の統計を集計 ===
function aggregateTermStats(termRecords) {
  if (!termRecords.length) {
    return { race_count: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_st: null, f_rate: null, course_stats: {}, winning_methods: {} };
  }
  let totalRaces = 0, totalFirst = 0, totalSecond = 0, totalTop3 = 0;
  let totalSt = 0, stCount = 0, totalF = 0;
  const courseAgg = {};
  for (let c = 1; c <= 6; c++) courseAgg[String(c)] = { entries: 0, first: 0, second: 0, third: 0, f: 0, st_sum: 0, st_count: 0 };

  for (const t of termRecords) {
    const rc = num(t.race_count) || 0;
    if (rc <= 0) continue;
    totalRaces += rc;
    totalFirst += num(t.first_count) || 0;
    totalSecond += num(t.second_count) || 0;
    totalTop3 += (num(t.first_count) || 0) + (num(t.second_count) || 0) + ((num(t.course_stats?.["1"]?.third_count) || 0) + (num(t.course_stats?.["2"]?.third_count) || 0) + (num(t.course_stats?.["3"]?.third_count) || 0) + (num(t.course_stats?.["4"]?.third_count) || 0) + (num(t.course_stats?.["5"]?.third_count) || 0) + (num(t.course_stats?.["6"]?.third_count) || 0));
    const st = num(t.avg_st);
    if (st != null && st > 0 && st < 5) { totalSt += st * rc; stCount += rc; }
    totalF += num(t.f_count) || 0;

    // コース別集計
    for (let c = 1; c <= 6; c++) {
      const cs = t.course_stats?.[String(c)];
      if (!cs) continue;
      const entries = num(cs.entries) || 0;
      if (entries > 0) {
        courseAgg[String(c)].entries += entries;
        courseAgg[String(c)].first += num(cs.first_count) || 0;
        courseAgg[String(c)].second += num(cs.second_count) || 0;
        courseAgg[String(c)].third += num(cs.third_count) || 0;
        courseAgg[String(c)].f += num(cs.f_count) || 0;
        const cst = num(cs.avg_st);
        if (cst != null && cst > 0 && cst < 5) { courseAgg[String(c)].st_sum += cst * entries; courseAgg[String(c)].st_count += entries; }
      }
    }
  }

  if (totalRaces === 0) {
    return { race_count: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_st: null, f_rate: null, course_stats: {}, winning_methods: {} };
  }

  // top3の再計算（termRecordsから直接計算）
  let totalTop3Correct = 0;
  for (const t of termRecords) {
    for (let c = 1; c <= 6; c++) {
      totalTop3Correct += num(t.course_stats?.[String(c)]?.first_count) || 0;
      totalTop3Correct += num(t.course_stats?.[String(c)]?.second_count) || 0;
      totalTop3Correct += num(t.course_stats?.[String(c)]?.third_count) || 0;
    }
  }

  const courseStats = {};
  for (let c = 1; c <= 6; c++) {
    const a = courseAgg[String(c)];
    if (a.entries > 0) {
      courseStats[String(c)] = {
        entries: a.entries,
        win_rate: pct(a.first, a.entries),
        top2_rate: pct(a.first + a.second, a.entries),
        top3_rate: pct(a.first + a.second + a.third, a.entries),
        avg_st: a.st_count > 0 ? round3(a.st_sum / a.st_count) : null,
        f_count: a.f,
        f_rate: pct(a.f, a.entries),
      };
    }
  }

  return {
    race_count: totalRaces,
    win_rate: pct(totalFirst, totalRaces),
    top2_rate: pct(totalFirst + totalSecond, totalRaces),
    top3_rate: totalTop3Correct > 0 ? pct(totalTop3Correct, totalRaces) : pct(totalFirst + totalSecond, totalRaces),
    avg_st: stCount > 0 ? round3(totalSt / stCount) : null,
    f_rate: pct(totalF, totalRaces),
    course_stats: courseStats,
    winning_methods: {},
  };
}

// === RacerRaceHistoryから指定期間の統計を集計 ===
function aggregateHistoryStats(historyRecords) {
  const finished = historyRecords.filter((r) => {
    const fo = num(r.finish_order);
    return fo != null && fo >= 1 && fo <= 6 && !r.is_absent && !r.is_disqualified;
  });
  if (!finished.length) {
    return { race_count: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_st: null, f_rate: null, course_stats: {}, winning_methods: {} };
  }

  let totalFirst = 0, totalSecond = 0, totalTop3 = 0;
  let totalSt = 0, stCount = 0, totalF = 0;
  const courseAgg = {};
  for (let c = 1; c <= 6; c++) courseAgg[String(c)] = { entries: 0, first: 0, second: 0, third: 0, f: 0, st_sum: 0, st_count: 0 };
  const wmCounts = { escape: 0, sashi: 0, makuri: 0, makuri_sashi: 0, nuki: 0, megumare: 0, other: 0 };
  let totalWins = 0;

  for (const r of finished) {
    const fo = num(r.finish_order);
    if (fo === 1) totalFirst++;
    if (fo <= 2) totalSecond++;
    if (fo <= 3) totalTop3++;
    const st = num(r.st);
    if (st != null && st > 0 && st < 5) { totalSt += st; stCount++; }
    const course = num(r.course) || num(r.boat_number);
    if (course >= 1 && course <= 6) {
      const a = courseAgg[String(course)];
      a.entries++;
      if (fo === 1) a.first++;
      if (fo === 2) a.second++;
      if (fo === 3) a.third++;
    }
    // 勝ち方
    if (fo === 1) {
      totalWins++;
      const m = String(r.winning_method || "");
      if (/逃げ/.test(m)) wmCounts.escape++;
      else if (/まくり差し|まくり差/.test(m)) wmCounts.makuri_sashi++;
      else if (/差し/.test(m)) wmCounts.sashi++;
      else if (/まくり/.test(m)) wmCounts.makuri++;
      else if (/抜き/.test(m)) wmCounts.nuki++;
      else if (/恵まれ|恵ま/.test(m)) wmCounts.megumare++;
      else wmCounts.other++;
    }
  }

  const courseStats = {};
  for (let c = 1; c <= 6; c++) {
    const a = courseAgg[String(c)];
    if (a.entries > 0) {
      courseStats[String(c)] = {
        entries: a.entries,
        win_rate: pct(a.first, a.entries),
        top2_rate: pct(a.first + a.second, a.entries),
        top3_rate: pct(a.first + a.second + a.third, a.entries),
        avg_st: a.st_count > 0 ? round3(a.st_sum / a.st_count) : null,
      };
    }
  }

  const winningMethods = {
    escape_rate: pct(wmCounts.escape, totalWins),
    sashi_rate: pct(wmCounts.sashi, totalWins),
    makuri_rate: pct(wmCounts.makuri, totalWins),
    makuri_sashi_rate: pct(wmCounts.makuri_sashi, totalWins),
    nuki_rate: pct(wmCounts.nuki, totalWins),
    megumare_rate: pct(wmCounts.megumare, totalWins),
    total_wins: totalWins,
  };

  return {
    race_count: finished.length,
    win_rate: pct(totalFirst, finished.length),
    top2_rate: pct(totalSecond, finished.length),
    top3_rate: pct(totalTop3, finished.length),
    avg_st: stCount > 0 ? round3(totalSt / stCount) : null,
    f_rate: null, // RacerRaceHistoryにはF情報がない場合が多い
    course_stats: courseStats,
    winning_methods: winningMethods,
  };
}

// === トレンドスコア計算 ===
function computeTrendScores(termRecords, rollingStats) {
  // 期を時系列順にソート（古い→新しい）
  const sorted = [...termRecords].sort((a, b) => {
    const ka = String(a.term_year || "") + (a.term_half === "FIRST" ? "0" : "1");
    const kb = String(b.term_year || "") + (b.term_half === "FIRST" ? "0" : "1");
    return ka.localeCompare(kb);
  });

  const scores = {
    recent_form_score: 50,
    st_trend_score: 50,
    class_trend_score: 50,
    course_trend_score: 50,
    performance_trend: 50,
    racer_power_score: 50,
  };

  if (sorted.length < 1) return { scores, classHistory: [], sorted: [] };

  const latest = sorted[sorted.length - 1];
  const older = sorted.slice(0, -1);

  // === recent_form_score: 最近期の勝率 vs 過去平均 ===
  if (older.length >= 1) {
    const latestWin = num(latest.win_rate) || 0;
    const olderWinAvg = older.reduce((s, t) => s + (num(t.win_rate) || 0), 0) / older.length;
    const diff = latestWin - olderWinAvg;
    // 差が+1.0なら+20ポイント、-1.0なら-20ポイント
    scores.recent_form_score = round1(clamp(50 + diff * 20, 0, 100));
  }

  // === st_trend_score: 最近期のST vs 過去平均（改善=高） ===
  if (older.length >= 1) {
    const latestST = num(latest.avg_st);
    const olderSTAvg = older.reduce((s, t) => s + (num(t.avg_st) || 0), 0) / older.length;
    if (latestST != null && olderSTAvg > 0) {
      const diff = olderSTAvg - latestST; // STが下がった（改善）=正
      // 差が+0.03なら+20ポイント
      scores.st_trend_score = round1(clamp(50 + diff / 0.03 * 20, 0, 100));
    }
  }

  // === class_trend_score: 級別推移 ===
  const classHistory = sorted.map((t) => ({ term_key: t.term_key, player_class: t.player_class }));
  if (classHistory.length >= 2) {
    const latestClass = classToNum(latest.player_class);
    const prevClasses = older.slice(-3).map((t) => classToNum(t.player_class)).filter((c) => c > 0);
    if (prevClasses.length > 0 && latestClass > 0) {
      const prevAvg = prevClasses.reduce((s, c) => s + c, 0) / prevClasses.length;
      const diff = latestClass - prevAvg;
      // 1級上昇で+25ポイント
      scores.class_trend_score = round1(clamp(50 + diff * 25, 0, 100));
    }
  }

  // === course_trend_score: コース別成長 ===
  if (older.length >= 1) {
    let courseDiffs = [];
    for (let c = 1; c <= 6; c++) {
      const latestCS = latest.course_stats?.[String(c)];
      if (!latestCS || num(latestCS.entries) < 3) continue;
      const latestWinRate = num(latestCS.win_rate) || 0;
      // 過去3期の同コース勝率平均
      const olderWinRates = older.slice(-3).map((t) => num(t.course_stats?.[String(c)]?.win_rate) || 0).filter((w) => w > 0);
      if (olderWinRates.length > 0) {
        const olderAvg = olderWinRates.reduce((s, w) => s + w, 0) / olderWinRates.length;
        courseDiffs.push(latestWinRate - olderAvg);
      }
    }
    if (courseDiffs.length > 0) {
      const avgDiff = courseDiffs.reduce((s, d) => s + d, 0) / courseDiffs.length;
      // +10%で+20ポイント
      scores.course_trend_score = round1(clamp(50 + avgDiff * 2, 0, 100));
    }
  }

  // === performance_trend: 総合 ===
  scores.performance_trend = round1(
    (scores.recent_form_score + scores.st_trend_score + scores.class_trend_score + scores.course_trend_score) / 4
  );

  // === racer_power_score: 総合選手力 ===
  const currentWin = num(latest.win_rate) || 0;
  const currentTop2 = num(latest.fukusho_rate) || 0;
  const currentST = num(latest.avg_st) || 0.2;
  const classNum = classToNum(latest.player_class);

  // 勝率: 6.0→100, 3.0→50, 0.0→0 (boatrace勝率は低いほど良いが、ファン手帳の勝率は高いほど良い)
  // ※ファン手帳の勝率は平均着順点（低いほど良い）の場合と、1着率（高いほど良い）の場合がある
  // ここでは「高いほど良い」として扱う（1着率ベース）
  const winScore = clamp(currentWin * 10, 0, 100); // 10%→100
  const top2Score = clamp(currentTop2, 0, 100);
  // ST: 0.10→100, 0.30→0
  const stScore = clamp(100 - (currentST - 0.10) / 0.20 * 100, 0, 100);
  const classScore = clamp(classNum * 25, 0, 100);
  const trendScore = scores.performance_trend;

  scores.racer_power_score = round1(
    winScore * 0.25 + top2Score * 0.20 + stScore * 0.20 + classScore * 0.15 + trendScore * 0.20
  );

  return { scores, classHistory, sorted };
}

// === メイン: 1選手のRacerRollingStatsを計算 ===
export function computeRollingStats(registration_number, racer_name, termRecords, historyRecords) {
  const now = new Date().toISOString();
  const cutoff6m = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const cutoff1y = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const cutoff3y = new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000);

  // 期別データを期間でフィルタ
  const termsInPeriod = (cutoff) => {
    return termRecords.filter((t) => {
      const end = t.term_end_date ? new Date(t.term_end_date) : null;
      const start = t.term_start_date ? new Date(t.term_start_date) : null;
      if (end && end >= cutoff) return true;
      if (!end && start && start >= cutoff) return true;
      return false;
    });
  };

  // RacerRaceHistoryを期間でフィルタ
  const historyInPeriod = (cutoff) => {
    return historyRecords.filter((r) => {
      if (!r.race_date) return false;
      return new Date(r.race_date) >= cutoff;
    });
  };

  // 6m/1y/3y: RacerRaceHistory優先、不足時はRacerTermStats補完
  const stats6m = historyInPeriod(cutoff6m).length >= 5
    ? aggregateHistoryStats(historyInPeriod(cutoff6m))
    : (termsInPeriod(cutoff6m).length > 0 ? aggregateTermStats(termsInPeriod(cutoff6m)) : aggregateHistoryStats(historyInPeriod(cutoff6m)));
  const stats1y = historyInPeriod(cutoff1y).length >= 10
    ? aggregateHistoryStats(historyInPeriod(cutoff1y))
    : (termsInPeriod(cutoff1y).length > 0 ? aggregateTermStats(termsInPeriod(cutoff1y)) : aggregateHistoryStats(historyInPeriod(cutoff1y)));
  const stats3y = termsInPeriod(cutoff3y).length > 0
    ? aggregateTermStats(termsInPeriod(cutoff3y))
    : aggregateHistoryStats(historyInPeriod(cutoff3y));
  const statsAll = termRecords.length > 0
    ? aggregateTermStats(termRecords)
    : aggregateHistoryStats(historyRecords);

  // トレンドスコア
  const { scores, classHistory, sorted } = computeTrendScores(termRecords, { stats6m, stats1y, stats3y, statsAll });

  // 履歴配列
  const termHistory = sorted.map((t) => ({
    term_key: t.term_key,
    term_year: t.term_year,
    term_half: t.term_half,
    player_class: t.player_class,
    win_rate: t.win_rate,
    avg_st: t.avg_st,
    race_count: t.race_count,
  }));
  const stHistory = sorted.map((t) => ({ term_key: t.term_key, avg_st: t.avg_st }));
  const winRateHistory = sorted.map((t) => ({ term_key: t.term_key, win_rate: t.win_rate }));

  // 最新期
  const latest = sorted[sorted.length - 1] || null;
  const currentTerm = latest ? {
    term_key: latest.term_key,
    term_year: latest.term_year,
    term_half: latest.term_half,
    player_class: latest.player_class,
    win_rate: latest.win_rate,
    avg_st: latest.avg_st,
  } : null;

  // データ信頼度
  const totalTerms = termRecords.length;
  const totalHistory = historyRecords.length;
  let dataConfidence = 0;
  if (totalTerms >= 8) dataConfidence = 100;
  else if (totalTerms >= 4) dataConfidence = 60 + (totalTerms - 4) * 10;
  else if (totalTerms >= 1) dataConfidence = totalTerms * 15;
  if (totalHistory >= 50) dataConfidence = Math.max(dataConfidence, 80);
  dataConfidence = Math.min(100, dataConfidence);

  return {
    registration_number,
    racer_name: racer_name || "",
    calculated_at: now,
    stats_6m: stats6m,
    stats_1y: stats1y,
    stats_3y: stats3y,
    stats_all: statsAll,
    term_history: termHistory,
    trend_scores: scores,
    class_history: classHistory || [],
    st_history: stHistory,
    win_rate_history: winRateHistory,
    current_term: currentTerm,
    data_confidence: dataConfidence,
  };
}