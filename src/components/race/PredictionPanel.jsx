import React from "react";
import { cn } from "@/lib/utils";
import { Crown, Shield, Sparkles, TrendingUp, Gauge, Trophy, Zap } from "lucide-react";
import PlayerPhoto from "@/components/race/PlayerPhoto";

const gradeStyle = {
  S: "border-fuchsia-400 text-fuchsia-300 bg-fuchsia-500/10",
  A: "border-amber-400 text-amber-300 bg-amber-400/10",
  B: "border-emerald-500 text-emerald-300 bg-emerald-500/10",
  C: "border-slate-600 text-slate-400 bg-slate-700/20",
};

const judgmentStyle = {
  STRONG_BUY: "text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-400/40",
  BUY: "text-rose-400 bg-rose-500/10 border-rose-400/40",
  WATCH: "text-amber-300 bg-amber-400/10 border-amber-400/40",
  SKIP: "text-slate-400 bg-slate-700/20 border-slate-600",
  PENDING: "text-slate-500 bg-slate-700/20 border-slate-600",
};

const boatColors = {
  1: "bg-white text-black",
  2: "bg-slate-500 text-white",
  3: "bg-rose-600 text-white",
  4: "bg-blue-600 text-white",
  5: "bg-amber-400 text-black",
  6: "bg-emerald-600 text-white",
};

