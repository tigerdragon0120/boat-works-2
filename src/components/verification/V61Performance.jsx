import React, { useState, useEffect } from "react";
import { getV61Summary } from "@/lib/v61ComparisonSummary";
import { Target, Coins, CheckCircle2, RefreshCw, DollarSign, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const PERIODS = [
  { label: "7日", value: 7 },
  { label: "30日", value: 30 },
  { label: "90日", value: 90 },
  { label: "全期間", value: 0 },
];

const OUTCOME_CARDS = [
  { key: "HIT_PROFIT", desc: "的中+利益", tone: "bg-emerald-100 text-emerald-700 border-emerald-300" },
  { key: "HIT_LOW_VALUE", desc: "的中+低配当", tone: "bg-sky-100 text-sky-700 border-sky-300" },
  { key: "MISS_FIRST", desc: "1着外れ", tone: "bg-rose-100 text-rose-700 border-rose-300" },
  { key: "MISS_SECOND", desc: "2着外れ", tone: "bg-orange-100 text-orange-700 border-orange-300" },
  { key: "MISS_THIRD", desc: "3着外れ", tone: "bg-amber-100 text-amber-700 border-amber-300" },
  { key: "MISS_OTHER", desc: "その他", tone: "bg-slate-100 text-slate-600 border-slate-300" },
];

export default function V61Performance() {
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await getV61Summary(period));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [period]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                "h-8 px-3 rounded-lg text-[11px] font-bold border transition-colors",
                period === p.value ? "bg-fuchsia-600 text-white border-fuchsia-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-slate-600 text-[11px] font-bold flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />更新
        </button>
      </div>

      {loading && !data ? (
        <div className="text-center py-8 text-slate-400 text-sm">V6.1成績を集計中…</div>
      ) : !data || (data.total === 0 && data.buy_count === 0) ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          この期間のV6.1検証データがありません。
          <br />
          <span className="text-[11px]">結果が確定したレースから自動で集計されます。</span>
        </div>
      ) : (
        <>
          <div className="text-[11px] text-slate-400">
            検証済み {data.total}R・BUY {data.buy_count}R（WATCH {data.watch_count}R / SKIP {data.skip_count}R）
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat icon={Target} label="BUY数" value={data.buy_count} unit="R" tone="text-fuchsia-600" />
            <Stat icon={CheckCircle2} label="的中数" value={data.hits} unit="R" tone="text-emerald-600" sub={`的中率 ${data.hit_rate}%`} />
            <Stat
              icon={Coins}
              label="回収率"
              value={data.recovery_rate}
              unit="%"
              tone={data.recovery_rate >= 110 ? "text-emerald-600" : "text-rose-500"}
              sub={`投資¥${fmt(data.investment)} → 払戻¥${fmt(data.payout)}`}
            />
            <Stat icon={DollarSign} label="利益額" value={fmt(data.profit)} unit="円" tone={data.profit > 0 ? "text-emerald-600" : "text-rose-500"} />
          </div>

          <div>
            <div className="text-[11px] font-bold text-slate-500 mb-2">的中・不的中の内訳</div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              {OUTCOME_CARDS.map((c) => (
                <div key={c.key} className={cn("rounded-xl border p-2.5 text-center", c.tone)}>
                  <div className="text-[9px] font-bold leading-tight">{c.key.replace(/_/g, " ")}</div>
                  <div className="text-xl font-black mt-1">{data.outcome?.[c.key] || 0}</div>
                  <div className="text-[9px] opacity-70 mt-0.5">{c.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {data.recovery_rate < 110 && data.buy_count > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <div className="text-[11px] text-amber-700 font-medium">
                目標110%まであと{Math.max(0, 110 - data.recovery_rate).toFixed(1)}pt。サンプルが増えるほど精度が上がります。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, unit, tone, sub }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn("font-display font-black text-2xl mt-1", tone)}>{value}<span className="text-sm font-normal text-slate-400 ml-0.5">{unit}</span></div>
      {sub && <div className="text-[10px] text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function fmt(v) { return Number(v || 0).toLocaleString("ja-JP"); }