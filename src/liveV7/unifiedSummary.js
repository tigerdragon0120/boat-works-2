import { summarizeLocal } from './controller.js';

export function summarizeUnified(controller, stage, model, count, mode = 'hit') {
  const valid = summarizeLocal(controller, stage).rows;
  const rankHits = [0, 0, 0];
  const judgments = { BUY: 0, WATCH: 0, SKIP: 0 };
  let forecast = 0, eligible = 0;
  const references = { baseline: { n: 0, hits: 0, stake: 0, payout: 0, unknown: false },
    candidate: { n: 0, hits: 0, stake: 0, payout: 0, unknown: false } };
  let n = 0, hits = 0, stake = 0, payout = 0, missingPayout = 0, brier = 0;
  for (const row of valid) {
    const { output, race_key, snapshot } = controller.records.get(row.id).payload;
    if (output.model !== model) continue;
    eligible++;
    const result = controller.resultHistory.get(race_key);
    const plan = (mode === 'hit' ? output.ticketPlans : output.recoveryPlans)?.[count];
    if (!plan) continue;
    judgments[plan.judgment]++;
    forecast += plan.probability;
    n++;
    row.rankHits.forEach((hit, i) => { rankHits[i] += Number(hit); });
    stake += 100 * plan.tickets.length;
    const hit = plan.tickets.includes(result.combination);
    brier += (plan.probability - Number(hit)) ** 2;
    for (const [name, stats] of Object.entries(references)) {
      const odds = snapshot.oddsMap;
      const rows = (output.references?.[name] ?? []).filter(x => x.probability > 0);
      const picks = (mode === 'hit' ? rows : rows.filter(x => Number.isFinite(odds?.[x.combination]) && odds[x.combination] > 0)
        .sort((a,b)=>b.probability*odds[b.combination]-a.probability*odds[a.combination])).slice(0, plan.tickets.length);
      if (picks.length !== plan.tickets.length) continue;
      stats.n++;
      stats.stake += 100*picks.length;
      if (picks.some(x=>x.combination===result.combination)) {
        stats.hits++;
        const amount = controller.resultEnrichment.get(race_key) ?? result.payout;
        if (amount == null) stats.unknown = true;
        else stats.payout += amount;
      }
    }
    if (!hit) continue;
    hits++;
    const amount = controller.resultEnrichment.get(race_key) ?? result.payout;
    if (amount == null) missingPayout++;
    else payout += amount;
  }
  return { eligible, judgments, references: Object.fromEntries(Object.entries(references).map(([key,r])=>[key,{
      n:r.n, hitRate:r.n?r.hits/r.n:null, recovery:r.stake&&!r.unknown?r.payout/r.stake:null,
    }])) , gap: n ? (forecast-hits)/n : null, n, hits, rankAccuracy: rankHits.map(h => n ? h / n : null), hitRate: n ? hits / n : null,
    stake: n ? stake : null, payout: n && !missingPayout ? payout : null,
    recovery: stake && !missingPayout ? payout / stake : null, brier: n ? brier / n : null };
}