export default function PredictionPanel({ race, pre, fin, view, setView, run, busy, entries, activePred, activeBoats, allTri, betPlan, compareData }) {
  const hasPred = pre || fin;
  return (
    <div className="bg-[#1e232d] rounded-xl border border-[#3a404c] overflow-hidden flex flex-col h-full">
      {/* ヘッダー: 動画プレイヤー風 */}
      <div className="px-3 sm:px-4 py-2.5 border-b border-[#3a404c] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-black text-white text-base sm:text-lg">{race.venue || "—"}</span>
          <span className="text-xs text-slate-400">{race.race_number}R</span>
        </div>
        <div className="flex gap-1">
          {pre && <TabBtn active={view === "PRE"} onClick={() => setView("PRE")} label="PRE" />}
          {fin && <TabBtn active={view === "FINAL"} onClick={() => setView("FINAL")} label="FINAL" />}
        </div>
      </div>

      {/* 予想サマリー本体 (動画枠の代わり) */}
      <div className="flex-1 p-3 sm:p-4 bg-gradient-to-b from-[#1e232d] to-[#161a22] flex flex-col">
        {!hasPred ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-10">
            <div className="w-16 h-16 rounded-full bg-[#2c3546] flex items-center justify-center mb-3">
              <Zap className="w-8 h-8 text-[#f9c836]" />
            </div>
            <div className="text-slate-300 font-semibold text-sm mb-1">予想未実行</div>
            <div className="text-slate-500 text-xs mb-4">PRE/FINAL予想を実行すると<br />ここにサマリーが表示されます</div>
            <div className="flex gap-2 w-full max-w-xs">
              <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
                className="flex-1 h-10 rounded-lg bg-[#2c3546] border border-[#3a404c] text-slate-200 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-[#374056] disabled:opacity-50">
                <Zap className="w-4 h-4" /> PRE
              </button>
              <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0}
                className="flex-1 h-10 rounded-lg bg-[#f9c836] text-slate-950 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-amber-300 disabled:opacity-50">
                <Gauge className="w-4 h-4" /> FINAL
              </button>
            </div>
            {busy && <div className="text-xs text-[#f9c836] mt-3 animate-pulse">計算中…</div>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* グレード + 判定 */}
            <div className="flex items-center gap-3">
              <div className={cn("w-14 h-14 border-2 rounded-xl flex items-center justify-center text-3xl font-black", gradeStyle[activePred?.prediction_grade || "C"])}>
                {activePred?.prediction_grade || "C"}
              </div>
              <div className="flex-1">
                <div className="text-[10px] text-slate-500 mb-0.5">総合判定</div>
                <div className={cn("inline-block px-2.5 h-7 rounded-lg text-sm font-black border flex items-center", judgmentStyle[activePred?.top_judgment || "PENDING"])}>
                  {activePred?.top_judgment === "STRONG_BUY" ? "STRONG BUY" : activePred?.top_judgment || "PENDING"}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-500">信頼度</div>
                <div className="font-black text-lg text-slate-200">{activePred?.data_confidence ?? "—"}</div>
              </div>
            </div>

            {/* 本命/対抗/穴 */}
            <div className="grid grid-cols-3 gap-2">
              <RoleBox label="本命" n={activePred?.honmei_boat} icon={Crown} cls="border-amber-400/40" photo={entries.find((e) => e.boat_number === activePred?.honmei_boat)?.player_photo} reg={entries.find((e) => e.boat_number === activePred?.honmei_boat)?.register_number || entries.find((e) => e.boat_number === activePred?.honmei_boat)?.registration_number} name={entries.find((e) => e.boat_number === activePred?.honmei_boat)?.player_name} />
              <RoleBox label="対抗" n={activePred?.taiko_boat} icon={Shield} cls="border-blue-400/40" photo={entries.find((e) => e.boat_number === activePred?.taiko_boat)?.player_photo} reg={entries.find((e) => e.boat_number === activePred?.taiko_boat)?.register_number || entries.find((e) => e.boat_number === activePred?.taiko_boat)?.registration_number} name={entries.find((e) => e.boat_number === activePred?.taiko_boat)?.player_name} />
              <RoleBox label="穴" n={activePred?.ana_boat} icon={Sparkles} cls="border-rose-400/40" photo={entries.find((e) => e.boat_number === activePred?.ana_boat)?.player_photo} reg={entries.find((e) => e.boat_number === activePred?.ana_boat)?.register_number || entries.find((e) => e.boat_number === activePred?.ana_boat)?.registration_number} name={entries.find((e) => e.boat_number === activePred?.ana_boat)?.player_name} />
            </div>

            {/* 予想1位 3連単 */}
            <div className="rounded-lg border border-[#3a404c] bg-[#161a22] p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Trophy className="w-3.5 h-3.5 text-[#f9c836]" />
                <span className="text-[11px] font-bold text-slate-400">予想1位 3連単</span>
              </div>
              <div className="flex items-end justify-between">
                <div className="font-mono text-3xl sm:text-4xl font-black tracking-wider text-[#f9c836]">{activePred?.top_trifecta || "—"}</div>
                <div className="text-right text-xs">
                  <div className="text-slate-500">的中確率</div>
                  <div className="font-bold text-slate-200">{activePred?.top_probability != null ? `${activePred.top_probability}%` : "—"}</div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#2c3546] text-xs">
                <span className="text-slate-500">期待値</span>
                <span className={cn("font-bold", (activePred?.top_expected_value || 0) >= 150 ? "text-emerald-400" : (activePred?.top_expected_value || 0) >= 110 ? "text-amber-400" : "text-slate-400")}>
                  {activePred?.top_expected_value != null ? `${activePred.top_expected_value}%` : "—"}
                </span>
              </div>
            </div>

            {/* 推奨買い目 */}
            {betPlan && (
              <div className={cn("rounded-lg px-3 py-2.5 text-xs flex items-center gap-2 border", betPlan.tier === "skip" ? "bg-slate-800/50 text-slate-400 border-slate-600" : betPlan.tier === "1-3" ? "bg-emerald-500/10 text-emerald-300 border-emerald-400/40" : "bg-amber-500/10 text-amber-300 border-amber-400/40")}>
                <span className="font-bold">推奨</span>
                <span className="font-black text-sm">{betPlan.tier === "skip" ? "見送り" : `${betPlan.tier}点`}</span>
                <span className="text-slate-500 truncate">· {betPlan.reason}</span>
              </div>
            )}

            {/* PRE→FINAL比較 */}
            {compareData.length > 0 && (
              <div className="rounded-lg border border-[#3a404c] bg-[#161a22] p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[11px] font-bold text-slate-400">PRE → FINAL 変化</span>
                </div>
                <div className="grid grid-cols-6 gap-1">
                  {compareData.map((c) => (
                    <div key={c.n} className="text-center">
                      <div className={cn("w-6 h-6 mx-auto rounded flex items-center justify-center text-[10px] font-bold mb-0.5", boatColors[c.n])}>{c.n}</div>
                      <div className={cn("text-xs font-bold", c.delta > 0 ? "text-emerald-400" : c.delta < 0 ? "text-rose-400" : "text-slate-500")}>
                        {c.delta > 0 ? "+" : ""}{c.delta}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 6艇スコアバー */}
            {activeBoats.length > 0 && (
              <div className="rounded-lg border border-[#3a404c] bg-[#161a22] p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Gauge className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[11px] font-bold text-slate-400">6艇 総合力</span>
                </div>
                <div className="space-y-1.5">
                  {activeBoats.map((bp) => {
                    const entry = entries.find((e) => e.boat_number === bp.boat_number);
                    const pct = Math.min(100, bp.total_power || 0);
                    return (
                      <div key={bp.boat_number} className="flex items-center gap-2">
                        <span className={cn("w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0", boatColors[bp.boat_number])}>{bp.boat_number}</span>
                        <PlayerPhoto src={entry?.player_photo} registrationNumber={entry?.register_number || entry?.registration_number} alt={entry?.player_name} size="xs" />
                        <span className="text-[11px] text-slate-400 w-14 truncate shrink-0">{entry?.player_name || ""}</span>
                        <div className="flex-1 h-2 rounded-full bg-[#2c3546] overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs font-bold text-slate-200 w-7 text-right shrink-0">{bp.total_power?.toFixed(0) ?? "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 再実行ボタン */}
            <div className="flex gap-2 mt-1">
              <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
                className="flex-1 h-9 rounded-lg bg-[#2c3546] border border-[#3a404c] text-slate-200 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-[#374056] disabled:opacity-50">
                <Zap className="w-3.5 h-3.5" /> PRE再実行
              </button>
              <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0}
                className="flex-1 h-9 rounded-lg bg-[#f9c836] text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-amber-300 disabled:opacity-50">
                <Gauge className="w-3.5 h-3.5" /> FINAL再実行
              </button>
            </div>
            {busy && <div className="text-xs text-[#f9c836] text-center animate-pulse">計算中…</div>}
          </div>
        )}
      </div>

      {/* フッター: レース場切替風 */}
      <div className="px-3 py-2 border-t border-[#3a404c] flex items-center justify-between text-[11px]">
        <span className="text-slate-500">予想エンジン v3</span>
        <span className="text-slate-500">{race.has_final ? "FINAL済" : race.has_pre ? "PRE済" : "予想待ち"}</span>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button onClick={onClick} className={cn("px-3 h-7 rounded-md text-xs font-bold transition-colors", active ? "bg-[#f9c836] text-slate-950" : "bg-[#2c3546] text-slate-400 hover:text-white")}>{label}</button>
  );
}

function RoleBox({ label, n, icon: Icon, cls, photo, reg, name }) {
  const boatColors = {
    1: "bg-white text-black", 2: "bg-slate-500 text-white", 3: "bg-rose-600 text-white",
    4: "bg-blue-600 text-white", 5: "bg-amber-400 text-black", 6: "bg-emerald-600 text-white",
  };
  return (
    <div className={cn("rounded-lg border bg-[#161a22] p-2 text-center", cls)}>
      <div className="flex items-center justify-center gap-1 text-[10px] text-slate-400 mb-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="flex items-center justify-center gap-1.5 mb-1">
        <PlayerPhoto src={photo} registrationNumber={reg} alt={name} size="xs" />
        <div className={cn("w-7 h-7 rounded flex items-center justify-center font-black text-sm", n ? boatColors[n] : "bg-slate-700 text-slate-500")}>{n || "—"}</div>
      </div>
      {name && <div className="text-[10px] text-slate-400 truncate">{name}</div>}
    </div>
  );
}