// BOAT WORKS 2 - 予想エンジン
// 人気順ではなく、各艇の1/2/3着力を数値化し、3連単120通りを確率化する純粋計算モジュール。
// 取得できない項目は0点扱いせず「未取得」とし、取得済み項目だけで正規化する。

// ---------- 補助関数 ----------

// 値が有効な数値か
const isValid = (v) => typeof v === "number" && !Number.isNaN(v) && Number.isFinite(v);

// 0-100に正規化(取得済み値のみ)
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

// 配列の正規化(合計1)
const normalize = (arr) => {
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum <= 0) return arr.map(() => 1 / arr.length);
  return arr.map((x) => x / sum);
};

// min-maxスケーリング(取得済み値だけで)
const minMaxScale = (values) => {
  const valid = values.filter(isValid);
  if (valid.length === 0) return values.map(() => 50);
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  if (hi - lo < 1e-9) return values.map(() => 60);
  return values.map((v) => (isValid(v) ? clamp(((v - lo) / (hi - lo)) * 100, 5, 100) : 50));
};

// スコア成分: 値が大きいほど良い → 0-100
const rateToScore = (rate) => (isValid(rate) ? clamp(rate, 0, 100) : null);

// ST: 小さい(速い)ほど良い
const stToScore = (st, refSt = 0.15) => {
  if (!isValid(st)) return null;
  // 0.10秒速い=高得点, 0.20秒遅い=低得点 の線形
  const s = clamp(70 + (refSt - st) * 300, 5, 100);
  return s;
};

