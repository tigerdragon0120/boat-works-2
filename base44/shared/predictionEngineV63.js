// ============================================================
// Prediction Engine V6.3 — V4・V6.2・V5 統合エンジン
// V4 / V6.2 / V5 の既存ロジックは一切変更せず、結果だけを合成する。
//
// 統合の根拠(全期間BUY実績):
//   V4   : BUY 42R / 的中 50.0% / 回収 81.6% → 「当てにいく軸」に強い
//   V6.2 : BUY 36R / 的中 25.0% / 回収 93.0% → 「期待値と校正」に強い
//   V5   : BUY 42R / 的中  9.5% / 回収163.7% → 「展開から中配当を拾う」に強い
//
// V6.3の設計:
//  1. 確率は3エンジンの合成(40% V4 + 45% V6.2校正 + 15% V5展開)
//     V5は「1着を誰が取るか」の展開確率だけを持っているため、
//     2着3着の配分はV6.2の条件付き構造を借りて120通りへ展開する。
//  2. 買い目は役割分担で組む(合計6〜8点)
//     - V4の6点から融合確率上位3点 (当てにいく)
//     - V6.2の買い目から期待値上位2点 (校正された価値)
//     - V5上位シナリオから中配当かつEVの高い2点 (回収率)
//     - 不足分は期待値順で補完
//  3. 1号艇が出走するレースは1着1号艇の買い目を必ず含める(V6.2実測の継承)
//  4. BUYは「V4かV6.2がBUY」+ セット確率 + 期待回収率 + 最低払戻 + 1号艇カバー
//     5・6号艇頭のシナリオはBUY対象外(V6.1/V6.2の検証結果を継承)
// ============================================================
import { runPredictionV4 } from "./predictionEngineV4.js";
import { runPredictionV62 } from "./predictionEngineV62.js";

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const maybeNum = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 3エンジンの確率合成比
const V63_PROBABILITY_WEIGHTS = { v4: 0.40, v62: 0.45, v5: 0.15 };

const MIN_TICKETS = 6;
const MAX_TICKETS = 8;
const BUY_RECOVERY_THRESHOLD = 100;
const MIN_PAYOUT_RATIO = 1.25;
const MIN_SET_PROBABILITY = 20;
const MIN_FIRST_CONFIDENCE = 48;
const VALUE_MIN_ODDS = 15;   // V5枠で拾う中配当の下限オッズ
const VALUE_MIN_EV = 105;    // V5枠に求める最低期待値(%)

// 5・6号艇頭はBUY対象外(V6.1/V6.2の検証結果)
const BLOCKED_SCENARIOS = ["5_6_ATTACK"];

const LANE_BONUS = { 1: 16, 2: 8, 3: 5, 4: 1, 5: -5, 6: -10 };

