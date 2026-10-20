import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import EngineAlertBlock from "@/components/alerts/EngineAlertBlock";

const ENGINE_ORDER = ["v6.1", "v6.2"];

function fmtTime(v) {
  return v ? new Date(v).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--";
}

export default function BuyAlertCard({ row, now }) {
  const { race, versions, confirmed } = row;
  const deadline = race?.deadline ? new Date(race.deadline).getTime() : null;
  const minutes = deadline != null ? Math.ceil((deadline - now) / 60000) : null;
  const expired = minutes != null && minutes <= 0;
  const urgent = minutes != null && minutes > 0 && minutes <= 30;

  const engines = ENGINE_ORDER.filter((v) => versions[v]).length
    ? ENGINE_ORDER.filter((v) => versions[v])
    : Object.keys(versions);

  return (
    <div className={cn("rounded-xl border bg-white overflow-hidden shadow-sm", confirmed ? "border-[#f6b6d0]" : "border-[#e8d8a6]")}>
      <div className={cn("h-1", confirmed ? "bg-[#f02f7d]" : "bg-[#f2b500]")} />
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap border-b border-slate-100">
        <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-black text-white", confirmed ? "bg-[#f02f7d]" : "bg-[#d99f00]")}>
          {confirmed ? "確定BUY" : "暫定BUY"}
        </span>
        <span className="font-black text-slate-900 text-sm sm:text-base">
          {race.venue_name || race.venue || race.venue_code} {race.race_number}R
        </span>
        {race.race_name && <span className="text-[10px] text-slate-500 truncate max-w-[180px]">{race.race_name}</span>}
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          <Clock className={cn("w-3.5 h-3.5", urgent ? "text-[#f02f7d]" : "text-slate-400")} />
          <span className="text-slate-500">締切 {fmtTime(race.deadline)}</span>
          {expired ? (
            <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 font-black text-slate-500">締切済み</span>
          ) : (
            <span className={cn("px-2 py-0.5 rounded-full font-black", urgent ? "bg-[#fff1f6] text-[#d92d72] border border-[#f6b6d0]" : "bg-slate-100 text-slate-700 border border-slate-200")}>
              あと{minutes}分
            </span>
          )}
        </span>
      </div>

      <div className="p-3 space-y-2">
        {engines.map((version) => {
          const slot = versions[version] || {};
          const stage = slot.FINAL ? "FINAL" : "PRE";
          const pred = slot.FINAL || slot.PRE;
          if (!pred) return null;
          return <EngineAlertBlock key={version} version={version} pred={pred} stage={stage} />;
        })}
      </div>

      <Link
        to={`/race/${race.id}`}
        className="flex items-center justify-center gap-1 h-9 border-t border-slate-100 text-[11px] font-black text-[#1462d2] hover:bg-[#f5f8ff] transition-colors"
      >
        レース詳細で予想を見る
        <ChevronRight className="w-3.5 h-3.5" />
      </Link>
    </div>
  );
}