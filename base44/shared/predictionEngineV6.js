// ============================================================
// Prediction Engine V6 PROFIT Candidate
// 回収率110%+を最重要目標とする利益型予想エンジン
// V2〜V5とは完全独立。既存エンジンを一切変更しない。
//
// 核心思想:
// 1. 1号艇逃げ確率を算出し、8シナリオ(1逃げ/2差し/2まくり/
//    3まくり/3まくり差し/4まくり/4まくり差し/5-6攻め)を評価
// 2. 外枠A1を単純下方評価せず、内側艇の弱さ・ST・展示・モーター
//    から「1が逃げ切るか外艇が攻め切るか」を評価
// 3. 1着艇ごとに P(2着|1着) を独立評価(シナリオ別2着候補)
// 4. 3着候補を広げて的中率を上げることは禁止
// 5. 基本6点・条件付き7点・最大8点(EVベース拡張)
// 6. 期待値(予測確率×オッズ)からBUY/WATCH/SKIP判定
// 7. 回収率110%+でBUY、的中率20-30%狙い
// ============================================================

const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

const V6_WEIGHTS = { past: 0.25, recent: 0.35, today: 0.40 };

// Lane Prior(実績1着分布) — 参考値。V6はシナリオベースで上書き
const LANE_PRIOR = {
  1: 0.52, 2: 0.143, 3: 0.146, 4: 0.109, 5: 0.054, 6: 0.029,
};

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
// Boat Scores計算(V4と同等のデータ準備・純粋関数)
// 欠場艇を完全除外
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

  const isOutside = entry.boat_number >= 5;
  const stWeight = isOutside ? 0.10 : 0.20;
  const stRankWeight = isOutside ? 0.05 : 0.10;
  const timeWeight = isOutside ? 0.30 : 0.25;
  const motorWeight = isOutside ? 0.20 : 0.15;

  const score = weightedAvg([
    [exTimeRankScore, timeWeight], [exTimeAbsScore, 0.10],
    [exStScore, stWeight], [exStRankScore, stRankWeight],
    [motorScore, motorWeight], [boatScore, 0.08],
    [clamp(50 + entryAdjust, 0, 100), 0.12],
  ]);

  return { score: round1(score), components, isOutside };
}

function computeV6BoatScores(entries, race, stage) {
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
        past.score * V6_WEIGHTS.past + recent.score * V6_WEIGHTS.recent + today.score * V6_WEIGHTS.today,
        0, 100
      );
    } else {
      const totalW = V6_WEIGHTS.past + V6_WEIGHTS.recent;
      pre_score = clamp(
        (past.score * V6_WEIGHTS.past + recent.score * V6_WEIGHTS.recent) / totalW,
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
        b.past_score * V6_WEIGHTS.past + b.recent_score * V6_WEIGHTS.recent + b.today_score * V6_WEIGHTS.today,
        0, 100
      );
      b.final_score = round1(finalScore);
      b.final_delta = round1(finalScore - b.pre_score);
    }
  }

  return boats;
}

// ============================================================
// V6核心: 1号艇逃げ確率
// 1号艇の枠実績・ST・モーター + 内側艇(2-3)の壁強度 から算出
// ============================================================
function computeEscapeProbability(boatScores, stage) {
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";
  const boat1 = boatScores.find(b => b.boat_number === 1);
  if (!boat1) return 50;

  const b1Score = boat1[scoreField] ?? boat1.pre_score ?? 50;
  const b1ExSt = boat1.entry?.exhibition_st;
  const b1StScore = b1ExSt != null ? stToScore(b1ExSt, 0.1) : (boat1.recent_components?.waku10_st_score ?? 50);
  const b1LaneWin = boat1.entry?._laneRecent?.winning_rate ?? 52;
  const b1Motor = boat1.today_components?.motor ?? 50;
  const b1Class = classToScore(boat1.entry?.player_class || boat1.entry?.grade_class);

  // 内側壁: 2-3号艇のスコア+ST
  const boat2 = boatScores.find(b => b.boat_number === 2);
  const boat3 = boatScores.find(b => b.boat_number === 3);
  const wallScores = [boat2, boat3].filter(Boolean).map(b => {
    const s = b[scoreField] ?? b.pre_score ?? 50;
    const st = b.entry?.exhibition_st;
    const stS = st != null ? stToScore(st, 0.1) : 50;
    return s * 0.6 + stS * 0.4;
  });
  const wallAvg = wallScores.length ? wallScores.reduce((a, b) => a + b, 0) / wallScores.length : 50;

  // 逃げ確率スコア: 1号艇力 + ST + 枠実績 + モーター + 級別 - 内側壁
  const escapeScore = clamp(
    b1Score * 0.28 + b1StScore * 0.22 + b1LaneWin * 0.18 + b1Motor * 0.10 +
    b1Class * 0.10 + (100 - wallAvg) * 0.12
  );

  return round1(escapeScore);
}

