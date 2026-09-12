import React, { useState, useEffect } from "react";
import { getV2VerificationSummary } from "@/lib/predictionService";
import { BarChart3, Target, Coins, TrendingUp, CheckCircle2, XCircle, GitCompare, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

const fmt = (n) => n != null ? n.toLocaleString() : "—";

export default function V1V2Comparison() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setSummary(await getV2VerificationSummary());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-center py-8 text-slate-400 text-sm">V1 vs V2 読み込み中…</div>;

  if (!summary || summary.total === 0) {
    return (
      <section className="bg-white rounded-2xl border border-slate-200 p-4">
        <div className="flex items-center gap-2 mb-3">
          <GitCompare className="w-5 h-5 text-indigo-500" />
          <div>
            <div className="text-[10px] font-bold text-slate-400">V1 vs V2 COMPARISON</div>
            <h3 className="font-bold text-slate-900">エンジン比較検証</h3>
          </div>
        </div>
        <div className="py-8 text-center text-sm text-slate-400">
          まだV1/V2並行検証のデータがありません。<br />結果が確定すると、V1とV2の的中率・回収率を比較できます。
        </div>
      </section>
    );
  }

  const { v1, v2, comparison } = summary;

  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <GitCompare className="w-5 h-5 text-indigo-500" />
          <div>
            <div className="text-[10px] font-bold text-slate-400">V1 vs V2 COMPARISON</div>
            <h3 className="font-bold text-slate-900">エンジン比較検証</h3>
          </div>
        </div>
        <div className="text-[10px] text-slate-400">確定結果 {summary.total}R</div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {/* V1 */}
        <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/50">
          <div className="text-[10px] font-bold text-slate-400 mb-2">V1 ENGINE</div>
          <div className="space-y-2">
            <MetricRow icon={Target} label="BUY数" value={v1.buy_count} unit="R" />
            <MetricRow icon={CheckCircle2} label="的中数" value={v1.buy_hits} unit="R" tone="text-emerald-600" />
            <MetricRow icon={BarChart3} label="的中率" value={v1.buy_hit_rate} unit="%" />
            <MetricRow icon={Coins} label="回収率" value={v1.buy_recovery_rate} unit="%" tone={v1.buy_recovery_rate >= 100 ? "text-emerald-600" : "text-rose-500"} />
          </div>
        </div>

        {/* V2 */}
        <div className="rounded-xl border border-indigo-200 p-3 bg-indigo-50/30">
          <div className="text-[10px] font-bold text-indigo-500 mb-2">V2 ENGINE</div>
          <div className="space-y-2">
            <MetricRow icon={Target} label="BUY数" value={v2.buy_count} unit="R" />
            <MetricRow icon={CheckCircle2} label="的中数" value={v2.buy_hits} unit="R" tone="text-emerald-600" />
            <MetricRow icon={BarChart3} label="的中率" value={v2.buy_hit_rate} unit="%" />
            <MetricRow icon={Coins} label="回収率" value={v2.buy_recovery_rate} unit="%" tone={v2.buy_recovery_rate >= 100 ? "text-emerald-600" : "text-rose-500"} />
          </div>
        </div>
      </div>

      {/* 改善差 */}
      <div className="rounded-xl bg-gradient-to-r from-slate-50 to-indigo-50 border border-slate-200 p-3 mb-4">
        <div className="text-[10px] font-bold text-slate-500 mb-2 flex items-center gap-1">
          <ArrowUpDown className="w-3 h-3" /> V2改善差
        </div>
        <div className="grid grid-cols-3 gap-2">
          <DiffCard label="的中率差" value={comparison.hit_rate_diff} unit="%" />
          <DiffCard label="回収率差" value={comparison.recovery_rate_diff} unit="%" />
          <DiffCard label="BUY数差" value={comparison.buy_count_diff} unit="R" />
        </div>
      </div>

      {/* チケット数別 */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <TicketCountTable title="V1 チケット別" data={{ 6: v1.tickets_6, 7: v1.tickets_7, 8: v1.tickets_8 }} />
        <TicketCountTable title="V2 チケット別" data={{ 6: v2.tickets_6, 7: v2.tickets_7, 8: v2.tickets_8 }} tone="indigo" />
      </div>

      {/* 外れ原因(V2) */}
      {v2.miss_reasons && Object.keys(v2.miss_reasons).length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/30 p-3">
          <div className="text-[10px] font-bold text-amber-600 mb-2">V2 外れ原因分析</div>
          <div className="space-y-1.5">
            {Object.entries(v2.miss_reasons)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-600">{missReasonLabel(reason)}</span>
                  <span className="font-bold text-slate-900">{count}件</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

function MetricRow({ icon: Icon, label, value, unit, tone = "text-slate-900" }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-slate-500 flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </span>
      <span className={cn("font-bold", tone)}>{value != null ? `${value}${unit}` : "—"}</span>
    </div>
  );
}

function DiffCard({ label, value, unit }) {
  const positive = value > 0;
  const negative = value < 0;
  return (
    <div className="text-center">
      <div className="text-[9px] text-slate-400 mb-0.5">{label}</div>
      <div className={cn("font-black text-sm", positive ? "text-emerald-600" : negative ? "text-rose-500" : "text-slate-500")}>
        {value > 0 ? "+" : ""}{value}{unit}
      </div>
    </div>
  );
}

function TicketCountTable({ title, data, tone = "slate" }) {
  return (
    <div className={cn("rounded-lg border p-2", tone === "indigo" ? "border-indigo-200 bg-indigo-50/20" : "border-slate-200 bg-slate-50/30")}>
      <div className="text-[9px] font-bold text-slate-400 mb-1.5">{title}</div>
      <div className="grid grid-cols-3 gap-1 text-center">
        {[6, 7, 8].map(n => (
          <div key={n}>
            <div className="text-[8px] text-slate-400">{n}点</div>
            <div className="text-[10px] font-bold text-slate-700">{data[n]?.count || 0}R</div>
            <div className={cn("text-[9px]", (data[n]?.hit_rate || 0) >= 50 ? "text-emerald-600" : "text-slate-500")}>
              {data[n]?.hit_rate || 0}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function missReasonLabel(reason) {
  const labels = {
    first_miss: "1着候補外れ",
    second_miss: "2着候補外れ",
    third_miss: "3着候補外れ",
    ticket_narrow: "買い目絞り込み外れ",
    entry_mismatch: "進入想定外れ",
    exhibition_over: "展示評価過大",
    exhibition_under: "展示評価不足",
    waku10_over: "WAKU10評価過大",
    waku10_under: "WAKU10評価不足",
    odds_exclusion: "オッズ条件による除外",
    other: "その他",
  };
  return labels[reason] || reason;
}