// ---------- 各艇サブスコア計算 ----------
// 取得できない項目はnullとし、後で集計時に除外する。
export function computeBoatScores(entry, settings) {
  const w = settings?.weights || {};
  const stage = settings?.stage || "PRE";
  const isFinal = stage === "FINAL";

  const components = {};

  // 選手成績
  components.national_win = rateToScore(entry.national_win_rate != null ? entry.national_win_rate * 10 : null); // 勝率→%
  components.local_win = rateToScore(entry.local_win_rate != null ? entry.local_win_rate * 10 : null);
  components.national_f2 = rateToScore(entry.national_f2_rate);
  components.national_f3 = rateToScore(entry.national_f3_rate);
  components.local_f2 = rateToScore(entry.local_f2_rate);
  components.local_f3 = rateToScore(entry.local_f3_rate);

  // スタート
  components.st = stToScore(entry.avg_st);
  components.f_penalty = isValid(entry.f_count) ? clamp(100 - entry.f_count * 8, 0, 100) : null;
  components.l_penalty = isValid(entry.l_count) ? clamp(100 - entry.l_count * 5, 0, 100) : null;

  // モーター・ボート
  components.motor_f2 = rateToScore(entry.motor_f2_rate);
  components.motor_f3 = rateToScore(entry.motor_f3_rate);
  components.boat_f2 = rateToScore(entry.boat_f2_rate);
  components.boat_f3 = rateToScore(entry.boat_f3_rate);

  // 当地適性: 当地勝率と当地連率の合成
  components.local_fit = (() => {
    const parts = [components.local_win, components.local_f2, components.local_f3].filter((x) => x !== null);
    if (parts.length === 0) return null;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  })();

  // 節間調子
  components.section = (() => {
    const parts = [];
    if (isValid(entry.section_points)) parts.push(clamp(entry.section_points * 2, 0, 100));
    if (isValid(entry.section_momentum)) parts.push(clamp(entry.section_momentum, 0, 100));
    // 今節着順の平均着順(小さいほど良い)
    if (entry.section_finishes) {
      const finishes = String(entry.section_finishes).split(/[.\s,]/).map(Number).filter((n) => !Number.isNaN(n));
      if (finishes.length) {
        const avg = finishes.reduce((a, b) => a + b, 0) / finishes.length;
        parts.push(clamp(110 - avg * 20, 0, 100));
      }
    }
    if (!parts.length) return null;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  })();

  // 展示力 (FINALのみ)
  components.exhibition = (() => {
    if (!isFinal) return null;
    const parts = [];
    if (isValid(entry.exhibition_time)) {
      // 展示タイム: 小さい(速い)ほど良い。1.40秒基準
      parts.push(clamp(50 + (1.4 - entry.exhibition_time) * 100, 5, 100));
    }
    if (isValid(entry.exhibition_rank)) {
      parts.push(clamp(110 - entry.exhibition_rank * 15, 0, 100));
    }
    if (isValid(entry.exhibition_st)) parts.push(stToScore(entry.exhibition_st, 0.1));
    if (!parts.length) return null;
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  })();

  // 穴期待度: 総合力は低いが展示や節間が良い → 穴
  components.ana_potential = null; // 後段で計算

  // ---------- 重み付き合成 ----------
  const weightOf = (key) => (w[key] != null ? w[key] : 1.0);

  const totalRaw = [];
  const totalW = [];
  const add = (score, key) => {
    if (score === null) return;
    totalRaw.push(score * weightOf(key));
    totalW.push(weightOf(key));
  };

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

  const total_power = totalW.length ? clamp(totalRaw.reduce((a, b) => a + b, 0) / totalW.reduce((a, b) => a + b, 0), 0, 100) : 50;

  // データ項目数(信頼度計算用)
  const dataCount = totalW.length;

  // ---------- 1/2/3着力 ----------
  // 旧ロジックは「総合力」と「小さなコース加点」を同じ配列で平均してしまい、
  // 1着力が不自然に30前後まで圧縮されて全レースC判定になりやすかった。
  // v2では各要素を0-100スケールに揃えてから加重平均する。
  const courseFirstScore = { 1: 100, 2: 78, 3: 66, 4: 54, 5: 43, 6: 34 }[entry.boat_number] || 50;
  const courseSecondScore = { 1: 72, 2: 82, 3: 78, 4: 68, 5: 58, 6: 50 }[entry.boat_number] || 60;
  const courseThirdScore = { 1: 68, 2: 76, 3: 78, 4: 74, 5: 66, 6: 58 }[entry.boat_number] || 65;

  const weightedAverage = (pairs, fallback = 50) => {
    const validPairs = pairs.filter(([score]) => score !== null && isValid(score));
    if (!validPairs.length) return fallback;
    const denom = validPairs.reduce((a, [, weight]) => a + weight, 0);
    return denom > 0 ? validPairs.reduce((a, [score, weight]) => a + score * weight, 0) / denom : fallback;
  };

  const first_power = clamp(weightedAverage([
    [total_power, isFinal ? 0.50 : 0.60],
    [components.st, isFinal ? 0.15 : 0.20],
    [courseFirstScore, 0.20],
    [isFinal ? components.exhibition : null, 0.15],
  ]), 5, 100);

  const second_power = clamp(weightedAverage([
    [total_power, isFinal ? 0.55 : 0.65],
    [components.section, 0.15],
    [courseSecondScore, 0.10],
    [isFinal ? components.exhibition : null, 0.20],
  ]), 5, 100);

  const third_power = clamp(weightedAverage([
    [total_power, 0.68],
    [components.section, 0.12],
    [courseThirdScore, 0.12],
    [isFinal ? components.exhibition : null, 0.08],
  ]), 5, 100);

  // スタート力・モーター力・展示力・当地適性・節間調子(0-100)
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

  // 穴期待度: 総合力低めだが展示/節間が良い → 高い
  const ana_potential = clamp(
    (exhibition_power * 0.4 + section_form * 0.3 + (100 - total_power) * 0.3),
    0,
    100
  );

  // ---------- 予想理由 ----------
  const reasons = [];
  const notes = [];
  if (entry.boat_number === 1) reasons.push("1コース逃げ率が高い");
  if (components.local_win !== null && components.local_win >= 60) reasons.push(`当地勝率が高い(${entry.local_win_rate?.toFixed(2)})`);
  if (components.national_f2 !== null && components.national_f2 >= 55) reasons.push(`全国2連率${entry.national_f2_rate}%`);
  if (components.motor_f2 !== null && components.motor_f2 >= 55) reasons.push("モーター上位");
  if (isFinal && components.exhibition !== null && components.exhibition >= 70) reasons.push(`展示タイム${entry.exhibition_rank}位`);
  if (components.section !== null && components.section >= 65) reasons.push("節間好調");
  if (components.st !== null && components.st >= 70) reasons.push("スタート安定");

  if (components.st !== null && components.st < 55) notes.push("平均STがやや遅い");
  if (components.f_penalty !== null && entry.f_count > 0) notes.push(`F数${entry.f_count}`);
  if (components.motor_f2 !== null && components.motor_f2 < 40) notes.push("モーター低調");
  if (isFinal && components.exhibition !== null && components.exhibition < 45) notes.push("展示伸び悩む");

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
    reasons,
    notes,
    dataCount,
    _components: components,
  };
}

