import React from "react";
import { cn } from "@/lib/utils";

// 競艇標準色: 1=白 2=黒 3=赤 4=青 5=黄 6=緑
const boatColors = {
  1: { bg: "bg-white", text: "text-black", hex: "#ffffff", ring: "ring-white/30" },
  2: { bg: "bg-slate-800", text: "text-white", hex: "#475569", ring: "ring-slate-500/40" },
  3: { bg: "bg-rose-600", text: "text-white", hex: "#e11d48", ring: "ring-rose-500/40" },
  4: { bg: "bg-blue-600", text: "text-white", hex: "#2563eb", ring: "ring-blue-500/40" },
  5: { bg: "bg-amber-400", text: "text-black", hex: "#fbbf24", ring: "ring-amber-400/50" },
  6: { bg: "bg-emerald-600", text: "text-white", hex: "#059669", ring: "ring-emerald-500/40" },
};

// ST値フォーマット: 0.06→".06", -0.05→"F.05", null→"--", absent→"欠場"
function formatST(st, isAbsent) {
  if (isAbsent) return "欠場";
  if (st == null || !Number.isFinite(st)) return "--";
  if (st < 0) return `F${Math.abs(st).toFixed(2)}`;
  const s = st.toFixed(2);
  return s.startsWith("0.") ? s.slice(1) : s;
}

// F判定: ST < 0
function isFlying(st, stRaw) {
  const v = stRaw != null ? stRaw : st;
  return v != null && Number.isFinite(v) && v < 0;
}

// ST → 水平オフセット(%): 速い(低い)ほど右(ライン寄り)、Fはライン越え
function stToOffset(st, stRaw, minST, range) {
  const v = stRaw != null ? stRaw : st;
  if (v == null || !Number.isFinite(v)) return 50;
  if (v < 0) return 93; // F はライン越え
  const normalized = (v - minST) / range;
  return 86 - normalized * 66; // 20%〜86%
}

