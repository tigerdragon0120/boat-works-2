import { v7Trial } from './engine.js';
import { researchCandidate } from './researchCandidate.js';
import { raceModel, womensTickets } from './womens.js';
import { extraEvidence } from './evidence.js';
import { policy, researchJudgment } from './policy.js';

export const UNIFIED_REVISION = 'v7-unified-trial-2';
export const ticketCounts = [4, 6, 8, 12];
const sum = values => values.reduce((a, b) => a + b, 0);

export function unifiedV7(snapshot, stage) {
  const model = raceModel(snapshot.race);
  if (model === 'UNKNOWN') return { status: 'UNAVAILABLE', model, reason: '通常戦・女子戦の判別保留。レース区分を確認してください' };
  const baseline = v7Trial(snapshot, stage);
  const candidate = researchCandidate(snapshot, stage, baseline);
  if (candidate.status !== 'READY') return candidate;
  const evidence = extraEvidence(snapshot, stage, model);
  const base = researchCandidate(snapshot, stage, baseline, evidence.logit);
  const womens = model === 'WOMENS';
  const active = base.combinations.filter(row => row.probability > 0);
  const shrink = womens ? (1-base.coverage)*policy.WOMENS.missingShrink : 0;
  const combinations = base.combinations.map(row => ({ ...row,
    probability: row.probability > 0 ? (1-shrink)*row.probability + shrink/active.length : 0 }));
  const marginals = [{}, {}, {}];
  for (const row of combinations.filter(row => row.probability > 0)) {
    row.combination.split('-').forEach((boat, rank) => {
      marginals[rank][boat] = (marginals[rank][boat] ?? 0) + row.probability;
    });
  }
  const oddsFailed = snapshot.data_quality?.rows?.some(row => row.key === 'odds' && row.failed);
  const price = row => snapshot.oddsMap?.[row.combination];
  const priced = row => stage === 'FINAL' && !oddsFailed && Number.isFinite(price(row)) && price(row) > 0;
  const ranked = combinations.filter(row => row.probability > 0);
  const oddsCoverage = ranked.filter(priced).length / ranked.length;
  const valueRanked = ranked.filter(priced).sort((a,b)=>b.probability*price(b)-a.probability*price(a));
  const critical = !base.missing.some(reason => /national_win_rate|exhibition_st|exhibition_time/.test(reason));
  const plans = (rows, diversify) => Object.fromEntries(ticketCounts.map(count => {
    if (rows.length < Math.min(count, ranked.length)) return [count, null];
    const selected = diversify ? womensTickets(rows, count) : rows.slice(0, count);
    const plan = { tickets: selected.map(row => row.combination), probability: sum(selected.map(row => row.probability)),
      stake: selected.length*100, oddsCoverage, expectedRecovery: selected.every(priced)
        ? sum(selected.map(row => row.probability * price(row))) / selected.length : null,
      spread: [0,1,2].map(rank=>new Set(selected.map(row=>row.combination.split('-')[rank])).size) };
    return [count, { ...plan, judgment: researchJudgment(model, stage, base.coverage, critical, plan) }];
  }));
  const ticketPlans = plans(ranked, womens);
  const recoveryPlans = plans(valueRanked, false);
  const plan = ticketPlans[8];
  return { ...base, ...plan, model, revision: UNIFIED_REVISION, missing:[...base.missing,...evidence.missing],
    judgment_reason: '試験判定。確率は未校正で、研究用BUYを購入推奨や既存判定に使いません',
    combinations, marginals, ticketPlans, recoveryPlans,
    references: { baseline: baseline.combinations, candidate: candidate.combinations },
    calibration: 'UNVALIDATED', formal_eligible: false };
}