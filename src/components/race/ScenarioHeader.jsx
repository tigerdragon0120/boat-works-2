import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import { buildV5ScenarioForecast } from "@/lib/v5ScenarioEngine";

// 予想の上部に表示する展開シナリオ。
// 総合判定(例: イン逃げ優勢)+ 1位シナリオの確率 + 2位シナリオを表示する。
export default function ScenarioHeader({ entries = [], activePred, children }) {
  const forecast = useMemo(
    () => buildV5ScenarioForecast(entries || [], activePred),
    [entries, activePred]
  );
  const [top, second] = forecast.scenarios || [];
  if (!top) return null;

  return (
    <div className="rounded-xl border border-cyan-400/30 bg-slate-950/70 p-3">
      <div className="text-[10px] font-black tracking-wider text-cyan-400">展開シナリオ</div>
      <div className="text-base sm:text-lg font-black text-white mb-2">{forecast.verdict}</div>
      <div className="space-y-1.5">
        <ScenarioRow s={top} rank="1位" highlight />
        {second && <ScenarioRow s={second} rank="2位" />}
      </div>
      {children && <div className="mt-2.5 pt-2.5 border-t border-cyan-400/20">{children}</div>}
    </div>
  );
}

function ScenarioRow({ s, rank, highlight = false }) {
  return (
    <div className={cn("rounded-lg border p-2", highlight ? "border-cyan-400/40 bg-cyan-500/10" : "border-slate-700 bg-slate-900/80")}>
      <div className="flex items-center gap-2">
        <span className={cn("text-[10px] font-bold shrink-0", highlight ? "text-cyan-300" : "text-slate-400")}>{rank}</span>
        <span className="flex-1 min-w-0 text-xs font-bold text-white truncate">{s.label}</span>
        <span className={cn("font-black shrink-0", highlight ? "text-2xl text-cyan-300" : "text-base text-slate-200")}>
          {s.probability}<span className="text-[10px] ml-0.5">%</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className={cn("h-full rounded-full", highlight ? "bg-cyan-400" : "bg-slate-500")} style={{ width: `${s.probability}%` }} />
      </div>
    </div>
  );
}