// ============================================================
// V5: 展開シナリオ
// 枠prior + ST + 展示 + 機力 + 1着適性(V4/V6.2の艇評価を平均)で
// 「誰が1着を取るか」の確率を作り、V6.2の8シナリオ確率と混ぜる。
// ============================================================
function buildV5Scenarios(entries, v4, v62) {
  const boats = [1, 2, 3, 4, 5, 6].map((boat) => {
    const entry = (entries || []).find((x) => Number(x.boat_number) === boat) || {};
    const a = (v4?.boatScores || []).find((x) => Number(x.boat_number) === boat) || {};
    const b = (v62?.boatScores || []).find((x) => Number(x.boat_number) === boat) || {};
    const finalScore = (num(a.final_score, num(a.pre_score, 50)) + num(b.final_score, num(b.pre_score, 50))) / 2;
    const firstScore = (num(a.first_score, finalScore) + num(b.first_score, finalScore)) / 2;
    const st = num(entry.exhibition_st, num(entry.section_st, num(entry.avg_st, 0.18)));
    const start = clamp(82 - (st - 0.10) * 260, 15, 100);
    const todayComp = a.today_components || {};
    const exRank = maybeNum(todayComp.exhibition_time_rank);
    const exhibition = exRank != null ? clamp(108 - exRank * 13) : 50;
    const motor = clamp(num(todayComp.motor, num(entry.motor_f2_rate, 45)));
    const lane = LANE_BONUS[boat] || 0;
    return {
      boat,
      st,
      score: firstScore * 0.48 + finalScore * 0.20 + start * 0.15 + exhibition * 0.10 + motor * 0.07 + lane,
    };
  }).sort((x, y) => y.score - x.score);

  const max = boats[0]?.score || 1;
  const exp = boats.map((x) => Math.exp((x.score - max) / 14));
  const sum = exp.reduce((s, v) => s + v, 0) || 1;
  const ownProb = new Map(boats.map((x, i) => [x.boat, (exp[i] / sum) * 100]));

  // V6.2の8シナリオ確率を1着艇ごとに集計して混ぜる(まくり適性を持つのはV6.2側)
  const v62ByFirst = new Map();
  for (const s of v62?.scenario_scores || []) {
    const f = maybeNum(s.first_boat);
    if (f == null) continue;
    v62ByFirst.set(f, (v62ByFirst.get(f) || 0) + num(s.probability));
  }

  const scenarios = boats.map((x) => {
    const p5 = ownProb.get(x.boat) || 0;
    const p62s = v62ByFirst.get(x.boat) || 0;
    const probability = v62s > 0 ? p5 * 0.6 + p62s * 0.4 : p5;
    return {
      first_boat: x.boat,
      probability: round2(probability),
      score: round1(x.score),
      st: maybeNum(x.st),
      followers: boats.filter((y) => y.boat !== x.boat).slice(0, 3).map((y) => y.boat),
    };
  });

  const total = scenarios.reduce((s, x) => s + x.probability, 0) || 1;
  scenarios.forEach((s) => { s.probability = round2((s.probability / total) * 100); });
  scenarios.sort((a, b) => b.probability - a.probability);

  const top = scenarios[0];
  return {
    scenarios,
    verdict: top ? (top.first_boat === 1 ? "イン逃げ優勢" : `${top.first_boat}号艇の攻め優勢`) : "展開不明",
  };
}

