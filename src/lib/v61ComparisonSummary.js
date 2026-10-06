// ============================================================
// V6.1 単体成績サマリー
// PredictionV61Verification を期間別に集計する(サーバー側aggregateで集計)
// V6はメインエンジンから外したため、V6.1の成績のみを扱う
// ============================================================
import { base44 } from "@/api/base44Client";

const EMPTY_OUTCOME = { HIT_PROFIT: 0, HIT_LOW_VALUE: 0, MISS_FIRST: 0, MISS_SECOND: 0, MISS_THIRD: 0, MISS_OTHER: 0 };

function buildSide(judgmentRows, outcomeRows) {
  const counts = {};
  for (const row of judgmentRows || []) {
    const key = row.v61_final_judgment;
    if (key) counts[key] = (counts[key] || 0) + (row.count || 0);
  }

  const outcome = { ...EMPTY_OUTCOME };
  let buyCount = 0, hits = 0, investment = 0, payout = 0;
  for (const row of outcomeRows || []) {
    const key = row.outcome_class || "MISS_OTHER";
    if (outcome[key] != null) outcome[key] += row.count || 0;
    buyCount += row.count || 0;
    if (key === "HIT_PROFIT" || key === "HIT_LOW_VALUE") hits += row.count || 0;
    investment += Number(row.sum_v61_investment || 0);
    payout += Number(row.sum_v61_payout || 0);
  }

  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    buy_count: counts.BUY || 0,
    watch_count: counts.WATCH || 0,
    skip_count: counts.SKIP || 0,
    hits,
    hit_rate: buyCount ? Math.round((hits / buyCount) * 1000) / 10 : 0,
    investment,
    payout,
    profit: payout - investment,
    recovery_rate: investment > 0 ? Math.round((payout / investment) * 100) : 0,
    outcome,
  };
}

// periodDays=0 は全期間
export async function getV61Summary(periodDays = 30) {
  const periodQuery = {
    race_id: { $ne: "BACKTEST_SUMMARY_V6" },
    ...(periodDays
      ? { race_date: { $gte: new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10) } }
      : {}),
  };

  const empty = { rows: [] };
  const [judgments, outcome] = await Promise.all([
    base44.entities.PredictionV61Verification.aggregate({ query: periodQuery, groupBy: "v61_final_judgment", limit: 10 }).catch(() => empty),
    base44.entities.PredictionV61Verification.aggregate({
      query: { ...periodQuery, v61_final_judgment: "BUY" },
      groupBy: "outcome_class",
      sum: ["v61_payout", "v61_investment"],
      limit: 20,
    }).catch(() => empty),
  ]);

  return { period_days: periodDays, ...buildSide(judgments?.rows, outcome?.rows) };
}