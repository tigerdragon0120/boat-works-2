// ============================================================
// Prediction Engine V2
// 過去25% + 直近35% + 当日40% の3軸評価
// V1(predictionEngine.js)とは完全独立。V1を一切変更しない。
// 確率はBOATCASTデータから純粋に生成(オッズ不使用)
// オッズは期待値計算のみに使用
// ============================================================

const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

// V2重み配分(固定。自動変更禁止)
const V2_WEIGHTS = { past: 0.25, recent: 0.35, today: 0.40 };

// ST値→スコア(低い=良い)
const stToScore = (st, refSt = 0.15) => {
  if (!isValid(st)) return null;
  return clamp(70 + (refSt - st) * 300, 5, 100);
};

// 級別→スコア
const classToScore = (cls) => {
  if (!cls) return 50;
  const c = String(cls).toUpperCase();
  if (c === 'A1') return 100;
  if (c === 'A2') return 80;
  if (c === 'B1') return 60;
  if (c === 'B2') return 40;
  return 50;
};

// 6艇内順位→スコア(1位=100, 6位≈17)
const rankToScore = (rank, total = 6) => {
  if (!isValid(rank)) return null;
  return clamp(((total - rank + 1) / total) * 100, 0, 100);
};

// 6艇内で値の順位を計算(高い=良い → rank 1)
const rankHigh = (values) => {
  const indexed = values.map((v, i) => ({ v, i })).filter(x => isValid(x.v));
  indexed.sort((a, b) => b.v - a.v);
  const ranks = new Array(values.length).fill(null);
  indexed.forEach((x, idx) => { ranks[x.i] = idx + 1; });
  return ranks;
};

// 6艇内で値の順位を計算(低い=良い → rank 1)
const rankLow = (values) => {
  const indexed = values.map((v, i) => ({ v, i })).filter(x => isValid(x.v));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(null);
  indexed.forEach((x, idx) => { ranks[x.i] = idx + 1; });
  return ranks;
};

// 重み付き平均(null/NaN除外→再正規化)
const weightedAvg = (pairs, fallback = 50) => {
  const valid = pairs.filter(([s]) => s !== null && isValid(s));
  if (!valid.length) return fallback;
  const denom = valid.reduce((a, [, w]) => a + w, 0);
  return denom > 0 ? valid.reduce((a, [s, w]) => a + s * w, 0) / denom : fallback;
};

