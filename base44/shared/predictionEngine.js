// BOAT WORKS 2 - 予想エンジン(サーバー側共有コピー)
// src/lib/predictionEngine.js と同等の純粋計算モジュール。
// バックエンド関数から import するためのサーバー側正本。
// ※ロジック変更時は src/lib/predictionEngine.js と合わせること。

const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const normalize = (arr) => {
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum <= 0) return arr.map(() => 1 / arr.length);
  return arr.map((x) => x / sum);
};
const rateToScore = (rate) => (isValid(rate) ? clamp(rate, 0, 100) : null);
const stToScore = (st, refSt = 0.15) => {
  if (!isValid(st)) return null;
  return clamp(70 + (refSt - st) * 300, 5, 100);
};

export function computeBoatScores(entry, settings) {
  const w = settings?.weights || {};
  const stage = settings?.stage || "PRE";
  const isFinal = stage === "FINAL";
  const components = {};

  components.national_win = rateToScore(entry.national_win_rate != null ? entry.national_win_rate * 10 : null);
  components.local_win = rateToScore(entry.local_win_rate != null ? entry.local_win_rate * 10 : null);
  components.national_f2 = rateToScore(entry.national_f2_rate);
  components.national_f3 = rateToScore(entry.national_f3_rate);
  components.local_f2 = rateToScore(entry.local_f2_rate);
  components.local_f3 = rateToScore(entry.local_f3_rate);

  components.st = stToScore(entry.avg_st);
  components.f_penalty = isValid(entry.f_count) ? clamp(100 - entry.f_count * 8, 0, 100) : null;
  components.l_penalty = isValid(entry.l_count) ? clamp(100 - entry.l_count * 5, 0, 100) : null;

  components.motor_f2 = rateToScore(entry.motor_f2_rate);
  components.motor_f3 = rateToScore(entry.motor_f3_rate);
  components.boat_f2 = rateToScore(entry.boat_f2_rate);
  components.boat_f3 = rateToScore(entry.boat_f3_rate);

  components.local_fit = (() => {
    const parts = [components.local_win, components.local_f2, components.local_f3].filter((x) => x !== null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  })();

  components.section = (() => {
    const parts = [];
    if (isValid(entry.section_points)) parts.push(clamp(entry.section_points * 2, 0, 100));
    if (isValid(entry.section_momentum)) parts.push(clamp(entry.section_momentum, 0, 100));
    if (entry.section_finishes) {
      const finishes = String(entry.section_finishes).split(/[.\s,]/).map(Number).filter((n) => !Number.isNaN(n));
      if (finishes.length) {
        const avg = finishes.reduce((a, b) => a + b, 0) / finishes.length;
        parts.push(clamp(110 - avg * 20, 0, 100));
      }
    }
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  })();

  components.exhibition = (() => {
    if (!isFinal) return null;
    const parts = [];
    if (isValid(entry.exhibition_time)) parts.push(clamp(50 + (1.4 - entry.exhibition_time) * 100, 5, 100));
    if (isValid(entry.exhibition_rank)) parts.push(clamp(110 - entry.exhibition_rank * 15, 0, 100));
    if (isValid(entry.exhibition_st)) parts.push(stToScore(entry.exhibition_st, 0.1));
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  })();

  // === 選手プロファイルベースの成分 ===
  const profile = entry._profile;
  // プロファイル勝率: 6ヶ月5件以上→6ヶ月、そうでなければ全期間5件以上
  components.profile_win = (() => {
    if (!profile) return null;
    const s6 = profile.stats_6m, sAll = profile.stats_all;
    const s = (s6?.sample_size >= 5) ? s6 : (sAll?.sample_size >= 5 ? sAll : null);
    return s?.win_rate != null ? clamp(s.win_rate, 0, 100) : null;
  })();
  // プロファイル2連率
  components.profile_f2 = (() => {
    if (!profile) return null;
    const s6 = profile.stats_6m, sAll = profile.stats_all;
    const s = (s6?.sample_size >= 5) ? s6 : (sAll?.sample_size >= 5 ? sAll : null);
    return s?.top2_rate != null ? clamp(s.top2_rate, 0, 100) : null;
  })();
  // プロファイル3連率
  components.profile_f3 = (() => {
    if (!profile) return null;
    const s6 = profile.stats_6m, sAll = profile.stats_all;
    const s = (s6?.sample_size >= 5) ? s6 : (sAll?.sample_size >= 5 ? sAll : null);
    return s?.top3_rate != null ? clamp(s.top3_rate, 0, 100) : null;
  })();
  // コース別成績: この艇番のコースでの勝率
  components.profile_course_win = (() => {
    if (!profile || !entry.boat_number) return null;
    const cs = profile.course_stats?.[String(entry.boat_number)];
    if (!cs || cs.samples < 3) return null;
    return cs.win_rate != null ? clamp(cs.win_rate, 0, 100) : null;
  })();
  components.profile_course_f2 = (() => {
    if (!profile || !entry.boat_number) return null;
    const cs = profile.course_stats?.[String(entry.boat_number)];
    if (!cs || cs.samples < 3) return null;
    return cs.top2_rate != null ? clamp(cs.top2_rate, 0, 100) : null;
  })();
  // 勝ち方プロファイル
  components.front_runner = profile?.winning_style?.front_runner_score != null ? clamp(profile.winning_style.front_runner_score, 0, 100) : null;
  components.chaser = profile?.winning_style?.chaser_score != null ? clamp(profile.winning_style.chaser_score, 0, 100) : null;
  components.st_stability = profile?.winning_style?.st_stability != null ? clamp(profile.winning_style.st_stability, 0, 100) : null;
  components.attack = profile?.winning_style?.attack_score != null ? clamp(profile.winning_style.attack_score, 0, 100) : null;
  // 勢い
  components.momentum = profile?.momentum != null ? clamp(50 + profile.momentum * 20, 0, 100) : null;
  // データ信頼度
  const profileConfidence = profile?.data_confidence != null ? profile.data_confidence : 0;

  const weightOf = (key) => (w[key] != null ? w[key] : 1.0);
  const totalRaw = [], totalW = [];
  const add = (score, key) => { if (score === null) return; totalRaw.push(score * weightOf(key)); totalW.push(weightOf(key)); };
  // プロファイル成分を優先(データ信頼度に応じて重み付け)
  const profileWeight = profileConfidence / 100; // 0-1
  add(components.national_win, "national_win");
  add(components.local_win, "local_win");
  add(components.national_f2, "f2_rate");
  add(components.national_f3, "f3_rate");
  add(components.local_f2, "f2_rate");
  add(components.local_f3, "f3_rate");
  add(components.st, "st");
  add(components.f_penalty, "st");
  add(components.l_penalty, "st");
  add(components.motor_f2, "motor");
  add(components.motor_f3, "motor");
  add(components.boat_f2, "boat");
  add(components.boat_f3, "boat");
  add(components.local_fit, "local_fit");
  add(components.section, "section");
  if (isFinal) add(components.exhibition, "exhibition");
  // プロファイル成分(信頼度に応じて重み付け)
  if (components.profile_win !== null) add(components.profile_win * profileWeight + components.national_win * (1 - profileWeight) * 0 + components.profile_win, "national_win");
  if (components.profile_f2 !== null) add(components.profile_f2, "f2_rate");
  if (components.profile_f3 !== null) add(components.profile_f3, "f3_rate");
  if (components.momentum !== null) add(components.momentum, "section");

  const total_power = totalW.length ? clamp(totalRaw.reduce((a, b) => a + b, 0) / totalW.reduce((a, b) => a + b, 0), 0, 100) : 50;
  const dataCount = totalW.length;

  // コース別スコア: プロファイルの実績があれば優先、なければ静的テーブル
  const courseFirstScore = components.profile_course_win !== null
    ? components.profile_course_win
    : { 1: 100, 2: 78, 3: 66, 4: 54, 5: 43, 6: 34 }[entry.boat_number] || 50;
  const courseSecondScore = components.profile_course_f2 !== null
    ? components.profile_course_f2
    : { 1: 72, 2: 82, 3: 78, 4: 68, 5: 58, 6: 50 }[entry.boat_number] || 60;
  const courseThirdScore = { 1: 68, 2: 76, 3: 78, 4: 74, 5: 66, 6: 58 }[entry.boat_number] || 65;
  const weightedAverage = (pairs, fallback = 50) => {
    const validPairs = pairs.filter(([score]) => score !== null && isValid(score));
    if (!validPairs.length) return fallback;
    const denom = validPairs.reduce((a, [, weight]) => a + weight, 0);
    return denom > 0 ? validPairs.reduce((a, [score, weight]) => a + score * weight, 0) / denom : fallback;
  };
  // 勝ち方を1着力に反映: 内コースなら逃げ型、外コースなら追込型を加点
  const styleBonus1 = (() => {
    if (entry.boat_number <= 3 && components.front_runner !== null) return components.front_runner;
    if (entry.boat_number >= 4 && components.chaser !== null) return components.chaser;
    return null;
  })();
  const first_power = clamp(weightedAverage([
    [total_power, isFinal ? 0.45 : 0.50],
    [components.profile_win, 0.15],
    [components.st, isFinal ? 0.10 : 0.15],
    [courseFirstScore, 0.20],
    [styleBonus1, 0.05],
    [components.momentum, 0.05],
    [isFinal ? components.exhibition : null, 0.15],
  ]), 5, 100);
  const second_power = clamp(weightedAverage([
    [total_power, isFinal ? 0.50 : 0.55],
    [components.profile_f2, 0.15],
    [components.section, 0.10],
    [courseSecondScore, 0.10],
    [components.momentum, 0.05],
    [isFinal ? components.exhibition : null, 0.20],
  ]), 5, 100);
  const third_power = clamp(weightedAverage([
    [total_power, 0.60],
    [components.profile_f3, 0.13],
    [components.section, 0.10],
    [courseThirdScore, 0.10],
    [components.momentum, 0.07],
    [isFinal ? components.exhibition : null, 0.08],
  ]), 5, 100);

  const start_power = (() => {
    const parts = [components.st, components.f_penalty, components.l_penalty].filter((x) => x !== null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
  })();
  const motor_power = (() => {
    const parts = [components.motor_f2, components.motor_f3, components.boat_f2, components.boat_f3].filter((x) => x !== null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 50;
  })();
  const exhibition_power = components.exhibition !== null ? components.exhibition : 50;
  const local_fit = components.local_fit !== null ? components.local_fit : 50;
  const section_form = components.section !== null ? components.section : 50;
  const ana_potential = clamp(exhibition_power * 0.4 + section_form * 0.3 + (100 - total_power) * 0.3, 0, 100);

  const reasons = [], notes = [];
  if (entry.boat_number === 1) reasons.push("1コース逃げ率が高い");
  if (components.local_win !== null && components.local_win >= 60) reasons.push(`当地勝率が高い(${entry.local_win_rate})`);
  if (components.national_f2 !== null && components.national_f2 >= 55) reasons.push(`全国2連率${entry.national_f2_rate}%`);
  if (components.motor_f2 !== null && components.motor_f2 >= 55) reasons.push("モーター上位");
  if (isFinal && components.exhibition !== null && components.exhibition >= 70) reasons.push(`展示タイム${entry.exhibition_rank}位`);
  if (components.section !== null && components.section >= 65) reasons.push("節間好調");
  if (components.st !== null && components.st >= 70) reasons.push("スタート安定");
  // プロファイルベースの理由
  if (components.profile_win !== null && components.profile_win >= 50) reasons.push(`直近勝率${components.profile_win}%`);
  if (components.profile_course_win !== null && components.profile_course_win >= 40) reasons.push(`${entry.boat_number}コース勝率${components.profile_course_win}%`);
  if (components.front_runner !== null && components.front_runner >= 60 && entry.boat_number <= 3) reasons.push("逃げ型(内コース得意)");
  if (components.chaser !== null && components.chaser >= 50 && entry.boat_number >= 4) reasons.push("追込型(外コース差し)");
  if (components.st_stability !== null && components.st_stability >= 70) reasons.push("ST安定性高い");
  if (components.momentum !== null && components.momentum >= 65) reasons.push("勢い上向き");
  if (components.attack !== null && components.attack >= 50) reasons.push("攻撃型(位置上げ)");
  if (components.st !== null && components.st < 55) notes.push("平均STがやや遅い");
  if (components.f_penalty !== null && entry.f_count > 0) notes.push(`F数${entry.f_count}`);
  if (components.motor_f2 !== null && components.motor_f2 < 40) notes.push("モーター低調");
  if (isFinal && components.exhibition !== null && components.exhibition < 45) notes.push("展示伸び悩む");
  if (components.momentum !== null && components.momentum < 40) notes.push("最近調子落ち");
  if (profile && profile.total_samples < 5) notes.push("プロファイルデータ少");

  return {
    boat_number: entry.boat_number,
    first_power: Math.round(first_power * 10) / 10,
    second_power: Math.round(second_power * 10) / 10,
    third_power: Math.round(third_power * 10) / 10,
    total_power: Math.round(total_power * 10) / 10,
    start_power: Math.round(start_power),
    motor_power: Math.round(motor_power),
    exhibition_power: Math.round(exhibition_power),
    local_fit: Math.round(local_fit),
    section_form: Math.round(section_form),
    ana_potential: Math.round(ana_potential),
    reasons, notes, dataCount,
  };
}

export function computeTrifectas(boatScores, options = {}) {
  const { oddsMap = {}, margin = 0.25 } = options;
  const boats = boatScores.filter((b) => !b._absent);
  const numbers = boats.map((b) => b.boat_number);
  // v3: 旧来の power^n は差を十分に確率へ反映できず、120通りが平坦化していた。
  // softmaxで「艇力差」を順位確率へ変換し、強いレースほど上位買い目へ自然に集中させる。
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
        const combo = `${i}-${j}-${k}`;
        const actualOdds = oddsMap[combo];
        const estimated_odds = Math.max(1.0, (1 / prob) * (1 - margin));
        const odds = actualOdds != null ? actualOdds : estimated_odds;
        const expected_value = prob * odds * 100;
        results.push({
          combination: combo,
          probability: Math.round(prob * 1000) / 10,
          estimated_odds: Math.round(estimated_odds * 10) / 10,
          actual_odds: actualOdds != null ? actualOdds : null,
          expected_value: Math.round(expected_value * 10) / 10,
        });
      }
    }
  }
  results.sort((a, b) => b.probability - a.probability);
  results.forEach((r, idx) => (r.rank = idx + 1));
  return results;
}

