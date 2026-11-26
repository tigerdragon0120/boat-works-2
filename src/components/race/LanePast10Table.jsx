import React, { useEffect, useState, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import PlayerPhoto from "@/components/race/PlayerPhoto";
import { base44 } from "@/api/base44Client";
import {recentLaneTableView, recentLaneRequestKey, recentLaneReadySnapshotKey, recentLaneHistoryCells, recentLaneNumber,
  recentLaneTime, recentLaneReason} from '@/components/liveV8/v8RecentLaneView';

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

const BOAT_BRANCH_NAMES = [
  "群馬", "埼玉", "東京", "静岡", "愛知", "三重", "福井", "滋賀", "大阪",
  "兵庫", "徳島", "香川", "岡山", "広島", "山口", "福岡", "佐賀", "長崎",
];

function getRacerIdentity(e, profile) {
  const rawName = String(e.player_name || e.racer_name || `#${e.boat_number}`).trim();
  let name = rawName;
  let branch = String(profile.branch_name || "").trim();
  let birthplace = String(profile.birthplace || "").trim();

  if (branch) {
    const fullSuffix = birthplace ? `${branch}/${birthplace}` : branch;
    if (name.endsWith(fullSuffix)) name = name.slice(0, -fullSuffix.length).trim();
    else if (name.endsWith(branch)) name = name.slice(0, -branch.length).trim();
  }

  if ((!branch || !birthplace) && rawName.includes("/")) {
    const escapedBranches = BOAT_BRANCH_NAMES.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const match = rawName.match(new RegExp(`(${escapedBranches})/([^/\\s]+)$`));
    if (match) {
      name = rawName.slice(0, match.index).trim();
      branch ||= match[1];
      birthplace ||= match[2];
    }
  }

  return { name: name || rawName, branch, birthplace };
}

// 着順による文字色(ヒートマップ風)
function finishTextClass(finish, special) {
  if (special) return "text-rose-500";
  const n = Number(finish);
  if (!Number.isFinite(n)) return "text-slate-400";
  if (n === 1) return "text-white font-black";
  if (n === 2 || n === 3) return "text-slate-200 font-bold";
  if (n >= 4) return "text-slate-500";
  return "text-slate-400";
}

function formatFinish(h) {
  if (!h) return "—";
  if (h.finish_status) return h.finish_status;
  if (h.finish_order != null && Number.isFinite(h.finish_order)) return String(h.finish_order);
  return "—";
}

function isSpecial(h) {
  return !!(h?.finish_status && h.finish_status !== "");
}

// WAKU10安全表示ユーティリティ — NaN/undefined/null/空文字の画面露出を防止
// 数値1-6のみ有効、それ以外はnull(NaN防止)
function safeLaneNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

// The endpoint returns the exact normalized BOATCAST snapshot used by V8.
// Authentication and cache-only access are handled on the server.
export default function LanePast10Table({ entries, race, v8Forecasts = null }) {
  const requestKey = useMemo(() => recentLaneRequestKey(race, entries),
    [race?.id, race?.race_key, race?.race_date, race?.venue_code, race?.race_number, entries]);
  const parameters = useMemo(() => ({race_id: race?.id, race_key: race?.race_key,
    race_date: race?.race_date, venue_code: String(race?.venue_code || '').padStart(2, '0'),
    race_number: Number(race?.race_number)}),
    [race?.id, race?.race_key, race?.race_date, race?.venue_code, race?.race_number]);
  const snapshotKey = useMemo(() => recentLaneReadySnapshotKey(v8Forecasts, race), [v8Forecasts, race?.id, race?.race_key]);
  const lastRead = useRef({key: null, snapshotKey: ''}), sequence = useRef(0);
  const [result, setResult] = useState({key: null, snapshotKey: '', data: null, loading: false, error: null});
  const current = result.key === requestKey && (!snapshotKey || result.snapshotKey === snapshotKey)
    ? result : {data: null, loading: true, error: null};
  const view = useMemo(() => recentLaneTableView(current.data, entries, race, v8Forecasts),
    [current.data, entries, race, v8Forecasts]);
  const statsByKey = Object.fromEntries(view.rows.map(row => [`${row.registration_number}_${row.boat_number}`, {
    ...row, recent10: recentLaneHistoryCells(row), sample_count: row.sample_size,
    total_lane_count: row.history.length, profile: {}, status: row.available ? 'ok' : 'unavailable',
  }]));
  const loading = current.loading;

  useEffect(() => () => { sequence.current++; lastRead.current = {key: null, snapshotKey: ''}; }, [requestKey]);
  useEffect(() => {
    if (lastRead.current.key === requestKey && (!snapshotKey || lastRead.current.snapshotKey === snapshotKey)) return;
    lastRead.current = {key: requestKey, snapshotKey};
    const request = ++sequence.current;
    setResult({key: requestKey, snapshotKey, data: null, loading: true, error: null});
    if (!parameters.race_id || !parameters.race_date || !parameters.race_number) {
      setResult({key: requestKey, snapshotKey, data: null, loading: false, error: '対象レースの確認待ちです。'});
      return;
    }
    (async () => {
      try {
        const response = await base44.functions.invoke('fetchBoatcastWaku10', parameters);
        const data = response?.data || null;
        if (sequence.current === request) setResult({key: requestKey, snapshotKey, data, loading: false,
          error: data?.ok === false ? recentLaneReason(data.reason) : null});
      } catch {
        if (sequence.current === request) setResult({key: requestKey, snapshotKey, data: null, loading: false,
          error: '枠番過去10走を取得できませんでした。次の読み込みをお待ちください。'});
      }
    })();
  }, [requestKey, parameters, snapshotKey]);

  if (!entries.length) {
    return <div className="py-12 text-center text-slate-500 text-sm">出走表データがありません</div>;
  }

  return (
    <div className="bg-slate-900 overflow-x-auto [-webkit-overflow-scrolling:touch] pb-4">
      <table className="border-collapse min-w-[808px] w-full table-fixed">
        <colgroup>
          <col className="w-[200px]" />
          {Array.from({ length: 10 }).map((_, i) => <col key={`history-col-${i}`} className="w-[44px]" />)}
          <col className="w-[56px]" />
          <col className="w-[56px]" />
          <col className="w-[56px]" />
        </colgroup>
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
            <th rowSpan={2} className="border border-slate-700 py-1 text-center font-bold text-slate-500 text-[9px] w-[42px]">勝率<br/>（着順点）</th>
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
            const reg = String(e.registration_number ?? e.register_number ?? "").trim();
            const stats = statsByKey[`${reg}_${e.boat_number}`];
            const isError = false;
            const isNoData = !stats?.available || (stats.total_lane_count ?? 0) === 0;
            const isLoading = loading && !stats?.available;
            const profile = stats?.profile || {};
            const recent10 = stats?.recent10 || [];

            return (
              <React.Fragment key={e.boat_number}>
                {/* 上段: 進入コース */}
                <tr className="bg-slate-800/40">
                  <td rowSpan={2} className="sticky left-0 z-20 bg-slate-800 border border-slate-700 px-1.5 py-1 align-top">
                    <RacerInfo e={e} reg={reg} profile={profile} sampleCount={stats?.sample_count} normalCount={stats?.normal_sample_size} adoption={stats?.adoption} reason={!loading && !stats?.available ? recentLaneReason(stats?.reason) : null}/>
                  </td>
                  {Array.from({ length: 10 }).map((_, i) => (
                    <CourseCell key={i} h={recent10[i]} loading={isLoading} isError={isError} />
                  ))}
                  <StatCell rowSpan={2} value={recentLaneNumber(stats?.winning_rate)} loading={isLoading} isError={isError} isNoData={isNoData} highlight />
                  <StatCell rowSpan={2} value={recentLaneNumber(stats?.avg_st)} loading={isLoading} isError={isError} isNoData={isNoData} mono />
                  <StatCell rowSpan={2} value={recentLaneNumber(stats?.avg_start_order, 1)} loading={isLoading} isError={isError} isNoData={isNoData} />
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
      {current.error && <p role="status" className="px-3 py-2 text-[11px] leading-5 text-amber-200">{current.error}</p>}
      <div className="space-y-1 px-3 py-2 text-[10px] leading-5 text-slate-400">
        <p><span className="font-semibold text-blue-300">BOATCAST {view.available}/{view.total}艇</span>{view.available > 0 && <> · 取得 {recentLaneTime(current.data?.metadata?.fetched_at || view.rows.find(row => row.available)?.fetched_at)}</>}</p>
        <p>勝率は0〜10の着順点の平均です。1着率（%）とは異なります。平均STは秒、ST順は順位です。</p>
        {v8Forecasts && <p>「反映」は保存したV8予想と同じ取得記録・内容を使い、計算に適用した艇だけに表示します。</p>}
      </div>
    </div>
  );
}

// 左側sticky: 選手情報ブロック
function RacerInfo({ e, reg, profile, sampleCount, normalCount, adoption, reason }) {
  const identity = getRacerIdentity(e, profile);

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
        <div className="font-bold text-slate-100 text-[12px] leading-tight truncate">{identity.name}</div>
        {(identity.branch || identity.birthplace || profile.age != null) && (
          <div className="mt-1 text-[9px] text-slate-500 leading-tight truncate">
            {identity.branch}
            {identity.branch && identity.birthplace && <span className="mx-1 text-slate-600">/</span>}
            {identity.birthplace}
            {profile.age != null && <span className="ml-1.5">{profile.age}歳</span>}
          </div>
        )}
        {sampleCount != null && <div className="mt-1 text-[9px] text-slate-400">同枠{sampleCount}走{normalCount != null ? ` · 正常着順${normalCount}走` : ''}</div>}
        {adoption && adoption.kind !== 'UNAVAILABLE' && <div className={`mt-1 text-[9px] leading-4 ${adoption.kind === 'APPLIED' ? 'font-semibold text-sky-300' : 'text-slate-400'}`}>{adoption.label}</div>}
        {reason && <div className="mt-1 text-[9px] leading-4 text-amber-200">{reason}</div>}
      </div>
    </div>
  );
}

// 上段セル: 進入コース(コース番号カラー背景)
function CourseCell({ h, loading, isError }) {
  if (loading) return <td className="border border-slate-700 text-center text-slate-700 animate-pulse text-[10px] py-0.5">…</td>;
  if (isError || !h) return <td className="border border-slate-700 bg-slate-900/50 text-center text-slate-700 text-[10px] py-0.5">—</td>;
  const course = safeLaneNumber(h.course);
  return (
    <td title={h.course_inferred ? '元データの枠なり表記から補完' : undefined} className={cn("border border-slate-700 text-center font-black text-[11px] py-0.5", course != null ? (courseBg[course] || "bg-slate-700 text-slate-300") : "bg-slate-900/50 text-slate-700")}>
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
function StatCell({ value, loading, isError, isNoData, highlight = false, mono = false, rowSpan }) {
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
