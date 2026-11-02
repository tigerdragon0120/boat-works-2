import React, { useState, useEffect } from "react";
import { getV65WinProbability } from "@/lib/v65WinProbability";
import { Target, Percent, TrendingUp, RefreshCw, Scale, CalendarDays, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

const PERIODS = [
  { label: "30日", value: 30 },
  { label: "90日", value: 90 },
  { label: "全期間", value: 0 },
];

const VENUE_NAMES = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川", "06": "浜名湖",
  "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国", "11": "びわこ", "12": "住之江",
  "13": "尼崎", "14": "鳴門", "15": "丸亀", "16": "児島", "17": "宮島", "18": "徳山",
  "19": "下関", "20": "若松", "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
};

const venueName = (code) => VENUE_NAMES[String(code || "").padStart(2, "0")] || (code ? `場${code}` : "—");

export default function V65WinProbability() {
  const [period, setPeriod] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setData(await getV65WinProbability(period));
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
                "h-8 px-3 rounded-lg text-[11px] font-bold border",
                period === p.value ? "bg-rose-600 text-white border-rose-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
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
        <div className="text-center py-8 text-slate-400 text-sm">V6.5の予想と結果を照合中…</div>
      ) : !data ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          勝率を推計できませんでした。しばらくしてから更新してください。
        </div>
      ) : (
        <>
          {data.total > 0 ? (
            <V65ResultComparison data={data} />
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">
              この期間に照合できるV6.5の確定レースがまだありません。
              <br />
              <span className="text-[11px]">女子戦の結果が確定すると、予想との比較から勝率を自動推計します。下は現在の予想からの推計です。</span>
            </div>
          )}
          <V65PendingEstimates pending={data.pending} />
        </>
      )}
    </div>
  );
}

