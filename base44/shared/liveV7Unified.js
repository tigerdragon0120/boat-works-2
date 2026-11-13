// 統合V7(サーバー版)。ブラウザ版(src/liveV7/unified.js, researchCandidate.js)と同じ計算。
import { v7Trial, raceModel, womensTickets, policy, researchJudgment } from "./liveV7Engine.js";
import { extraEvidence } from "./liveV7Evidence.js";
import { timeMs } from "./liveV7Time.js";

export const UNIFIED_REVISION = "v7-unified-trial-2";
export const candidateRevision = "v7-research-conditional-v1";
export const ticketCounts = [4, 6, 8, 12];

const sum = (values) => values.reduce((a, b) => a + b, 0);

// 基準モデルの確率を条件付き分布ごとに再重み付けし、その条件 prefix の確率を保つ。
export function researchCandidate(snapshot, stage, baseline = v7Trial(snapshot, stage), extraLogit = () => 0) {
  if (baseline.status !== "READY") return baseline;
  const entries = new Map(snapshot.entries.map((row) => [row.boat_number, row]));
  const observed = timeMs(snapshot.as_of);
  const course = (boat) => (stage === "PRE" ? boat : entries.get(boat).exhibition_course);
  const start = (boat) => {
    const value = entries.get(boat).exhibition_st;
    const at = timeMs(snapshot.field_times?.[boat]?.exhibition_st ?? snapshot.captured_at);
    return stage === "FINAL" && snapshot.units?.exhibition_st === "seconds" &&
      at !== null && at <= observed && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  };
  const interaction = (boat, prefix) => {
    if (stage !== "FINAL" || prefix.length === 0) return 0;
    return sum(prefix.map((ahead) => {
      const proximity = 1 / (1 + Math.abs(course(boat) - course(ahead)));
      const a = start(ahead);
      const b = start(boat);
      return a === null || b === null ? 0 : proximity * Math.max(-0.1, Math.min(0.1, a - b));
    })) / prefix.length;
  };
  const groups = new Map();
  for (const row of baseline.combinations) {
    const boats = row.combination.split("-").map(Number);
    for (let depth = 0; depth < 3; depth++) {
      const key = boats.slice(0, depth).join("-");
      const group = groups.get(key) ?? new Map();
      group.set(boats[depth], (group.get(boats[depth]) ?? 0) + row.probability);
      groups.set(key, group);
    }
  }
  const conditionals = new Map();
  for (const [key, group] of groups) {
    const prefix = key ? key.split("-").map(Number) : [];
    const weighted = [...group].map(([boat, mass]) => [boat, mass ** (1 / 1.08) * Math.exp(interaction(boat, prefix) + extraLogit(boat, prefix.length))]);
    const total = sum(weighted.map(([, weight]) => weight));
    conditionals.set(key, new Map(weighted.map(([boat, weight]) => [
      boat, baseline.coverage * weight / total + (1 - baseline.coverage) / group.size,
    ])));
  }
  const combinations = baseline.combinations.map(({ combination }) => {
    const boats = combination.split("-").map(Number);
    return { combination, probability: boats.reduce((p, boat, i) => p * conditionals.get(boats.slice(0, i).join("-")).get(boat), 1) };
  });
  const total = sum(combinations.map((row) => row.probability));
  for (const row of combinations) row.probability /= total;
  combinations.sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination));
  const marginals = [{}, {}, {}];
  for (const row of combinations) {
    row.combination.split("-").forEach((boat, rank) => { marginals[rank][boat] = (marginals[rank][boat] ?? 0) + row.probability; });
  }
  const tickets = combinations.slice(0, 8).map((row) => row.combination);
  // 欠場艇を確率0の三連単として復活させない。5艇なら 5*4*3 = 60通り。
  const priced = tickets.every((key) => Number.isFinite(snapshot.oddsMap?.[key]) && snapshot.oddsMap[key] > 0);
  return {
    ...baseline, revision: candidateRevision, combinations, marginals, tickets,
    method: "UNTRAINED_PREFIX_INTERACTION_AND_COVERAGE_SHRINKAGE",
    expectedRecovery: stage === "FINAL" && priced
      ? sum(combinations.slice(0, tickets.length).map((row) => row.probability * snapshot.oddsMap[row.combination])) / tickets.length : null,
    judgment: "SKIP", judgment_reason: "独立研究候補。温度と相互作用は未学習・未校正", formal_eligible: false,
  };
}

export function unifiedV7(snapshot, stage) {
  const model = raceModel(snapshot.race);
  if (model === "UNKNOWN") return { status: "UNAVAILABLE", model, reason: "通常戦・女子戦の判別保留。レース区分を確認してください" };
  const baseline = v7Trial(snapshot, stage);
  const candidate = researchCandidate(snapshot, stage, baseline);
  if (candidate.status !== "READY") return candidate;
  const evidence = extraEvidence(snapshot, stage, model);
  const base = researchCandidate(snapshot, stage, baseline, evidence.logit);
  const womens = model === "WOMENS";
  const active = base.combinations.filter((row) => row.probability > 0);
  const shrink = womens ? (1 - base.coverage) * policy.WOMENS.missingShrink : 0;
  const combinations = base.combinations.map((row) => ({ ...row,
    probability: row.probability > 0 ? (1 - shrink) * row.probability + shrink / active.length : 0 }));
  const marginals = [{}, {}, {}];
  for (const row of combinations.filter((row) => row.probability > 0)) {
    row.combination.split("-").forEach((boat, rank) => {
      marginals[rank][boat] = (marginals[rank][boat] ?? 0) + row.probability;
    });
  }
  const oddsFailed = snapshot.data_quality?.rows?.some((row) => row.key === "odds" && row.failed);
  const price = (row) => snapshot.oddsMap?.[row.combination];
  const priced = (row) => stage === "FINAL" && !oddsFailed && Number.isFinite(price(row)) && price(row) > 0;
  const ranked = combinations.filter((row) => row.probability > 0);
  const oddsCoverage = ranked.filter(priced).length / ranked.length;
  const valueRanked = ranked.filter(priced).sort((a, b) => b.probability * price(b) - a.probability * price(a));
  const critical = !base.missing.some((reason) => /national_win_rate|exhibition_st|exhibition_time/.test(reason));
  const plans = (rows, diversify) => Object.fromEntries(ticketCounts.map((count) => {
    if (rows.length < Math.min(count, ranked.length)) return [count, null];
    const selected = diversify ? womensTickets(rows, count) : rows.slice(0, count);
    const plan = {
      tickets: selected.map((row) => row.combination),
      probability: sum(selected.map((row) => row.probability)),
      stake: selected.length * 100,
      oddsCoverage,
      expectedRecovery: selected.every(priced) ? sum(selected.map((row) => row.probability * price(row))) / selected.length : null,
      spread: [0, 1, 2].map((rank) => new Set(selected.map((row) => row.combination.split("-")[rank])).size),
    };
    return [count, { ...plan, judgment: researchJudgment(model, stage, base.coverage, critical, plan) }];
  }));
  const ticketPlans = plans(ranked, womens);
  const recoveryPlans = plans(valueRanked, false);
  const plan = ticketPlans[8];
  return {
    ...base, ...plan, model, revision: UNIFIED_REVISION, missing: [...base.missing, ...evidence.missing],
    judgment_reason: "試験判定。確率は未校正で、研究用BUYを購入推奨や既存判定に使いません",
    combinations, marginals, ticketPlans, recoveryPlans,
    references: { baseline: baseline.combinations, candidate: candidate.combinations },
    calibration: "UNVALIDATED", formal_eligible: false,
  };
}