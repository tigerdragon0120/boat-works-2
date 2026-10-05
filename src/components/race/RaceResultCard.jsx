import React from "react";
import { cn } from "@/lib/utils";
import { parseRacerIdentity } from "@/lib/racerIdentity";

// 艇番バッジ(白背景カード用)
const boatBadge = {
  1: "bg-white text-slate-900 border border-slate-400",
  2: "bg-slate-900 text-white border border-slate-900",
  3: "bg-rose-600 text-white border border-rose-600",
  4: "bg-blue-600 text-white border border-blue-600",
  5: "bg-amber-400 text-slate-900 border border-amber-400",
  6: "bg-emerald-600 text-white border border-emerald-600",
};

// 着順バッジ
const finishTone = {
  1: "bg-rose-500 text-white",
  2: "bg-slate-700 text-white",
  3: "bg-amber-500 text-slate-900",
};

// 券種 → RaceResult.payoutsのキー候補。存在するものだけ表示する。
const PAYOUT_KINDS = [
  { label: "3連単", keys: ["trifecta"] },
  { label: "3連複", keys: ["trifecta_quinella", "trio"] },
  { label: "2連単", keys: ["exacta"] },
  { label: "2連複", keys: ["quinella"] },
  { label: "拡連複", keys: ["wide"] },
  { label: "単勝", keys: ["win", "tansho"] },
  { label: "複勝", keys: ["place", "fukusho", "show"] },
];

function formatStartedAt(race) {
  const iso = race?.start_time || race?.deadline;
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// 着順データ: finish_order優先、空ならresult_trifectaを分解して1〜3着に使う
function resolveFinishBoats(raceResult) {
  const source = raceResult?.finish_order?.length
    ? raceResult.finish_order
    : String(raceResult?.result_trifecta || "").split("-");
  return source.map(Number).filter((n) => n >= 1 && n <= 6).slice(0, 3);
}

function buildPayoutRows(raceResult) {
  const payouts = raceResult?.payouts || {};
  const rows = [];
  for (const kind of PAYOUT_KINDS) {
    const raw = kind.keys.map((key) => payouts[key]).find((v) => v != null && (Array.isArray(v) ? v.length > 0 : true));
    if (raw == null) continue;
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (item == null || (item.combination == null && item.payout == null)) continue;
      rows.push({ label: kind.label, combination: item.combination || "", payout: item.payout });
    }
  }
  // 3連単は必ずresult_trifecta/payoutでフォールバック表示する
  if (!rows.some((row) => row.label === "3連単") && raceResult?.result_trifecta) {
    rows.unshift({ label: "3連単", combination: raceResult.result_trifecta, payout: raceResult.payout });
  }
  return rows;
}

export default function RaceResultCard({ race, raceResult, entries = [] }) {
  if (!raceResult || !(raceResult.is_finished || raceResult.result_status === "RESULT_FINAL")) return null;

  const finishBoats = resolveFinishBoats(raceResult);
  const payoutRows = buildPayoutRows(raceResult);
  const startLabel = formatStartedAt(race);

  // 出走表: 重複があっても艇番ごとに最新1件を使う
  const entryByBoat = new Map();
  for (const entry of entries || []) {
    const boat = Number(entry?.boat_number);
    if (!(boat >= 1 && boat <= 6)) continue;
    const prev = entryByBoat.get(boat);
    if (!prev || String(entry.updated_date || "") > String(prev.updated_date || "")) entryByBoat.set(boat, entry);
  }

  return (
    <div className="rounded-xl border-2 border-rose-400 bg-white p-3 sm:p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="font-black text-slate-900 text-base sm:text-lg truncate">🏁 レース結果</h2>
          {race?.race_number ? <span className="text-[11px] font-bold text-slate-500 whitespace-nowrap">{race.race_number}R</span> : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="rounded-md bg-rose-500 px-2.5 py-1 text-[11px] font-black text-white whitespace-nowrap">確定</span>
          {startLabel && <span className="text-[11px] font-bold text-slate-500 whitespace-nowrap">{startLabel}</span>}
        </div>
      </div>

      {finishBoats.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-2">
          {finishBoats.map((boat, index) => {
            const entry = entryByBoat.get(boat);
            const identity = parseRacerIdentity(entry?.player_name || entry?.racer_name || "");
            const racerClass = entry?.player_class || entry?.grade_class || "";
            const sub = [identity.branch, racerClass].filter(Boolean).join(" / ");
            return (
              <div key={`${boat}-${index}`} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-2 sm:p-3 text-center">
                <span className={cn("inline-flex items-center justify-center rounded-md px-2 py-0.5 text-[10px] font-black", finishTone[index + 1] || "bg-slate-200 text-slate-700")}>
                  {index + 1}着
                </span>
                <div className="mt-1.5 flex items-center justify-center gap-1">
                  <span className={cn("w-6 h-6 rounded-md flex items-center justify-center text-xs font-black", boatBadge[boat] || "bg-slate-200 text-slate-700")}>{boat}</span>
                  <span className="text-[10px] font-bold text-slate-500">号艇</span>
                </div>
                <div className="mt-1 text-xs sm:text-sm font-black text-slate-900 truncate">{identity.name || "—"}</div>
                <div className="text-[10px] text-slate-500 truncate">{sub || "—"}</div>
              </div>
            );
          })}
        </div>
      )}

      {payoutRows.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="text-sm font-black text-slate-900">¥ 払戻金</div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:gap-x-6">
            {payoutRows.map((row, index) => (
              <div key={`${row.label}-${row.combination}-${index}`} className="flex items-center justify-between gap-1.5 min-w-0 rounded-md bg-slate-50 px-2 py-1">
                <span className="text-[11px] text-slate-500 whitespace-nowrap">
                  {row.label}
                  {row.combination && <span className="ml-1 font-mono font-bold text-slate-700">{row.combination}</span>}
                </span>
                <span className="text-[11px] sm:text-xs font-black text-rose-600 whitespace-nowrap">
                  {row.payout != null ? `${Number(row.payout).toLocaleString()}円` : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}