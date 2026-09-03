import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { listTodayRaces } from "@/lib/predictionService";
import { cn } from "@/lib/utils";

const VENUES = [
  ["01","桐生"],["02","戸田"],["03","江戸川"],["04","平和島"],["05","多摩川"],["06","浜名湖"],["07","蒲郡"],["08","常滑"],
  ["09","津"],["10","三国"],["11","びわこ"],["12","住之江"],["13","尼崎"],["14","鳴門"],["15","丸亀"],["16","児島"],
  ["17","宮島"],["18","徳山"],["19","下関"],["20","若松"],["21","芦屋"],["22","福岡"],["23","唐津"],["24","大村"],
];

export default function Home() {
  const [races, setRaces] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const list = await listTodayRaces({ includeFinished: true });
    setRaces(list || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const venueData = useMemo(() => {
    const map = new Map();
    for (const r of races) {
      const code = String(r.venue_code || "").padStart(2, "0");
      if (!map.has(code)) map.set(code, []);
      map.get(code).push(r);
    }
    return map;
  }, [races]);

  return (
    <div className="text-slate-100 space-y-3 sm:space-y-5">
      <div className="flex items-start sm:items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0"><h1 className="text-xl sm:text-2xl font-black tracking-tight">本日のレース場</h1><p className="text-[11px] sm:text-xs text-slate-500 mt-1">レース場を選んで、1R〜12Rの予想へ進みます</p></div>
        <button onClick={load} className="h-10 sm:h-9 min-w-10 px-3 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-2 text-xs font-semibold shrink-0"><RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /><span className="hidden sm:inline">更新</span></button>
      </div>

      <section className="rounded-xl sm:rounded-2xl border border-slate-800 bg-[#0b1118] p-2.5 sm:p-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2 sm:gap-2.5">
          {VENUES.map(([code, name]) => {
            const list = (venueData.get(code) || []).sort((a,b) => a.race_number - b.race_number);
            const active = list.length > 0;
            const nextRace = list.find((r) => r.status !== "finished" && r.status !== "cancelled") || list[list.length - 1];
            const activeCount = list.filter((r) => r.status !== "finished" && r.status !== "cancelled").length;
            const eventRace = list[0] || nextRace;
            const dayText = eventRace?.series_day ? (eventRace.is_final_day ? "最終日" : `${eventRace.series_day}日目`) : "";
            const gradeText = displayGrade(eventRace?.grade);
            const womens = !!eventRace?.is_womens;
            const content = <><div className="flex items-center justify-between"><span className="text-[10px] font-bold text-slate-500">{code}</span>{active && <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]" />}</div><div className={cn("mt-2 text-lg font-black", active ? "text-white" : "text-slate-600")}>{name}</div><div className="mt-1.5 min-h-[58px] text-xs leading-5">{active ? <><div className="flex items-center gap-1.5 flex-wrap"><span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-400/30 text-blue-300 font-bold">{gradeText}</span>{dayText && <span className="font-bold text-amber-300">{dayText}</span>}{womens && <span title="女子戦" className="text-pink-400 text-sm">♥</span>}</div><div className="text-slate-400 truncate">{eventRace?.event_name || "本日開催"}</div><div className="font-bold text-blue-300">{nextRace ? `${nextRace.race_number}R / ${fmtTime(nextRace.deadline)}` : `${activeCount}R`}</div></> : <div className="text-slate-700">本日開催なし</div>}</div></>;
            return active ? <Link key={code} to={`/venue/${code}`} className="min-h-[104px] sm:min-h-[118px] rounded-xl border border-blue-500/30 bg-gradient-to-b from-blue-600/15 to-slate-900 p-2.5 sm:p-3 hover:border-blue-400 hover:bg-blue-500/15 active:scale-[.99] transition shadow-sm">{content}</Link> : <div key={code} className="min-h-[104px] sm:min-h-[118px] rounded-xl border border-slate-800 bg-slate-900/50 p-2.5 sm:p-3 opacity-70">{content}</div>;
          })}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-slate-500 px-1"><span><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1.5" />本日開催</span><span>開催場 {venueData.size}場</span><span>登録レース {races.length}R</span><span>※開催データはBOAT WORKS同期内容を表示</span></div>
    </div>
  );
}

function displayGrade(v) { const g = String(v || "").toUpperCase(); return !g || g === "GENERAL" ? "一般" : g; }
function fmtTime(v) { return v ? new Date(v).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"; }