// ============================================================
// V6核心: 8シナリオ評価
// 1逃げ / 2差し / 2まくり / 3まくり / 3まくり差し /
// 4まくり / 4まくり差し / 5-6攻め
// ============================================================
function computeScenarios(boatScores, escapeProb, stage) {
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";
  const get = (n) => boatScores.find(b => b.boat_number === n);
  const score = (n) => get(n)?.[scoreField] ?? get(n)?.pre_score ?? 50;
  const stScoreOf = (n) => {
    const st = get(n)?.entry?.exhibition_st;
    return st != null ? stToScore(st, 0.1) : 50;
  };
  const wm = (n) => get(n)?.entry?._profile?.winning_methods || {};
  const cls = (n) => classToScore(get(n)?.entry?.player_class || get(n)?.entry?.grade_class);
  const insideWeak = clamp(100 - escapeProb);

  // 外枠A1検知
  const outerA1 = [5, 6].filter(n => {
    const c = String(get(n)?.entry?.player_class || get(n)?.entry?.grade_class || "").toUpperCase();
    return c === "A1";
  });

  const scenarios = [
    {
      key: "1_ESCAPE", label: "1号艇 逃げ", first_boat: 1,
      score: escapeProb * 0.65 + score(1) * 0.20 + stScoreOf(1) * 0.15,
      second_followers: [2, 3, 4],
      second_weights: { 2: 0.35, 3: 0.25, 4: 0.20, 5: 0.12, 6: 0.08 },
      reason: `1号艇逃げ確率${escapeProb}・内側壁${Math.round((score(2)+score(3))/2)}`,
    },
    {
      key: "2_SASHI", label: "2号艇 差し", first_boat: 2,
      score: score(2) * 0.28 + stScoreOf(2) * 0.20 + (wm(2).sashi_rate || 0) * 0.12 + insideWeak * 0.22 + score(1) * 0.18,
      second_followers: [1, 4, 3],
      second_weights: { 1: 0.35, 3: 0.25, 4: 0.20, 5: 0.12, 6: 0.08 },
      reason: `2差し(級${cls(2)}・ST${stScoreOf(2)})・1号艇残し優先`,
    },
    {
      key: "2_MAKURI", label: "2号艇 まくり", first_boat: 2,
      score: score(2) * 0.22 + stScoreOf(2) * 0.25 + (wm(2).makuri_rate || 0) * 0.13 + (stScoreOf(2) - stScoreOf(1)) * 0.15 + insideWeak * 0.25,
      second_followers: [4, 3, 5],
      second_weights: { 4: 0.30, 3: 0.25, 1: 0.20, 5: 0.15, 6: 0.10 },
      reason: `2まくり(ST差${Math.round(stScoreOf(2)-stScoreOf(1))})・4号艇追走`,
    },
    {
      key: "3_MAKURI", label: "3号艇 まくり", first_boat: 3,
      score: score(3) * 0.22 + stScoreOf(3) * 0.25 + (wm(3).makuri_rate || 0) * 0.13 + (stScoreOf(3) - stScoreOf(2)) * 0.10 + insideWeak * 0.30,
      second_followers: [4, 5, 1],
      second_weights: { 4: 0.30, 1: 0.25, 5: 0.20, 2: 0.15, 6: 0.10 },
      reason: `3まくり(ST差${Math.round(stScoreOf(3)-stScoreOf(2))})・4号艇連動`,
    },
    {
      key: "3_MAKURIZASHI", label: "3号艇 まくり差し", first_boat: 3,
      score: score(3) * 0.22 + stScoreOf(3) * 0.20 + (wm(3).makuri_sashi_rate || 0) * 0.13 + insideWeak * 0.22 + score(1) * 0.23,
      second_followers: [1, 4, 5],
      second_weights: { 1: 0.35, 4: 0.25, 5: 0.20, 2: 0.12, 6: 0.08 },
      reason: `3まくり差し・1号艇残り優先`,
    },
    {
      key: "4_MAKURI", label: "4号艇 まくり", first_boat: 4,
      score: score(4) * 0.22 + stScoreOf(4) * 0.25 + ((wm(4).makuri_rate || 0) + (wm(4).makuri_sashi_rate || 0)) * 0.13 + insideWeak * 0.30,
      second_followers: [5, 1, 3],
      second_weights: { 5: 0.25, 1: 0.25, 3: 0.20, 2: 0.15, 6: 0.15 },
      reason: `4まくり・5号艇連動`,
    },
    {
      key: "4_MAKURIZASHI", label: "4号艇 まくり差し", first_boat: 4,
      score: score(4) * 0.22 + stScoreOf(4) * 0.20 + (wm(4).makuri_sashi_rate || 0) * 0.13 + insideWeak * 0.22 + score(1) * 0.23,
      second_followers: [1, 5, 3],
      second_weights: { 1: 0.35, 5: 0.20, 3: 0.20, 2: 0.15, 6: 0.10 },
      reason: `4まくり差し・1号艇残り`,
    },
    {
      key: "5_6_ATTACK", label: "5・6号艇 攻め", first_boat: 5,
      score: Math.max(
        score(5) * 0.18 + stScoreOf(5) * 0.18 + insideWeak * 0.34 + (cls(5) - 50) * 0.30,
        score(6) * 0.18 + stScoreOf(6) * 0.18 + insideWeak * 0.38 + (cls(6) - 50) * 0.26,
      ),
      second_followers: [1, 2, 6],
      second_weights: { 1: 0.30, 2: 0.25, 6: 0.20, 3: 0.15, 4: 0.10 },
      reason: outerA1.length ? `外枠A1(${outerA1.join("・")})・内側弱度${insideWeak}` : `外攻め・内側弱度${insideWeak}`,
    },
  ];

  // 5_6_ATTACKのfirst_boatを決定(5 or 6の強い方)
  const s56 = scenarios.find(s => s.key === "5_6_ATTACK");
  const b5Attack = score(5) * 0.35 + stScoreOf(5) * 0.35 + (cls(5) - 50) * 0.30;
  const b6Attack = score(6) * 0.35 + stScoreOf(6) * 0.35 + (cls(6) - 50) * 0.30;
  s56.first_boat = b5Attack >= b6Attack ? 5 : 6;
  if (s56.first_boat === 6) {
    s56.second_followers = [1, 2, 5];
    s56.second_weights = { 1: 0.30, 2: 0.25, 5: 0.20, 3: 0.15, 4: 0.10 };
  }

  // Softmaxでシナリオ確率化
  const maxScore = Math.max(...scenarios.map(s => s.score));
  const exps = scenarios.map(s => Math.exp((s.score - maxScore) / 12));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  scenarios.forEach((s, i) => { s.probability = round2(exps[i] / sumExp * 100); });

  scenarios.sort((a, b) => b.probability - a.probability);
  return scenarios;
}

