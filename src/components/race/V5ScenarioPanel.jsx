import React, { useMemo } from "react";
import { AlertTriangle, ArrowRight, Shield, Swords } from "lucide-react";
import { buildV5ScenarioForecast } from "@/lib/v5ScenarioEngine";
import { cn } from "@/lib/utils";

export default function V5ScenarioPanel({ entries, activePred }) {
  const forecast = useMemo(
    () => buildV5ScenarioForecast(entries || [], activePred),
    [entries, activePred]
  );
  const top = forecast.scenarios.slice(0, 6);

  return (
    <div className="rounded-xl border border-cyan-400/30 bg-slate-950/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-[10px] font-black tracking-wider text-cyan-400">V5 展開シナリオ</div>
          <div className="text-sm font-black text-white">{forecast.verdict}</div>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <div className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-2 py-1 text-blue-300">
            <Shield className="inline h-3 w-3 mr-1" />イン防御 <b>{forecast.insideDefense}</b>
          </div>
          <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-rose-300">
            <Swords className="inline h-3 w-3 mr-1" />外攻撃 <b>{forecast.outsideAttack}</b>
          </div>
        </div>
      </div>

      {forecast.outerA1.length > 0 && (
        <div className="mb-3 flex gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <div className="text-[10px] leading-relaxed text-amber-200">{forecast.note}</div>
        </div>
      )}

      <div className="space-y-2">
        {top.map((s, index) => (
          <div key={s.key} className={cn("rounded-lg border p-2", index === 0 ? "border-cyan-400/40 bg-cyan-500/10" : "border-slate-700 bg-slate-900/80")}>
            <div className="flex items-center gap-2">
              <div className={cn("w-8 text-right text-sm font-black", index === 0 ? "text-cyan-300" : "text-slate-300")}>{s.probability}%</div>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-white">{s.label}</span>
                  <span className="flex items-center gap-1 text-[10px] text-slate-400">
                    次候補 <ArrowRight className="h-3 w-3" />
                    {s.followers.map(n => String(n) + "号艇").join("・")}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className={cn("h-full rounded-full", index === 0 ? "bg-cyan-400" : "bg-slate-500")} style={{ width: String(s.probability) + "%" }} />
                </div>
              </div>
            </div>
            <div className="mt-1.5 text-[9px] leading-relaxed text-slate-400">{s.reason}</div>
          </div>
        ))}
      </div>

      <div className="mt-2 text-[9px] leading-relaxed text-slate-500">
        全シナリオ合計100%。級別だけで外枠を頭にせず、枠別実績・ST・展示・モーター・直近成績・イン側の弱さを比較しています。
      </div>
    </div>
  );
}