// ============================================================
// 120通りの融合確率
// ============================================================
function buildFusedCombos(v4, v62, v5) {
  const map = new Map();
  const ensure = (combination) => {
    if (!map.has(combination)) {
      map.set(combination, { combination, p4: 0, p62: 0, p5: 0, odds: null });
    }
    return map.get(combination);
  };

  for (const t of v4?.trifectas || []) {
    if (!t?.combination) continue;
    const row = ensure(t.combination);
    row.p4 = num(t.race_probability ?? t.probability);
  }
  for (const t of v62?.trifectas || []) {
    if (!t?.combination) continue;
    const row = ensure(t.combination);
    row.p62 = num(t.calibrated_probability ?? t.race_probability ?? t.probability);
    const odds = maybeNum(t.actual_odds);
    if (odds != null && odds > 0) row.odds = odds;
  }

  // V5の1着確率を、V6.2の2着3着構造で120通りへ配分する
  const totalByFirst = new Map();
  for (const row of map.values()) {
    const f = Number(row.combination.split("-")[0]);
    totalByFirst.set(f, (totalByFirst.get(f) || 0) + (row.p62 || 0));
  }
  const scenarioProbByFirst = new Map((v5?.scenarios || []).map((s) => [s.first_boat, s.probability]));
  for (const row of map.values()) {
    const f = Number(row.combination.split("-")[0]);
    const scenarioProb = scenarioProbByFirst.get(f) || 0;
    const totalFirst = totalByFirst.get(f) || 0;
    const share = totalFirst > 0 ? (row.p62 || 0) / totalFirst : 0;
    row.p5 = scenarioProb * share;
  }

  const weighted = [];
  for (const row of map.values()) {
    const p = V63_PROBABILITY_WEIGHTS.v4 * (row.p4 / 100) +
      V63_PROBABILITY_WEIGHTS.v62 * (row.p62 / 100) +
      V63_PROBABILITY_WEIGHTS.v5 * (row.p5 / 100);
    weighted.push({ ...row, raw: p });
  }
  const total = weighted.reduce((s, row) => s + row.raw, 0) || 1;

  return weighted
    .map((row) => {
      const probability = (row.raw / total) * 100;
      return {
        combination: row.combination,
        probability: round2(probability),
        p4: round2(row.p4),
        p62: round2(row.p62),
        p5: round2(row.p5),
        actual_odds: row.odds,
        expected_value: row.odds != null ? round1(probability * row.odds) : null,
      };
    })
    .sort((a, b) => b.probability - a.probability)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

// ============================================================
// 買い目選択(6〜8点)
// ============================================================
function selectTicketsV63(fused, v4, v62, v5, boat1Active) {
  const byCombo = new Map(fused.map((t) => [t.combination, t]));
  const selected = [];
  const sources = new Map();
  const chosen = new Set();

  const push = (combination, source) => {
    if (!combination || chosen.has(combination) || !byCombo.has(combination)) return false;
    chosen.add(combination);
    selected.push(combination);
    sources.set(combination, [...(sources.get(combination) || []), source]);
    return true;
  };

  // 1) V4の買い目から融合確率上位3点(当てにいく軸)
  (v4?.selected_trifectas || [])
    .map((c) => byCombo.get(c))
    .filter(Boolean)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3)
    .forEach((t) => push(t.combination, "V4"));

  // 2) V6.2の買い目から期待値上位2点(校正された価値)
  (v62?.selected_trifectas || [])
    .map((c) => byCombo.get(c))
    .filter(Boolean)
    .sort((a, b) => num(b.expected_value, -1) - num(a.expected_value, -1))
    .slice(0, 2)
    .forEach((t) => push(t.combination, "V6.2"));

  // 3) V5上位2シナリオから、中配当かつEVの高い組み合わせを2点(回収率)
  const valueSource = "V5";
  const valuePicks = [];
  for (const scenario of (v5?.scenarios || []).slice(0, 2)) {
    const candidates = fused.filter((t) => {
      const parts = t.combination.split("-").map(Number);
      return parts[0] === scenario.first_boat &&
        (t.actual_odds || 0) >= VALUE_MIN_ODDS &&
        (t.expected_value || 0) >= VALUE_MIN_EV;
    });
    const followers = new Set(scenario.followers || []);
    const preferred = candidates
      .filter((t) => followers.has(Number(t.combination.split("-")[1])))
      .sort((a, b) => num(b.expected_value, 0) - num(a.expected_value, 0))[0];
    const best = preferred || candidates.sort((a, b) => num(b.expected_value, 0) - num(a.expected_value, 0))[0];
    if (best) valuePicks.push(best);
  }
  valuePicks.slice(0, 2).forEach((t) => push(t.combination, valueSource));

  // 4) 6点に満たない場合は期待値順で補完
  if (selected.length < MIN_TICKETS) {
    [...fused]
      .sort((a, b) => num(b.expected_value, -1) - num(a.expected_value, -1) || b.probability - a.probability)
      .forEach((t) => {
        if (selected.length < MIN_TICKETS) push(t.combination, "FILL");
      });
  }

  // 5) 1号艇出走レースは1着1号艇の買い目を必ず1点含める
  let boat1Covered = selected.some((c) => c.startsWith("1-"));
  if (boat1Active && !boat1Covered) {
    const best1 = fused
      .filter((t) => t.combination.startsWith("1-"))
      .sort((a, b) => num(b.expected_value, -1) - num(a.expected_value, -1) || b.probability - a.probability)[0];
    if (best1) {
      if (selected.length >= MIN_TICKETS) {
        // 1号艇を含まず期待値が最も低い買い目を入れ替える
        let dropIdx = -1;
        let worstEv = Infinity;
        selected.forEach((c, i) => {
          if (c.startsWith("1-")) return;
          const ev = num(byCombo.get(c)?.expected_value, -1);
          if (ev < worstEv) { worstEv = ev; dropIdx = i; }
        });
        if (dropIdx >= 0) {
          chosen.delete(selected[dropIdx]);
          sources.delete(selected[dropIdx]);
          selected.splice(dropIdx, 1);
        }
      }
      if (push(best1.combination, "V5")) boat1Covered = true;
    }
  }

  // 6) 8点を超える場合は融合確率の低い点から削る(1号艇の買い目は残す)
  while (selected.length > MAX_TICKETS) {
    let dropIdx = -1;
    let worstProb = Infinity;
    selected.forEach((c, i) => {
      if (c.startsWith("1-")) return;
      const p = num(byCombo.get(c)?.probability, 0);
      if (p < worstProb) { worstProb = p; dropIdx = i; }
    });
    if (dropIdx < 0) break;
    chosen.delete(selected[dropIdx]);
    sources.delete(selected[dropIdx]);
    selected.splice(dropIdx, 1);
  }

  const sourceCounts = { V4: 0, "V6.2": 0, V5: 0, FILL: 0 };
  for (const list of sources.values()) {
    const main = list[list.length - 1];
    if (sourceCounts[main] != null) sourceCounts[main] += 1;
  }

  return {
    selected,
    sources: Object.fromEntries(sources),
    sourceCounts,
    boat1Active,
    boat1Covered,
    axisCount: new Set(selected.map((c) => Number(c.split("-")[0]))).size,
  };
}

