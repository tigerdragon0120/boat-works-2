import React, { useState, useEffect } from "react";
import { getV6VerificationSummary } from "@/lib/predictionService";
import { Target, Coins, TrendingUp, CheckCircle2, XCircle, RefreshCw, TicketCheck, AlertTriangle, DollarSign, Percent } from "lucide-react";
import { cn } from "@/lib/utils";

export default function V4V6Comparison() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await getV6VerificationSummary());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-center py-8 text-slate-400 text-sm">V6集計中…</div>;
  if (!data || data.total === 0) {
    return (
      <div className="text-center py-8 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
        まだV6の検証データがありません。バックテストを実行すると集計が表示されます。
      </div>
    );
  }

  const outcome = data.outcome || {};
  const adoptionProgress = Math.min(100, Math.round((data.buy_count / 100) * 100));

  return (
    <div className="space-y-4">
      {/* 採用ステータス */}
      <div className={cn("rounded-xl border p-3 flex items-center gap-3", data.buy_count >= 100 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50")}>
        <div className={cn("w-10 h-10 rounded-full flex items-center justify-center text-white font-black", data.buy_count >= 100 ? "bg-emerald-500" : "bg-amber-500")}>
          {data.buy_count >= 100 ? "✓" : data.buy_count}
        </div>
        <div className="flex-1">
          <div className="text-xs font-bold text-slate-700">
            {data.buy_count >= 100 ? "V6採用判定OK — 比較評価可能" : `V6候補稼働中 — 採用まで残り${100 - data.buy_count}BUY`}
          </div>
          <div className="h-2 rounded-full bg-white/60 mt-1 overflow-hidden">
            <div className={cn("h-full rounded-full", data.buy_count >= 100 ? "bg-emerald-500" : "bg-amber-500")} style={{ width: `${adoptionProgress}%` }} />
          </div>
        </div>
        <button onClick={load} className="h-8 px-2 rounded-lg border border-slate-200 bg-white text-slate-600 text-[11px] font-bold flex items-center gap-1 hover:bg-slate-50"><RefreshCw className="w-3 h-3" />更新</button>
      </div>

      {/* 基本成績 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Target} label="BUY数" value={data.buy_count} unit="R" tone="text-slate-900" />
        <StatCard icon={CheckCircle2} label="的中数" value={data.hit_count} unit="R" tone="text-emerald-600" sub={`的中率 ${data.hit_rate}%`} />
        <StatCard icon={Coins} label="回収率" value={data.recovery_rate} unit="%" tone={data.recovery_rate >= 110 ? "text-emerald-600" : "text-rose-500"} sub={`投資¥${fmt(data.total_investment)}→払戻¥${fmt(data.total_return)}`} />
        <StatCard icon={TicketCheck} label="平均買い目" value={data.avg_ticket_count} unit="点" tone="text-slate-900" sub={`6:${data.tickets_6}・7:${data.tickets_7}・8:${data.tickets_8}`} />
      </div>

      {/* 判定別 */}
      <div className="grid grid-cols-3 gap-2">
        <CountCard label="BUY" value={data.buy_count} tone="bg-emerald-50 text-emerald-700 border-emerald-200" />
        <CountCard label="WATCH" value={data.watch_count} tone="bg-amber-50 text-amber-700 border-amber-200" />
        <CountCard label="SKIP" value={data.skip_count} tone="bg-slate-50 text-slate-600 border-slate-200" />
      </div>

      {/* チケット数別 */}
      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-2">チケット数別BUY成績</div>
        <div className="grid grid-cols-3 gap-2">
          <TicketStat n={6} data={data.tickets_detail?.[6]} />
          <TicketStat n={7} data={data.tickets_detail?.[7]} />
          <TicketStat n={8} data={data.tickets_detail?.[8]} />
        </div>
      </div>

      {/* outcome分類 */}
      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-2">的中・不的中分類(要因学習)</div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          <OutcomeCard label="HIT_PROFIT" value={outcome.HIT_PROFIT || 0} tone="bg-emerald-100 text-emerald-700 border-emerald-300" desc="的中+利益" />
          <OutcomeCard label="HIT_LOW_VALUE" value={outcome.HIT_LOW_VALUE || 0} tone="bg-sky-100 text-sky-700 border-sky-300" desc="的中+低配当" />
          <OutcomeCard label="MISS_FIRST" value={outcome.MISS_FIRST || 0} tone="bg-rose-100 text-rose-700 border-rose-300" desc="1着外れ" />
          <OutcomeCard label="MISS_SECOND" value={outcome.MISS_SECOND || 0} tone="bg-orange-100 text-orange-700 border-orange-300" desc="2着外れ" />
          <OutcomeCard label="MISS_THIRD" value={outcome.MISS_THIRD || 0} tone="bg-amber-100 text-amber-700 border-amber-300" desc="3着外れ" />
        </div>
      </div>

      {/* 要因学習接続 */}
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] font-bold text-indigo-600">FACTOR LEARNING</div>
            <div className="text-sm font-bold text-slate-800">予想時点の要因 → 確定結果</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-black text-indigo-600">{data.factor_link_rate}<span className="text-sm">%</span></div>
            <div className="text-[10px] text-slate-400">要因接続率 {data.factor_linked}/{data.buy_count}</div>
          </div>
        </div>
      </div>

      {/* データリーク確認 */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
        <span className="font-bold text-slate-600">データリーク:</span> V6エンジンは予想時点データ(出走表・展示・オッズ・選手プロファイル)のみ使用。結果は採点専用。
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, unit, tone, sub }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn("font-display font-black text-2xl mt-1", tone)}>{value}<span className="text-sm font-normal text-slate-400 ml-0.5">{unit}</span></div>
      {sub && <div className="text-[10px] text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function CountCard({ label, value, tone }) {
  return (
    <div className={cn("rounded-xl border p-3 text-center", tone)}>
      <div className="text-[10px] font-bold">{label}</div>
      <div className="text-2xl font-black mt-1">{value}</div>
    </div>
  );
}

function TicketStat({ n, data = {} }) {
  const good = (data.recovery_rate || 0) >= 110;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
      <div className="text-xs font-black text-slate-700">{n}点BUY</div>
      <div className="text-xl font-black text-slate-900 mt-1">{data.hit_rate || 0}<span className="text-xs text-slate-400">%</span></div>
      <div className="text-[9px] text-slate-400">的中 {data.hits || 0}/{data.count || 0}</div>
      <div className={cn("mt-1.5 text-[11px] font-bold", good ? "text-emerald-600" : "text-slate-500")}>回収 {data.recovery_rate || 0}%</div>
    </div>
  );
}

function OutcomeCard({ label, value, tone, desc }) {
  return (
    <div className={cn("rounded-xl border p-2.5 text-center", tone)}>
      <div className="text-[9px] font-bold leading-tight">{label.replace(/_/g, ' ')}</div>
      <div className="text-xl font-black mt-1">{value}</div>
      <div className="text-[9px] opacity-70 mt-0.5">{desc}</div>
    </div>
  );
}

function fmt(v) { return Number(v || 0).toLocaleString("ja-JP"); }