export function judgeTrifecta(trifecta, ctx = {}) {
  const { settings = {}, topBoatTotal = 60, dataConfidence = 50, exhibitionReady = false } = ctx;
  const prob = trifecta.probability;
  const ev = trifecta.expected_value;
  const gates = [];
  if (prob < (settings.min_probability || 5)) gates.push("確率不足");
  if (topBoatTotal < 55) gates.push("本命艇評価不足");
  if (dataConfidence < (settings.min_confidence || 40)) gates.push("データ信頼度不足");
  if (ctx.stage === "FINAL" && !exhibitionReady) gates.push("展示評価不足");
  if (gates.length > 0) return { judgment: "SKIP", basis: gates.join("・") };
  const strongEv = settings.strong_buy_ev_threshold || 200;
  const buyEv = settings.buy_ev_threshold || 150;
  const watchEv = settings.watch_ev_threshold || 110;
  if (ev >= strongEv && prob >= (settings.min_probability || 5) * 1.5) return { judgment: "STRONG_BUY", basis: `期待値${ev}%・確率${prob}%・信頼度${dataConfidence}` };
  if (ev >= buyEv) return { judgment: "BUY", basis: `期待値${ev}%・確率${prob}%` };
  if (ev >= watchEv) return { judgment: "WATCH", basis: `期待値${ev}%・確率${prob}%` };
  return { judgment: "SKIP", basis: `期待値${ev}%低・確率${prob}%` };
}

