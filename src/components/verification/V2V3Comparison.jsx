import React, { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";
import { Target, TrendingUp, TrendingDown, Trophy, DollarSign, AlertCircle, CheckCircle2, XCircle } from "lucide-react";

// KPI目標値
const TARGET_HIT_RATE = 16;
const TARGET_RECOVERY_RATE = 100;

// 期間オプション
const PERIOD_OPTIONS = [
  { key: "50", label: "直近50 BUY" },
  { key: "100", label: "直近100 BUY" },
  { key: "300", label: "直近300 BUY" },
  { key: "all", label: "全期間" },
];

// V2/V3比較カード
export default function V2V3Comparison() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("100");

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke("getV3VerificationSummary", { period }).catch(() => null);
      if (res?.data) {
        setSummary(res.data);
      } else {
        // フォールバック: クライアントサイド集計
        const v2Verifs = await base44.entities.PredictionV2Verification.list('-verified_at', 500).catch(() => []);
        const v3Verifs = await base44.entities.PredictionV3Verification.list('-verified_at', 500).catch(() => []);
        const computed = computeSummaryClient(v2Verifs, v3Verifs, period);
        setSummary(computed);
      }
    } catch (e) {
      console.error("V2V3Comparison fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-6 h-6 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!summary) {
    return <div className="text-center text-slate-500 py-8 text-sm">検証データがありません</div>;
  }

  const { v2, v3 } = summary;

  return (
    <div className="space-y-4">
      {/* TARGET 16/100 ヘッダー */}
      <div className="bg-gradient-to-r from-blue-900 to-indigo-900 rounded-lg p-4 border border-blue-700">
        <div className="flex items-center gap-2 mb-2">
          <Target className="w-5 h-5 text-blue-400" />
          <h3 className="text-white font-bold text-base">TARGET 16 / 100</h3>
        </div>
        <p className="text-blue-200 text-xs">
          BUY的中率16%以上 かつ BUY回収率100%以上 を同時達成
        </p>
      </div>

      {/* 期間選択 */}
      <div className="flex gap-2 flex-wrap">
        {PERIOD_OPTIONS.map(opt => (
          <button
            key={opt.key}
            onClick={() => setPeriod(opt.key)}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition",
              period === opt.key
                ? "bg-blue-600 text-white"
                : "bg-slate-800 text-slate-400 hover:bg-slate-700"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* V2 vs V3 比較 */}
      <div className="grid grid-cols-2 gap-3">
        {/* V2カード */}
        <VersionCard
          label="V2 (基準)"
          data={v2}
          color="slate"
        />
        {/* V3カード */}
        <VersionCard
          label="V3 Candidate"
          data={v3}
          color="blue"
          isNew
        />
      </div>

      {/* 差分表示 */}
      <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
        <h4 className="text-slate-300 font-bold text-xs mb-2">V3 vs V2 改善差分</h4>
        <div className="grid grid-cols-2 gap-2">
          <DiffItem
            label="的中率"
            v2Val={v2?.hit_rate}
            v3Val={v3?.hit_rate}
            target={TARGET_HIT_RATE}
            unit="%"
            higherIsBetter
          />
          <DiffItem
            label="回収率"
            v2Val={v2?.recovery_rate}
            v3Val={v3?.recovery_rate}
            target={TARGET_RECOVERY_RATE}
            unit="%"
            higherIsBetter
          />
        </div>
      </div>

      {/* サンプル数 */}
      <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
        <div className="flex items-center gap-2 mb-2">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          <span className="text-slate-300 text-xs font-bold">サンプル数</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="text-slate-400">
            V2 BUY数: <span className="text-slate-200 font-bold">{v2?.buy_count || 0}</span>
          </div>
          <div className="text-slate-400">
            V3 BUY数: <span className="text-slate-200 font-bold">{v3?.buy_count || 0}</span>
          </div>
        </div>
        {(v3?.buy_count || 0) < 50 && (
          <p className="text-amber-400 text-[10px] mt-2">
            ※ V3サンプル数が50未満です。十分なサンプル蓄積後に正式評価してください。
          </p>
        )}
      </div>

      {/* 外れ原因ランキング(V3) */}
      {v3?.miss_reasons && v3.miss_reasons.length > 0 && (
        <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
          <h4 className="text-slate-300 font-bold text-xs mb-2">V3外れ原因TOP5</h4>
          <div className="space-y-1">
            {v3.miss_reasons.slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{i + 1}. {r.reason}</span>
                <span className="text-slate-200 font-mono">{r.count}件</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 勝ちパターン(V3) */}
      {v3?.win_patterns && v3.win_patterns.length > 0 && (
        <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
          <h4 className="text-slate-300 font-bold text-xs mb-2">V3勝ちパターン</h4>
          <div className="space-y-1">
            {v3.win_patterns.slice(0, 5).map((w, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-emerald-400">{w.pattern}</span>
                <span className="text-slate-200 font-mono">{w.count}件</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* レースタイプ分布(V3) */}
      {v3?.race_type_distribution && Object.keys(v3.race_type_distribution).length > 0 && (
        <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
          <h4 className="text-slate-300 font-bold text-xs mb-2">V3レースタイプ分布</h4>
          <div className="space-y-1">
            {Object.entries(v3.race_type_distribution).map(([type, count]) => (
              <div key={type} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{type}</span>
                <span className="text-slate-200 font-mono">{count}件</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// V2/V3個別カード
function VersionCard({ label, data, color, isNew }) {
  if (!data) {
    return (
      <div className="bg-slate-900 rounded-lg p-3 border border-slate-700">
        <div className="text-slate-500 text-xs font-bold mb-2">{label}</div>
        <div className="text-slate-600 text-xs">データなし</div>
      </div>
    );
  }

  const hitRate = data.hit_rate || 0;
  const recoveryRate = data.recovery_rate || 0;
  const hitAchieved = hitRate >= TARGET_HIT_RATE;
  const recoveryAchieved = recoveryRate >= TARGET_RECOVERY_RATE;

  return (
    <div className={cn(
      "rounded-lg p-3 border",
      color === "blue" ? "bg-blue-950/50 border-blue-700" : "bg-slate-900 border-slate-700"
    )}>
      <div className="flex items-center gap-1.5 mb-3">
        {isNew && <span className="bg-blue-600 text-white text-[9px] px-1.5 py-0.5 rounded font-bold">NEW</span>}
        <span className={cn("text-xs font-bold", color === "blue" ? "text-blue-300" : "text-slate-300")}>{label}</span>
      </div>

      {/* 的中率 */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-400 text-[10px]">BUY的中率</span>
          {hitAchieved
            ? <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            : <XCircle className="w-3 h-3 text-rose-400" />
          }
        </div>
        <div className="flex items-baseline gap-1">
          <span className={cn("font-bold text-lg", hitAchieved ? "text-emerald-400" : "text-slate-200")}>
            {hitRate.toFixed(1)}%
          </span>
          <span className="text-slate-500 text-[10px]">/ TARGET {TARGET_HIT_RATE}%</span>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-1.5 mt-1">
          <div
            className={cn("h-1.5 rounded-full transition-all", hitAchieved ? "bg-emerald-500" : "bg-amber-500")}
            style={{ width: `${Math.min(100, (hitRate / TARGET_HIT_RATE) * 100)}%` }}
          />
        </div>
      </div>

      {/* 回収率 */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-400 text-[10px]">BUY回収率</span>
          {recoveryAchieved
            ? <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            : <XCircle className="w-3 h-3 text-rose-400" />
          }
        </div>
        <div className="flex items-baseline gap-1">
          <span className={cn("font-bold text-lg", recoveryAchieved ? "text-emerald-400" : "text-slate-200")}>
            {recoveryRate.toFixed(1)}%
          </span>
          <span className="text-slate-500 text-[10px]">/ TARGET {TARGET_RECOVERY_RATE}%</span>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-1.5 mt-1">
          <div
            className={cn("h-1.5 rounded-full transition-all", recoveryAchieved ? "bg-emerald-500" : "bg-amber-500")}
            style={{ width: `${Math.min(100, (recoveryRate / TARGET_RECOVERY_RATE) * 100)}%` }}
          />
        </div>
      </div>

      {/* 詳細 */}
      <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-400 mt-2 pt-2 border-t border-slate-700">
        <div>BUY: <span className="text-slate-200 font-mono">{data.buy_count || 0}</span></div>
        <div>的中: <span className="text-slate-200 font-mono">{data.hit_count || 0}</span></div>
        <div>投資: <span className="text-slate-200 font-mono">{(data.investment || 0).toLocaleString()}円</span></div>
        <div>払戻: <span className="text-slate-200 font-mono">{(data.payout || 0).toLocaleString()}円</span></div>
      </div>
    </div>
  );
}

// 差分表示
function DiffItem({ label, v2Val, v3Val, target, unit, higherIsBetter }) {
  const v2 = v2Val || 0;
  const v3 = v3Val || 0;
  const diff = v3 - v2;
  const isPositive = higherIsBetter ? diff > 0 : diff < 0;

  return (
    <div className="bg-slate-800/50 rounded p-2">
      <div className="text-slate-400 text-[10px] mb-1">{label}</div>
      <div className="flex items-center gap-1">
        <span className="text-slate-300 text-xs font-mono">{v2.toFixed(1)}{unit}</span>
        <span className="text-slate-500">→</span>
        <span className={cn("text-xs font-mono font-bold", isPositive ? "text-emerald-400" : "text-rose-400")}>
          {v3.toFixed(1)}{unit}
        </span>
      </div>
      <div className={cn("text-[10px] font-mono", isPositive ? "text-emerald-400" : "text-rose-400")}>
        {diff > 0 ? "+" : ""}{diff.toFixed(1)}{unit}
      </div>
    </div>
  );
}

// ============================================================
// クライアントサイド集計(フォールバック)
// ============================================================
function computeSummaryClient(v2Verifs, v3Verifs, period) {
  const limit = period === "all" ? 9999 : parseInt(period);

  // V2集計(BUY判定のみ)
  const v2BuyRaces = (v2Verifs || [])
    .filter(v => v.v2_final_judgment === "BUY" && v.v2_recommended_hit != null)
    .slice(0, limit);
  const v2HitCount = v2BuyRaces.filter(v => v.v2_recommended_hit).length;
  const v2Investment = v2BuyRaces.reduce((s, v) => s + (v.v2_investment || 0), 0);
  const v2Payout = v2BuyRaces.reduce((s, v) => s + (v.v2_payout || 0), 0);
  const v2HitRate = v2BuyRaces.length > 0 ? (v2HitCount / v2BuyRaces.length) * 100 : 0;
  const v2Recovery = v2Investment > 0 ? (v2Payout / v2Investment) * 100 : 0;

  // V3集計(BUY判定のみ)
  const v3BuyRaces = (v3Verifs || [])
    .filter(v => v.v3_final_judgment === "BUY" && v.v3_recommended_hit != null)
    .slice(0, limit);
  const v3HitCount = v3BuyRaces.filter(v => v.v3_recommended_hit).length;
  const v3Investment = v3BuyRaces.reduce((s, v) => s + (v.v3_investment || 0), 0);
  const v3Payout = v3BuyRaces.reduce((s, v) => s + (v.v3_payout || 0), 0);
  const v3HitRate = v3BuyRaces.length > 0 ? (v3HitCount / v3BuyRaces.length) * 100 : 0;
  const v3Recovery = v3Investment > 0 ? (v3Payout / v3Investment) * 100 : 0;

  // V3外れ原因集計
  const v3MissRaces = v3BuyRaces.filter(v => !v.v3_recommended_hit);
  const missReasonMap = {};
  for (const v of v3MissRaces) {
    if (v.miss_reason_primary) {
      missReasonMap[v.miss_reason_primary] = (missReasonMap[v.miss_reason_primary] || 0) + 1;
    }
  }
  const missReasons = Object.entries(missReasonMap)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // V3勝ちパターン集計
  const v3HitRaces = v3BuyRaces.filter(v => v.v3_recommended_hit);
  const winPatternMap = {};
  for (const v of v3HitRaces) {
    if (v.win_pattern) {
      winPatternMap[v.win_pattern] = (winPatternMap[v.win_pattern] || 0) + 1;
    }
  }
  const winPatterns = Object.entries(winPatternMap)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  // V3レースタイプ分布
  const raceTypeMap = {};
  for (const v of v3BuyRaces) {
    if (v.v3_race_type) {
      raceTypeMap[v.v3_race_type] = (raceTypeMap[v.v3_race_type] || 0) + 1;
    }
  }

  return {
    v2: {
      buy_count: v2BuyRaces.length,
      hit_count: v2HitCount,
      hit_rate: v2HitRate,
      investment: v2Investment,
      payout: v2Payout,
      recovery_rate: v2Recovery,
    },
    v3: {
      buy_count: v3BuyRaces.length,
      hit_count: v3HitCount,
      hit_rate: v3HitRate,
      investment: v3Investment,
      payout: v3Payout,
      recovery_rate: v3Recovery,
      miss_reasons: missReasons,
      win_patterns: winPatterns,
      race_type_distribution: raceTypeMap,
    },
  };
}