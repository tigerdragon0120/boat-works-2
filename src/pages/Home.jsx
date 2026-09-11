import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Clock } from "lucide-react";
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
  const [now, setNow] = useState(Date.now());

  const load = async () => {
    setLoading(true);
    const list = await listTodayRaces({ includeFinished: true });
    setRaces(list || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);

  const venueData = useMemo(() => {
    const map = new Map();
    for (const r of races) {
      const code = String(r.venue_code || "").padStart(2, "0");
      if (!map.has(code)) map.set(code, []);
      map.get(code).push(r);
    }
    for (const list of map.values()) list.sort((a,b) => Number(a.race_number||0)-Number(b.race_number||0));
    return map;
  }, [races]);

  const chronological = useMemo(() => races
    .filter(r => r.deadline)
    .slice()
    .sort((a,b) => new Date(a.deadline)-new Date(b.deadline)), [races]);
  const currentIndex = useMemo(() => {
    if (!chronological.length) return -1;
    return chronological.findIndex(r =>
      r.status !== 'finished' &&
      r.status !== 'cancelled' &&
      new Date(r.deadline).getTime() > now
    );
  }, [chronological, now]);
  const currentRace = currentIndex >= 0 ? chronological[currentIndex] : null;
  const minutesToDeadline = currentRace
    ? Math.max(0, Math.ceil((new Date(currentRace.deadline).getTime() - now) / 60000))
    : null;

  return (
    <div className="text-[#26364d] space-y-2 pb-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-black text-[#123d9c]">本日の開催</h1>
          <div className="text-[10px] text-slate-500">24場を1画面で確認</div>
        </div>
        <button onClick={load} className="h-9 px-3 rounded-lg border border-[#e8c900] bg-[#ffe600] text-[#16254a] shadow-sm flex items-center gap-2 text-xs font-black hover:bg-[#ffeb33] active:scale-[0.98] transition"><RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />更新</button>
      </div>

      {currentRace && <div className="rounded-xl border border-[#ff4d93] bg-gradient-to-r from-[#fff1f6] via-[#fff7fa] to-[#fff3f8] px-3 sm:px-4 py-2.5 flex items-center gap-3 shadow-sm">
        <div className="flex items-center gap-2 shrink-0">
          <Clock className="w-5 h-5 text-[#f02f7d]"/>
          <span className="px-2 py-1 rounded-full bg-[#f02f7d] text-white text-[10px] sm:text-[11px] font-black whitespace-nowrap">締切間近</span>
        </div>
        <div className="font-black text-sm sm:text-base text-slate-900 whitespace-nowrap">{venueName(currentRace.venue_code)} {currentRace.race_number}R</div>
        <div className="hidden sm:block w-px h-7 bg-[#f6b6d0]"/>
        <div className="hidden sm:flex items-baseline gap-1 whitespace-nowrap"><span className="text-[10px] text-slate-500">締切時刻</span><span className="text-xl font-black text-[#f02f7d]">{fmtTime(currentRace.deadline)}</span></div>
        <div className="hidden md:block w-px h-7 bg-[#f6b6d0]"/>
        <div className="flex items-baseline gap-1 whitespace-nowrap"><span className="text-[11px] font-bold text-[#d92d72]">あと</span><span className="text-2xl font-black text-[#f02f7d]">{minutesToDeadline}</span><span className="text-sm font-black text-[#d92d72]">分</span></div>
        <div className="hidden lg:block w-px h-7 bg-[#f6b6d0]"/>
        <div className="hidden lg:flex items-baseline gap-1 whitespace-nowrap"><span className="text-[10px] text-slate-500">現在時刻</span><span className="text-sm font-black text-slate-700">{fmtTime(now)}</span></div>
        <div className="hidden xl:block flex-1 text-center text-[10px] font-semibold text-[#e13a7b]">本日これから締切のレースの中で最も近いレースを表示しています</div>
        <div className="ml-auto text-right shrink-0"><div className="text-[10px] text-slate-400">本日全{chronological.length}R</div><div className="text-sm font-black text-slate-900">{currentIndex+1} / {chronological.length}</div></div>
      </div>}

      <section className="rounded-xl border border-[#d4dde9] bg-[#f7f9fc] p-1.5 sm:p-2 shadow-sm">
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
          {VENUES.map(([code,name]) => {
            const list = venueData.get(code) || [];
            const active = list.length > 0;
            const finishedByNow = (r) => r.status === 'finished' || r.status === 'cancelled' || (r.deadline && new Date(r.deadline).getTime() <= now);
            const done = list.filter(finishedByNow).length;
            const upcoming = list.filter(r => !finishedByNow(r));
            const nextRace = upcoming.find(r => !r.deadline || new Date(r.deadline).getTime() > now) || upcoming[0] || null;
            const venueFinished = active && done >= list.length;
            const day = list[0]?.series_day ? (list[0]?.is_final_day ? '最終日' : `${list[0].series_day}日目`) : '';
            const grade = displayGrade(list[0]?.grade);
            const isCurrent = currentRace && String(currentRace.venue_code).padStart(2,'0')===code;
            const body = <>
              <div className="flex items-center justify-between gap-1"><span className={cn("font-bold text-[11px] sm:text-xs truncate",active?'text-slate-900':'text-slate-400')}>{name}</span><span className="text-[8px] text-slate-600">{code}</span></div>
              {active ? <>
                <div className="mt-1 flex items-center gap-1 text-[9px]"><span className="px-1 rounded bg-[#e4edff] text-[#2457c5]">{grade}</span>{day&&<span className="text-[#ef3d83] font-bold">{day}</span>}</div>
                <div className={cn("mt-1 text-base sm:text-lg font-black leading-none",venueFinished?'text-slate-500':isCurrent?'text-[#f02f7d]':'text-[#1462d2]')}>{venueFinished ? '終了' : nextRace ? `現在 ${nextRace.race_number}R` : '終了'}</div>
                <div className="mt-1 flex justify-between text-[9px] text-slate-500"><span>{venueFinished?'全レース終了':nextRace?`締切 ${fmtTime(nextRace.deadline)}`:'終了'}</span><span>{done}/{list.length || 12}</span></div>
                <div className="mt-1 h-1 rounded-full bg-slate-200 overflow-hidden"><div className="h-full bg-slate-400" style={{width:`${Math.min(100,(done/12)*100)}%`}}/></div>
              </> : <div className="mt-2 text-center text-[10px] text-slate-700">開催なし</div>}
            </>;
            return active ? <Link key={code} to={`/venue/${code}`} className={cn("min-h-[86px] rounded-lg border p-2 transition",isCurrent?'border-[#f02f7d] bg-[#fff2f7] ring-1 ring-[#f7a8c7]':'border-[#cfd9e6] bg-white hover:border-[#2f6fe4] shadow-sm')}>{body}</Link> : <div key={code} className="min-h-[86px] rounded-lg border border-[#d6dde6] bg-[#edf0f4] p-2 opacity-75">{body}</div>;
          })}
        </div>
      </section>

      <div className="text-[9px] text-slate-600 text-center">各場の「現在のR・締切時刻・終了数」を時系列で自動更新します。</div>
    </div>
  );
}

function venueName(code){ const c=String(code||'').padStart(2,'0'); return VENUES.find(v=>v[0]===c)?.[1] || c; }
function displayGrade(v){ const g=String(v||'').toUpperCase(); return !g||g==='GENERAL'?'一般':g; }
function fmtTime(v){ return v ? new Date(v).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}) : '--:--'; }
