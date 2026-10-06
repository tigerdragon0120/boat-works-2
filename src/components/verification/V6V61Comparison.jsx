import React, { useState, useEffect } from "react";
import { getV6V61ComparisonSummary } from "@/lib/v61ComparisonSummary";
import { Target, Coins, CheckCircle2, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const PERIODS = [
  { days: 7, label: "直近7日" },
  { days: 30, label: "直近30日" },
  { days: 0, label: "全期間" },
];

export default function V6V61Comparison() {
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await getV6V61ComparisonSummary(period);
        if (alive) setData(res);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [period]);

  const v6 = data?.v6;
  const v61 = data?.v61;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setPeriod(p.days)}
              className={cn("px-3 h-8 rounded-lg text-[11px] font-bold border", period === p.days ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-500 border-slate-200 hover:text-slate-800")}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-slate-400">確定結果と照合済みの検証レコードから集計</div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-slate-400 text-sm">V6 / V6.1 集計中…</div>
      ) : !v61?.total ? (
        <div className="text-center py-8 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
          この期間のV6.1検証データがありません。
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <VersionCard title="V6 PROFIT" tone="violet" data={v6} />
            <VersionCard title="V6.1 PROFIT" tone="fuchsia" data={v61} />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <DiffCard label="的中率 差" value={v61.hit_rate - (v6?.hit_rate || 0)} unit="pt" />
            <DiffCard label="回収率 差" value={v61.recovery_rate - (v6?.recovery_rate || 0)} unit="pt" />
            <DiffCard label="利益 差" value={v61.profit - (v6?.profit || 0)} unit="円" money />
          </div>

          <div>
            <div className="text-[11px] font-bold text-slate-500 mb-2">V6.1 BUY的中・不的中の内訳</div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              <OutcomeCard label="HIT_PROFIT" value={v61.outcome.HIT_PROFIT} tone="bg-emerald-100 text-emerald-700 border-emerald-300" desc="的中+利益" />
              <OutcomeCard label="HIT_LOW_VALUE" value={v61.outcome.HIT_LOW_VALUE} tone="bg-sky-100 text-sky-700 border-sky-300" desc="的中+低配当" />
              <OutcomeCard label="MISS_FIRST" value={v61.outcome.MISS_FIRST} tone="bg-rose-100 text-rose-700 border-rose-300" desc="1着外れ" />
              <OutcomeCard label="MISS_SECOND" value={v61.outcome.MISS_SECOND} tone="bg-orange-100 text-orange-700 border-orange-300" desc="2着外れ" />
              <OutcomeCard label="MISS_THIRD" value={v61.outcome.MISS_THIRD} tone="bg-amber-100 text-amber-700 border-amber-300" desc="3着外れ" />
              <OutcomeCard label="MISS_OTHER" value={v61.outcome.MISS_OTHER} tone="bg-slate-100 text-slate-600 border-slate-300" desc="買い目枠外" />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500 leading-relaxed">
            <span className="font-bold text-slate-600">判定:</span> V6.1は回収率110%以上を要求する利益型。
            BUY数が増えない期間は、期待値基準を満たすレースが少ないことを意味します。
            <br />
            <span className="font-bold text-slate-600">弱点シナリオ除外:</span> 2まくり・4まくり・4まくり差しはWATCHでシャドー検証を継続します。
          </div>
        </>
      )}
    </div>
  );
}

function VersionCard({ title, tone, data }) {
  const styles = tone === "fuchsia"
    ? "border-fuchsia-200 bg-fuchsia-50/50"
    : "border-violet-200 bg-violet-50/50";
  const accent = tone === "fuchsia" ? "text-fuchsia-700" : "text-violet-700";
  if (!data) return <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-[11px] text-slate-400">データなし</div>;
  const d = data;
  return (
    <div className={cn("rounded-xl border p-3.5", styles)}>
      <div className="flex items-center justify-between">
        <div className={cn("text-xs font-black", accent)}>{title}</div>
        <div className="text-[10px] text-slate-400">検証 {fmt(d.total)}R</div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3">
        <Mini icon={Target} label="BUY" value={d.buy_count} unit="R" />
        <Mini icon={CheckCircle2} label="的中率" value={d.hit_rate} unit="%" />
        <Mini icon={Coins} label="回収率" value={d.recovery_rate} unit="%" tone={d.recovery_rate >= 110 ? "text-emerald-600" : "text-rose-500"} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span>的中 {d.hits}R</span>
        <span>投資 ¥{fmt(d.investment)}</span>
        <span>払戻 ¥{fmt(d.payout)}</span>
        <span className={cn("font-bold", d.profit > 0 ? "text-emerald-600" : "text-rose-500")}>
          利益 {d.profit > 0 ? "+" : ""}¥{fmt(d.profit)}
        </span>
        <span>WATCH {d.watch_count} / SKIP {d.skip_count}</span>
      </div>
    </div>
  );
}

function Mini({ icon: Icon, label, value, unit, tone = "text-slate-900" }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 py-1.5 text-center">
      <div className="flex items-center justify-center gap-1 text-[9px] text-slate-400"><Icon className="w-3 h-3" />{label}</div>
      <div className={cn("text-lg font-black mt-0.5", tone)}>{value}<span className="text-[10px] font-normal text-slate-400 ml-0.5">{unit}</span></div>
    </div>
  );
}

function DiffCard({ label, value, unit, money }) {
  const positive = value > 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5 text-center">
      <div className="flex items-center justify-center gap-1 text-[10px] text-slate-400"><TrendingUp className="w-3 h-3" />{label}</div>
      <div className={cn("text-lg font-black mt-0.5", positive ? "text-emerald-600" : value < 0 ? "text-rose-500" : "text-slate-500")}>
        {positive ? "+" : ""}{money ? fmt(value) : value}
        <span className="text-[10px] font-normal text-slate-400 ml-0.5">{unit}</span>
      </div>
    </div>
  );
}

function OutcomeCard({ label, value, tone, desc }) {
  return (
    <div className={cn("rounded-xl border p-2.5 text-center", tone)}>
      <div className="text-[9px] font-bold leading-tight">{label.replace(/_/g, " ")}</div>
      <div className="text-xl font-black mt-1">{value}</div>
      <div className="text-[9px] opacity-70 mt-0.5">{desc}</div>
    </div>
  );
}

function fmt(v) { return Number(v || 0).toLocaleString("ja-JP"); }