export default function StartTimingPanel({ entries, compact = false }) {
  // 1-6号艇を正順に揃える(欠場含む)
  const boats = [1, 2, 3, 4, 5, 6].map((n) => {
    const e = entries?.find((x) => x.boat_number === n);
    return e ? { ...e, boat_number: n } : { boat_number: n, is_absent: true, _missing: true };
  });

  // 展示データが1件でもあるか
  const hasExhibition = boats.some(
    (b) => !b._missing && (b.exhibition_st != null || b.exhibition_st_raw != null)
  );

  // === 未取得時 ===
  if (!hasExhibition) {
    return (
      <div className="rounded-xl border border-[#3a404c] overflow-hidden">
        <PanelTitle />
        <div className="bg-gradient-to-b from-[#0a1929] to-[#0d2540] px-3 py-6 text-center">
          <div className="text-slate-400 text-xs">スタート展示データ待ち</div>
        </div>
      </div>
    );
  }

  // ST正規化用: 有効ST値を収集
  const validSTs = boats
    .filter((b) => !b.is_absent && !b._missing)
    .map((b) => {
      const st = b.exhibition_st_raw != null ? b.exhibition_st_raw : b.exhibition_st;
      return st != null && Number.isFinite(st) ? st : null;
    })
    .filter((v) => v != null);

  const minST = validSTs.length ? Math.min(...validSTs) : 0;
  const maxST = validSTs.length ? Math.max(...validSTs) : 0.3;
  const range = Math.max(maxST - minST, 0.15);

  return (
    <div className="rounded-xl border border-[#3a404c] overflow-hidden">
      <PanelTitle />

      {/* パネル本体: 水面イメージの薄いブルー背景 */}
      <div className="bg-gradient-to-b from-[#0a1929] via-[#0d2540] to-[#0a1929] p-2 sm:p-2.5">
        {/* 列ヘッダ */}
        <div className="flex items-center text-[9px] text-blue-300/50 font-bold mb-1 px-0.5">
          <div className={cn("text-center font-bold", compact ? "w-6" : "w-7 sm:w-8")}>C</div>
          <div className="flex-1 text-center">並び</div>
          <div className={cn("text-center", compact ? "w-10" : "w-11 sm:w-12")}>ST</div>
        </div>

        {/* 6艇行 */}
        <div className="space-y-0.5">
          {boats.map((b) => {
            const color = boatColors[b.boat_number];
            const absent = b.is_absent || b.is_scratched || b._missing;
            const flying = !absent && isFlying(b.exhibition_st, b.exhibition_st_raw);
            const stVal = b.exhibition_st_raw != null ? b.exhibition_st_raw : b.exhibition_st;
            const stText = formatST(stVal, absent);
            const offset = absent ? 50 : stToOffset(b.exhibition_st, b.exhibition_st_raw, minST, range);

            return (
              <div
                key={b.boat_number}
                className={cn(
                  "flex items-center gap-1.5 rounded-md",
                  compact ? "h-7" : "h-8 sm:h-9",
                  absent && "opacity-40"
                )}
              >
                {/* 左: コース番号(色分け) */}
                <div
                  className={cn(
                    "rounded-md flex items-center justify-center font-black shrink-0 ring-1",
                    compact ? "w-6 h-6 text-xs" : "w-7 h-7 sm:w-8 sm:h-8 text-sm",
                    color.bg,
                    color.text,
                    color.ring
                  )}
                >
                  {b.boat_number}
                </div>

                {/* 中央: 水面トラック + ボート + スタートライン */}
                <div className="flex-1 relative rounded-md bg-gradient-to-r from-[#081626] via-[#0a2238] to-[#0e2d4a] overflow-hidden">
                  {/* 水面テクスチャ(波紋) */}
                  <div
                    className="absolute inset-0 opacity-25"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(90deg, transparent 0, transparent 5px, rgba(80,160,255,0.10) 5px, rgba(80,160,255,0.10) 6px)",
                    }}
                  />

                  {/* スタートライン(右側の縦線) */}
                  <div className="absolute right-2.5 top-0 bottom-0 w-[2px] bg-gradient-to-b from-transparent via-red-500/70 to-transparent" />
                  <div className="absolute right-0.5 top-0 bottom-0 flex items-center">
                    <span className="text-[7px] text-red-400/60 font-bold [writing-mode:vertical-rl] rotate-180">SL</span>
                  </div>

                  {/* ボートアイコン(ST位置に配置) */}
                  {!absent && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 transition-all duration-300"
                      style={{ left: `${offset}%`, transform: "translate(-50%, -50%)" }}
                    >
                      <BoatIcon hex={color.hex} flying={flying} />
                    </div>
                  )}

                  {/* 欠場表示 */}
                  {absent && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-[10px] text-slate-500 font-bold">欠場</span>
                    </div>
                  )}
                </div>

                {/* 右: ST値 */}
                <div
                  className={cn(
                    "text-center font-mono font-bold shrink-0",
                    compact ? "w-10 text-xs" : "w-11 sm:w-12 text-sm",
                    absent ? "text-slate-600" : flying ? "text-rose-400" : "text-slate-100"
                  )}
                >
                  {stText}
                </div>
              </div>
            );
          })}
        </div>

        {/* 凡例 */}
        <div className="mt-1.5 flex items-center justify-end gap-2 text-[8px] text-slate-500">
          <span className="flex items-center gap-0.5">
            <span className="inline-block w-2 h-0.5 bg-red-500/60" /> スタートライン
          </span>
          <span className="text-rose-400">F=フライング</span>
        </div>
      </div>
    </div>
  );
}

// パネルタイトル
function PanelTitle() {
  return (
    <div className="px-3 py-1.5 bg-[#0d2540] border-b border-blue-900/40">
      <div className="text-blue-300 font-bold text-xs flex items-center gap-1.5">
        <span className="inline-block w-1 h-3 bg-blue-400 rounded-full" />
        スタート展示
      </div>
    </div>
  );
}

// ボートアイコン(上から見たシルエット)
function BoatIcon({ hex, flying }) {
  return (
    <svg
      width="20"
      height="13"
      viewBox="0 0 20 13"
      className={flying ? "drop-shadow-[0_0_4px_rgba(244,63,94,0.9)]" : "drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]"}
    >
      {/* 船体(矢印形) */}
      <path
        d="M3 5 L14 5 L12 10 L5 10 Z M10 1 L15 5 L5 5 Z"
        fill={hex}
        stroke="rgba(0,0,0,0.4)"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      {flying && (
        <circle cx="17" cy="6" r="1.8" fill="#f43f5e" stroke="#fff" strokeWidth="0.5" />
      )}
    </svg>
  );
}