import React, { useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import PlayerPhoto from "@/components/race/PlayerPhoto";
import { base44 } from "@/api/base44Client";

// BOATCAST準拠: ダークテーマ + 進入コース別カラー
const courseBg = {
  1: "bg-white text-slate-900",
  2: "bg-slate-950 text-white",
  3: "bg-rose-600 text-white",
  4: "bg-blue-600 text-white",
  5: "bg-amber-400 text-slate-900",
  6: "bg-emerald-600 text-white",
};

const boatBadgeBg = {
  1: "bg-white text-slate-900",
  2: "bg-slate-950 text-white border border-slate-500",
  3: "bg-rose-600 text-white",
  4: "bg-blue-600 text-white",
  5: "bg-amber-400 text-slate-900",
  6: "bg-emerald-600 text-white",
};

// 着順による文字色(ヒートマップ風)
function finishTextClass(finish, special) {
  if (special) return "text-rose-500";
  const n = Number(finish);
  if (n === 1) return "text-white font-black";
  if (n === 2 || n === 3) return "text-slate-200 font-bold";
  if (n >= 4) return "text-slate-500";
  return "text-slate-400";
}

function formatFinish(h) {
  if (!h) return "";
  if (h.finish_status) return h.finish_status;
  if (h.finish_order != null) return String(h.finish_order);
  return "";
}

function isSpecial(h) {
  return !!(h?.finish_status && h.finish_status !== "");
}

export default function LanePast10Table({ entries, race }) {
  const [statsByKey, setStatsByKey] = useState({});
  const [loading, setLoading] = useState(false);

  const reqKey = useMemo(
    () => entries.map((e) => `${e.register_number || e.registration_number}_${e.boat_number}`).join(","),
    [entries]
  );

  useEffect(() => {
    if (!reqKey) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const reqEntries = entries
          .map((e) => ({
            registration_number: String(e.register_number || e.registration_number || ""),
            lane: Number(e.boat_number),
          }))
          .filter((x) => /^\d{4}$/.test(x.registration_number) && x.lane >= 1 && x.lane <= 6);
        if (!reqEntries.length) { setStatsByKey({}); return; }
        const res = await base44.functions.invoke("getLanePast10Stats", {
          entries: reqEntries,
          race_date: race?.race_date || null,
        });
        if (!cancelled) setStatsByKey(res?.data?.by_key || {});
      } catch (e) {
        console.error("LanePast10 fetch error:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [reqKey, race?.race_date]);

  if (!entries.length) {
    return <div className="py-12 text-center text-slate-500 text-sm">出走表データがありません</div>;
  }

  return (
    <div className="bg-slate-900 overflow-x-auto [-webkit-overflow-scrolling:touch] pb-4">
      <table className="border-collapse min-w-[760px] w-full">
        {/* ヘッダー: 2段 */}
        <thead>
          <tr className="bg-slate-800">
            <th rowSpan={2} className="sticky left-0 z-30 bg-slate-800 border border-slate-700 px-2 py-1 text-left font-bold text-slate-400 text-[10px] min-w-[200px] w-[200px]">
              選手情報
            </th>
            {Array.from({ length: 10 }).map((_, i) => (
              <th key={i} className="border border-slate-700 py-1 text-center font-bold text-slate-500 text-[9px] w-[42px]">
                {i === 9 ? "前走" : `${10 - i}走`}
              </th>
            ))}
            <th rowSpan={2} className="border border-slate-700 py-1 text-center font-bold text-slate-500 text-[9px] w-[42px]">勝率</th>
            <th rowSpan={2} className="border border-slate-700 py-1 text-center font-bold text-slate-500 text-[9px] w-[48px]">平均ST</th>
            <th rowSpan={2} className="border border-slate-700 py-1 text-center font-bold text-slate-500 text-[9px] w-[42px]">ST順</th>
          </tr>
          <tr className="bg-slate-800">
            {Array.from({ length: 10 }).map((_, i) => (
              <th key={i} className="border border-slate-700 py-0.5 text-center text-slate-600 text-[8px] w-[42px]">
                進入/着
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const reg = String(e.register_number || e.registration_number || "");
            const stats = statsByKey[`${reg}_${e.boat_number}`];
            const isError = stats?.status === "error";
            const isNoData = (!stats && !loading) || (stats && !isError && (stats.total_lane_count ?? 0) === 0);
            const isLoading = loading && !stats;
            const profile = stats?.profile || {};
            const recent10 = stats?.recent10 || [];

            return (
              <React.Fragment key={e.boat_number}>
                {/* 上段: 進入コース */}
                <tr className="bg-slate-800/40">
                  <td rowSpan={2} className="sticky left-0 z-20 bg-slate-800 border border-slate-700 px-1.5 py-1 align-top">
                    <RacerInfo e={e} reg={reg} profile={profile} sampleCount={stats?.sample_count} />
                  </td>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <CourseCell key={i} h={recent10[i]} loading={isLoading} isError={isError} />
                  ))}
                  <StatCell rowSpan={2} value={stats?.winning_rate != null ? Number(stats.winning_rate).toFixed(2) : "—"} loading={isLoading} isError={isError} isNoData={isNoData} highlight />
                  <StatCell rowSpan={2} value={stats?.avg_st != null ? Number(stats.avg_st).toFixed(2) : "—"} loading={isLoading} isError={isError} isNoData={isNoData} mono />
                  <StatCell rowSpan={2} value={stats?.avg_start_order != null ? Number(stats.avg_start_order).toFixed(1) : "—"} loading={isLoading} isError={isError} isNoData={isNoData} />
                </tr>
                {/* 下段: 着順 */}
                <tr className="bg-slate-800/40">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <FinishCell key={i} h={recent10[i]} loading={isLoading} isError={isError} />
                  ))}
                </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {loading && <div className="px-3 py-1 text-[10px] text-blue-400">取得中...</div>}
    </div>
  );
}

// 左側sticky: 選手情報ブロック
function RacerInfo({ e, reg, profile, sampleCount }) {
  return (
    <div className="flex items-start gap-1.5 py-0.5">
      <span className={cn("w-5 h-5 rounded flex items-center justify-center font-black text-[11px] shrink-0 mt-0.5", boatBadgeBg[e.boat_number])}>
        {e.boat_number}
      </span>
      <PlayerPhoto src={e.player_photo} registrationNumber={reg} alt={e.player_name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="text-[9px] text-slate-400 leading-tight">
          {e.player_class && <span className="font-bold text-slate-300">{e.player_class}</span>}
          {reg && <span className="ml-0.5">/ {reg}</span>}
        </div>
        <div className="font-bold text-slate-100 text-[12px] leading-tight truncate">{e.player_name || e.racer_name || `#${e.boat_number}`}</div>
        <div className="text-[9px] text-slate-500 leading-tight truncate">
          {profile.branch_name && `${profile.branch_name}`}
          {profile.birthplace && `/${profile.birthplace}`}
          {profile.age != null && `/${profile.age}歳`}
        </div>
        {sampleCount != null && sampleCount > 0 && <div className="text-[8px] text-slate-600 mt-px">同枠{sampleCount}走</div>}
      </div>
    </div>
  );
}

// 上段セル: 進入コース(コース番号カラー背景)
function CourseCell({ h, loading, isError }) {
  if (loading) return <td className="border border-slate-700 text-center text-slate-700 animate-pulse text-[10px] py-0.5">…</td>;
  if (isError || !h) return <td className="border border-slate-700 bg-slate-900/50 text-center text-slate-700 text-[10px] py-0.5">—</td>;
  const course = h.course;
  return (
    <td className={cn("border border-slate-700 text-center font-black text-[11px] py-0.5", course != null ? (courseBg[course] || "bg-slate-700 text-slate-300") : "bg-slate-900/50 text-slate-700")}>
      {course != null ? course : "—"}
    </td>
  );
}

// 下段セル: 着順(大)
function FinishCell({ h, loading, isError }) {
  if (loading) return <td className="border border-slate-700 text-center text-slate-700 animate-pulse text-[10px] py-0.5">…</td>;
  if (isError || !h) return <td className="border border-slate-700 bg-slate-900/50 text-center text-slate-700 text-[10px] py-0.5">—</td>;
  const finish = formatFinish(h);
  const special = isSpecial(h);
  return (
    <td className="border border-slate-700 bg-slate-800/60 text-center py-0.5">
      <span className={cn("text-[15px] leading-none", finishTextClass(finish, special))}>{finish}</span>
    </td>
  );
}

// 右端集計セル(rowSpan=2)
function StatCell({ value, loading, isError, isNoData, highlight, mono, rowSpan }) {
  const cls = cn(
    "border border-slate-700 bg-slate-800/60 text-center font-bold py-1",
    mono ? "font-mono text-[10px]" : "text-[11px]",
    highlight ? "text-slate-100" : "text-slate-300"
  );
  if (loading) return <td rowSpan={rowSpan} className={cn(cls, "text-slate-700 animate-pulse")}>…</td>;
  if (isError) return <td rowSpan={rowSpan} className={cn(cls, "text-rose-500 text-[9px]")}>エラー</td>;
  if (isNoData) return <td rowSpan={rowSpan} className={cn(cls, "text-slate-700 text-[9px]")}>—</td>;
  return <td rowSpan={rowSpan} className={cls}>{value}</td>;
}