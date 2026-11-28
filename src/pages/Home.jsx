import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { listTodayRaces } from "@/lib/predictionService";
import { dashboardDate, dashboardTime, describeVenueRaces } from "@/lib/venueDashboard";
import { cn } from "@/lib/utils";

const VENUES = [
  ["01","桐生"],["02","戸田"],["03","江戸川"],["04","平和島"],["05","多摩川"],["06","浜名湖"],["07","蒲郡"],["08","常滑"],
  ["09","津"],["10","三国"],["11","びわこ"],["12","住之江"],["13","尼崎"],["14","鳴門"],["15","丸亀"],["16","児島"],
  ["17","宮島"],["18","徳山"],["19","下関"],["20","若松"],["21","芦屋"],["22","福岡"],["23","唐津"],["24","大村"],
];
const REFRESH_MS = 60000;

export default function Home() {
  const [snapshot, setSnapshot] = useState({ date: null, races: [], fetchedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refresh = useRef(() => {});
  const date = dashboardDate(now);

  useEffect(() => {
    let alive = true, request = null, refreshAfterRequest = false, activeDate = dashboardDate(), lastAttempt = 0;
    const load = async (force = false) => {
      const requestedDate = dashboardDate();
      if (request) {
        if (request.date !== requestedDate) refreshAfterRequest = true;
        return;
      }
      request = { date: requestedDate };
      lastAttempt = Date.now();
      setLoading(true);
      try {
        const rows = await listTodayRaces({ includeFinished: true, raceDate: requestedDate, force });
        if (!alive) return;
        const checkedAt = Date.now();
        setNow(checkedAt);
        if (dashboardDate(checkedAt) !== requestedDate) { refreshAfterRequest = true; return; }
        if (!Array.isArray(rows)) throw new Error('INVALID_DASHBOARD_ROWS');
        activeDate = requestedDate;
        setSnapshot({ date: requestedDate, races: rows.filter(race => race?.race_date === requestedDate), fetchedAt: checkedAt });
        setError(false);
      } catch {
        if (alive) {
          const failedAt = Date.now();
          setNow(failedAt);
          if (dashboardDate(failedAt) !== requestedDate) refreshAfterRequest = true;
          else setError(true);
        }
      } finally {
        request = null;
        if (alive) {
          setLoading(false);
          if (refreshAfterRequest) { refreshAfterRequest = false; void load(true); }
        }
      }
    };
    refresh.current = load;
    void load(true);
    const clock = setInterval(() => {
      const at = Date.now(), nextDate = dashboardDate(at);
      setNow(at);
      if (nextDate !== activeDate) { activeDate = nextDate; setError(false); void load(true); }
    }, 30000);
    const poll = setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - lastAttempt >= REFRESH_MS) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(clock); clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      refresh.current = () => {};
    };
  }, []);

  const loaded = snapshot.date === date && snapshot.fetchedAt != null;
  const venues = useMemo(() => {
    const map = new Map();
    for (const race of snapshot.date === date ? snapshot.races : []) {
      const code = String(race.venue_code || '').padStart(2, '0');
      if (!map.has(code)) map.set(code, []);
      map.get(code).push(race);
    }
    return VENUES.map(([code, name]) => ({ code, name, ...describeVenueRaces(map.get(code) || [], { date, now }) }));
  }, [snapshot, date, now]);
  const nearest = venues.filter(view => view.nextRace).sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline))[0]?.code;

  return (
    <div className="text-[#26364d] space-y-2 pb-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-black text-[#123d9c]">本日の開催</h1>
          <div className="text-[10px] text-slate-500">24場を1画面で確認 · {date?.slice(5).replace('-', '/')}（日本時間）</div>
        </div>
        <button onClick={() => refresh.current(true)} disabled={loading} className="h-9 px-3 rounded-lg border border-[#e8c900] bg-[#ffe600] text-[#16254a] shadow-sm flex items-center gap-2 text-xs font-black hover:bg-[#ffeb33] active:scale-[0.98] transition disabled:opacity-60"><RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />{loading ? '確認中' : '更新'}</button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{loaded ? '更新できませんでした。前回取得分を表示しています。' : '開催情報を取得できませんでした。更新で再試行できます。'}</div>}
      <div className="flex justify-between gap-2 text-[10px] text-slate-500" aria-live="polite">
        <span>結果確定・中止・順延を分けて表示</span>
        <span>{loaded ? `取得 ${dashboardTime(new Date(snapshot.fetchedAt).toISOString())}` : loading ? '本日の開催を確認中' : '未取得'}</span>
      </div>
      <section aria-label="各場一覧" className="rounded-xl border border-[#d4dde9] bg-[#f7f9fc] p-1.5 sm:p-2 shadow-sm">
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
          {venues.map(view => {
            const { code, name, races, counts, nextRace, focusRace, title, detail, kind, reason } = view;
            const active = races.length > 0;
            const day = races[0]?.series_day ? (races[0]?.is_final_day ? '最終日' : `${races[0].series_day}日目`) : '';
            const grade = displayGrade(races[0]?.grade);
            const isCurrent = nextRace && code === nearest;
            const stopped = ['CANCELLED', 'POSTPONED'].includes(kind);
            const notices = [counts.cancelled > 0 && `中止 ${counts.cancelled}R`, counts.postponed > 0 && `順延 ${counts.postponed}R`,
              counts.pending + counts.missing > 0 && `確認待ち ${counts.pending + counts.missing}R`].filter(Boolean);
            const body = <>
              <div className="flex items-center justify-between gap-1"><span className={cn("font-bold text-[11px] sm:text-xs truncate",active?'text-slate-900':'text-slate-400')}>{name}</span><span className="text-[8px] text-slate-600">{code}</span></div>
              {active ? <>
                <div className="mt-1 flex items-center gap-1 text-[9px]"><span className="px-1 rounded bg-[#e4edff] text-[#2457c5]">{grade}</span>{day&&<span className="text-[#ef3d83] font-bold">{day}</span>}</div>
                <div className={cn("mt-1 text-base sm:text-lg font-black leading-tight", kind === 'POSTPONED' ? 'text-violet-700' : stopped ? 'text-amber-800' : kind === 'FINISHED' ? 'text-slate-500' : kind === 'PENDING' ? 'text-amber-800' : isCurrent ? 'text-[#f02f7d]' : 'text-[#1462d2]')}>{title}</div>
                <div className="mt-1 text-[9px] text-slate-600 leading-tight">{detail}</div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-1 text-[9px] text-slate-600"><span>確定 {counts.finished}/12</span>{notices.map(notice => <span key={notice} className={notice.startsWith('確認') ? 'text-slate-500' : 'font-bold text-amber-800'}>{notice}</span>)}</div>
                {reason && stopped && <div title={reason} className="mt-1 truncate text-[9px] text-amber-900">{reason}</div>}
                <div role="img" aria-label={`結果確定${counts.finished}R、中止${counts.cancelled}R、順延${counts.postponed}R`} className="mt-1 h-1 flex rounded-full bg-slate-200 overflow-hidden">
                  <div className="h-full bg-slate-400" style={{width:`${counts.finished / 12 * 100}%`}}/>
                  <div className="h-full bg-amber-400" style={{width:`${counts.cancelled / 12 * 100}%`}}/>
                  <div className="h-full bg-violet-400" style={{width:`${counts.postponed / 12 * 100}%`}}/>
                </div>
              </> : <div className="mt-2 text-center text-[10px] text-slate-700">{loaded ? title : loading ? '確認中' : '未取得'}</div>}
            </>;
            return active ? <Link key={code} to={`/venue/${code}?date=${date}${focusRace ? `&race=${focusRace.race_number}` : ''}`} className={cn("min-h-[100px] rounded-lg border p-2 transition",stopped?'border-amber-200 bg-amber-50':isCurrent?'border-[#f02f7d] bg-[#fff2f7] ring-1 ring-[#f7a8c7]':'border-[#cfd9e6] bg-white hover:border-[#2f6fe4] shadow-sm')}>{body}</Link> : <div key={code} className="min-h-[100px] rounded-lg border border-[#d6dde6] bg-[#edf0f4] p-2 opacity-75">{body}</div>;
          })}
        </div>
      </section>
      <div className="text-[9px] text-slate-600 text-center">開催状況は1分ごとに再読込します。確認できた結果だけを「確定」に数えます。</div>
    </div>
  );
}

function displayGrade(v){ const g=String(v||'').toUpperCase(); return !g||g==='GENERAL'?'一般':g; }
