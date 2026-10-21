// ============================================================
// V6.3 単体成績サマリー
// PredictionV63Verification を期間別に集計する
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
    investment += Number(row.sum_v63_investment || 0);
    payout += Number(row.sum_v63_payout || 0);
  }
  return { outcome, count, hits, investment, payout };
}

function buildSide(judgmentRows, buyOutcomeRows, watchOutcomeRows) {
  const counts = {};
  for (const row of judgmentRows || []) {
    const key = row.v63_final_judgment;
    if (key) counts[key] = (counts[key] || 0) + (row.count || 0);
  }

  const buy = sumOutcome(buyOutcomeRows);
  const watch = sumOutcome(watchOutcomeRows);
  // WATCHは実際には購入しないため、6点×100円を仮定した参考回収率を出す
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
    // BUYに至らなかったWATCHの参考成績(買っていたらどうだったか)
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
export async function getV63Summary(periodDays = 30) {
  const query = periodQuery(periodDays);
  const empty = { rows: [] };
  const [judgments, buyOutcome, watchOutcome, ticketRows, records] = await Promise.all([
    base44.entities.PredictionV63Verification.aggregate({ query, groupBy: "v63_final_judgment", limit: 10 }).catch(() => empty),
    base44.entities.PredictionV63Verification.aggregate({
      query: { ...query, v63_final_judgment: "BUY" },
      groupBy: "outcome_class",
      sum: ["v63_payout", "v63_investment"],
      limit: 20,
    }).catch(() => empty),
    base44.entities.PredictionV63Verification.aggregate({
      query: { ...query, v63_final_judgment: "WATCH" },
      groupBy: "outcome_class",
      sum: ["v63_payout", "v63_investment"],
      limit: 20,
    }).catch(() => empty),
    base44.entities.PredictionV63Verification.filter(
      { ...query, v63_final_judgment: "BUY" },
      { sort: "-verified_at", limit: 500, fields: ["v63_ticket_count", "v63_recommended_hit", "v63_investment", "v63_payout"] },
    ).catch(() => empty),
    base44.entities.PredictionV63Verification.filter(query, "-verified_at", 60).catch(() => []),
  ]);

  const side = buildSide(judgments?.rows, buyOutcome?.rows, watchOutcome?.rows);

  // 買い目点数別の成績は点数×判定を跨ぐため、対象レコードをJSで集計する
  const buyRows = Array.isArray(ticketRows) ? ticketRows : (ticketRows?.items || []);
  const ticketBuckets = new Map();
  for (const row of buyRows) {
    const tickets = Number(row.v63_ticket_count || 0);
    if (tickets < 6 || tickets > 8) continue;
    const bucket = ticketBuckets.get(tickets) || { tickets, count: 0, hits: 0, investment: 0, payout: 0 };
    bucket.count += 1;
    if (row.v63_recommended_hit) {
      bucket.hits += 1;
      bucket.payout += Number(row.v63_payout || 0);
    }
    bucket.investment += Number(row.v63_investment || 0);
    ticketBuckets.set(tickets, bucket);
  }
  const ticketRowsList = [...ticketBuckets.values()]
    .map((b) => ({
      ...b,
      hit_rate: b.count ? Math.round((b.hits / b.count) * 1000) / 10 : 0,
      recovery_rate: b.investment > 0 ? Math.round((b.payout / b.investment) * 100) : 0,
    }))
    .sort((a, b) => a.tickets - b.tickets);

  return {
    period_days: periodDays,
    ...side,
    ticket_rows: ticketRowsList,
    records: Array.isArray(records) ? records : (records?.items || []),
  };
}