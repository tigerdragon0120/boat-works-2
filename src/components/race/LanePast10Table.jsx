import React, { useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import PlayerPhoto from "@/components/race/PlayerPhoto";
import { base44 } from "@/api/base44Client";

// 進入コース別カラー(BOATCAST準拠) — 過去レースで実際に何コース進入したか
const courseBg = {
  1: "bg-white text-slate-900 border border-slate-300",
  2: "bg-slate-500 text-white",
  3: "bg-rose-500 text-white",
  4: "bg-blue-500 text-white",
  5: "bg-amber-400 text-slate-900",
  6: "bg-emerald-500 text-white",
};

const boatBadge = {
  1: "bg-white text-slate-900 border border-slate-400",
  2: "bg-slate-500 text-white",
  3: "bg-rose-500 text-white",
  4: "bg-blue-500 text-white",
  5: "bg-amber-400 text-slate-900",
  6: "bg-emerald-500 text-white",
};

function formatFinish(h) {
  if (!h) return "—";
  if (h.finish_status) return h.finish_status;
  if (h.finish_order != null) return String(h.finish_order);
  return "—";
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
    <div className="overflow-x-auto [-webkit-overflow-scrolling:touch] pb-6">
      <table className="border-collapse min-w-[820px]">
        {/* ヘッダー: 2段 */}
        <thead>
          <tr className="bg-slate-100">
            <th rowSpan={2} className="sticky left-0 z-30 bg-slate-100 border-2 border-slate-400 px-2 py-1 text-left font-bold text-slate-700 text-[10px] min-w-[210px] w-[210px]">
              選手情報
            </th>
            {Array.from({ length: 10 }).map((_, i) => (
              <th key={i} className="border border-slate-300 py-0.5 text-center font-bold text-slate-600 text-[9px] w-[42px]">
                {i === 9 ? "前走" : `${10 - i}走前`}
              </th>
            ))}
            <th rowSpan={2} className="border-2 border-slate-400 py-1 text-center font-bold text-slate-700 text-[9px] w-[42px]">1着率</th>
            <th rowSpan={2} className="border-2 border-slate-400 py-1 text-center font-bold text-slate-700 text-[9px] w-[42px]">2連対</th>
            <th rowSpan={2} className="border-2 border-slate-400 py-1 text-center font-bold text-slate-700 text-[9px] w-[42px]">3連対</th>
            <th rowSpan={2} className="border-2 border-slate-400 py-1 text-center font-bold text-slate-700 text-[9px] w-[48px]">平均ST</th>
            <th rowSpan={2} className="border-2 border-slate-400 py-1 text-center font-bold text-slate-700 text-[9px] w-[42px]">ST順</th>
          </tr>
          <tr className="bg-slate-100">
            {Array.from({ length: 10 }).map((_, i) => (
              <th key={i} className="border border-slate-300 py-0.5 text-center text-slate-400 text-[8px] w-[42px]">
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
                <tr>
                  <td rowSpan={2} className="sticky left-0 z-20 bg-white border-2 border-slate-300 px-1.5 py-0.5 align-top">
                    <RacerInfo e={e} reg={reg} profile={profile} sampleCount={stats?.sample_count} />
                  </td>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <CourseCell key={i} h={recent10[i]} loading={isLoading} isError={isError} />
                  ))}
                  <StatCell rowSpan={2} value={stats?.win_rate != null ? `${stats.win_rate}%` : "—"} loading={isLoading} isError={isError} isNoData={isNoData} highlight />
                  <StatCell rowSpan={2} value={stats?.top2_rate != null ? `${stats.top2_rate}%` : "—"} loading={isLoading} isError={isError} isNoData={isNoData} />
                  <StatCell rowSpan={2} value={stats?.top3_rate != null ? `${stats.top3_rate}%` : "—"} loading={isLoading} isError={isError} isNoData={isNoData} />
                  <StatCell rowSpan={2} value={stats?.avg_st != null ? Number(stats.avg_st).toFixed(3) : "—"} loading={isLoading} isError={isError} isNoData={isNoData} mono />
                  <StatCell rowSpan={2} value={stats?.avg_start_order != null ? Number(stats.avg_start_order).toFixed(1) : "—"} loading={isLoading} isError={isError} isNoData={isNoData} />
                </tr>
                {/* 下段: 着順 */}
                <tr>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <FinishCell key={i} h={recent10[i]} loading={isLoading} isError={isError} />
                  ))}
                </tr>
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {loading && <div className="px-3 py-1 text-[10px] text-blue-500">取得中...</div>}
    </div>
  );
}

