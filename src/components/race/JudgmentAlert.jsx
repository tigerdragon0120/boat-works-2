import React from "react";
import { cn } from "@/lib/utils";

const STAGE_LABEL = { PRE: "事前予想", FINAL: "直前予想" };

// 直前予想が確定したときの判定アラート。展開シナリオは表示せず、判定だけを出す。
export default function JudgmentAlert({ stage, jcfg, ticketCount, pred }) {
  return (
    <div className={cn("rounded-xl border-2 p-3 flex items-center gap-3", jcfg.cls)}>
      <div className="text-center shrink-0">
        <div className="text-[10px] text-slate-400 mb-0.5">{STAGE_LABEL[stage] || "予想"}の判定</div>
        <div className={cn("w-16 h-16 rounded-xl border-2 flex items-center justify-center text-2xl font-black", jcfg.cls)}>
          {jcfg.label}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-slate-400">買い目</span>
          <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 text-xs font-bold">{ticketCount}点</span>
          {pred?.ticket_strategy && <span className="text-[10px] text-slate-400 truncate">{pred.ticket_strategy}</span>}
        </div>
        <div className="text-[11px] text-slate-300 leading-relaxed">{pred?.judgment_reason || "—"}</div>
        {pred?.expand_reason && <div className="text-[10px] text-amber-400/80 mt-1">拡張: {pred.expand_reason}</div>}
      </div>
    </div>
  );
}