// ============================================================
// セット指標
// ============================================================
function computeSetMetricsV63(selected, fused) {
  const rows = selected.map((c) => fused.find((t) => t.combination === c)).filter(Boolean);
  if (!rows.length) return null;

  const setProbability = rows.reduce((s, t) => s + num(t.probability), 0);
  const oddsRows = rows.filter((t) => t.actual_odds != null && t.actual_odds > 0);
  const oddsComplete = oddsRows.length === rows.length;
  const recovery = oddsComplete
    ? round1(rows.reduce((s, t) => s + num(t.probability) * t.actual_odds, 0) / rows.length)
    : null;
  const oddsValues = oddsRows.map((t) => t.actual_odds);

  return {
    set_probability: round2(setProbability),
    set_expected_recovery: recovery,
    synthetic_odds: setProbability > 0 ? round1(10000 / setProbability) : null,
    investment: rows.length * 100,
    min_payout: oddsValues.length ? Math.min(...oddsValues) * 100 : null,
    max_payout: oddsValues.length ? Math.max(...oddsValues) * 100 : null,
    avg_payout: oddsValues.length ? (oddsValues.reduce((s, o) => s + o, 0) / oddsValues.length) * 100 : null,
    odds_complete: oddsComplete,
    best_ev_ticket: [...rows].sort((a, b) => num(b.expected_value, -1) - num(a.expected_value, -1))[0]?.combination || null,
  };
}

// ============================================================
// 判定
// ============================================================
function judgeV63({ stage, setMetrics, firstProbs, v4, v62, v5, selection, boat1Active }) {
  const sortedFirst = [...firstProbs].sort((a, b) => b - a);
  const firstConfidence = clamp(sortedFirst[0] + (sortedFirst[0] - sortedFirst[1]) * 0.5, 0, 100);
  const setProb = setMetrics?.set_probability ?? 0;
  const recovery = setMetrics?.set_expected_recovery;
  const investment = setMetrics?.investment || 0;
  const minPayout = setMetrics?.min_payout;
  const payoutSafe = minPayout != null && investment > 0 && minPayout >= investment * MIN_PAYOUT_RATIO;
  const scenarioKey = v62?.winning_scenario || null;
  const blocked = BLOCKED_SCENARIOS.includes(scenarioKey);
  const engineBuy = v4?.final_judgment === "BUY" || v62?.final_judgment === "BUY";
  const boat1CoverageOk = !boat1Active || selection.boat1Covered === true;

  const votes = `V4(${v4?.final_judgment || "—"})・V6.2(${v62?.final_judgment || "—"})・V5(${v5?.verdict || "—"})`;

  if (stage === "FINAL") {
    if (blocked && engineBuy && setProb >= MIN_SET_PROBABILITY) {
      return { judgment: "WATCH", reason: `V6.3 弱点シナリオ除外(${scenarioKey}) — ${votes}` };
    }
    if (!boat1CoverageOk && engineBuy && setProb >= MIN_SET_PROBABILITY) {
      return { judgment: "WATCH", reason: `V6.3 1号艇カバー外 — ${votes}` };
    }
    if (engineBuy && boat1CoverageOk && recovery != null && recovery >= BUY_RECOVERY_THRESHOLD &&
        setProb >= MIN_SET_PROBABILITY && firstConfidence >= MIN_FIRST_CONFIDENCE && payoutSafe) {
      return {
        judgment: "BUY",
        reason: `V6.3 統合BUY(${votes} / 想定回収${recovery}%・セット${setProb}%・1着信頼度${round1(firstConfidence)}・最低払戻¥${Math.round(minPayout)})`,
      };
    }
    if (engineBuy && setProb >= MIN_SET_PROBABILITY && !payoutSafe) {
      return {
        judgment: "WATCH",
        reason: `V6.3 配当不足(最低払戻¥${minPayout != null ? Math.round(minPayout) : "—"} < 投資¥${investment}×${MIN_PAYOUT_RATIO}) — ${votes}`,
      };
    }
    if (engineBuy && setProb >= MIN_SET_PROBABILITY && recovery != null && recovery < BUY_RECOVERY_THRESHOLD) {
      return { judgment: "WATCH", reason: `V6.3 想定回収${recovery}%<${BUY_RECOVERY_THRESHOLD}% — ${votes}` };
    }
    if (setProb >= 15) {
      return { judgment: "WATCH", reason: `V6.3 根拠不足(セット${setProb}%・1着信頼度${round1(firstConfidence)}) — ${votes}` };
    }
    return { judgment: "SKIP", reason: `V6.3 予測不安定(セット${setProb}%) — ${votes}` };
  }

  // PRE: オッズ未確定のため期待回収率は判定に使わない
  if (engineBuy && boat1CoverageOk && !blocked && setProb >= MIN_SET_PROBABILITY && firstConfidence >= MIN_FIRST_CONFIDENCE) {
    return {
      judgment: "BUY",
      reason: `V6.3 PRE暫定BUY(${votes} / セット${setProb}%・1着信頼度${round1(firstConfidence)})`,
    };
  }
  if (engineBuy && blocked) {
    return { judgment: "WATCH", reason: `V6.3 PRE弱点シナリオ(${scenarioKey}) — ${votes}` };
  }
  if (setProb >= 15) {
    return { judgment: "WATCH", reason: `V6.3 PRE(セット${setProb}%・1着信頼度${round1(firstConfidence)}) — ${votes}` };
  }
  return { judgment: "SKIP", reason: `V6.3 PRE予測不安定 — ${votes}` };
}

