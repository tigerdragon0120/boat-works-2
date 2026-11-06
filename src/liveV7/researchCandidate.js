import { v7Trial } from './engine.js';
import { timeMs } from '../lib/uiReadGuard.js';

export const revision = 'v7-research-conditional-v1';
const sum = values => values.reduce((total, value) => total + value, 0);

// The baseline supplies validated probabilities. Reweight each conditional
// distribution separately, preserving the probability of its conditioning prefix.
export function researchCandidate(snapshot, stage, baseline = v7Trial(snapshot, stage), extraLogit = /** @type {(boat: number, rank: number) => number} */ (() => 0)) {
  if (baseline.status !== 'READY') return baseline;
  const entries = new Map(snapshot.entries.map(row => [row.boat_number, row]));
  const observed = timeMs(snapshot.as_of);
  const course = boat => stage === 'PRE' ? boat : entries.get(boat).exhibition_course;
  const start = boat => {
    const value = entries.get(boat).exhibition_st;
    const at = timeMs(snapshot.field_times?.[boat]?.exhibition_st ?? snapshot.captured_at);
    return stage === 'FINAL' && snapshot.units?.exhibition_st === 'seconds' &&
      at !== null && at <= observed && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  };
  const interaction = (boat, prefix) => {
    if (stage !== 'FINAL' || prefix.length === 0) return 0;
    return sum(prefix.map(ahead => {
      const proximity = 1 / (1 + Math.abs(course(boat) - course(ahead)));
      const a = start(ahead);
      const b = start(boat);
      return a === null || b === null ? 0 : proximity * Math.max(-0.10, Math.min(0.10, a - b));
    })) / prefix.length;
  };
  const groups = new Map();
  for (const row of baseline.combinations) {
    const boats = row.combination.split('-').map(Number);
    for (let depth = 0; depth < 3; depth++) {
      const key = boats.slice(0, depth).join('-');
      const group = groups.get(key) ?? new Map();
      group.set(boats[depth], (group.get(boats[depth]) ?? 0) + row.probability);
      groups.set(key, group);
    }
  }
  const conditionals = new Map();
  for (const [key, group] of groups) {
    const prefix = key ? key.split('-').map(Number) : [];
    const weighted = [...group].map(([boat, mass]) => [boat, mass ** (1 / 1.08) * Math.exp(interaction(boat, prefix) + extraLogit(boat, prefix.length))]);
    const total = sum(weighted.map(([, weight]) => weight));
    conditionals.set(key, new Map(weighted.map(([boat, weight]) => [
      boat, baseline.coverage * weight / total + (1 - baseline.coverage) / group.size,
    ])));
  }
  const combinations = baseline.combinations.map(({ combination }) => {
    const boats = combination.split('-').map(Number);
    return {
      combination,
      probability: boats.reduce((p, boat, i) => p * conditionals.get(boats.slice(0, i).join('-')).get(boat), 1),
    };
  });
  const total = sum(combinations.map(row => row.probability));
  for (const row of combinations) row.probability /= total;
  combinations.sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination));
  const marginals = [{}, {}, {}];
  for (const row of combinations) row.combination.split('-').forEach((boat, rank) => {
    marginals[rank][boat] = (marginals[rank][boat] ?? 0) + row.probability;
  });
  const tickets = combinations.slice(0, 8).map(row => row.combination);
  // Never reintroduce scratched boats as zero-probability trifectas.
  // Five active boats have exactly 5*4*3 = 60 valid combinations.
  const priced = tickets.every(key => Number.isFinite(snapshot.oddsMap?.[key]) && snapshot.oddsMap[key] > 0);
  return {
    ...baseline, revision, combinations, marginals, tickets,
    method: 'UNTRAINED_PREFIX_INTERACTION_AND_COVERAGE_SHRINKAGE',
    expectedRecovery: stage === 'FINAL' && priced
      ? sum(combinations.slice(0, tickets.length).map(row => row.probability * snapshot.oddsMap[row.combination])) / tickets.length : null,
    judgment: 'SKIP', judgment_reason: '独立研究候補。温度と相互作用は未学習・未校正',
    formal_eligible: false,
  };
}