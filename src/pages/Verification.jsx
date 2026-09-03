import React, { useState, useEffect } from "react";
import { getVerificationSummary } from "@/lib/predictionService";
import { BarChart3, Target, Coins, TrendingUp, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Verification() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getVerificationSummary().then((s) => { setSummary(s); setLoading(false); });
  }, []);

  if (loading) return <div className="text-center py-20 text-slate-400 text-sm">読み込み中…</div>;

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="w-5 h-5 text-sky-600" />
        <h1 className="text-xl font-display font-bold text-slate-900">検証</h1>
      </div>

      {!summary || summary.total === 0 ? (
        <div className="text-center py-20 text-slate-400 text-sm bg-white rounded-2xl border border-dashed border-slate-200">
          まだ検証対象レースがありません。<br />結果を登録すると自動で集計されます。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Stat icon={Target} label="対象レース" value={summary.total} unit="件" tone="text-slate-900" />
            <Stat icon={CheckCircle2} label="FINAL予想1位的中率" value={summary.final_hit_rate} unit="%" tone="text-sky-600" />
            <Stat icon={CheckCircle2} label="PRE予想1位的中率" value={summary.pre_hit_rate} unit="%" tone="text-blue-500" />
            <Stat icon={TrendingUp} label="推奨買い目的中率" value={summary.recommended_hit_rate} unit="%" tone="text-emerald-600" />
            <Stat icon={Coins} label="回収率" value={summary.recovery_rate} unit="%" tone={summary.recovery_rate >= 100 ? "text-emerald-600" : "text-rose-500"} />
          </div>

          <h2 className="font-display font-bold text-slate-900 mb-2 mt-5">レース別照合</h2>
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            {summary.records.map((v) => (
              <div key={v.id} className="px-3 py-3 border-b border-slate-50 last:border-0">
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-slate-900">{v.actual_result || "—"}</span>
                  <div className="flex items-center gap-1.5">
                    <HitTag hit={v.pre_hit} label="PRE" />
                    <HitTag hit={v.final_hit} label="FINAL" />
                    <HitTag hit={v.recommended_hit} label="BUY" />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1.5 text-[11px] text-slate-500">
                  <span>PRE {v.pre_prediction || "—"} → FINAL {v.final_prediction || "—"}</span>
                  <span>払戻 {v.payout != null ? `¥${v.payout}` : "—"} · 回収率{v.recovery_rate}%</span>
                </div>
                {v.miss_reason && (
                  <div className="mt-1.5 text-[11px] text-rose-500 flex items-center gap-1">
                    <XCircle className="w-3 h-3" /> {v.miss_reason}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, unit, tone }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={cn("font-display font-bold text-2xl mt-1", tone)}>{value}<span className="text-sm font-normal text-slate-400 ml-0.5">{unit}</span></div>
    </div>
  );
}

function HitTag({ hit, label }) {
  return (
    <span className={cn("px-1.5 h-5 rounded text-[10px] font-bold flex items-center gap-0.5", hit ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400")}>
      {hit ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {label}
    </span>
  );
}