export function gradePrediction(boatScores) {
  const top = boatScores.reduce((a, b) => (a.first_power > b.first_power ? a : b));
  const second = boatScores.filter((b) => b.boat_number !== top.boat_number).reduce((a, b) => (a.first_power > b.first_power ? a : b));
  const gap = top.first_power - second.first_power;
  const conf = top.dataCount;
  if (gap >= 10 && top.first_power >= 80 && conf >= 8) return "S";
  if (gap >= 6 && top.first_power >= 70) return "A";
  if (top.first_power >= 60) return "B";
  return "C";
}

export function computeConfidence(boatScores) {
  const avgCount = boatScores.reduce((a, b) => a + b.dataCount, 0) / Math.max(1, boatScores.length);
  return clamp(Math.round((avgCount / 12) * 100), 0, 100);
}

// 買い目点数判定: 1-3点 / 4-6点 / 見送り。分散度と信頼度で決める。
export function decideBetPlan(trifectas, settings, ctx = {}) {
  const { dataConfidence = 50, stage = "PRE" } = ctx;
  if (!trifectas || trifectas.length === 0) return { tier: "skip", count: 0, reason: "予想データなし" };
  if (dataConfidence < (settings.min_confidence || 40)) return { tier: "skip", count: 0, reason: "データ信頼度不足" };
  const buyable = trifectas.filter((t) => t.judgment === "STRONG_BUY" || t.judgment === "BUY" || t.judgment === "WATCH");
  if (buyable.length === 0) return { tier: "skip", count: 0, reason: "BUY/WATCH該当なし" };
  const top = trifectas[0];
  const second = trifectas[1];
  const gap = second ? top.probability - second.probability : top.probability;
  // 集中型: 本命確率が高く2位との差が大きい
  if (top.probability >= 12 && gap >= 4) return { tier: "1-3", count: Math.min(3, buyable.length), reason: "本命濃厚・集中" };
  if (top.probability >= 8) return { tier: "4-6", count: Math.min(6, buyable.length), reason: "予想分散・広目" };
  return { tier: "skip", count: 0, reason: "確率低・見送り" };
}

