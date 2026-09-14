import React, { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";
import { Target, AlertCircle, CheckCircle2, XCircle, Anchor } from "lucide-react";

const TARGET_HIT_RATE = 30;
const RECOVERY_WARNING = 80;

const PERIOD_OPTIONS = [
  { key: "50", label: "直近50 BUY" },
  { key: "100", label: "直近100 BUY" },
  { key: "300", label: "直近300 BUY" },
  { key: "all", label: "全期間" },
];

export default function V3V4Comparison() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("100");

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const [v3Verifs, v4Verifs] = await Promise.all([
        base44.entities.PredictionV3Verification.list('-verified_at', 500).catch(() => []),
        base44.entities.PredictionV4Verification.list('-verified_at', 500).catch(() => []),
      ]);
      setSummary(computeSummary(v3Verifs || [], v4Verifs || [], period));
    } catch (e) {
      console.error("V3V4Comparison fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-6 h-6 border-2 border-slate-600 border-t-amber-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!summary || (summary.v3.buy_count === 0 && summary.v4.buy_count === 0)) {
    return <div className="text-center text-slate-500 py-8 text-sm">V4検証データがまだありません。結果確定後に自動集計されます。</div>;
  }

  const { v3, v4, actual } = summary;
  const actual56Rate = actual.total > 0 ? ((actual.firstCounts[5] + actual.firstCounts[6]) / actual.total * 100) : 0;
  const fiftySixOver = v4.fiftySixRate > actual56Rate * 1.5 && actual.total > 0;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap">
        {PERIOD_OPTIONS.map(opt => (
          <button key={opt.key} onClick={() => setPeriod(opt.key)}
            className={cn("px-3 h-8 rounded-lg text-xs font-bold transition-colors",
              period === opt.key ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}>
            {opt.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
          <Target className="w-3.5 h-3.5 text-amber-600" />
          <span className="font-bold text-amber-700">V4目標的中率: {TARGET_HIT_RATE}%以上</span>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-50 border border-rose-200">
          <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
          <span className="font-bold text-rose-700">回収率WARNING: {RECOVERY_WARNING}%未満</span>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <VersionCard title="V3 回収率型" data={v3} color="indigo" targetHit={null} />
        <VersionCard title="V4 HIT的中率型" data={v4} color="amber" targetHit={TARGET_HIT_RATE} />
      </div>

      <div className="rounded-xl border border-slate-200 p-3">
        <div className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5">
          <Anchor className="w-3.5 h-3.5 text-slate-500" />
          艇番別本命分布 vs 実際の1着分布
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="py-1.5 px-2 text-left text-slate-500">艇番</th>
                <th className="py-1.5 px-2 text-right text-slate-500">V3本命</th>
                <th className="py-1.5 px-2 text-right text-slate-500">V4本命</th>
                <th className="py-1.5 px-2 text-right text-slate-500">実際1着</th>
                <th className="py-1.5 px-2 text-right text-slate-500">V4乖離</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6].map(bn => {
                const v3Count = v3.firstBoatCounts[bn] || 0;
                const v4Count = v4.firstBoatCounts[bn] || 0;
                const actualCount = actual.firstCounts[bn] || 0;
                const v3Rate = v3.buy_count > 0 ? (v3Count / v3.buy_count * 100) : 0;
                const v4Rate = v4.buy_count > 0 ? (v4Count / v4.buy_count * 100) : 0;
                const actualRate = actual.total > 0 ? (actualCount / actual.total * 100) : 0;
                const deviation = v4Rate - actualRate;
                return (
                  <tr key={bn} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 px-2 font-bold text-slate-900">{bn}号艇</td>
                    <td className="py-1.5 px-2 text-right text-slate-600">{v3Count}R ({v3Rate.toFixed(1)}%)</td>
                    <td className="py-1.5 px-2 text-right text-slate-900 font-bold">{v4Count}R ({v4Rate.toFixed(1)}%)</td>
                    <td className="py-1.5 px-2 text-right text-slate-500">{actualCount}R ({actualRate.toFixed(1)}%)</td>
                    <td className={cn("py-1.5 px-2 text-right font-bold", Math.abs(deviation) > 10 ? "text-rose-500" : "text-emerald-600")}>
                      {deviation > 0 ? "+" : ""}{deviation.toFixed(1)}pt
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
        <div className="text-xs font-bold text-amber-700 mb-2">5・6号艇1着監視</div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-slate-500">ACTUAL_56_FIRST_RATE</div>
            <div className="font-black text-slate-900 text-lg">
              {actual56Rate.toFixed(1)}%
              <span className="text-xs text-slate-400 ml-1">({(actual.firstCounts[5] || 0) + (actual.firstCounts[6] || 0)}/{actual.total}R)</span>
            </div>
          </div>
          <div>
            <div className="text-slate-500">V4_56_FIRST_PREDICTION_RATE</div>
            <div className={cn("font-black text-lg", fiftySixOver ? "text-rose-500" : "text-slate-900")}>
              {v4.fiftySixRate.toFixed(1)}%
              <span className="text-xs text-slate-400 ml-1">({v4.fiftySixCount}/{v4.buy_count}R)</span>
            </div>
          </div>
        </div>
        {v4.fiftySixSuppressedCount > 0 && (
          <div className="mt-2 text-[11px] text-amber-600">
            抑制適用: {v4.fiftySixSuppressedCount}R (5/6号艇1着を条件不足で抑制)
          </div>
        )}
        {fiftySixOver && (
          <div className="mt-1 text-[11px] font-bold text-rose-500">
            WARNING: V4の5/6号艇1着予想率が実績の1.5倍を超えています
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 p-3">
        <div className="text-xs font-bold text-slate-700 mb-2">評価期間別 V4 的中率</div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <PeriodStat label="直近50 BUY" data={v4.periods["50"]} target={TARGET_HIT_RATE} />
          <PeriodStat label="直近100 BUY" data={v4.periods["100"]} target={TARGET_HIT_RATE} />
          <PeriodStat label="直近300 BUY" data={v4.periods["300"]} target={TARGET_HIT_RATE} />
        </div>
      </div>
    </div>
  );
}

function VersionCard({ title, data, color, targetHit }) {
  const colorMap = {
    indigo: { bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-700" },
    amber: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700" },
  };
  const c = colorMap[color] || colorMap.indigo;
  const hitRate = data.buy_count > 0 ? (data.buy_hits / data.buy_count * 100) : 0;
  const recovery = data.buy_investment > 0 ? Math.round(data.buy_return / data.buy_investment * 100) : 0;
  const targetMet = targetHit != null && hitRate >= targetHit;
  const recoveryWarning = recovery > 0 && recovery < RECOVERY_WARNING;

  return (
    <div className={cn("rounded-xl border p-3", c.bg, c.border)}>
      <div className={cn("text-sm font-black mb-2", c.text)}>{title}</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Metric label="BUY数" value={`${data.buy_count}R`} />
        <Metric label="的中数" value={`${data.buy_hits}R`} />
        <Metric label="的中率" value={`${hitRate.toFixed(1)}%`} highlight={targetMet ? "good" : null} />
        <Metric label="回収率" value={`${recovery}%`} highlight={recoveryWarning ? "bad" : recovery >= 100 ? "good" : null} />
        <Metric label="投資" value={`¥${(data.buy_investment || 0).toLocaleString()}`} />
        <Metric label="払戻" value={`¥${(data.buy_return || 0).toLocaleString()}`} />
      </div>
      {targetHit != null && (
        <div className={cn("mt-2 text-[11px] font-bold flex items-center gap-1", targetMet ? "text-emerald-600" : "text-slate-500")}>
          {targetMet ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          目標{targetHit}%{targetMet ? "達成" : "未達"}
        </div>
      )}
      {recoveryWarning && (
        <div className="mt-1 text-[11px] font-bold text-rose-500 flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5" />回収率{RECOVERY_WARNING}%未満WARNING
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, highlight }) {
  return (
    <div className="bg-white rounded-lg p-2">
      <div className="text-slate-400 text-[10px]">{label}</div>
      <div className={cn("font-bold text-slate-900", highlight === "good" && "text-emerald-600", highlight === "bad" && "text-rose-500")}>{value}</div>
    </div>
  );
}

function PeriodStat({ label, data, target }) {
  const hitRate = data?.count > 0 ? (data?.hits / data.count * 100) : 0;
  const met = hitRate >= target;
  return (
    <div className="bg-slate-50 rounded-lg p-2">
      <div className="text-slate-400 text-[10px]">{label}</div>
      <div className={cn("font-black text-lg", met ? "text-emerald-600" : "text-slate-900")}>{hitRate.toFixed(1)}%</div>
      <div className="text-[9px] text-slate-400">{data?.hits || 0}/{data?.count || 0}R</div>
    </div>
  );
}

function computeSummary(v3Verifs, v4Verifs, period) {
  const periodMap = { "50": 50, "100": 100, "300": 300, "all": 999999 };
  const limit = periodMap[period] || 100;

  const v3Buys = v3Verifs.filter(v => v.v3_final_judgment === "BUY").slice(0, limit);
  const v3Data = computeVersionData(v3Buys, "v3");

  const v4Buys = v4Verifs.filter(v => v.v4_final_judgment === "BUY").slice(0, limit);
  const v4Data = computeVersionData(v4Buys, "v4");

  const allVerifs = [...v3Verifs, ...v4Verifs];
  const uniqueResults = new Map();
  for (const v of allVerifs) {
    const key = v.race_id || v.race_key;
    if (key && v.actual_result && !uniqueResults.has(key)) {
      uniqueResults.set(key, v.actual_result);
    }
  }
  const firstCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const result of uniqueResults.values()) {
    const first = parseInt(String(result).split("-")[0]);
    if (first >= 1 && first <= 6) firstCounts[first]++;
  }

  const periods = {};
  for (const pKey of ["50", "100", "300"]) {
    const pLimit = periodMap[pKey];
    const pBuys = v4Buys.slice(0, pLimit);
    periods[pKey] = {
      count: pBuys.length,
      hits: pBuys.filter(v => v.v4_recommended_hit).length,
    };
  }

  return {
    v3: v3Data,
    v4: { ...v4Data, periods },
    actual: { firstCounts, total: uniqueResults.size },
  };
}

function computeVersionData(buys, version) {
  const buyHits = buys.filter(v => v[`${version}_recommended_hit`]).length;
  const buyInvestment = buys.reduce((s, v) => s + (v[`${version}_investment`] || 0), 0);
  const buyReturn = buys.filter(v => v[`${version}_recommended_hit`]).reduce((s, v) => s + (v[`${version}_payout`] || 0), 0);

  const firstBoatCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const v of buys) {
    let firstBoat = null;
    if (version === "v4") {
      firstBoat = v.v4_first_boat;
    } else {
      const pred = v.v3_final_prediction || "";
      firstBoat = parseInt(pred.split("-")[0]) || null;
    }
    if (firstBoat >= 1 && firstBoat <= 6) firstBoatCounts[firstBoat]++;
  }

  const fiftySixCount = (firstBoatCounts[5] || 0) + (firstBoatCounts[6] || 0);
  const fiftySixRate = buys.length > 0 ? (fiftySixCount / buys.length * 100) : 0;
  const fiftySixSuppressedCount = version === "v4" ? buys.filter(v => v.v4_fifty_six_suppressed).length : 0;

  return {
    buy_count: buys.length,
    buy_hits: buyHits,
    buy_investment: buyInvestment,
    buy_return: buyReturn,
    firstBoatCounts,
    fiftySixCount,
    fiftySixRate,
    fiftySixSuppressedCount,
  };
}