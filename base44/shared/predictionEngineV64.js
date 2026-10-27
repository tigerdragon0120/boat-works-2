// ============================================================
// Prediction Engine V6.4 — V6.1・V6.2・V6.3 合議エンジン
// V6.1 / V6.2 / V6.3 のロジックは一切変更せず、3つの判断だけを合成する。
//
// 全期間BUY実績(統合前):
//   V6.1 : BUY 360R / 的中22.8% / 回収 61%   → 最も多く買うが配当が細い
//   V6.2 : BUY  56R / 的中23.2% / 回収 74%   → 校正済みだが的中率と配当が噛み合わない
//   V6.3 : BUY  14R / 的中35.7% / 回収 86%   → 的中は高いが点数が広く配当を取り切れない
// 3つとも回収率100%に届かない原因は「確率の見積もりが楽観的で、
// 期待値が実際より高く出た買い目まで買っていること」。
//
// V6.4の設計(回収率を上げるための3つの工夫):
//  1. 合議: 3エンジンのうち2つ以上がBUYと判断したレースだけを対象にする。
//     V6.3単独のBUYは的中実績が高い(35.7%)ため、これも合議1票分として扱う。
//  2. 保守的期待値: 買い目の期待値は「3エンジンのうち最も低い確率」で計算する。
//     一番慎重に見積もってもなお期待値が残る買い目だけを選ぶ。
//  3. 配当下限: 6〜8点のうちどの1点が当たっても投資額の1.5倍以上が返る構成を必須にする。
//     的中しても低配当で負ける「当て損」を構造的に排除する。
// ============================================================
import { runPredictionV61 } from "./predictionEngineV61.js";
import { runPredictionV62 } from "./predictionEngineV62.js";
import { runPredictionV63 } from "./predictionEngineV63.js";

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const maybeNum = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 3エンジンの合成比(確率の表示・並び順に使用)
const V64_BLEND_WEIGHTS = { v61: 0.45, v62: 0.30, v63: 0.25 };

const MIN_TICKETS = 6;
const MAX_TICKETS = 8;
const CONSENSUS_TICKETS = 4;      // 2エンジン以上が選んだ買い目を優先して入れる点数
const SET_RECOVERY_MIN = 130;     // 保守的期待値ベースのセット回収率下限(%)
const MIN_PAYOUT_RATIO = 1.5;     // 1点的中で投資額の1.5倍以上
const MIN_SET_PROBABILITY = 8;    // セット的中率の下限(これ未満は薄すぎる)
const PRE_MAX_SET_PROBABILITY = 25; // PRE(オッズ未取得)で配当細りを避ける上限
const MAX_ODDS = 500;             // 現実的に拾える上限オッズ
const MIN_FIRST_CONFIDENCE = 40;
const BLOCKED_SCENARIOS = ["5_6_ATTACK"];

const probOf = (t) => num(t?.race_probability ?? t?.calibrated_probability ?? t?.probability, 0);

