// ============================================================
// Prediction Engine V6.5 — 女子戦 的中率特化エンジン
//
// 女子戦だけを対象に「当てにいく」ことに振り切ったエンジン。
// 回収率(V6.2/V6.4)ではなく、セット的中率そのものを最大化する。
//
// 女子戦の傾向として知られる性質を補正に使う:
//  - イン(1コース)の逃げが決まりやすい
//  - 外枠(4〜6号艇)からのまくりは男子より少ない
//  - 能力差が小さく、配当は低めに収まりやすい
//
// 買い目の作り方(的中率優先):
//  1. V6.1の120通り確率を土台にし、1着艇別の女子戦補正をかけて再正規化する。
//  2. 1着は確率上位2艇(1艇が抜けている場合はその1艇)に絞る=軸を絞る。
//  3. 軸の1着から2・3着の組み合わせを確率の高い順に6〜8点。
//     薄い買い目(0.8%未満)は点数を増やさずに切る。
//  4. 1号艇が走るレースは1着1号艇の買い目を必ず1点入れる。
//
// 判定:
//  - セット的中率が基準以上ならBUY。基準未満はWATCH、薄すぎるレースはSKIP。
//  - 配当の下限は問わない(的中率を優先するため)。
// ============================================================
import { runPredictionV61 } from "./predictionEngineV61.js";
import { calibrateSetProbability } from "./v65Calibration.js";

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const maybeNum = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 1着艇別の女子戦補正(1コース寄りに確率を移す)
const WOMENS_FIRST_FACTOR = { 1: 1.20, 2: 1.05, 3: 0.97, 4: 0.88, 5: 0.78, 6: 0.70 };

const MIN_TICKETS = 6;
const MAX_TICKETS = 8;
const MIN_TICKET_PROBABILITY = 0.8;   // これ未満の薄い買い目は6点を超えて足さない
const MAX_ODDS = 500;
const MIN_AXIS_CONFIDENCE = 50;       // 軸艇が1着を取る確率(セットの土台)
const BUY_SET_PROBABILITY = { PRE: 24, FINAL: 28 };
const WATCH_SET_PROBABILITY = 18;
const AXIS_SINGLE_THRESHOLD = 55;     // 1着1位がこの確率以上なら1軸に絞る