// ============================================================
// 1着確率(シナリオ確率の集約)
// ============================================================
function computeFirstProbsV6(boatScores, scenarios) {
  const firstProbs = new Array(boatScores.length).fill(0);
  for (const s of scenarios) {
    const idx = boatScores.findIndex(b => b.boat_number === s.first_boat);
    if (idx >= 0) firstProbs[idx] += s.probability;
  }
  const sum = firstProbs.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (let i = 0; i < firstProbs.length; i++) firstProbs[i] = round2(firstProbs[i] / sum * 100);
  }
  return firstProbs;
}

// ============================================================
// V6核心: 条件付き2着 P(2着|1着) — シナリオ別2着候補
// 1着艇がどう勝つかで2着候補を変える
// ============================================================
function computeSecondProbsV6(boatScores, scenarios) {
  const numbers = boatScores.map(b => b.boat_number);
  const secondProbs = {};

  for (const firstBoat of numbers) {
    const winningScenarios = scenarios.filter(s => s.first_boat === firstBoat);
    if (!winningScenarios.length) {
      const others = numbers.filter(n => n !== firstBoat);
      secondProbs[firstBoat] = {};
      for (const o of others) secondProbs[firstBoat][o] = round2(100 / others.length);
      continue;
    }

    // シナリオ確率で重み付けした2着候補ウェイト
    const totalScenarioProb = winningScenarios.reduce((a, s) => a + s.probability, 0);
    const secondWeights = {};
    for (const s of winningScenarios) {
      const sw = s.second_weights || {};
      const scenarioWeight = totalScenarioProb > 0 ? s.probability / totalScenarioProb : 1 / winningScenarios.length;
      for (const [boatStr, w] of Object.entries(sw)) {
        const boat = Number(boatStr);
        if (boat === firstBoat) continue;
        secondWeights[boat] = (secondWeights[boat] || 0) + w * scenarioWeight;
      }
    }

    // スコア適性で調整
    const scoreField = "final_score";
    const adjusted = {};
    let totalRaw = 0;
    for (const b of boatScores) {
      if (b.boat_number === firstBoat) continue;
      const baseW = secondWeights[b.boat_number] || 0.05;
      const aptitude = b[scoreField] ?? b.pre_score ?? 50;
      const top2 = b.recent_components?.waku10_top2;
      const adj = top2 != null ? (top2 - 50) * 0.10 : 0;
      const raw = baseW * Math.exp((aptitude + adj - 50) / 20);
      adjusted[b.boat_number] = raw;
      totalRaw += raw;
    }
    secondProbs[firstBoat] = {};
    for (const [boat, raw] of Object.entries(adjusted)) {
      secondProbs[firstBoat][Number(boat)] = totalRaw > 0 ? round2(raw / totalRaw * 100) : 0;
    }
  }

  return secondProbs;
}

