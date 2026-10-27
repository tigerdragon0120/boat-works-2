// ============================================================
// V6.4 単体成績サマリー
// PredictionV64Verification を期間別に集計する
// ============================================================
import { base44 } from "@/api/base44Client";

const EMPTY_OUTCOME = { HIT_PROFIT: 0, HIT_LOW_VALUE: 0, MISS_FIRST: 0, MISS_SECOND: 0, MISS_THIRD: 0, MISS_OTHER: 0 };
const HIT_KEYS = ["HIT_PROFIT", "HIT_LOW_VALUE"];

function periodQuery(periodDays) {
  return periodDays
    ? { race_date: { $gte: new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10) } }
    : {};
}

function sumOutcome(rows) {
  const outcome = { ...EMPTY_OUTCOME };
  let count = 0, hits = 0, investment = 0, payout = 0;
  for (const row of rows || []) {
    const key = row.outcome_class || "MISS_OTHER";
    if (outcome[key] != null) outcome[key] += row.count || 0;
    count += row.count || 0;
    if (HIT_KEYS.includes(key)) hits += row.count || 0;
    investment += Number(row.sum_v64_investment || 0);
    payout += Number(row.sum_v64_payout || 0);
  }
  return { outcome, count, hits, investment, payout };
}

function buildSide(judgmentRows, buyOutcomeRows, watchOutcomeRows) {
  const counts = {};
  for (const row of judgmentRows || []) {
    const key = row.v64_final_judgment;
    if (key) counts[key] = (counts[key] || 0) + (row.count || 0);
  }

  const buy = sumOutcome(buyOutcomeRows);
  const watch = sumOutcome(watchOutcomeRows);
  const watchInvestment = watch.count * 600;

  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    buy_count: counts.BUY || 0,
    watch_count: counts.WATCH || 0,
    skip_count: counts.SKIP || 0,
    hits: buy.hits,
    hit_rate: buy.count ? Math.round((buy.hits / buy.count) * 1000) / 10 : 0,
    investment: buy.investment,
    payout: buy.payout,
    profit: buy.payout - buy.investment,
    recovery_rate: buy.investment > 0 ? Math.round((buy.payout / buy.investment) * 100) : 0,
    outcome: buy.outcome,
    watch: {
      count: watch.count,
      hits: watch.hits,
      hit_rate: watch.count ? Math.round((watch.hits / watch.count) * 1000) / 10 : 0,
      payout: watch.payout,
      recovery_rate: watchInvestment > 0 ? Math.round((watch.payout / watchInvestment) * 100) : 0,
    },
  };
}

// periodDays=0 は全期間
export async function getV64Summary(periodDays = 30) {
  const query = periodQuery(periodDays);
  const empty = { rows: [] };
  const [judgments, buyOutcome, watchOutcome, records] = await Promise.all([
    base44.entities.PredictionV64Verification.aggregate({ query, groupBy: "v64_final_judgment", limit: 10 }).catch(() => empty),
    base44.entities.PredictionV64Verification.aggregate({
      query: { ...query, v64_final_judgment: "BUY" },
      groupBy: "outcome_class",
      sum: ["v64_payout", "v64_investment"],
      limit: 20,
    }).catch(() => empty),
    base44.entities.PredictionV64Verification.aggregate({
      query: { ...query, v64_final_judgment: "WATCH" },
      groupBy: "outcome_class",
      sum: ["v64_payout", "v64_investment"],
      limit: 20,
    }).catch(() => empty),
    base44.entities.PredictionV64Verification.filter(query, "-verified_at", 60).catch(() => []),
  ]);

  const side = buildSide(judgments?.rows, buyOutcome?.rows, watchOutcome?.rows);

  return {
    period_days: periodDays,
    ...side,
    records: Array.isArray(records) ? records : (records?.items || []),
  };
}