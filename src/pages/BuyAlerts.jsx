import React from "react";
import { BellRing } from "lucide-react";
import V8DailyBoard from "@/components/liveV8/V8DailyBoard";

export default function BuyAlerts() {
  return (
    <div className="space-y-3 pb-2 text-[#26364d]">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-200 bg-white">
          <BellRing className="h-5 w-5 text-sky-700" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-black text-[#123d9c] sm:text-xl">予想アラート</h1>
            <span className="rounded-md bg-sky-100 px-2 py-0.5 text-xs font-bold text-sky-800">V8</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">事前の展開予想から、展示後のBUY判定まで。</p>
        </div>
      </header>
      <V8DailyBoard />
    </div>
  );
}
