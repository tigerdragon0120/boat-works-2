import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { getV63Summary } from "@/lib/v63ComparisonSummary";
import { Target, Coins, CheckCircle2, RefreshCw, DollarSign, AlertTriangle, Layers, PlayCircle, CalendarDays, MapPin } from "lucide-react";
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

const VENUE_NAMES = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川", "06": "浜名湖",
  "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国", "11": "びわこ", "12": "住之江",
  "13": "尼崎", "14": "鳴門", "15": "丸亀", "16": "児島", "17": "宮島", "18": "徳山",
  "19": "下関", "20": "若松", "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
};

export default function V63Performance() {
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setData(await getV63Summary(period));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [period]);

  const runVerify = async () => {
    setVerifying(true);
    try {
      const res = await base44.functions.invoke("verifyV63Daily", {});
      setVerifyResult(res?.data || res);
      await load();
    } finally {
      setVerifying(false);
    }
  };

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
                period === p.value ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runVerify}
            disabled={verifying}
            className="h-8 px-3 rounded-lg bg-indigo-600 text-white text-[11px] font-bold flex items-center gap-1.5 hover:bg-indigo-700 disabled:opacity-50"
          >
            <PlayCircle className={cn("w-3.5 h-3.5", verifying && "animate-pulse")} />
            {verifying ? "検証中…" : "結果を取り込む"}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="h-8 px-3 rounded-lg border border-slate-200 bg-white text-slate-600 text-[11px] font-bold flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />更新
          </button>
        </div>
      </div>

      {verifyResult && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] text-indigo-700 font-medium">
          検証完了：対象{verifyResult.races || 0}R・新規検証{verifyResult.verified || 0}R・既検証{verifyResult.skipped_already || 0}R・
          結果待ち{verifyResult.skipped_no_result || 0}R
        </div>
      )}

      {loading && !data ? (
        <div className="text-center py-8 text-slate-400 text-sm">V6.3成績を集計中…</div>
      ) : !data || (data.total === 0 && data.buy_count === 0) ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          この期間のV6.3検証データがありません。
          <br />
          <span className="text-[11px]">結果が確定したレースから自動集計されます。「結果を取り込む」で直近分を即時照合できます。</span>
        </div>
      ) : (
        <>
          <div className="text-[11px] text-slate-400">
            検証済み {data.total}R・BUY {data.buy_count}R / WATCH {data.watch_count}R / SKIP {data.skip_count}R
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat icon={Target} label="BUY数" value={data.buy_count} unit="R" tone="text-indigo-600" />
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

          <div className="grid lg:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] font-bold text-slate-500 mb-2">的中・不的中の内訳（BUY）</div>
              <div className="grid grid-cols-2 gap-2">
                {OUTCOME_CARDS.map((c) => (
                  <div key={c.key} className={cn("rounded-xl border p-2.5 text-center", c.tone)}>
                    <div className="text-[9px] font-bold leading-tight">{c.key.replace(/_/g, " ")}</div>
                    <div className="text-xl font-black mt-1">{data.outcome?.[c.key] || 0}</div>
                    <div className="text-[9px] opacity-70 mt-0.5">{c.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 mb-2">
                  <Layers className="w-3.5 h-3.5" /> 買い目点数別のBUY成績
                </div>
                {(data.ticket_rows || []).length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-[11px] text-slate-400">点数別データがまだありません。</div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {(data.ticket_rows || []).map((t) => (
                      <div key={t.tickets} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-center">
                        <div className="text-[11px] font-black text-slate-700">{t.tickets}点</div>
                        <div className="text-lg font-black text-slate-900 mt-0.5">{t.hit_rate}<span className="text-[10px] text-slate-400">%</span></div>
                        <div className="text-[9px] text-slate-400">的中 {t.hits}/{t.count}</div>
                        <div className={cn("mt-1 text-[11px] font-bold", t.recovery_rate >= 110 ? "text-emerald-600" : "text-slate-500")}>回収 {t.recovery_rate}%</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-bold text-slate-600">WATCH参考成績（BUYに至らなかったレース）</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-lg font-black text-slate-900">{data.watch?.count || 0}</div>
                    <div className="text-[9px] text-slate-400">レース数</div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-slate-900">{data.watch?.hit_rate ?? 0}%</div>
                    <div className="text-[9px] text-slate-400">的中率 {data.watch?.hits || 0}R</div>
                  </div>
                  <div>
                    <div className={cn("text-lg font-black", (data.watch?.recovery_rate || 0) >= 110 ? "text-emerald-600" : "text-slate-900")}>
                      {data.watch?.recovery_rate ?? 0}%
                    </div>
                    <div className="text-[9px] text-slate-400">仮回収率</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {data.recovery_rate < 110 && data.buy_count > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <div className="text-[11px] text-amber-700 font-medium">
                目標110%まであと{Math.max(0, 110 - data.recovery_rate).toFixed(1)}pt。検証レースが増えるほど精度が上がります。
              </div>
            </div>
          )}

          <div>
            <div className="text-[11px] font-bold text-slate-500 mb-2">直近のV6.3検証レース（新しい順）</div>
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              {(data.records || []).length === 0 ? (
                <div className="py-8 text-center text-[11px] text-slate-400">検証レースがまだありません。</div>
              ) : (
                (data.records || []).map((r) => <V63RecordRow key={r.id} row={r} />)
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function V63RecordRow({ row }) {
  const judgment = row.v63_final_judgment;
  const parts = String(row.race_key || "").split("_");
  const date = String(row.race_date || parts[0] || "").replace(/-/g, "/");
  const venue = VENUE_NAMES[String(row.venue_code || parts[1] || "").padStart(2, "0")] || row.venue_code || "—";
  const hit = row.v63_recommended_hit;

  return (
    <div className={cn("px-3 py-2.5 border-b border-slate-100 last:border-0", hit ? "bg-emerald-50/40" : "bg-white")}>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-slate-600">
        <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5">
          <CalendarDays className="w-3 h-3 text-sky-600" />{date || "日付不明"}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5">
          <MapPin className="w-3 h-3 text-indigo-600" />{venue}
        </span>
        <span className="rounded-md bg-slate-900 px-1.5 py-0.5 font-black text-white">{row.race_number ? `${row.race_number}R` : "R不明"}</span>
        <span
          className={cn(
            "px-1.5 py-0.5 rounded-md font-black",
            judgment === "BUY" ? "bg-indigo-100 text-indigo-700" : judgment === "WATCH" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
          )}
        >
          {judgment || "未判定"}
        </span>
        {judgment === "BUY" && (
          <span className={cn("px-1.5 py-0.5 rounded-md font-black", hit ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-600")}>
            {hit ? "的中" : "不的中"}
          </span>
        )}
        <span className="ml-auto font-mono text-slate-900">結果 {row.actual_result || "—"}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span>買い目 {row.v63_ticket_count || "—"}点: {(row.v63_selected_trifectas || []).join(" / ") || "—"}</span>
        {row.v63_ticket_strategy && <span className="text-slate-400">内訳 {row.v63_ticket_strategy}</span>}
        {judgment === "BUY" && (
          <span className="ml-auto text-slate-600">
            払戻 ¥{fmt(row.v63_payout)} ·{" "}
            <b className={cn((row.v63_recovery_rate || 0) >= 110 ? "text-emerald-600" : "text-slate-500")}>回収率 {row.v63_recovery_rate || 0}%</b>
          </span>
        )}
      </div>
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