// ============================================================
// メイン: V6.3予想
// ============================================================
export function runPredictionV63(entries, race, settings, options = {}) {
  const stage = options.stage || "PRE";
  const oddsMap = options.oddsMap || {};

  // 1. 既存エンジンを同じデータで実行(ロジックは変更しない)
  const v4 = runPredictionV4(entries, race, settings, { stage, oddsMap });
  const v62 = runPredictionV62(entries, race, settings, { stage, oddsMap });

  // 2. V5展開シナリオ
  const v5 = buildV5Scenarios(entries, v4, v62);

  // 3. 120通りの融合確率
  const fused = buildFusedCombos(v4, v62, v5);
  if (!fused.length) {
    return { error: "NO_COMBINATIONS", v4, v62, v5 };
  }

  const activeBoats = new Set(fused.flatMap((t) => t.combination.split("-").map(Number)));
  const boat1Active = activeBoats.has(1);

  // 4. 1着確率(融合後)
  const firstTotals = new Map();
  for (const t of fused) {
    const f = Number(t.combination.split("-")[0]);
    firstTotals.set(f, (firstTotals.get(f) || 0) + t.probability);
  }
  const firstProbsMap = new Map([...firstTotals.entries()].sort((a, b) => b[1] - a[1]));
  const firstProbs = [...firstProbsMap.values()];
  const firstRanking = [...firstProbsMap.keys()];

  // 5. 買い目
  const selection = selectTicketsV63(fused, v4, v62, v5, boat1Active);

  // 6. セット指標
  const setMetrics = computeSetMetricsV63(selection.selected, fused);

  // 7. 判定
  const { judgment, reason } = judgeV63({
    stage, setMetrics, firstProbs, v4, v62, v5, selection, boat1Active,
  });

  const firstSorted = [...firstProbs].sort((a, b) => b - a);
  const firstConfidence = clamp(firstSorted[0] + (firstSorted[0] - firstSorted[1]) * 0.5, 0, 100);
  const topCombo = fused[0];
  const topScenario = v5.scenarios[0];

  const secondRanking = [1, 2, 3, 4, 5, 6]
    .map((boat) => ({
      boat,
      score: fused.filter((t) => t.combination.split("-")[1] === String(boat)).reduce((s, t) => s + t.probability, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.boat);
  const thirdRanking = [1, 2, 3, 4, 5, 6]
    .map((boat) => ({
      boat,
      score: fused.filter((t) => t.combination.split("-")[2] === String(boat)).reduce((s, t) => s + t.probability, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.boat);

  const boatScoreOf = (boat) => {
    const a = (v4?.boatScores || []).find((x) => Number(x.boat_number) === boat) || {};
    const b = (v62?.boatScores || []).find((x) => Number(x.boat_number) === boat) || {};
    const score = (num(a.final_score, num(a.pre_score, 50)) + num(b.final_score, num(b.pre_score, 50))) / 2;
    return round1(score);
  };

  return {
    boatScores: firstRanking.map((boat) => ({
      boat_number: boat,
      final_score: boatScoreOf(boat),
      first_probability: round2(firstTotals.get(boat) || 0),
      reasons: [],
      notes: [],
    })),
    trifectas: fused.map((t) => ({
      combination: t.combination,
      rank: t.rank,
      race_probability: t.probability,
      actual_odds: t.actual_odds,
      expected_value: t.expected_value,
      is_selected: selection.selected.includes(t.combination),
      ticket_rank: selection.selected.includes(t.combination) ? selection.selected.indexOf(t.combination) + 1 : null,
    })),
    selected_trifectas: selection.selected,
    ticket_count: selection.selected.length,
    ticket_strategy: `V4 ${selection.sourceCounts.V4}点 + V6.2 ${selection.sourceCounts["V6.2"]}点 + V5 ${selection.sourceCounts.V5}点`,
    expand_reason: `合成比 V4:${V63_PROBABILITY_WEIGHTS.v4 * 100}% / V6.2:${V63_PROBABILITY_WEIGHTS.v62 * 100}% / V5:${V63_PROBABILITY_WEIGHTS.v5 * 100}%` +
      (selection.sourceCounts.FILL ? ` / 補完${selection.sourceCounts.FILL}点` : ""),
    set_metrics: setMetrics,
    data_confidence: round1((num(v4?.data_confidence, 50) + num(v62?.data_confidence, 50)) / 2),
    final_judgment: judgment,
    judgment_reason: reason,
    honmei_boat: firstRanking[0] || null,
    taiko_boat: firstRanking[1] || null,
    ana_boat: firstRanking[2] || null,
    keshi_boat: firstRanking[firstRanking.length - 1] || null,
    top_trifecta: topCombo?.combination || null,
    top_probability: topCombo?.probability ?? null,
    top_odds: topCombo?.actual_odds ?? null,
    top_expected_value: topCombo?.expected_value ?? null,
    first_ranking: firstRanking,
    second_ranking: secondRanking,
    third_ranking: thirdRanking,
    first_probability_gap: firstSorted.length > 1 ? round2(firstSorted[0] - firstSorted[1]) : null,
    first_confidence: round1(firstConfidence),
    escape_probability: v62?.escape_probability ?? null,
    winning_scenario: v62?.winning_scenario || null,
    scenario_scores: v62?.scenario_scores || [],
    v6_weights: V63_PROBABILITY_WEIGHTS,
    factor_snapshot: {
      st: v62?.factor_snapshot?.st ?? null,
      exhibition: v62?.factor_snapshot?.exhibition ?? null,
      lane_past10: v62?.factor_snapshot?.lane_past10 ?? null,
      racer_power: v62?.factor_snapshot?.racer_power ?? null,
      section: v62?.factor_snapshot?.section ?? null,
      motor: v62?.factor_snapshot?.motor ?? null,
      course: v62?.factor_snapshot?.course ?? null,
      odds: v62?.factor_snapshot?.odds ?? null,
      scenario: topScenario?.probability ?? null,
      escape_prob: v62?.escape_probability ?? null,
      first_confidence: round1(firstConfidence),
      set_probability: setMetrics?.set_probability ?? null,
    },
    // V6.3専用(保存時はjudgment_reason/expand_reasonへ要約して保持)
    engine_votes: {
      v4: v4?.final_judgment || null,
      v62: v62?.final_judgment || null,
      v5: v5?.verdict || null,
      v5_top_boat: topScenario?.first_boat ?? null,
      v5_top_probability: topScenario?.probability ?? null,
    },
    v5_scenarios: v5.scenarios,
    ticket_sources: selection.sources,
    axis_count: selection.axisCount,
    boat1_active: boat1Active,
    boat1_covered: selection.boat1Covered,
  };
}