function V65ResultComparison({ data }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={Target} label="照合レース" value={data.total} unit="R" tone="text-slate-900" sub={`BUY ${data.buy.count}R / WATCH ${data.watch.count}R`} />
        <Stat icon={Percent} label="BUY実測勝率" value={data.buy.measured_rate ?? "—"} unit="%" tone="text-emerald-600" sub={`的中 ${data.buy.hits}/${data.buy.count}R`} />
        <Stat icon={TrendingUp} label="予想勝率(平均)" value={data.buy.avg_predicted ?? "—"} unit="%" tone="text-slate-900" sub="保存時に見込んだセット的中率" />
        <Stat
          icon={Scale}
          label="較正倍率"
          value={data.buy.calibration ?? "—"}
          unit="倍"
          tone={(data.buy.calibration || 0) >= 1 ? "text-emerald-600" : "text-rose-500"}
          sub={(data.buy.calibration || 0) >= 1 ? "予想より実際に当たっている" : "予想より実際は当たっていない"}
        />
      </div>

      <BandTable bands={data.bands} sampleWarning={data.sample_warning} />

      <div className="grid sm:grid-cols-3 gap-2">
        <JudgmentCard label="BUY" data={data.buy} tone="bg-rose-50 border-rose-200 text-rose-700" />
        <JudgmentCard label="WATCH" data={data.watch} tone="bg-amber-50 border-amber-200 text-amber-700" />
        <JudgmentCard label="SKIP" data={data.skip} tone="bg-slate-50 border-slate-200 text-slate-600" />
      </div>

      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-2">予想と結果の比較（新しい順）</div>
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          {data.recent.map((r) => (
            <div key={r.id} className={cn("px-3 py-2.5 border-b border-slate-100 last:border-0", r.hit ? "bg-emerald-50/40" : "bg-white")}>
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold text-slate-600">
                <span>{String(r.race_date || "").replace(/-/g, "/")}</span>
                <span>{venueName(r.venue_code)} {r.race_number ? `${r.race_number}R` : ""}</span>
                {r.judgment && (
                  <span className={cn("px-1.5 py-0.5 rounded-md", r.judgment === "BUY" ? "bg-rose-100 text-rose-700" : r.judgment === "WATCH" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500")}>
                    {r.judgment}
                  </span>
                )}
                <span className={cn("px-1.5 py-0.5 rounded-md", r.hit ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-600")}>
                  {r.hit ? "的中" : "不的中"}
                </span>
                <span className="ml-auto font-mono">
                  予想 {r.predicted || "—"} <span className="text-slate-300 mx-1">→</span> 結果 {r.actual || "—"}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-500">
                <span>予想勝率 {r.set_probability != null ? `${r.set_probability}%` : "—"}</span>
                <span>買い目 {r.ticket_count || 0}点</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function BandTable({ bands, sampleWarning }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-slate-500 mb-2">予想確率帯ごとの実測勝率（帯ごとの当たりやすさ）</div>
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-slate-50 text-slate-400">
              <th className="py-2 px-3 text-left font-bold">予想確率帯</th>
              <th className="py-2 px-2 text-right font-bold">予想</th>
              <th className="py-2 px-2 text-right font-bold">実測勝率</th>
              <th className="py-2 px-2 text-right font-bold">差</th>
              <th className="py-2 px-3 text-right font-bold">サンプル</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.key} className="border-t border-slate-100">
                <td className="py-2 px-3 font-bold text-slate-700">{b.label}</td>
                <td className="py-2 px-2 text-right text-slate-500">{b.avg_predicted != null ? `${b.avg_predicted}%` : "—"}</td>
                <td className={cn("py-2 px-2 text-right font-black", b.measured_rate == null ? "text-slate-300" : b.measured_rate >= (b.avg_predicted || 0) ? "text-emerald-600" : "text-rose-500")}>
                  {b.measured_rate != null ? `${b.measured_rate}%` : "—"}
                </td>
                <td className={cn("py-2 px-2 text-right font-bold", (b.gap || 0) >= 0 ? "text-emerald-600" : "text-rose-500")}>
                  {b.gap != null ? `${b.gap > 0 ? "+" : ""}${b.gap}pt` : "—"}
                </td>
                <td className="py-2 px-3 text-right text-slate-400">
                  {b.count}R{b.reliable ? "" : "（少）"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sampleWarning && (
        <div className="mt-2 text-[10px] text-amber-600">照合レースが30R未満です。サンプルが増えるほど推計勝率の精度が上がります。</div>
      )}
    </div>
  );
}

function V65PendingEstimates({ pending }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-slate-500 mb-2">結果待ちレースの推計勝率（帯の実測勝率から算出）</div>
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        {pending.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-slate-400">推計できる結果待ちのV6.5予想はありません。</div>
        ) : (
          pending.map((p) => (
            <div key={p.id} className="px-3 py-2.5 border-b border-slate-100 last:border-0">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-slate-600">
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5">
                  <CalendarDays className="w-3 h-3 text-sky-600" />{String(p.race_date || "").replace(/-/g, "/")}
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5">
                  <MapPin className="w-3 h-3 text-indigo-600" />{venueName(p.venue_code)}
                </span>
                <span className="rounded-md bg-slate-900 px-1.5 py-0.5 font-black text-white">{p.race_number ? `${p.race_number}R` : "R不明"}</span>
                <span className={cn("px-1.5 py-0.5 rounded-md font-black", p.judgment === "BUY" ? "bg-rose-100 text-rose-700" : p.judgment === "WATCH" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500")}>
                  {p.judgment || "未判定"}
                </span>
                <span className="ml-auto text-slate-900">
                  推計勝率 <b className={cn("text-sm", (p.estimated_rate || 0) >= (p.set_probability || 0) ? "text-emerald-600" : "text-rose-500")}>{p.estimated_rate ?? "—"}%</b>
                  <span className="ml-1 text-[9px] font-normal text-slate-400">({p.estimate_source})</span>
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
                <span>予想勝率 {p.set_probability != null ? `${p.set_probability}%` : "—"}</span>
                <span>買い目 {p.ticket_count || 0}点: {(p.selected_trifectas || []).join(" / ") || p.top_trifecta || "—"}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function JudgmentCard({ label, data, tone }) {
  return (
    <div className={cn("rounded-xl border p-3", tone)}>
      <div className="flex items-center justify-between text-[10px] font-black">
        <span>{label}</span>
        <span>{data.count}R</span>
      </div>
      <div className="mt-1 text-xl font-black">{data.measured_rate != null ? `${data.measured_rate}%` : "—"}</div>
      <div className="text-[9px] opacity-80">実測勝率（的中 {data.hits}R）</div>
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