// 左側sticky: 選手情報ブロック
function RacerInfo({ e, reg, profile, sampleCount }) {
  return (
    <div className="flex items-start gap-1.5 py-0.5">
      <span className={cn("w-5 h-5 rounded flex items-center justify-center font-black text-[10px] shrink-0 mt-0.5", boatBadge[e.boat_number])}>
        {e.boat_number}
      </span>
      <PlayerPhoto src={e.player_photo} registrationNumber={reg} alt={e.player_name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="font-bold text-slate-900 text-[11px] truncate">{e.player_name || e.racer_name || `#${e.boat_number}`}</span>
          {e.player_class && <span className="text-[8px] px-0.5 rounded bg-slate-200 text-slate-700 font-bold shrink-0">{e.player_class}</span>}
        </div>
        <div className="text-[9px] text-slate-500 truncate">
          {reg && `登${reg}`}
          {profile.branch_name && ` · ${profile.branch_name}`}
          {profile.birthplace && ` · ${profile.birthplace}`}
          {profile.age != null && ` · ${profile.age}歳`}
        </div>
        {sampleCount != null && sampleCount > 0 && <div className="text-[8px] text-slate-400">同枠{sampleCount}走</div>}
      </div>
    </div>
  );
}

// 上段セル: 進入コース(艇番カラー背景)
function CourseCell({ h, loading, isError }) {
  if (loading) return <td className="border border-slate-300 text-center text-slate-300 animate-pulse text-[10px] py-0.5">…</td>;
  if (isError || !h) return <td className="border border-slate-300 text-center text-slate-300 text-[10px] py-0.5">—</td>;
  const course = h.course;
  return (
    <td className={cn("border border-slate-300 text-center font-black text-[11px] py-0.5", course != null ? (courseBg[course] || "bg-slate-100 text-slate-400") : "bg-white text-slate-300")}>
      {course != null ? course : "—"}
    </td>
  );
}

// 下段セル: 着順(大) + ST(極小)
function FinishCell({ h, loading, isError }) {
  if (loading) return <td className="border border-slate-300 text-center text-slate-300 animate-pulse text-[10px] py-0.5">…</td>;
  if (isError || !h) return <td className="border border-slate-300 text-center text-slate-300 text-[10px] py-0.5">—</td>;
  const finish = formatFinish(h);
  const special = isSpecial(h);
  const st = h.st != null ? Number(h.st).toFixed(2) : "";
  return (
    <td className="border border-slate-300 text-center py-0.5">
      <div className={cn("text-[13px] font-black leading-none", special ? "text-rose-600" : "text-slate-900")}>{finish}</div>
      {st && <div className="text-[8px] text-slate-400 font-mono leading-none mt-px">{st}</div>}
    </td>
  );
}

// 右端集計セル(rowSpan=2)
function StatCell({ value, loading, isError, isNoData, highlight, mono, rowSpan }) {
  const cls = cn(
    "border-2 border-slate-300 text-center font-bold py-1",
    mono ? "font-mono text-[10px]" : "text-[11px]",
    highlight ? "text-slate-900" : "text-slate-700"
  );
  if (loading) return <td rowSpan={rowSpan} className={cn(cls, "text-slate-300 animate-pulse")}>…</td>;
  if (isError) return <td rowSpan={rowSpan} className={cn(cls, "text-rose-500 text-[9px]")}>エラー</td>;
  if (isNoData) return <td rowSpan={rowSpan} className={cn(cls, "text-slate-400 text-[9px]")}>—</td>;
  return <td rowSpan={rowSpan} className={cls}>{value}</td>;
}