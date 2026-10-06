// ============================================================
// V6 vs V6.1 比較検証サマリー
// PredictionV6Verification と PredictionV61Verification を期間別に集計
// 集計はサーバー側(aggregate)で行い、レコードを全件読み込まない
// ============================================================
import { base44 } from "@/api/base44Client";

const EMPTY_OUTCOME = { HIT_PROFIT: 0, HIT_LOW_VALUE: 0, MISS_FIRST: 0, MISS_SECOND: 0, MISS_THIRD: 0, MISS_OTHER: 0 };

function buildSide(judgmentRows, outcomeRows, prefix) {
  const counts = {};
  for (const row of judgmentRows || []) {
    const key = row[`${prefix}_final_judgment`];
    if (key) counts[key] = (counts[key] || 0) + (row.count || 0);
  }

  const outcome = { ...EMPTY_OUTCOME };
  let buyCount = 0, hits = 0, investment = 0, payout = 0;
  for (const row of outcomeRows || []) {
    const key = row.outcome_class || "MISS_OTHER";
    if (outcome[key] != null) outcome[key] += row.count || 0;
    buyCount += row.count || 0;
    if (key === "HIT_PROFIT" || key === "HIT_LOW_VALUE") hits += row.count || 0;
    investment += Number(row[`sum_${prefix}_investment`] || 0);
    payout += Number(row[`sum_${prefix}_payout`] || 0);
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
export async function getV6V61ComparisonSummary(periodDays = 30) {
  const periodQuery = periodDays
    ? {
        race_date: { $gte: new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10) },
        race_id: { $ne: "BACKTEST_SUMMARY_V6" },
      }
    : { race_id: { $ne: "BACKTEST_SUMMARY_V6" } };

  const empty = { rows: [] };
  const [v6Judgments, v6Outcome, v61Judgments, v61Outcome] = await Promise.all([
    base44.entities.PredictionV6Verification.aggregate({ query: periodQuery, groupBy: "v6_final_judgment", limit: 10 }).catch(() => empty),
    base44.entities.PredictionV6Verification.aggregate({
      query: { ...periodQuery, v6_final_judgment: "BUY" },
      groupBy: "outcome_class",
      sum: ["v6_payout", "v6_investment"],
      limit: 20,
    }).catch(() => empty),
    base44.entities.PredictionV61Verification.aggregate({ query: periodQuery, groupBy: "v61_final_judgment", limit: 10 }).catch(() => empty),
    base44.entities.PredictionV61Verification.aggregate({
      query: { ...periodQuery, v61_final_judgment: "BUY" },
      groupBy: "outcome_class",
      sum: ["v61_payout", "v61_investment"],
      limit: 20,
    }).catch(() => empty),
  ]);

  return {
    period_days: periodDays,
    v6: buildSide(v6Judgments?.rows, v6Outcome?.rows, "v6"),
    v61: buildSide(v61Judgments?.rows, v61Outcome?.rows, "v61"),
  };
}