export function runPrediction(entries, settings, options = {}) {
  const stage = settings.stage || "PRE";
  const oddsMap = options.oddsMap || {};
  const boats = entries.map((e) => ({ ...e, _absent: !!e.is_absent }));
  const activeBoats = boats.filter((b) => !b._absent);
  const boatScores = boats.map((e) => { const s = computeBoatScores(e, settings); s._absent = e._absent; return s; });
  const activeScores = boatScores.filter((b) => !b._absent);
  const trifectas = computeTrifectas(activeScores, { oddsMap });
  const dataConfidence = computeConfidence(activeScores);
  const exhibitionReady = activeBoats.some((e) => isValid(e.exhibition_time) || isValid(e.exhibition_st));
  const top = activeScores.reduce((a, b) => (a.first_power > b.first_power ? a : b), activeScores[0]);
  const ranked = [...activeScores].sort((a, b) => b.first_power - a.first_power);
  const honmei = ranked[0]?.boat_number;
  const taiko = ranked[1]?.boat_number;
  const ana = [...activeScores].sort((a, b) => b.ana_potential - a.ana_potential)[0]?.boat_number;
  const keshi = ranked[ranked.length - 1]?.boat_number;
  const judgedTrifectas = trifectas.map((t) => {
    const { judgment, basis } = judgeTrifecta(t, { settings, topBoatTotal: top?.total_power || 50, dataConfidence, exhibitionReady, stage });
    return { ...t, judgment, basis };
  });
  const grade = gradePrediction(activeScores);
  const topTrifecta = judgedTrifectas[0];
  const betPlan = decideBetPlan(judgedTrifectas, settings, { dataConfidence, stage });
  return {
    stage, boatScores, trifectas: judgedTrifectas,
    prediction_grade: grade, data_confidence: dataConfidence,
    honmei_boat: honmei, taiko_boat: taiko, ana_boat: ana, keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination, top_probability: topTrifecta?.probability,
    top_odds: topTrifecta?.actual_odds != null ? topTrifecta.actual_odds : topTrifecta?.estimated_odds,
    top_expected_value: topTrifecta?.expected_value, top_judgment: topTrifecta?.judgment,
    exhibition_ready: exhibitionReady, bet_plan: betPlan,
  };
}