// ============================================================
// 女子戦補正をかけた120通り
// ============================================================
function buildCombos(baseTrifectas) {
  const rows = [];
  for (const t of baseTrifectas || []) {
    const combination = String(t?.combination || "");
    const parts = combination.split("-").map(Number);
    if (parts.length !== 3 || parts.some((b) => !Number.isFinite(b) || b < 1 || b > 6)) continue;
    const factor = WOMENS_FIRST_FACTOR[parts[0]] ?? 1;
    const raw = num(t?.race_probability ?? t?.probability, 0);
    if (raw <= 0) continue;
    rows.push({
      combination,
      adjacent: raw * factor,
      raw,
      odds: maybeNum(t?.actual_odds),
    });
  }
  if (!rows.length) return [];

  const total = rows.reduce((s, r) => s + r.adjacent, 0) || 1;
  return rows
    .map((r) => {
      const probability = round2((r.adjacent / total) * 100);
      return {
        combination: r.combination,
        probability,
        actual_odds: r.odds,
        expected_value: r.odds != null ? round1(probability * r.odds) : null,
      };
    })
    .sort((a, b) => b.probability - a.probability)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ============================================================
// 買い目選択(的中率優先・6〜8点)
// ============================================================
function selectTickets(combos) {
  const firstTotals = new Map();
  for (const c of combos) {
    const f = Number(c.combination.split("-")[0]);
    firstTotals.set(f, round2((firstTotals.get(f) || 0) + c.probability));
  }
  const firstRanking = [...firstTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([boat, probability]) => ({ boat, probability }));

  const top = firstRanking[0];
  const axisBoats = top && top.probability >= AXIS_SINGLE_THRESHOLD
    ? [top.boat]
    : firstRanking.slice(0, 2).map((x) => x.boat);

  const pool = combos
    .filter((c) => axisBoats.includes(Number(c.combination.split("-")[0])))
    .filter((c) => c.actual_odds == null || c.actual_odds <= MAX_ODDS)
    .sort((a, b) => b.probability - a.probability);

  const selected = [];
  for (const c of pool) {
    if (selected.length >= MAX_TICKETS) break;
    if (selected.length >= MIN_TICKETS && c.probability < MIN_TICKET_PROBABILITY) break;
    selected.push(c.combination);
  }

  // 1号艇が出走しているレースは1着1号艇の買い目を必ず1点含める
  const boat1Active = firstTotals.has(1);
  let boat1Covered = selected.some((c) => c.startsWith("1-"));
  if (boat1Active && !boat1Covered) {
    const best1 = pool.find((c) => c.combination.startsWith("1-"));
    if (best1) {
      if (selected.length >= MIN_TICKETS) selected.pop();
      selected.push(best1.combination);
      boat1Covered = true;
    }
  }

  return { selected, axisBoats, firstRanking, boat1Active, boat1Covered };
}

// ============================================================
// セット指標
// ============================================================
function computeSetMetrics(selected, combos) {
  const byCombo = new Map(combos.map((c) => [c.combination, c]));
  const rows = selected.map((c) => byCombo.get(c)).filter(Boolean);
  if (!rows.length) return null;

  const setProbability = rows.reduce((s, t) => s + num(t.probability), 0);
  const oddsRows = rows.filter((t) => t.actual_odds != null && t.actual_odds > 0);
  const oddsComplete = oddsRows.length === rows.length;
  const oddsValues = oddsRows.map((t) => t.actual_odds);
  const recovery = oddsComplete
    ? round1(rows.reduce((s, t) => s + num(t.probability) * t.actual_odds, 0) / rows.length)
    : null;

  return {
    set_probability: round2(setProbability),
    set_expected_recovery: recovery,
    synthetic_odds: setProbability > 0 ? round1(100 / setProbability) : null,
    investment: rows.length * 100,
    min_payout: oddsValues.length ? Math.round(Math.min(...oddsValues) * 100) : null,
    max_payout: oddsValues.length ? Math.round(Math.max(...oddsValues) * 100) : null,
    avg_payout: oddsValues.length ? Math.round((oddsValues.reduce((s, o) => s + o, 0) / oddsValues.length) * 100) : null,
    odds_complete: oddsComplete,
    best_ev_ticket: [...rows].sort((a, b) => num(b.expected_value, -1) - num(a.expected_value, -1))[0]?.combination || null,
  };
}

// ============================================================
// 判定
// ============================================================
// calibration: 日次検証から算出した補正値。判定に使うセット的中率だけを補正し、
// 買い目の構成(組み合わせ)は変更しない。
function judge({ stage, setMetrics, axisConfidence, axisBoats, boat1Active, boat1Covered, calibration }) {
  const rawSetProb = setMetrics?.set_probability ?? 0;
  const setProb = calibration?.applied ? calibration.value : rawSetProb;
  const axisText = `軸${axisBoats.join("・")}号艇`;
  const setText = calibration?.applied
    ? `セット的中率${setProb}%(予想${rawSetProb}%・実測${calibration.measured_rate}%)`
    : `セット的中率${rawSetProb}%`;
  const confText = `軸1着率${round1(axisConfidence)}%`;
  const buyThreshold = BUY_SET_PROBABILITY[stage] ?? BUY_SET_PROBABILITY.FINAL;

  if (stage === "FINAL" && boat1Active && !boat1Covered) {
    return { judgment: "WATCH", reason: `V6.5 女子戦 1号艇カバー外 — ${axisText}・${setText}` };
  }
  if (setProb < WATCH_SET_PROBABILITY) {
    return { judgment: "SKIP", reason: `V6.5 女子戦 荒れ想定(${setText}<${WATCH_SET_PROBABILITY}%) — ${axisText}・${confText}` };
  }
  if (setProb < buyThreshold || axisConfidence < MIN_AXIS_CONFIDENCE) {
    return {
      judgment: "WATCH",
      reason: `V6.5 女子戦 ${setText}/${buyThreshold}%未満 または ${confText}<${MIN_AXIS_CONFIDENCE}% — ${axisText}`,
    };
  }
  const recoveryText = setMetrics?.set_expected_recovery != null
    ? `・期待回収${setMetrics.set_expected_recovery}%`
    : "";
  return {
    judgment: "BUY",
    reason: `V6.5 女子戦 的中率重視BUY(${setText}・${confText}・合成${setMetrics?.synthetic_odds ?? "—"}倍${recoveryText}) — ${axisText}`,
  };
}

// ============================================================
// メイン: V6.5予想
// ============================================================
export function runPredictionV65(entries, race, settings, options = {}) {
  const stage = options.stage || "PRE";
  const oddsMap = options.oddsMap || {};

  // 土台はV6.1(メインエンジン)。ロジックは変更せず確率だけ受け取る。
  const base = runPredictionV61(entries, race, settings, { stage, oddsMap });
  if (!base?.trifectas?.length) return { error: "NO_COMBINATIONS" };

  const combos = buildCombos(base.trifectas);
  if (!combos.length) return { error: "NO_COMBINATIONS" };

  const { selected, axisBoats, firstRanking, boat1Active, boat1Covered } = selectTickets(combos);
  const setMetrics = computeSetMetrics(selected, combos);

  const firstProbs = firstRanking.map((x) => x.probability);
  const gap = firstProbs.length > 1 ? firstProbs[0] - firstProbs[1] : 0;
  // 軸(1着候補)が1着を取る確率。買い目は軸の1着から組むため、この値で判定する。
  const axisConfidence = clamp(
    axisBoats.reduce((s, boat) => s + (firstRanking.find((x) => x.boat === boat)?.probability || 0), 0),
    0,
    100
  );

  // 日次検証の実績で「予想セット的中率」を補正してから判定する
  const calibration = calibrateSetProbability(setMetrics?.set_probability, options.calibration || null);

  const { judgment, reason } = judge({
    stage, setMetrics, axisConfidence, axisBoats, boat1Active, boat1Covered, calibration,
  });

  const firstBoats = firstRanking.map((x) => x.boat);
  const secondRanking = [1, 2, 3, 4, 5, 6]
    .map((boat) => ({
      boat,
      score: combos.filter((c) => Number(c.combination.split("-")[1]) === boat).reduce((s, c) => s + c.probability, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.boat);
  const thirdRanking = [1, 2, 3, 4, 5, 6]
    .map((boat) => ({
      boat,
      score: combos.filter((c) => Number(c.combination.split("-")[2]) === boat).reduce((s, c) => s + c.probability, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.boat);

  const baseBoatScore = (boat) => {
    const found = (base.boatScores || []).find((x) => Number(x.boat_number) === boat);
    return round1(num(found?.final_score, num(found?.pre_score, 50)));
  };

  const topCombo = combos[0];

  return {
    womens_race: true,
    womens_first_factor: WOMENS_FIRST_FACTOR,
    boatScores: firstBoats.map((boat) => ({
      boat_number: boat,
      final_score: baseBoatScore(boat),
      first_probability: round2(firstRanking.find((x) => x.boat === boat)?.probability ?? 0),
      reasons: [],
      notes: [],
    })),
    trifectas: combos.map((c) => ({
      combination: c.combination,
      rank: c.rank,
      race_probability: c.probability,
      actual_odds: c.actual_odds,
      expected_value: c.expected_value,
      is_selected: selected.includes(c.combination),
      ticket_rank: selected.includes(c.combination) ? selected.indexOf(c.combination) + 1 : null,
    })),
    selected_trifectas: selected,
    ticket_count: selected.length,
    ticket_strategy: `${axisBoats.length}軸${selected.length}点(的中率優先)`,
    expand_reason: "女子戦補正(1コース優位) + 1着軸を上位艇に限定 + 確率上位6〜8点",
    set_metrics: setMetrics,
    set_probability_calibrated: calibration.applied ? calibration.value : null,
    calibration_applied: calibration.applied,
    data_confidence: round1(num(base.data_confidence, 60)),
    final_judgment: judgment,
    judgment_reason: reason,
    honmei_boat: firstBoats[0] || null,
    taiko_boat: firstBoats[1] || null,
    ana_boat: firstBoats[2] || null,
    keshi_boat: firstBoats[firstBoats.length - 1] || null,
    top_trifecta: topCombo?.combination || null,
    top_probability: topCombo?.probability ?? null,
    top_odds: topCombo?.actual_odds ?? null,
    top_expected_value: topCombo?.expected_value ?? null,
    first_ranking: firstBoats,
    second_ranking: secondRanking,
    third_ranking: thirdRanking,
    first_probability_gap: round2(gap),
    first_confidence: round1(axisConfidence),
    escape_probability: base.escape_probability ?? null,
    winning_scenario: base.winning_scenario || null,
    scenario_scores: base.scenario_scores || [],
    v6_weights: { v61: 1 },
    factor_snapshot: {
      st: base.factor_snapshot?.st ?? null,
      exhibition: base.factor_snapshot?.exhibition ?? null,
      lane_past10: base.factor_snapshot?.lane_past10 ?? null,
      racer_power: base.factor_snapshot?.racer_power ?? null,
      section: base.factor_snapshot?.section ?? null,
      motor: base.factor_snapshot?.motor ?? null,
      course: base.factor_snapshot?.course ?? null,
      odds: base.factor_snapshot?.odds ?? null,
      scenario: null,
      escape_prob: base.escape_probability ?? null,
      first_confidence: round1(axisConfidence),
      set_probability: setMetrics?.set_probability ?? null,
      set_probability_calibrated: calibration.applied ? calibration.value : null,
      calibration_applied: calibration.applied,
      calibration_band: calibration.band ?? null,
      calibration_measured_rate: calibration.applied ? calibration.measured_rate : null,
      calibration_sample_count: calibration.applied ? calibration.sample_count : null,
      womens_axis: axisBoats,
      womens_first_factor: WOMENS_FIRST_FACTOR,
    },
    axis_count: axisBoats.length,
    axis_boats: axisBoats,
    boat1_active: boat1Active,
    boat1_covered: boat1Covered,
  };
}