// ---------- 3連単120通り計算 ----------
// モデル: P(1着=i) ∝ first_power_i, P(2着=j|i) ∝ second_power_j, P(3着=k|...) ∝ third_power_k
// 欠場艇を含む組み合わせは除外。
export function computeTrifectas(boatScores, options = {}) {
  const { oddsMap = {}, margin = 0.25 } = options;
  const boats = boatScores.filter((b) => !b._absent);
  const numbers = boats.map((b) => b.boat_number);

  // 1着確率
  // v3: 艇力差をsoftmaxで確率へ変換し、強いレースほど上位買い目へ集中させる。
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
    const bi = boats.find((b) => b.boat_number === i);
    // 2着確率
    const secondBoats = boats.filter((b) => b.boat_number !== i);
    const secondProb = softmax(secondBoats.map((b) => b.second_power), 8.0);
    const secondP = {};
    secondBoats.forEach((b, k) => (secondP[b.boat_number] = secondProb[k]));

    for (const j of numbers) {
      if (j === i) continue;
      // 3着確率
      const thirdBoats = boats.filter((b) => b.boat_number !== i && b.boat_number !== j);
      const thirdProb = softmax(thirdBoats.map((b) => b.third_power), 10.0);
      const thirdP = {};
      thirdBoats.forEach((b, k) => (thirdP[b.boat_number] = thirdProb[k]));

      for (const k of numbers) {
        if (k === i || k === j) continue;
        const prob = firstP[i] * secondP[j] * thirdP[k];
        const combo = `${i}-${j}-${k}`;
        const actualOdds = oddsMap[combo];
        // 推定オッズ: 確率の逆数 × (1-控除率)
        const estimated_odds = Math.max(1.0, (1 / prob) * (1 - margin));
        const odds = actualOdds != null ? actualOdds : estimated_odds;
        const expected_value = prob * odds * 100; // %
        results.push({
          combination: combo,
          probability: Math.round(prob * 1000) / 10,
          estimated_odds: Math.round(estimated_odds * 10) / 10,
          actual_odds: actualOdds != null ? actualOdds : null,
          expected_value: Math.round(expected_value * 10) / 10,
          _first: i,
          _second: j,
          _third: k,
        });
      }
    }
  }
  // 降順ソート
  results.sort((a, b) => b.probability - a.probability);
  results.forEach((r, idx) => (r.rank = idx + 1));
  return results;
}

// ---------- 買い目判定 ----------
// 期待値だけではBUYにしない。確率・艇評価・データ信頼度・展示評価を通過してからオッズで判断。
export function judgeTrifecta(trifecta, ctx = {}) {
  const { settings = {}, topBoatTotal = 60, dataConfidence = 50, exhibitionReady = false, topProbability = 10 } = ctx;
  const prob = trifecta.probability;
  const ev = trifecta.expected_value;
  const odds = trifecta.actual_odds != null ? trifecta.actual_odds : trifecta.estimated_odds;

  const gates = [];
  // ゲート1: 最低予想確率
  if (prob < (settings.min_probability || 5)) gates.push("確率不足");
  // ゲート2: 艇評価(1着艇の総合力)
  if (topBoatTotal < 55) gates.push("本命艇評価不足");
  // ゲート3: データ信頼度
  if (dataConfidence < (settings.min_confidence || 40)) gates.push("データ信頼度不足");
  // ゲート4: 展示評価(FINALで展示未取得なら抑制)
  if (ctx.stage === "FINAL" && !exhibitionReady) gates.push("展示評価不足");

  if (gates.length > 0) {
    return { judgment: "SKIP", basis: gates.join("・") };
  }

  // 最後にオッズ(期待値)で判断
  const strongEv = settings.strong_buy_ev_threshold || 200;
  const buyEv = settings.buy_ev_threshold || 150;
  const watchEv = settings.watch_ev_threshold || 110;

  if (ev >= strongEv && prob >= (settings.min_probability || 5) * 1.5) {
    return { judgment: "STRONG_BUY", basis: `期待値${ev}%・確率${prob}%・信頼度${dataConfidence}` };
  }
  if (ev >= buyEv) {
    return { judgment: "BUY", basis: `期待値${ev}%・確率${prob}%` };
  }
  if (ev >= watchEv) {
    return { judgment: "WATCH", basis: `期待値${ev}%・確率${prob}%` };
  }
  return { judgment: "SKIP", basis: `期待値${ev}%低・確率${prob}%` };
}

// ---------- 予想グレード(S/A/B/C) ----------
export function gradePrediction(boatScores, topTrifecta) {
  const top = boatScores.reduce((a, b) => (a.first_power > b.first_power ? a : b));
  const second = boatScores.filter((b) => b.boat_number !== top.boat_number).reduce((a, b) => (a.first_power > b.first_power ? a : b));
  const gap = top.first_power - second.first_power;
  const conf = top.dataCount;
  if (gap >= 10 && top.first_power >= 80 && conf >= 8) return "S";
  if (gap >= 6 && top.first_power >= 70) return "A";
  if (top.first_power >= 60) return "B";
  return "C";
}