// ============================================================
// 120通りの合議確率
//   blend     : 3エンジンの重み付き平均(表示・並び順)
//   p_min     : 3エンジンのうち最も低い確率(保守的期待値の計算用)
// ============================================================
function buildCombos(v61, v62, v63) {
  const map = new Map();
  const ensure = (combination) => {
    if (!map.has(combination)) {
      map.set(combination, { combination, p61: null, p62: null, p63: null, odds: null });
    }
    return map.get(combination);
  };

  for (const t of v61?.trifectas || []) {
    if (!t?.combination) continue;
    const row = ensure(t.combination);
    row.p61 = probOf(t);
    if (row.odds == null) row.odds = maybeNum(t.actual_odds);
  }
  for (const t of v62?.trifectas || []) {
    if (!t?.combination) continue;
    const row = ensure(t.combination);
    row.p62 = probOf(t);
    const o = maybeNum(t.actual_odds);
    if (o != null && o > 0 && row.odds == null) row.odds = o;
  }
  for (const t of v63?.trifectas || []) {
    if (!t?.combination) continue;
    const row = ensure(t.combination);
    row.p63 = probOf(t);
    const o = maybeNum(t.actual_odds);
    if (o != null && o > 0) row.odds = o;
  }

  const rows = [];
  for (const row of map.values()) {
    const values = [];
    if (row.p61 != null) values.push({ w: V64_BLEND_WEIGHTS.v61, p: row.p61 });
    if (row.p62 != null) values.push({ w: V64_BLEND_WEIGHTS.v62, p: row.p62 });
    if (row.p63 != null) values.push({ w: V64_BLEND_WEIGHTS.v63, p: row.p63 });
    if (!values.length) continue;
    const wSum = values.reduce((s, x) => s + x.w, 0) || 1;
    const blend = values.reduce((s, x) => s + x.p * x.w, 0) / wSum;
    const positive = values.map((x) => x.p).filter((p) => p > 0);
    const pMin = positive.length ? Math.min(...positive) : 0;
    const odds = row.odds != null && row.odds > 0 ? row.odds : null;
    rows.push({
      combination: row.combination,
      blend: round2(blend),
      p_min: round2(pMin),
      actual_odds: odds,
      expected_value: odds != null ? round1(blend * odds) : null,
      conservative_ev: odds != null ? round1(pMin * odds) : null,
    });
  }

  const total = rows.reduce((s, r) => s + r.blend, 0) || 1;
  return rows
    .map((r) => ({ ...r, probability: round2((r.blend / total) * 100) }))
    .sort((a, b) => b.probability - a.probability)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ============================================================
// 買い目選択(6〜8点)
//   合議(2エンジン以上が選択) → 片方のみ → 期待値順で補完
//   すべて保守的期待値(最も低い確率 × オッズ)の高い順に選ぶ
// ============================================================
function selectTicketsV64(combos, v61, v62, v63, boat1Active) {
  const byCombo = new Map(combos.map((c) => [c.combination, c]));
  const votes = new Map();
  for (const [engine, pred] of [["v61", v61], ["v62", v62], ["v63", v63]]) {
    for (const c of pred?.selected_trifectas || []) {
      votes.set(c, [...(votes.get(c) || []), engine]);
    }
  }

  const usable = (c) => {
    const row = byCombo.get(c);
    if (!row) return null;
    if (row.actual_odds != null && row.actual_odds > MAX_ODDS) return null;
    return row;
  };

  const scoreOf = (c) => {
    const row = byCombo.get(c);
    if (!row) return -Infinity;
    return row.conservative_ev ?? row.expected_value ?? -1;
  };
  const byScore = (a, b) =>
    scoreOf(b) - scoreOf(a) ||
    (byCombo.get(b)?.probability || 0) - (byCombo.get(a)?.probability || 0);

  const consensus = [...votes.keys()].filter((c) => votes.get(c).length >= 2 && usable(c)).sort(byScore);
  const single = [...votes.keys()].filter((c) => votes.get(c).length === 1 && usable(c)).sort(byScore);

  const selected = [];
  const push = (c) => {
    if (!c || selected.includes(c) || !usable(c)) return false;
    selected.push(c);
    return true;
  };

  consensus.slice(0, CONSENSUS_TICKETS).forEach(push);
  single.slice(0, 2).forEach(push);

  // 6点に満たない場合は、残りの合議買い目 → 単独買い目 → 全体から期待値順で補完
  const fillPool = [
    ...consensus.slice(CONSENSUS_TICKETS),
    ...single.slice(2),
    ...combos
      .filter((c) => c.actual_odds != null || c.probability > 0)
      .sort((a, b) => (b.conservative_ev ?? b.expected_value ?? -1) - (a.conservative_ev ?? a.expected_value ?? -1) || b.probability - a.probability)
      .map((c) => c.combination),
  ];
  for (const c of fillPool) {
    if (selected.length >= MIN_TICKETS) break;
    push(c);
  }

  // 1号艇出走レースは1着1号艇の買い目を必ず1点含める(1号艇カバー)
  let boat1Covered = selected.some((c) => c.startsWith("1-"));
  if (boat1Active && !boat1Covered) {
    const best1 = combos
      .filter((c) => c.combination.startsWith("1-") && (c.actual_odds == null || c.actual_odds <= MAX_ODDS))
      .sort((a, b) => (b.conservative_ev ?? b.expected_value ?? -1) - (a.conservative_ev ?? a.expected_value ?? -1) || b.probability - a.probability)[0];
    if (best1) {
      if (selected.length >= MIN_TICKETS) {
        let dropIdx = -1;
        let worstEv = Infinity;
        selected.forEach((c, i) => {
          if (c.startsWith("1-")) return;
          const ev = byCombo.get(c)?.conservative_ev ?? byCombo.get(c)?.expected_value ?? -1;
          if (ev < worstEv) { worstEv = ev; dropIdx = i; }
        });
        if (dropIdx >= 0) selected.splice(dropIdx, 1);
      }
      if (push(best1.combination)) boat1Covered = true;
    }
  }

  // 8点を超えたら保守的期待値の低い点から削る(1号艇の買い目は残す)
  while (selected.length > MAX_TICKETS) {
    let dropIdx = -1;
    let worstEv = Infinity;
    selected.forEach((c, i) => {
      if (c.startsWith("1-")) return;
      const ev = byCombo.get(c)?.conservative_ev ?? byCombo.get(c)?.expected_value ?? -1;
      if (ev < worstEv) { worstEv = ev; dropIdx = i; }
    });
    if (dropIdx < 0) break;
    selected.splice(dropIdx, 1);
  }

  const consensusCount = selected.filter((c) => (votes.get(c) || []).length >= 2).length;
  const engineCounts = { v61: 0, v62: 0, v63: 0, other: 0 };
  for (const c of selected) {
    const src = votes.get(c) || [];
    if (!src.length) { engineCounts.other += 1; continue; }
    for (const e of src) engineCounts[e] += 1;
  }

  return {
    selected,
    votes,
    consensusCount,
    engineCounts,
    boat1Active,
    boat1Covered,
    axisCount: new Set(selected.map((c) => Number(c.split("-")[0]))).size,
  };
}

// ============================================================
// セット指標
// ============================================================
function computeSetMetricsV64(selected, combos) {
  const rows = selected.map((c) => combos.find((t) => t.combination === c)).filter(Boolean);
  if (!rows.length) return null;

  const setProbability = rows.reduce((s, t) => s + num(t.probability), 0);
  const oddsRows = rows.filter((t) => t.actual_odds != null && t.actual_odds > 0);
  const oddsComplete = oddsRows.length === rows.length;
  const oddsValues = oddsRows.map((t) => t.actual_odds);

  const recovery = oddsComplete
    ? round1(rows.reduce((s, t) => s + num(t.probability) * t.actual_odds, 0) / rows.length)
    : null;
  // 最も慎重な確率で見積もった回収率(この値でBUYを判定する)
  const conservativeRecovery = oddsComplete
    ? round1(rows.reduce((s, t) => s + num(t.p_min) * t.actual_odds, 0) / rows.length)
    : null;

  return {
    set_probability: round2(setProbability),
    set_expected_recovery: recovery,
    conservative_recovery: conservativeRecovery,
    synthetic_odds: setProbability > 0 ? round1(10000 / setProbability) : null,
    investment: rows.length * 100,
    min_payout: oddsValues.length ? Math.round(Math.min(...oddsValues) * 100) : null,
    max_payout: oddsValues.length ? Math.round(Math.max(...oddsValues) * 100) : null,
    avg_payout: oddsValues.length ? Math.round((oddsValues.reduce((s, o) => s + o, 0) / oddsValues.length) * 100) : null,
    odds_complete: oddsComplete,
    best_ev_ticket: [...rows].sort((a, b) => num(b.conservative_ev, -1) - num(a.conservative_ev, -1))[0]?.combination || null,
  };
}

// ============================================================
// 判定
// ============================================================
function judgeV64({ stage, setMetrics, firstProbs, v61, v62, v63, selection, boat1Active }) {
  const sortedFirst = [...firstProbs].sort((a, b) => b - a);
  const firstConfidence = clamp(sortedFirst[0] + ((sortedFirst[0] - sortedFirst[1]) || 0) * 0.5, 0, 100);
  const setProb = setMetrics?.set_probability ?? 0;
  const conservative = setMetrics?.conservative_recovery;
  const investment = setMetrics?.investment || 0;
  const minPayout = setMetrics?.min_payout;

  const votes = { v61: v61?.final_judgment || null, v62: v62?.final_judgment || null, v63: v63?.final_judgment || null };
  const buyVotes = Object.values(votes).filter((v) => v === "BUY").length;
  const consensusOk = buyVotes >= 2 || (votes.v63 === "BUY" && buyVotes >= 1);
  const voteText = `V6.1(${votes.v61 || "—"})・V6.2(${votes.v62 || "—"})・V6.3(${votes.v63 || "—"})`;
  const scenarioKey = v63?.winning_scenario || v62?.winning_scenario || null;
  const blocked = BLOCKED_SCENARIOS.includes(scenarioKey);
  const boat1CoverageOk = !boat1Active || selection.boat1Covered === true;
  const payoutFloorOk = minPayout != null && investment > 0 && minPayout >= investment * MIN_PAYOUT_RATIO;

  if (stage === "FINAL") {
    if (buyVotes === 0) {
      return { judgment: "SKIP", reason: `V6.4 合議支持なし(3エンジンともBUY以外) — ${voteText}` };
    }
    if (!consensusOk) {
      return { judgment: "WATCH", reason: `V6.4 合議不成立(BUY ${buyVotes}/3) — ${voteText}` };
    }
    if (!boat1CoverageOk) {
      return { judgment: "WATCH", reason: `V6.4 1号艇カバー外 — ${voteText}` };
    }
    if (blocked) {
      return { judgment: "WATCH", reason: `V6.4 弱点シナリオ除外(${scenarioKey}) — ${voteText}` };
    }
    if (conservative == null) {
      return { judgment: "WATCH", reason: `V6.4 オッズ未取得(保守的期待値を算出できず) — ${voteText}` };
    }
    if (!payoutFloorOk) {
      return {
        judgment: "WATCH",
        reason: `V6.4 配当下限不足(最低払戻¥${minPayout != null ? Math.round(minPayout) : "—"} < 投資¥${investment}×${MIN_PAYOUT_RATIO}) — ${voteText}`,
      };
    }
    if (setProb < MIN_SET_PROBABILITY) {
      return { judgment: "SKIP", reason: `V6.4 セット${setProb}%は下限${MIN_SET_PROBABILITY}%未満 — ${voteText}` };
    }
    if (conservative < SET_RECOVERY_MIN) {
      return { judgment: "WATCH", reason: `V6.4 保守的回収${conservative}%<${SET_RECOVERY_MIN}% — ${voteText}` };
    }
    if (firstConfidence < MIN_FIRST_CONFIDENCE) {
      return { judgment: "WATCH", reason: `V6.4 1着信頼度${round1(firstConfidence)}<${MIN_FIRST_CONFIDENCE} — ${voteText}` };
    }
    return {
      judgment: "BUY",
      reason: `V6.4 BUY(合議${buyVotes}/3・保守的回収${conservative}%・セット${setProb}%・1着信頼度${round1(firstConfidence)}・最低払戻¥${Math.round(minPayout)}) — ${voteText}`,
    };
  }

  // PRE: オッズ未確定のため、合議成立とセット確率の帯で暫定判定する
  if (buyVotes === 0) {
    return { judgment: "SKIP", reason: `V6.4 PRE 合議支持なし — ${voteText}` };
  }
  if (!consensusOk) {
    return { judgment: "WATCH", reason: `V6.4 PRE 合議不成立(BUY ${buyVotes}/3) — ${voteText}` };
  }
  if (blocked) {
    return { judgment: "WATCH", reason: `V6.4 PRE 弱点シナリオ(${scenarioKey}) — ${voteText}` };
  }
  if (setProb < MIN_SET_PROBABILITY || setProb > PRE_MAX_SET_PROBABILITY) {
    return { judgment: "SKIP", reason: `V6.4 PRE セット${setProb}%が目標帯(${MIN_SET_PROBABILITY}〜${PRE_MAX_SET_PROBABILITY}%)外 — ${voteText}` };
  }
  if (!boat1CoverageOk || firstConfidence < MIN_FIRST_CONFIDENCE) {
    return { judgment: "WATCH", reason: `V6.4 PRE(セット${setProb}%・1着信頼度${round1(firstConfidence)}) — ${voteText}` };
  }
  return {
    judgment: "BUY",
    reason: `V6.4 PRE暫定BUY(合議${buyVotes}/3・セット${setProb}%・1着信頼度${round1(firstConfidence)}) — ${voteText}`,
  };
}

// ============================================================
// メイン: V6.4予想
// ============================================================
export function runPredictionV64(entries, race, settings, options = {}) {
  const stage = options.stage || "PRE";
  const oddsMap = options.oddsMap || {};

  // 1. 3エンジンを同じ入力で実行(それぞれのロジックは変更しない)
  const v61 = runPredictionV61(entries, race, settings, { stage, oddsMap });
  const v62 = runPredictionV62(entries, race, settings, { stage, oddsMap });
  const v63 = runPredictionV63(entries, race, settings, { stage, oddsMap });

  // 2. 120通りの合議確率
  const combos = buildCombos(v61, v62, v63);
  if (!combos.length) return { error: "NO_COMBINATIONS", v61, v62, v63 };

  const activeBoats = new Set(combos.flatMap((c) => c.combination.split("-").map(Number)));
  const boat1Active = activeBoats.has(1);

  // 3. 買い目
  const selection = selectTicketsV64(combos, v61, v62, v63, boat1Active);

  // 4. セット指標
  const setMetrics = computeSetMetricsV64(selection.selected, combos);

  // 5. 1着確率(合議後)
  const firstTotals = new Map();
  for (const c of combos) {
    const f = Number(c.combination.split("-")[0]);
    firstTotals.set(f, (firstTotals.get(f) || 0) + c.probability);
  }
  const firstRanking = [...firstTotals.entries()].sort((a, b) => b[1] - a[1]).map(([boat]) => boat);
  const firstProbs = firstRanking.map((b) => firstTotals.get(b));

  // 6. 判定
  const { judgment, reason } = judgeV64({
    stage, setMetrics, firstProbs, v61, v62, v63, selection, boat1Active,
  });

  const firstSorted = [...firstProbs].sort((a, b) => b - a);
  const firstConfidence = clamp(firstSorted[0] + ((firstSorted[0] - firstSorted[1]) || 0) * 0.5, 0, 100);
  const topCombo = combos[0];

  const secondRanking = [1, 2, 3, 4, 5, 6]
    .map((boat) => ({
      boat,
      score: combos.filter((c) => c.combination.split("-")[1] === String(boat)).reduce((s, c) => s + c.probability, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.boat);
  const thirdRanking = [1, 2, 3, 4, 5, 6]
    .map((boat) => ({
      boat,
      score: combos.filter((c) => c.combination.split("-")[2] === String(boat)).reduce((s, c) => s + c.probability, 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.boat);

  const boatScoreOf = (boat) => {
    const a = (v61?.boatScores || []).find((x) => Number(x.boat_number) === boat) || {};
    const b = (v63?.boatScores || []).find((x) => Number(x.boat_number) === boat) || {};
    return round1((num(a.final_score, num(a.pre_score, 50)) + num(b.final_score, num(b.pre_score, 50))) / 2);
  };

  return {
    boatScores: firstRanking.map((boat) => ({
      boat_number: boat,
      final_score: boatScoreOf(boat),
      first_probability: round2(firstTotals.get(boat) || 0),
      reasons: [],
      notes: [],
    })),
    trifectas: combos.map((c) => ({
      combination: c.combination,
      rank: c.rank,
      race_probability: c.probability,
      actual_odds: c.actual_odds,
      expected_value: c.expected_value,
      conservative_ev: c.conservative_ev,
      is_selected: selection.selected.includes(c.combination),
      ticket_rank: selection.selected.includes(c.combination) ? selection.selected.indexOf(c.combination) + 1 : null,
    })),
    selected_trifectas: selection.selected,
    ticket_count: selection.selected.length,
    ticket_strategy: `合議${selection.consensusCount}点 + 単独${selection.selected.length - selection.consensusCount}点`,
    expand_reason: `合議=2エンジン以上の一致 / 期待値は最も低い確率×オッズ / 配当下限=投資×${MIN_PAYOUT_RATIO}`,
    set_metrics: setMetrics,
    data_confidence: round1(
      [v61?.data_confidence, v62?.data_confidence, v63?.data_confidence]
        .filter((d) => Number.isFinite(Number(d)))
        .reduce((s, d, _, arr) => s + Number(d) / arr.length, 0)
    ),
    final_judgment: judgment,
    judgment_reason: reason,
    honmei_boat: firstRanking[0] || null,
    taiko_boat: firstRanking[1] || null,
    ana_boat: firstRanking[2] || null,
    keshi_boat: firstRanking[firstRanking.length - 1] || null,
    top_trifecta: topCombo?.combination || null,
    top_probability: topCombo?.probability ?? null,
    top_odds: topCombo?.actual_odds ?? null,
    top_expected_value: topCombo?.conservative_ev ?? null,
    first_ranking: firstRanking,
    second_ranking: secondRanking,
    third_ranking: thirdRanking,
    first_probability_gap: firstSorted.length > 1 ? round2(firstSorted[0] - firstSorted[1]) : null,
    first_confidence: round1(firstConfidence),
    escape_probability: v63?.escape_probability ?? v62?.escape_probability ?? null,
    winning_scenario: v63?.winning_scenario || v62?.winning_scenario || null,
    scenario_scores: v63?.scenario_scores || v62?.scenario_scores || [],
    v6_weights: V64_BLEND_WEIGHTS,
    factor_snapshot: {
      st: v63?.factor_snapshot?.st ?? null,
      exhibition: v63?.factor_snapshot?.exhibition ?? null,
      lane_past10: v63?.factor_snapshot?.lane_past10 ?? null,
      racer_power: v63?.factor_snapshot?.racer_power ?? null,
      section: v63?.factor_snapshot?.section ?? null,
      motor: v63?.factor_snapshot?.motor ?? null,
      course: v63?.factor_snapshot?.course ?? null,
      odds: v63?.factor_snapshot?.odds ?? null,
      scenario: null,
      escape_prob: v63?.escape_probability ?? null,
      first_confidence: round1(firstConfidence),
      set_probability: setMetrics?.set_probability ?? null,
      conservative_recovery: setMetrics?.conservative_recovery ?? null,
    },
    engine_votes: {
      v61: v61?.final_judgment || null,
      v62: v62?.final_judgment || null,
      v63: v63?.final_judgment || null,
      consensus_count: selection.consensusCount,
      boat1_covered: selection.boat1Covered,
    },
    ticket_votes: Object.fromEntries(selection.votes),
    axis_count: selection.axisCount,
    boat1_active: boat1Active,
    boat1_covered: selection.boat1Covered,
  };
}