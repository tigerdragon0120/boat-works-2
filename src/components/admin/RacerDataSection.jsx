import React, { useState, useEffect } from "react";
import { getRacerDataDashboard } from "@/lib/dataManagementService";
import { Users, Database, TrendingUp, Calendar, AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export default function RacerDataSection() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const d = await getRacerDataDashboard();
      setData(d);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!data) return <div className="text-center text-sm text-slate-500 py-8">データ取得失敗</div>;

  return (
    <div className="space-y-4">
      {/* サマリー */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={Users} label="RacerProfile" value={data.profile_count} color="sky" />
        <SummaryCard icon={Database} label="RacerTermStats" value={data.term_stats_count} color="emerald" />
        <SummaryCard icon={TrendingUp} label="RacerRollingStats" value={data.rolling_stats_count} color="purple" />
        <SummaryCard icon={Calendar} label="取込済期数" value={data.imported_term_count} color="amber" />
      </div>

      {/* 期間情報 */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-center">
        <div>
          <div className="text-xs text-slate-500">最古期</div>
          <div className="font-bold text-slate-800">{data.oldest_term || "—"}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">最新期</div>
          <div className="font-bold text-slate-800">{data.latest_term || "—"}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">直近取込日</div>
          <div className="font-bold text-slate-800 text-xs">{data.latest_import_at ? new Date(data.latest_import_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—"}</div>
        </div>
      </div>

      {/* 期別一覧 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-slate-700">期別取込状況</h3>
          <button onClick={load} className="text-xs text-sky-600 flex items-center gap-1 hover:text-sky-700">
            <RefreshCw className="w-3 h-3" /> 更新
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 max-h-96 overflow-y-auto p-1 bg-slate-50 rounded-lg">
          {data.term_status.map((t) => (
            <div
              key={t.term_key}
              className={cn(
                "rounded px-2 py-1.5 text-xs flex items-center justify-between",
                t.imported ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-400"
              )}
            >
              <span className="font-medium">{t.label}</span>
              {t.imported ? (
                <span className="flex items-center gap-0.5">
                  <CheckCircle2 className="w-3 h-3" />
                  <span className="text-[10px]">{t.count}</span>
                </span>
              ) : (
                <AlertCircle className="w-3 h-3" />
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-200" />取込済</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-slate-200" />未取込</span>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, color }) {
  const colorMap = {
    sky: "border-sky-200 bg-sky-50 text-sky-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    purple: "border-purple-200 bg-purple-50 text-purple-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
  };
  return (
    <div className={cn("rounded-xl border p-3", colorMap[color])}>
      <Icon className="w-4 h-4 mb-1" />
      <div className="text-xl font-bold">{value ?? 0}</div>
      <div className="text-[10px] opacity-70">{label}</div>
    </div>
  );
}