// ---------- データ信頼度 ----------
export function computeConfidence(boatScores) {
  const avgCount = boatScores.reduce((a, b) => a + b.dataCount, 0) / Math.max(1, boatScores.length);
  return clamp(Math.round((avgCount / 12) * 100), 0, 100);
}

// ---------- 全体予想実行 ----------
export function runPrediction(entries, settings, options = {}) {
  const stage = settings.stage || "PRE";
  const oddsMap = options.oddsMap || {};
  // 欠場マーク
  const boats = entries.map((e) => ({ ...e, _absent: !!e.is_absent }));
  const activeBoats = boats.filter((b) => !b._absent);

  const boatScores = boats.map((e) => {
    const s = computeBoatScores(e, settings);
    s._absent = e._absent;
    return s;
  });

  const activeScores = boatScores.filter((b) => !b._absent);
  const trifectas = computeTrifectas(activeScores, { oddsMap });
  const dataConfidence = computeConfidence(activeScores);
  const exhibitionReady = activeBoats.some((e) => isValid(e.exhibition_time) || isValid(e.exhibition_st));

  // 各買い目判定
  const top = activeScores.reduce((a, b) => (a.first_power > b.first_power ? a : b), activeScores[0]);
  const ranked = [...activeScores].sort((a, b) => b.first_power - a.first_power);
  const honmei = ranked[0]?.boat_number;
  const taiko = ranked[1]?.boat_number;
  const ana = [...activeScores].sort((a, b) => b.ana_potential - a.ana_potential)[0]?.boat_number;
  const keshi = ranked[ranked.length - 1]?.boat_number;

  const judgedTrifectas = trifectas.map((t) => {
    const { judgment, basis } = judgeTrifecta(t, {
      settings,
      topBoatTotal: top?.total_power || 50,
      dataConfidence,
      exhibitionReady,
      stage,
      topProbability: trifectas[0]?.probability || 10,
    });
    return { ...t, judgment, basis };
  });

  const grade = gradePrediction(activeScores, judgedTrifectas[0]);
  const topTrifecta = judgedTrifectas[0];

  return {
    stage,
    boatScores,
    trifectas: judgedTrifectas,
    prediction_grade: grade,
    data_confidence: dataConfidence,
    honmei_boat: honmei,
    taiko_boat: taiko,
    ana_boat: ana,
    keshi_boat: keshi,
    top_trifecta: topTrifecta?.combination,
    top_probability: topTrifecta?.probability,
    top_odds: topTrifecta?.actual_odds != null ? topTrifecta.actual_odds : topTrifecta?.estimated_odds,
    top_expected_value: topTrifecta?.expected_value,
    top_judgment: topTrifecta?.judgment,
    exhibition_ready: exhibitionReady,
    bet_plan: decideBetPlan(judgedTrifectas, settings, { dataConfidence, stage }),
  };
}

// ---------- 買い目点数判定(1-3点 / 4-6点 / 見送り) ----------
export function decideBetPlan(trifectas, settings, ctx = {}) {
  const { dataConfidence = 50, stage = "PRE" } = ctx;
  if (!trifectas || trifectas.length === 0) return { tier: "skip", count: 0, reason: "予想データなし" };
  if (dataConfidence < (settings.min_confidence || 40)) return { tier: "skip", count: 0, reason: "データ信頼度不足" };
  const buyable = trifectas.filter((t) => t.judgment === "STRONG_BUY" || t.judgment === "BUY" || t.judgment === "WATCH");
  if (buyable.length === 0) return { tier: "skip", count: 0, reason: "BUY/WATCH該当なし" };
  const top = trifectas[0];
  const second = trifectas[1];
  const gap = second ? top.probability - second.probability : top.probability;
  if (top.probability >= 12 && gap >= 4) return { tier: "1-3", count: Math.min(3, buyable.length), reason: "本命濃厚・集中" };
  if (top.probability >= 8) return { tier: "4-6", count: Math.min(6, buyable.length), reason: "予想分散・広目" };
  return { tier: "skip", count: 0, reason: "確率低・見送り" };
}

// ---------- 結果照合 ----------
export function verifyPrediction(prediction, result) {
  const actual = result?.result_trifecta;
  if (!actual) return null;
  const preHit = prediction.pre_trifecta === actual;
  const finalHit = prediction.final_trifecta === actual;
  return { preHit, finalHit, actual };
}