// ============================================================
// 3連単確率計算
// P(1着=i) × P(2着=j|1着=i) × P(3着=k|1着=i,2着=j)
// 3着は広げない(適性softmax)
// ============================================================
function computeTrifectasV6(boatScores, firstProbs, secondProbs, stage) {
  const numbers = boatScores.map(b => b.boat_number);
  const scoreField = stage === "FINAL" ? "final_score" : "pre_score";

  const thirdAptitude = boatScores.map(b => {
    const base = b[scoreField] ?? b.pre_score ?? 50;
    const top3 = b.recent_components?.waku10_top3;
    return top3 != null ? clamp(base + (top3 - 50) * 0.08) : base;
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
    const iIdx = boatScores.findIndex(b => b.boat_number === i);
    const firstP = firstProbs[iIdx] / 100;
    const secondP = secondProbs[i] || {};

    for (const j of numbers) {
      if (j === i) continue;
      const secondProbVal = (secondP[j] || 0) / 100;

      const thirdBoats = boatScores.filter(b => b.boat_number !== i && b.boat_number !== j);
      const thirdScores = thirdBoats.map(b => thirdAptitude[boatScores.indexOf(b)]);
      const thirdProbsArr = softmax(thirdScores, 10);
      const thirdP = {};
      thirdBoats.forEach((b, k) => { thirdP[b.boat_number] = thirdProbsArr[k]; });

      for (const k of numbers) {
        if (k === i || k === j) continue;
        const prob = firstP * secondProbVal * (thirdP[k] || 0);
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
  results.forEach((r, idx) => { r.rank = idx + 1; });

  const total = results.reduce((s, r) => s + r.probability, 0);
  if (total > 0 && Math.abs(total - 100) > 0.1) {
    const factor = 100 / total;
    results.forEach(r => { r.probability = Math.round(r.probability * factor * 10) / 10; });
  }

  return results;
}

// ============================================================
// V6核心: 6/7/8点選択(EVベース)
// 基本6点 → 条件付き7点 → 最大8点
// 8点時は必ず拡張理由を保存
// ============================================================
function selectTicketsV6(trifectas, firstProbs, scenarios, oddsMap) {
  const topScenario = scenarios[0];
  const firstBoat = topScenario.first_boat;
  const secondFollowers = topScenario.second_followers || [];

  const selected = [];
  const selectedSet = new Set();

  // 6点: 1着軸 × 2着3艇 × 3着2艇
  for (const secondBoat of secondFollowers.slice(0, 3)) {
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

  // 補完
  if (selected.length < 6) {
    for (const t of trifectas.sort((a, b) => b.probability - a.probability)) {
      if (t.first_boat === firstBoat && !selectedSet.has(t.combination)) {
        selectedSet.add(t.combination);
        selected.push(t.combination);
      }
      if (selected.length >= 6) break;
    }
  }

  let ticketCount = 6;
  let expandReason = null;

  // 7点拡張: EV十分な次点候補
  if (selected.length === 6) {
    const next = trifectas.filter(t => !selectedSet.has(t.combination))
      .sort((a, b) => b.probability - a.probability)[0];
    if (next) {
      const odds = oddsMap?.[next.combination];
      const ev = odds != null ? next.probability * odds : null;
      const probOk = next.probability >= 2;
      const evOk = ev != null ? ev >= 130 : next.probability >= 3;
      if (probOk && evOk) {
        selected.push(next.combination);
        selectedSet.add(next.combination);
        ticketCount = 7;
        expandReason = `7点拡張: ${next.combination} 確率${next.probability}%・EV${ev != null ? round1(ev) + '%' : '不明'}・期待値十分`;
      }
    }
  }

  // 8点拡張: どうしても絞れない場合(EVベース)
  if (selected.length === 7) {
    const next = trifectas.filter(t => !selectedSet.has(t.combination))
      .sort((a, b) => b.probability - a.probability)[0];
    if (next) {
      const odds = oddsMap?.[next.combination];
      const ev = odds != null ? next.probability * odds : null;
      const probOk = next.probability >= 1.5;
      const evOk = ev != null ? ev >= 120 : false;
      if (probOk && evOk) {
        selected.push(next.combination);
        selectedSet.add(next.combination);
        ticketCount = 8;
        expandReason = `8点拡張: ${next.combination} 確率${next.probability}%・EV${ev != null ? round1(ev) + '%' : '不明'} — 2着候補分散大きく6点に絞れない`;
      }
    }
  }

  return {
    selected,
    ticketCount,
    expandReason,
    strategy: ticketCount === 6 ? "1軸6点" : ticketCount === 7 ? "1軸7点" : "1軸8点",
  };
}

// ============================================================
// セット期待値計算
// ============================================================
function computeV6SetMetrics(selected, trifectas, oddsMap) {
  if (!selected.length) return null;

  const selectedData = selected.map(combo => {
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
  const investment = selectedData.length * 100;
  const expectedRecovery = avgPayout != null
    ? Math.round((avgPayout * (setProbability / 100)) / investment * 100 * 10) / 10
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
// V6核心: BUY/WATCH/SKIP判定(EVベース・回収率110%+最重要)
// BUY: 予測精度 + 期待値(回収率110%+)両方十分
// WATCH: 予測は強いが期待値不足、または根拠不足
// SKIP: 予測不安定
// ============================================================
function judgeV6(setMetrics, firstProbs, scenarios, stage) {
  const topProb = Math.max(...firstProbs);
  const sorted = [...firstProbs].sort((a, b) => b - a);
  const gap = sorted[0] - sorted[1];
  const setProb = setMetrics?.set_probability;
  const recovery = setMetrics?.set_expected_recovery;
  const firstConfidence = clamp(topProb + gap * 0.5, 0, 100);
  const topScenarioProb = scenarios[0]?.probability || 0;

  if (stage === "FINAL") {
    // BUY: 回収率110%+必須 + 1着信頼度 + セット確率 + シナリオ集中度
    if (recovery != null && recovery >= 110 && firstConfidence >= 50 && setProb >= 20 && topScenarioProb >= 25) {
      return { judgment: "BUY", reason: `利益型BUY(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%・回収率${recovery}%・シナリオ${scenarios[0].label}${topScenarioProb}%)` };
    }
    // WATCH: 予測強いが期待値不足
    if (firstConfidence >= 45 && setProb >= 18 && (recovery == null || recovery < 110)) {
      return { judgment: "WATCH", reason: `予測強度${round1(firstConfidence)}・セット確率${setProb}%・回収率${recovery != null ? recovery + '%' : '不明'}<110% — 期待値不足` };
    }
    // WATCH: 根拠不足
    if (firstConfidence >= 40 && setProb >= 15) {
      return { judgment: "WATCH", reason: `根拠不足(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%・シナリオ集中度${topScenarioProb}%)` };
    }
    return { judgment: "SKIP", reason: `予測不安定(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%)` };
  }

  // PRE: 回収率判定なし(オッズ未確定)
  if (firstConfidence >= 50 && setProb >= 20 && topScenarioProb >= 25) {
    return { judgment: "BUY", reason: `PRE利益型BUY(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%・シナリオ${scenarios[0].label}${topScenarioProb}%)` };
  }
  if (firstConfidence >= 40 && setProb >= 15) {
    return { judgment: "WATCH", reason: `PRE(1着信頼度${round1(firstConfidence)}・セット確率${setProb}%)` };
  }
  return { judgment: "SKIP", reason: `PRE予測不安定(1着信頼度${round1(firstConfidence)})` };
}

// ============================================================
// 要因スナップショット(学習用・結果確定後に結合)
// ============================================================
function buildFactorSnapshot(boatScores, race, scenarios, oddsMap, escapeProb, firstConfidence, setProb, stage) {
  const avg = (key) => {
    const vals = boatScores.map(b => b[key]).filter(v => Number.isFinite(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };
  const avgComp = (compKey) => {
    const vals = boatScores.map(b => b.today_components?.[compKey]).filter(v => Number.isFinite(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };
  const avgRecentComp = (compKey) => {
    const vals = boatScores.map(b => b.recent_components?.[compKey]).filter(v => Number.isFinite(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };
  const avgPastComp = (compKey) => {
    const vals = boatScores.map(b => b.past_components?.[compKey]).filter(v => Number.isFinite(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
  };

  const selectedOdds = Object.keys(oddsMap || {}).map(c => oddsMap[c]).filter(o => Number.isFinite(o) && o > 0);
  const oddsAvg = selectedOdds.length ? Math.round(selectedOdds.reduce((a, b) => a + b, 0) / selectedOdds.length * 10) / 10 : null;

  return {
    st: avgComp('exhibition_st_score'),
    exhibition: avgComp('exhibition_time_rank_score'),
    lane_past10: avgRecentComp('waku10_win'),
    racer_power: avgRecentComp('racer_power'),
    section: avgRecentComp('section'),
    motor: avgComp('motor'),
    course: avgPastComp('course_win'),
    odds: oddsAvg,
    scenario: scenarios[0]?.probability ?? null,
    escape_prob: escapeProb,
    first_confidence: firstConfidence,
    set_probability: setProb,
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

// ============================================================
// メイン: V6予想実行
// ============================================================
export function runPredictionV6(entries, race, settings, options = {}) {
  const stage = options.stage || "PRE";
  const oddsMap = options.oddsMap || {};

  // 1. Boat Scores
  const boatScores = computeV6BoatScores(entries, race, stage);

  // 2. 1号艇逃げ確率
  const escapeProb = computeEscapeProbability(boatScores, stage);

  // 3. 8シナリオ評価
  const scenarios = computeScenarios(boatScores, escapeProb, stage);

  // 4. 1着確率(シナリオ集約)
  const firstProbs = computeFirstProbsV6(boatScores, scenarios);
  boatScores.forEach((b, i) => {
    b.first_probability = firstProbs[i];
    b.first_score = round1(clamp((b.final_score ?? b.pre_score ?? 50) + (firstProbs[i] - 16) * 0.3, 5, 100));
  });

  // 5. 条件付き2着 P(2着|1着) — シナリオ別
  const secondProbs = computeSecondProbsV6(boatScores, scenarios);

  // 6. 3連単確率
  const trifectas = computeTrifectasV6(boatScores, firstProbs, secondProbs, stage);

  // 7. 6/7/8点選択(EVベース)
  const { selected, ticketCount, expandReason, strategy } = selectTicketsV6(trifectas, firstProbs, scenarios, oddsMap);

  // 8. セット期待値
  const setMetrics = computeV6SetMetrics(selected, trifectas, oddsMap);

  // 9. 判定(EVベース)
  const { judgment, reason } = judgeV6(setMetrics, firstProbs, scenarios, stage);

  // ランキング
  const sortedByFirst = boatScores.map((b, i) => ({ b, i, prob: firstProbs[i] }))
    .sort((a, b) => b.prob - a.prob);
  const firstRanking = sortedByFirst.map(x => x.b.boat_number);

  const secondRankingScores = boatScores.map(b => {
    const secondProbSum = Object.values(secondProbs).reduce((s, sp) => s + (sp[b.boat_number] || 0), 0);
    return { boat: b.boat_number, score: secondProbSum };
  }).sort((a, b) => b.score - a.score);
  const secondRanking = secondRankingScores.map(x => x.boat);

  const thirdRankingScores = boatScores.map(b => {
    const thirdProbSum = trifectas.filter(t => t.third_boat === b.boat_number).reduce((s, t) => s + t.probability, 0);
    return { boat: b.boat_number, score: thirdProbSum };
  }).sort((a, b) => b.score - a.score);
  const thirdRanking = thirdRankingScores.map(x => x.boat);

  const honmei = firstRanking[0];
  const taiko = firstRanking[1];
  const ana = firstRanking[2];
  const keshi = firstRanking[firstRanking.length - 1];

  const topTrifecta = trifectas[0];
  const topOdds = oddsMap?.[topTrifecta.combination] || null;
  const topEv = topOdds != null ? Math.round(topTrifecta.probability * topOdds * 10) / 10 : null;

  const topProb = firstProbs[0];
  const firstProbSorted = [...firstProbs].sort((a, b) => b - a);
  const firstConfidence = clamp(firstProbSorted[0] + (firstProbSorted[0] - firstProbSorted[1]) * 0.5, 0, 100);
  const firstProbabilityGap = round2(firstProbSorted[0] - firstProbSorted[1]);
  const dataConfidence = computeDataConfidence(boatScores, stage);

  // 要因スナップショット
  const factorSnapshot = buildFactorSnapshot(
    boatScores, race, scenarios, oddsMap, escapeProb, round1(firstConfidence), setMetrics?.set_probability, stage
  );

  // trifectasにodds/EV付与
  const trifectasWithOdds = trifectas.map(t => {
    const actualOdds = oddsMap?.[t.combination] || null;
    const ev = actualOdds != null ? Math.round(t.probability * actualOdds * 10) / 10 : null;
    const isSelected = selected.includes(t.combination);
    const ticketRank = isSelected ? selected.indexOf(t.combination) + 1 : null;
    return { ...t, actual_odds: actualOdds, expected_value: ev, is_selected: isSelected, ticket_rank: ticketRank };
  });

  return {
    boatScores: boatScores.map(b => ({
      boat_number: b.boat_number,
      past_score: b.past_score, recent_score: b.recent_score, today_score: b.today_score,
      pre_score: b.pre_score, final_score: b.final_score,
      first_score: b.first_score, first_probability: b.first_probability,
      reasons: b.reasons, notes: b.notes,
    })),
    trifectas: trifectasWithOdds,
    selected_trifectas: selected,
    ticket_count: ticketCount,
    ticket_strategy: strategy,
    expand_reason: expandReason,
    set_metrics: setMetrics,
    data_confidence: dataConfidence,
    final_judgment: judgment,
    judgment_reason: reason,
    honmei_boat: honmei, taiko_boat: taiko, ana_boat: ana, keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination,
    top_probability: topTrifecta?.probability,
    top_odds: topOdds, top_expected_value: topEv,
    first_ranking: firstRanking, second_ranking: secondRanking, third_ranking: thirdRanking,
    first_probability_gap: firstProbabilityGap,
    first_confidence: round1(firstConfidence),
    escape_probability: escapeProb,
    winning_scenario: scenarios[0]?.key || null,
    scenario_scores: scenarios.map(s => ({
      key: s.key, label: s.label, first_boat: s.first_boat,
      probability: s.probability, score: round1(s.score),
      second_followers: s.second_followers, reason: s.reason,
    })),
    factor_snapshot: factorSnapshot,
    v6_weights: V6_WEIGHTS,
  };
}