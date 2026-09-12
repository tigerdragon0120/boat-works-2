import React, { useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import PlayerPhoto from "@/components/race/PlayerPhoto";
import { base44 } from "@/api/base44Client";

// 色定義: 行全体をベタ塗りせず、バッジ・アクセントとして使用
const boatBadgeColors = {
  1: "bg-white text-black border border-slate-400",
  2: "bg-slate-700 text-white",
  3: "bg-rose-600 text-white",
  4: "bg-blue-600 text-white",
  5: "bg-amber-400 text-black",
  6: "bg-emerald-600 text-white",
};

const courseBadgeColors = {
  1: "bg-white text-black border border-slate-300",
  2: "bg-slate-600 text-white",
  3: "bg-rose-500 text-white",
  4: "bg-blue-500 text-white",
  5: "bg-amber-300 text-black",
  6: "bg-emerald-500 text-white",
};

const specialStyle = {
  F: "text-rose-600",
  L: "text-amber-600",
  L0: "text-amber-600",
  L1: "text-amber-600",
  K0: "text-purple-600",
  K1: "text-purple-600",
  S0: "text-purple-600",
  S1: "text-purple-600",
  S2: "text-purple-600",
  ABS: "text-slate-400",
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
        if (!reqEntries.length) {
          setStatsByKey({});
          return;
        }
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
    return () => {
      cancelled = true;
    };
  }, [reqKey, race?.race_date]);

  if (!entries.length) {
    return <div className="py-12 text-center text-slate-500 text-sm">出走表データがありません</div>;
  }

  return (
    <div className="overflow-x-auto text-[11px] [-webkit-overflow-scrolling:touch]">
      <table className="border-collapse min-w-[1000px]">
        {/* ヘッダー */}
        <thead>
          <tr className="bg-slate-50 border-b-2 border-slate-300">
            <th className="sticky left-0 z-20 bg-slate-50 px-2 py-1.5 text-left font-bold text-slate-600 text-[10px] min-w-[185px] border-r border-slate-200">
              選手情報
            </th>
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
              <th key={n} className="px-1 py-1.5 text-center font-bold text-slate-500 text-[10px] min-w-[52px]">
                {n === 1 ? "前走" : `${n}走前`}
              </th>
            ))}
            <th className="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[38px]">走数</th>
            <th className="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[44px]">1着率</th>
            <th className="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[44px]">2連対</th>
            <th className="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[44px]">3連対</th>
            <th className="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[48px]">平均ST</th>
            <th className="px-1 py-1.5 text-center font-bold text-slate-600 text-[10px] min-w-[38px]">ST順</th>
          </tr>
        </thead>
        {/* ボディ */}
        <tbody>
          {entries.map((e) => {
            const reg = String(e.register_number || e.registration_number || "");
            const stats = statsByKey[`${reg}_${e.boat_number}`];
            const isError = stats?.status === "error";
            const isNoData = (!stats && !loading) || (stats && !isError && (stats.total_lane_count ?? 0) === 0);
            const isLoading = loading && !stats;
            const profile = stats?.profile || {};

            return (
              <tr key={e.boat_number} className="border-b border-slate-200 hover:bg-slate-50/50">
                {/* sticky左: 選手情報 */}
                <td className="sticky left-0 z-10 bg-white px-2 py-1.5 border-r border-slate-200 min-w-[185px]">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "w-5 h-5 rounded flex items-center justify-center font-black text-[10px] shrink-0",
                        boatBadgeColors[e.boat_number]
                      )}
                    >
                      {e.boat_number}
                    </span>
                    <PlayerPhoto
                      src={e.player_photo}
                      registrationNumber={reg}
                      alt={e.player_name}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="font-bold text-slate-900 text-[11px] truncate">
                          {e.player_name || e.racer_name || `#${e.boat_number}`}
                        </span>
                        {e.player_class && (
                          <span className="text-[8px] px-0.5 rounded bg-slate-200 text-slate-700 font-bold shrink-0">
                            {e.player_class}
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] text-slate-500 truncate">
                        {reg && `登${reg}`}
                        {profile.branch_name && ` · ${profile.branch_name}`}
                        {profile.birthplace && ` · ${profile.birthplace}`}
                        {profile.age != null && ` · ${profile.age}歳`}
                      </div>
                    </div>
                  </div>
                </td>
                {/* 過去10走セル */}
                {Array.from({ length: 10 }).map((_, i) => (
                  <PastRaceCell key={i} h={stats?.recent10?.[i]} loading={isLoading} isError={isError} />
                ))}
                {/* 集計欄 */}
                <AggCell value={`${stats?.sample_count ?? 0}走`} loading={isLoading} isError={isError} isNoData={isNoData} />
                <AggCell
                  value={stats?.win_rate != null ? `${stats.win_rate}%` : "—"}
                  loading={isLoading}
                  isError={isError}
                  isNoData={isNoData}
                  highlight
                />
                <AggCell
                  value={stats?.top2_rate != null ? `${stats.top2_rate}%` : "—"}
                  loading={isLoading}
                  isError={isError}
                  isNoData={isNoData}
                />
                <AggCell
                  value={stats?.top3_rate != null ? `${stats.top3_rate}%` : "—"}
                  loading={isLoading}
                  isError={isError}
                  isNoData={isNoData}
                />
                <AggCell
                  value={stats?.avg_st != null ? Number(stats.avg_st).toFixed(3) : "—"}
                  loading={isLoading}
                  isError={isError}
                  isNoData={isNoData}
                  mono
                />
                <AggCell
                  value={stats?.avg_start_order != null ? Number(stats.avg_start_order).toFixed(1) : "—"}
                  loading={isLoading}
                  isError={isError}
                  isNoData={isNoData}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-3 py-2 text-[10px] text-slate-400">
        現在の枠番と同じ枠で走った過去10走を表示。各セル: 進入コース・着順・ST・ST順位。左が10走前、右が前走。
        {loading && <span className="text-blue-500 ml-2">取得中...</span>}
      </div>
    </div>
  );
}

function PastRaceCell({ h, loading, isError }) {
  if (loading) {
    return (
      <td className="px-0.5 py-1 text-center min-w-[52px]">
        <div className="text-slate-300 animate-pulse">…</div>
      </td>
    );
  }
  if (isError) {
    return (
      <td className="px-0.5 py-1 text-center min-w-[52px]">
        <div className="text-slate-300">—</div>
      </td>
    );
  }
  if (!h) {
    return (
      <td className="px-0.5 py-1 text-center min-w-[52px]">
        <div className="text-slate-300">—</div>
      </td>
    );
  }

  const course = h.course;
  const finish = formatFinish(h);
  const special = isSpecial(h);
  const st = h.st != null ? Number(h.st).toFixed(2) : "—";
  const stOrder = h.start_order ?? "—";

  return (
    <td className="px-0.5 py-1 text-center min-w-[52px]">
      <div className="flex items-center justify-center gap-0.5">
        {course != null ? (
          <span
            className={cn(
              "w-4 h-4 rounded-sm flex items-center justify-center text-[8px] font-black",
              courseBadgeColors[course] || "bg-slate-200 text-slate-600"
            )}
          >
            {course}
          </span>
        ) : (
          <span className="w-4 h-4 rounded-sm flex items-center justify-center text-[8px] font-black bg-slate-100 text-slate-400">
            -
          </span>
        )}
        <span
          className={cn(
            "text-[11px] font-black",
            special ? specialStyle[h.finish_status] || "text-rose-500" : "text-slate-900"
          )}
        >
          {finish}
        </span>
      </div>
      <div className="text-[9px] text-slate-500 mt-0.5 font-mono leading-none">{st}</div>
      <div className="text-[8px] text-slate-400 leading-none mt-0.5">順{stOrder}</div>
    </td>
  );
}

function AggCell({ value, loading, isError, isNoData, highlight, mono }) {
  if (loading) {
    return (
      <td className="px-1 py-1 text-center min-w-[38px]">
        <span className="text-slate-300 animate-pulse">…</span>
      </td>
    );
  }
  if (isError) {
    return (
      <td className="px-1 py-1 text-center min-w-[38px]">
        <span className="text-rose-500 text-[9px] font-bold">取得エラー</span>
      </td>
    );
  }
  if (isNoData) {
    return (
      <td className="px-1 py-1 text-center min-w-[38px]">
        <span className="text-slate-400 text-[9px]">データなし</span>
      </td>
    );
  }
  return (
    <td
      className={cn(
        "px-1 py-1 text-center font-bold min-w-[38px]",
        highlight ? "text-slate-900" : "text-slate-700",
        mono && "font-mono"
      )}
    >
      {value}
    </td>
  );
}