// ============================================================
// 1. 過去評価 25%
// 長期的選手能力 + 現在コース適性
// ============================================================
function computePastScore(entry, allEntries) {
  const profile = entry._profile;
  const rolling = entry._rollingStats;
  const course = entry.boat_number;

  // 全国勝率(0-100スケール: 7.5→75)
  const nationalWin = isValid(entry.national_win_rate) ? clamp(entry.national_win_rate * 10, 0, 100) : null;
  const nationalF2 = isValid(entry.national_f2_rate) ? clamp(entry.national_f2_rate, 0, 100) : null;

  // 当地勝率
  const localWin = isValid(entry.local_win_rate) ? clamp(entry.local_win_rate * 10, 0, 100) : null;
  const localF2 = isValid(entry.local_f2_rate) ? clamp(entry.local_f2_rate, 0, 100) : null;

  // 級別
  const classScore = classToScore(entry.player_class || entry.grade_class);

  // コース別長期成績(profile)
  let courseWin = null;
  if (profile?.course_stats) {
    const cs = profile.course_stats[String(course)];
    if (cs && cs.sample_size >= 3 && isValid(cs.win_rate)) {
      courseWin = clamp(cs.win_rate, 0, 100);
    }
  }

  // ローリング統計の勝率(6ヶ月)
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
// BOATCAST WAKU10 + 節間成績 + 直近調子
// ============================================================
function computeRecentScore(entry, allEntries) {
  const laneRecent = entry._laneRecent;
  const rolling = entry._rollingStats;

  // WAKU10勝率(BOATCAST最優先)
  const waku10Win = isValid(laneRecent?.winning_rate) ? clamp(Number(laneRecent.winning_rate), 0, 100) : null;
  const waku10Top2 = isValid(laneRecent?.top2_rate) ? clamp(Number(laneRecent.top2_rate), 0, 100) : null;
  const waku10Top3 = isValid(laneRecent?.top3_rate) ? clamp(Number(laneRecent.top3_rate), 0, 100) : null;

  // WAKU10平均ST
  const waku10St = isValid(laneRecent?.avg_st) ? Number(laneRecent.avg_st) : null;
  const waku10StScore = waku10St != null ? stToScore(waku10St) : null;

  // WAKU10 ST順
  const waku10StRank = isValid(laneRecent?.avg_start_order) ? Number(laneRecent.avg_start_order) : null;
  const waku10StRankScore = waku10StRank != null ? clamp(116 - waku10StRank * 16, 20, 100) : null;

  // 直近調子(RacerRollingStats)
  const recentFormScore = rolling?.trend_scores?.recent_form_score != null
    ? clamp(rolling.trend_scores.recent_form_score, 0, 100) : null;
  const racerPowerScore = rolling?.trend_scores?.racer_power_score != null
    ? clamp(rolling.trend_scores.racer_power_score, 0, 100) : null;

  // 節間成績
  const sectionScore = isValid(entry.section_points) ? clamp(entry.section_points * 2, 0, 100) : null;
  const sectionMomentum = isValid(entry.section_momentum) ? clamp(50 + entry.section_momentum * 10, 0, 100) : null;

  // WAKU10サンプル数による信頼度重み
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

  // WAKU10があれば重視、なければローリング+節間で補完
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
// 展示タイム・展示ST・展示進入・モーター・ボート・天候
// ============================================================
function computeTodayScore(entry, allEntries, race) {
  // 展示タイム
  const exTime = isValid(entry.exhibition_time) ? Number(entry.exhibition_time) : null;
  // 展示ST
  const exSt = isValid(entry.exhibition_st) ? Number(entry.exhibition_st) : null;
  const exStScore = exSt != null ? stToScore(exSt, 0.1) : null;
  // 展示進入
  const exCourse = isValid(entry.exhibition_course) ? Number(entry.exhibition_course) : null;
  // チルト
  const tilt = isValid(entry.tilt) ? Number(entry.tilt) : null;

  // 6艇内順位(展示タイム: 低い=良い)
  const exTimeRanks = rankLow(allEntries.map(e => isValid(e.exhibition_time) ? Number(e.exhibition_time) : null));
  const exTimeRank = exTimeRanks[allEntries.indexOf(entry)];
  const exTimeRankScore = rankToScore(exTimeRank, allEntries.filter(e => isValid(e.exhibition_time)).length || 6);

  // 6艇内順位(展示ST: 低い=良い)
  const exStRanks = rankLow(allEntries.map(e => isValid(e.exhibition_st) ? Number(e.exhibition_st) : null));
  const exStRank = exStRanks[allEntries.indexOf(entry)];
  const exStRankScore = rankToScore(exStRank, allEntries.filter(e => isValid(e.exhibition_st)).length || 6);

  // 進入変更効果(枠番より内側なら加点、外側なら減点)
  let entryAdjust = 0;
  if (exCourse != null && exCourse !== entry.boat_number) {
    entryAdjust = exCourse < entry.boat_number ? 8 : -8;
  }

  // モーター・ボート
  const motorScore = isValid(entry.motor_f2_rate) ? clamp(entry.motor_f2_rate, 0, 100) : null;
  const boatScore = isValid(entry.boat_f2_rate) ? clamp(entry.boat_f2_rate, 0, 100) : null;

  // 展示タイム絶対値スコア(1.4秒基準)
  const exTimeAbsScore = exTime != null ? clamp(50 + (1.4 - exTime) * 100, 5, 100) : null;

  const components = {
    exhibition_time: exTime, exhibition_time_rank: exTimeRank, exhibition_time_rank_score: exTimeRankScore,
    exhibition_st: exSt, exhibition_st_score: exStScore, exhibition_st_rank: exStRank, exhibition_st_rank_score: exStRankScore,
    exhibition_course: exCourse, entry_adjust: entryAdjust,
    tilt, motor: motorScore, boat: boatScore,
    exhibition_time_abs: exTimeAbsScore,
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
// 6艇内相対順位計算
// ============================================================
function computeRelativeRanks(boats) {
  const pastRanks = rankHigh(boats.map(b => b.past_score));
  const recentRanks = rankHigh(boats.map(b => b.recent_score));
  const todayRanks = rankHigh(boats.map(b => b.today_score));
  const preRanks = rankHigh(boats.map(b => b.pre_score));
  const finalRanks = rankHigh(boats.map(b => b.final_score));

  return boats.map((b, i) => ({
    boat_number: b.boat_number,
    past_rank: pastRanks[i],
    recent_rank: recentRanks[i],
    today_rank: todayRanks[i],
    pre_rank: preRanks[i],
    final_rank: finalRanks[i],
  }));
}

// ============================================================
// メイン: V2 Boat Scores計算
// ============================================================
export function computeV2BoatScores(entries, race, stage) {
  const isFinal = stage === "FINAL";
  const activeEntries = entries.filter(e => !e.is_absent && e.boat_number);

  // Step 1-3: 各軸スコア計算
  const boats = activeEntries.map(entry => {
    const past = computePastScore(entry, activeEntries);
    const recent = computeRecentScore(entry, activeEntries);
    const today = isFinal ? computeTodayScore(entry, activeEntries, race) : { score: null, components: {} };

    // PRE score: todayがnullの場合は過去+直近で再正規化
    let pre_score;
    if (today.score != null) {
      pre_score = clamp(
        past.score * V2_WEIGHTS.past + recent.score * V2_WEIGHTS.recent + today.score * V2_WEIGHTS.today,
        0, 100
      );
    } else {
      // today欠損時: 過去+直近で再正規化
      const totalW = V2_WEIGHTS.past + V2_WEIGHTS.recent;
      pre_score = clamp(
        (past.score * V2_WEIGHTS.past + recent.score * V2_WEIGHTS.recent) / totalW,
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
      reasons: [],
      notes: [],
    };
  });

  // Step 4: FINAL時のdelta計算
  if (isFinal) {
    for (const b of boats) {
      // FINAL score = past * 0.25 + recent * 0.35 + today * 0.40
      const finalScore = clamp(
        b.past_score * V2_WEIGHTS.past + b.recent_score * V2_WEIGHTS.recent + b.today_score * V2_WEIGHTS.today,
        0, 100
      );
      b.final_score = round1(finalScore);
      b.final_delta = round1(finalScore - b.pre_score);

      // 進入変更理由
      const exCourse = b.entry.exhibition_course;
      if (isValid(exCourse) && exCourse !== b.boat_number) {
        b.notes.push(`進入変更(${b.boat_number}→${exCourse})`);
      }
      // 展示ST理由
      if (isValid(b.entry.exhibition_st)) {
        b.reasons.push(`展示ST ${b.entry.exhibition_st}`);
      }
    }
  } else {
    for (const b of boats) {
      b.final_score = null;
      b.final_delta = null;
    }
  }

  // 相対順位
  const ranks = computeRelativeRanks(boats);
  for (const b of boats) {
    const r = ranks.find(x => x.boat_number === b.boat_number);
    b.relative_ranks = r || {};
  }

  return boats;
}

// ============================================================
// 3連単確率計算(120通り)
// 1着適性・2着適性・3着適性を分離
// ============================================================
export function computeV2Trifectas(boatScores, stage) {
  const boats = boatScores.filter(b => !b.entry?.is_absent);
  const numbers = boats.map(b => b.boat_number);

  // 1着適性: スコア + コース別1着能力 + ST
  const firstAptitude = boats.map(b => {
    const base = stage === "FINAL" ? (b.final_score ?? b.pre_score) : b.pre_score;
    const course = b.boat_number;
    // 1コースは逃げ能力を重視
    let escapeBonus = 0;
    const wm = b.entry?._profile?.winning_methods;
    if (wm?.total_wins >= 2) {
      if (course === 1 && wm.escape_rate != null) escapeBonus = wm.escape_rate * 0.15;
      if (course === 2 && wm.sashi_rate != null) escapeBonus = wm.sashi_rate * 0.10;
      if (course === 3 && wm.makuri_rate != null) escapeBonus = wm.makuri_rate * 0.08;
    }
    return clamp(base + escapeBonus, 5, 100);
  });

  // 2着適性: スコア + 2連率
  const secondAptitude = boats.map(b => {
    const base = stage === "FINAL" ? (b.final_score ?? b.pre_score) : b.pre_score;
    const top2 = b.recent_components?.waku10_top2;
    const adj = top2 != null ? (top2 - 50) * 0.10 : 0;
    return clamp(base + adj, 5, 100);
  });

  // 3着適性: スコア + 3連率
  const thirdAptitude = boats.map(b => {
    const base = stage === "FINAL" ? (b.final_score ?? b.pre_score) : b.pre_score;
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

  const firstProb = softmax(firstAptitude, 6.0);
  const firstP = {};
  boats.forEach((b, i) => { firstP[b.boat_number] = firstProb[i]; });

  const results = [];
  for (const i of numbers) {
    const secondBoats = boats.filter(b => b.boat_number !== i);
    const secondProb = softmax(secondBoats.map(b => {
      const idx = boats.indexOf(b);
      return secondAptitude[idx];
    }), 8.0);
    const secondP = {};
    secondBoats.forEach((b, k) => { secondP[b.boat_number] = secondProb[k]; });

    for (const j of numbers) {
      if (j === i) continue;
      const thirdBoats = boats.filter(b => b.boat_number !== i && b.boat_number !== j);
      const thirdProb = softmax(thirdBoats.map(b => {
        const idx = boats.indexOf(b);
        return thirdAptitude[idx];
      }), 10.0);
      const thirdP = {};
      thirdBoats.forEach((b, k) => { thirdP[b.boat_number] = thirdProb[k]; });

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

  // ランク付与
  results.sort((a, b) => b.probability - a.probability);
  results.forEach((r, idx) => { r.rank = idx + 1; });

  // 確率合計チェック(100%になるよう正規化)
  const total = results.reduce((s, r) => s + r.probability, 0);
  if (total > 0 && Math.abs(total - 100) > 0.1) {
    const factor = 100 / total;
    results.forEach(r => { r.probability = Math.round(r.probability * factor * 10) / 10; });
  }

  return results;
}

// ============================================================
// 買い目選定(基本6点、最大8点)
// EV = probability × odds で降順ソート
// ============================================================
export function selectV2Tickets(trifectas, oddsMap, settings) {
  const maxTickets = 8;
  const defaultTickets = 6;

  // EV計算
  const withEv = trifectas.map(t => {
    const odds = oddsMap?.[t.combination] || null;
    const ev = odds != null ? Math.round(t.probability * odds * 10) / 10 : null;
    return { ...t, actual_odds: odds, expected_value: ev };
  });

  // EV降順ソート(EV nullは確率順)
  withEv.sort((a, b) => {
    if (a.expected_value != null && b.expected_value != null) return b.expected_value - a.expected_value;
    if (a.expected_value != null) return -1;
    if (b.expected_value != null) return 1;
    return b.probability - a.probability;
  });

  // 基本6点選択
  const selected = withEv.slice(0, defaultTickets);

  // 7-8点拡張: EVが明確に高い場合のみ
  const extension = withEv.slice(defaultTickets, maxTickets);
  const minSelectedEv = selected.filter(t => t.expected_value != null).length > 0
    ? Math.min(...selected.filter(t => t.expected_value != null).map(t => t.expected_value))
    : null;

  const extended = [];
  for (const t of extension) {
    // 確率が上位8位以内で、EVが選択内最低以上の場合のみ拡張
    if (t.probability >= 1.0 && (minSelectedEv == null || (t.expected_value != null && t.expected_value >= minSelectedEv * 0.8))) {
      extended.push(t);
    }
    if (selected.length + extended.length >= maxTickets) break;
  }

  const allSelected = [...selected, ...extended];
  allSelected.forEach((t, i) => {
    t.is_selected = true;
    t.ticket_rank = i + 1;
  });

  // 選択外にis_selected=false
  for (const t of withEv) {
    if (!allSelected.find(s => s.combination === t.combination)) {
      t.is_selected = false;
      t.ticket_rank = null;
    }
  }

  return { selected: allSelected, all: withEv };
}

// ============================================================
// セット期待値計算
// ============================================================
export function computeV2SetMetrics(selectedTickets, oddsMap, settings) {
  if (!selectedTickets.length) return null;

  const setProbability = selectedTickets.reduce((s, t) => s + t.probability, 0);
  const oddsValues = selectedTickets
    .map(t => oddsMap?.[t.combination] || t.actual_odds)
    .filter(o => o != null && o > 0);

  const minPayout = oddsValues.length ? Math.min(...oddsValues) * 100 : null;
  const maxPayout = oddsValues.length ? Math.max(...oddsValues) * 100 : null;
  const avgPayout = oddsValues.length
    ? (oddsValues.reduce((s, o) => s + o, 0) / oddsValues.length) * 100
    : null;

  // 合成オッズ = 1 / 確率合計
  const syntheticOdds = setProbability > 0 ? Math.round(100 / setProbability * 10) / 10 : null;

  // セット期待回収率 = (的中時平均払戻) / 投資額(100円×点数)
  const investment = selectedTickets.length * 100;
  const expectedRecovery = avgPayout != null
    ? Math.round((avgPayout * (setProbability / 100)) / investment * 100 * 10) / 10
    : null;

  // 最高EV買い目
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
  };
}

// ============================================================
// BUY/WATCH/SKIP判定
// ============================================================
export function judgeV2(setMetrics, dataConfidence, settings, stage) {
  const recovery = setMetrics?.set_expected_recovery;
  const setProb = setMetrics?.set_probability;
  const buyThreshold = settings?.buy_set_ev_threshold || 120;
  const watchThreshold = settings?.watch_set_ev_threshold || 90;
  const minProb = settings?.min_set_probability || 25;

  if (recovery == null) return { judgment: "SKIP", reason: "オッズ未取得のため評価不可" };
  if (setProb != null && setProb < minProb) return { judgment: "SKIP", reason: `セット確率${setProb}%が最低値${minProb}%未満` };

  if (recovery >= buyThreshold) return { judgment: "BUY", reason: `セット期待回収率${recovery}%≥${buyThreshold}%` };
  if (recovery >= watchThreshold) return { judgment: "WATCH", reason: `セット期待回収率${recovery}%≥${watchThreshold}%` };
  return { judgment: "SKIP", reason: `セット期待回収率${recovery}%<${watchThreshold}%` };
}

// ============================================================
// メイン: V2予想実行
// ============================================================
export function runPredictionV2(entries, race, settings, options = {}) {
  const stage = options.stage || settings?.stage || "PRE";
  const oddsMap = options.oddsMap || {};

  // Boat Scores計算
  const boatScores = computeV2BoatScores(entries, race, stage);

  // 3連単確率計算
  const trifectas = computeV2Trifectas(boatScores, stage);

  // 買い目選定
  const { selected, all } = selectV2Tickets(trifectas, oddsMap, settings);

  // セット期待値
  const setMetrics = computeV2SetMetrics(selected, oddsMap, settings);

  // データ信頼度
  const dataConfidence = computeDataConfidence(boatScores, stage);

  // 判定
  const { judgment, reason } = judgeV2(setMetrics, dataConfidence, settings, stage);

  // ランキング
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";
  const sorted = [...boatScores].sort((a, b) => (b[scoreField] || 0) - (a[scoreField] || 0));
  const firstRanking = sorted.map(b => b.boat_number);

  // 2着候補ランキング
  const secondSorted = [...boatScores].sort((a, b) => {
    const aScore = (a.recent_components?.waku10_top2 || 0) + (a[scoreField] || 0) * 0.5;
    const bScore = (b.recent_components?.waku10_top2 || 0) + (b[scoreField] || 0) * 0.5;
    return bScore - aScore;
  });
  const secondRanking = secondSorted.map(b => b.boat_number);

  const thirdSorted = [...boatScores].sort((a, b) => {
    const aScore = (a.recent_components?.waku10_top3 || 0) + (a[scoreField] || 0) * 0.3;
    const bScore = (b.recent_components?.waku10_top3 || 0) + (b[scoreField] || 0) * 0.3;
    return bScore - aScore;
  });
  const thirdRanking = thirdSorted.map(b => b.boat_number);

  // 本命・対抗・穴・消し
  const honmei = firstRanking[0];
  const taiko = firstRanking[1];
  const ana = firstRanking[2];
  const keshi = firstRanking[5];

  // トップ3連単
  const topTrifecta = trifectas[0];
  const topOdds = oddsMap?.[topTrifecta.combination] || null;
  const topEv = topOdds != null ? Math.round(topTrifecta.probability * topOdds * 10) / 10 : null;

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
    trifectas: all,
    selected_trifectas: selected.map(t => t.combination),
    ticket_count: selected.length,
    ticket_selection: { selected },
    set_metrics: setMetrics,
    data_confidence: dataConfidence,
    final_judgment: judgment,
    judgment_reason: reason,
    prediction_grade: dataConfidence >= 70 ? "S" : dataConfidence >= 50 ? "A" : dataConfidence >= 30 ? "B" : "C",
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
    data_sources_used: dataSources,
    v2_weights: V2_WEIGHTS,
  };
}

// データ信頼度計算
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