import React, { useState } from "react";
import { cn } from "@/lib/utils";
import PlayerPhoto from "@/components/race/PlayerPhoto";


const boatColors = {
  1: "bg-white text-black",
  2: "bg-slate-500 text-white",
  3: "bg-rose-600 text-white",
  4: "bg-blue-600 text-white",
  5: "bg-amber-400 text-black",
  6: "bg-emerald-600 text-white",
};

const rowTint = {
  1: "bg-white/[0.02]",
  2: "bg-white/[0.02]",
  3: "bg-rose-500/[0.06]",
  4: "bg-blue-500/[0.06]",
  5: "bg-amber-400/[0.06]",
  6: "bg-emerald-500/[0.06]",
};

const judgmentStyle = {
  STRONG_BUY: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/40",
  BUY: "bg-rose-500/20 text-rose-300 border-rose-400/40",
  WATCH: "bg-amber-500/20 text-amber-300 border-amber-400/40",
  SKIP: "bg-slate-700/40 text-slate-400 border-slate-600",
};

const subTabs = ["出走表", "直前情報", "オッズ", "3連単", "6艇評価"];
const filterTabs = ["選手成績", "節間成績", "モーター履歴", "全国成績", "当地成績"];

export default function EntryTable({ race, entries, activePred, activeBoats, allTri, probRank, evRank, rankMode, setRankMode }) {
  const [subTab, setSubTab] = useState("出走表");
  const [filter, setFilter] = useState("選手成績");

  return (
    <div className="bg-[#1e232d] rounded-xl border border-[#3a404c] overflow-hidden flex flex-col h-full">
      {/* レースタイトル */}
      <div className="px-3 sm:px-4 py-3 border-b border-[#3a404c]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-400/30 text-blue-300 text-[11px] font-bold">{displayGrade(race.grade)}</span>
          {race.series_day && <span className="text-xs font-bold text-amber-300">{race.is_final_day ? "最終日" : `${race.series_day}日目`}</span>}
          {race.is_womens && <span className="text-pink-400 text-sm" title="女子戦">♥</span>}
          <div className="font-bold text-white text-sm sm:text-base truncate">{race.event_name || race.race_name || race.race_type || "一般"}</div>
        </div>
        <div className="text-[11px] text-slate-500 mt-1">{race.venue} · {race.race_number}R · 締切 {fmtTime(race.deadline)}</div>
      </div>

      {/* サブタブ */}
      <div className="px-2 sm:px-3 py-2 border-b border-[#3a404c] flex gap-1 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        {subTabs.map((t) => (
          <button key={t} onClick={() => setSubTab(t)}
            className={cn("px-2.5 h-8 rounded-md text-xs font-bold whitespace-nowrap transition-colors", subTab === t ? "bg-[#f9c836] text-slate-950" : "text-slate-400 hover:text-white hover:bg-[#2c3546]")}>
            {t}
          </button>
        ))}
      </div>

      {/* フィルタタブ (出走表時) */}
      {subTab === "出走表" && (
        <div className="px-2 sm:px-3 py-1.5 border-b border-[#3a404c] flex gap-1 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
          {filterTabs.map((t) => (
            <button key={t} onClick={() => setFilter(t)}
              className={cn("px-2 h-7 rounded text-[11px] font-semibold whitespace-nowrap transition-colors", filter === t ? "bg-[#2c3546] text-white" : "text-slate-500 hover:text-slate-300")}>
              {t}
            </button>
          ))}
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-auto">
        {subTab === "出走表" && <EntryGrid entries={entries} filter={filter} activeBoats={activeBoats} activePred={activePred} />}
        {subTab === "直前情報" && <ExhibitionInfo entries={entries} />}
        {subTab === "オッズ" && <OddsView allTri={allTri} />}
        {subTab === "3連単" && <TrifectaView probRank={probRank} evRank={evRank} rankMode={rankMode} setRankMode={setRankMode} />}
        {subTab === "6艇評価" && <BoatEvalView entries={entries} activeBoats={activeBoats} activePred={activePred} />}
      </div>
    </div>
  );
}

function EntryGrid({ entries, filter, activeBoats, activePred }) {
  if (!entries.length) return <Empty msg="出走表データがありません" />;
  const roleOf = (n) => {
    if (activePred?.honmei_boat === n) return "本命";
    if (activePred?.taiko_boat === n) return "対抗";
    if (activePred?.ana_boat === n) return "穴";
    if (activePred?.keshi_boat === n) return "消";
    return null;
  };
  const bpOf = (n) => activeBoats.find((b) => b.boat_number === n);

  return (
    <div className="text-[11px]">
      {/* ヘッダ行 */}
      <div className="grid grid-cols-[28px_1fr_32px_44px_70px_70px_44px] sm:grid-cols-[32px_1fr_36px_48px_80px_80px_52px] gap-1 px-2 py-1.5 bg-[#161a22] border-b border-[#3a404c] text-slate-500 font-bold text-[10px] sticky top-0">
        <div className="text-center">枠</div>
        <div>選手名</div>
        <div className="text-center">FL</div>
        <div className="text-center">ST</div>
        <div className="text-center">全国勝率</div>
        <div className="text-center">当地勝率</div>
        <div className="text-center">評価</div>
      </div>
      {entries.map((e) => {
        const bp = bpOf(e.boat_number);
        const role = roleOf(e.boat_number);
        return (
          <div key={e.boat_number} className={cn("grid grid-cols-[28px_1fr_32px_44px_70px_70px_44px] sm:grid-cols-[32px_1fr_36px_48px_80px_80px_52px] gap-1 px-2 py-2 border-b border-[#2c3546] items-center", rowTint[e.boat_number])}>
            <div className="flex justify-center">
              <span className={cn("w-6 h-6 rounded flex items-center justify-center font-black text-xs", boatColors[e.boat_number])}>{e.boat_number}</span>
            </div>
            <div className="min-w-0 flex items-center gap-1.5">
              <PlayerPhoto src={e.player_photo} registrationNumber={e.register_number || e.registration_number} alt={e.player_name} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-white text-xs truncate">{e.player_name || e.racer_name || `#${e.boat_number}`}</span>
                  {e.player_class && <span className="text-[9px] px-1 rounded bg-slate-700 text-slate-300 font-bold shrink-0">{e.player_class}</span>}
                  {role && <span className={cn("text-[9px] px-1 rounded font-bold shrink-0", role === "本命" ? "bg-amber-400 text-black" : role === "対抗" ? "bg-blue-500 text-white" : role === "穴" ? "bg-rose-500 text-white" : "bg-slate-600 text-slate-300")}>{role}</span>}
                </div>
                <div className="text-[10px] text-slate-500 truncate">{e.register_number || e.registration_number ? `登録${e.register_number || e.registration_number}` : ""}</div>
                {/* モーター/ボート */}
                <div className="text-[10px] text-slate-500 flex gap-2 mt-0.5">
                  <span>M{e.motor_number || "—"} <span className="text-slate-600">2連{e.motor_f2_rate ?? e.motor_2rate ?? "—"}%</span></span>
                  <span>B{e.boat_number_id || "—"} <span className="text-slate-600">2連{e.boat_f2_rate ?? e.boat_2rate ?? "—"}%</span></span>
                </div>
              </div>
            </div>
            <div className="text-center">
              {e.f_count > 0 ? <span className="text-rose-400 font-bold">F{e.f_count}</span> : <span className="text-slate-600">—</span>}
            </div>
            <div className="text-center font-mono text-slate-300">{e.avg_st != null ? e.avg_st.toFixed(2) : "—"}</div>
            <div className="text-center">
              <div className="font-bold text-slate-200">{e.national_win_rate != null ? e.national_win_rate.toFixed(2) : "—"}</div>
              <div className="text-[9px] text-slate-500">2連{e.national_f2_rate ?? e.national_2rate ?? "—"}%</div>
            </div>
            <div className="text-center">
              <div className="font-bold text-slate-200">{e.local_win_rate != null ? e.local_win_rate.toFixed(2) : "—"}</div>
              <div className="text-[9px] text-slate-500">2連{e.local_f2_rate ?? e.local_2rate ?? "—"}%</div>
            </div>
            <div className="text-center">
              {bp ? <span className="font-black text-[#f9c836] text-sm">{bp.total_power?.toFixed(0) ?? "—"}</span> : <span className="text-slate-600">—</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExhibitionInfo({ entries }) {
  if (!entries.length) return <Empty msg="展示データがありません" />;
  return (
    <div className="p-3 space-y-2">
      {entries.map((e) => (
        <div key={e.boat_number} className="flex items-center gap-2 rounded-lg border border-[#3a404c] bg-[#161a22] p-2">
          <span className={cn("w-6 h-6 rounded flex items-center justify-center font-black text-xs", boatColors[e.boat_number])}>{e.boat_number}</span>
          <PlayerPhoto src={e.player_photo} registrationNumber={e.register_number || e.registration_number} alt={e.player_name} size="sm" />
          <span className="text-xs font-bold text-slate-200 w-20 truncate">{e.player_name || ""}</span>
          <div className="flex-1 grid grid-cols-4 gap-1 text-center text-[10px]">
            <div><div className="text-slate-500">展示T</div><div className="font-mono font-bold text-slate-200">{e.exhibition_time?.toFixed(2) || "—"}</div></div>
            <div><div className="text-slate-500">展示ST</div><div className="font-mono font-bold text-slate-200">{e.exhibition_st?.toFixed(2) || "—"}</div></div>
            <div><div className="text-slate-500">進入</div><div className="font-bold text-slate-200">{e.exhibition_course || "—"}</div></div>
            <div><div className="text-slate-500">チルト</div><div className="font-bold text-slate-200">{e.tilt?.toFixed(1) || "—"}</div></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function OddsView({ allTri }) {
  if (!allTri?.length) return <Empty msg="オッズデータがありません" />;
  const sorted = [...allTri].sort((a, b) => (a.actual_odds || a.estimated_odds || 999) - (b.actual_odds || b.estimated_odds || 999)).slice(0, 30);
  return (
    <div className="p-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {sorted.map((t) => (
          <div key={t.combination} className="rounded-lg border border-[#3a404c] bg-[#161a22] p-2">
            <div className="font-mono font-bold text-white text-sm">{t.combination}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">オッズ <span className="font-bold text-slate-200">{t.actual_odds || t.estimated_odds || "—"}</span></div>
            <div className="text-[10px] text-slate-500">確率 <span className="font-bold text-slate-200">{t.probability}%</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrifectaView({ probRank, evRank, rankMode, setRankMode }) {
  const activeTri = rankMode === "prob" ? probRank : evRank;
  if (!activeTri?.length) return <Empty msg="3連単予想がありません" />;
  return (
    <div>
      <div className="flex gap-1 px-2 py-2 border-b border-[#2c3546]">
        <button onClick={() => setRankMode("prob")} className={cn("px-2.5 h-7 rounded-md text-[11px] font-bold", rankMode === "prob" ? "bg-[#f9c836] text-slate-950" : "bg-[#2c3546] text-slate-400")}>確率順</button>
        <button onClick={() => setRankMode("ev")} className={cn("px-2.5 h-7 rounded-md text-[11px] font-bold", rankMode === "ev" ? "bg-emerald-500 text-white" : "bg-[#2c3546] text-slate-400")}>期待値順</button>
      </div>
      {activeTri.map((t) => (
        <div key={t.combination} className="flex items-center px-3 py-2 border-b border-[#2c3546]">
          <span className={cn("inline-flex w-6 h-6 rounded-md items-center justify-center text-[11px] font-bold mr-2", t.rank <= 3 ? "bg-[#f9c836] text-slate-950" : "bg-[#2c3546] text-slate-400")}>{t.rank}</span>
          <span className="font-mono font-bold text-white text-base w-16">{t.combination}</span>
          <div className="flex-1 grid grid-cols-3 gap-1 text-center text-[10px]">
            <div><div className="text-slate-500">確率</div><div className="font-bold text-slate-200">{t.probability}%</div></div>
            <div><div className="text-slate-500">オッズ</div><div className="font-bold text-slate-200">{t.actual_odds ?? t.estimated_odds ?? "—"}</div></div>
            <div><div className="text-slate-500">期待値</div><div className={cn("font-bold", t.expected_value >= 150 ? "text-emerald-400" : t.expected_value >= 110 ? "text-amber-400" : "text-slate-400")}>{t.expected_value}%</div></div>
          </div>
          <span className={cn("ml-2 px-1.5 h-5 rounded text-[9px] font-bold border flex items-center", judgmentStyle[t.judgment] || judgmentStyle.SKIP)}>{t.judgment}</span>
        </div>
      ))}
    </div>
  );
}

function BoatEvalView({ entries, activeBoats, activePred }) {
  if (!activeBoats?.length) return <Empty msg="6艇評価データがありません。予想を実行してください。" />;
  const roleOf = (n) => {
    if (activePred?.honmei_boat === n) return "本命";
    if (activePred?.taiko_boat === n) return "対抗";
    if (activePred?.ana_boat === n) return "穴";
    return null;
  };
  return (
    <div className="p-2 space-y-1.5">
      {activeBoats.map((bp) => {
        const entry = entries.find((e) => e.boat_number === bp.boat_number);
        const role = roleOf(bp.boat_number);
        return (
          <div key={bp.boat_number} className="rounded-lg border border-[#3a404c] bg-[#161a22] p-2.5">
            <div className="flex items-center gap-2 mb-2">
              <span className={cn("w-7 h-7 rounded flex items-center justify-center font-black text-sm", boatColors[bp.boat_number])}>{bp.boat_number}</span>
              <PlayerPhoto src={entry?.player_photo} registrationNumber={entry?.register_number || entry?.registration_number} alt={entry?.player_name} />
              <span className="font-bold text-white text-sm flex-1 truncate">{entry?.player_name || ""}</span>
              {role && <span className={cn("text-[10px] px-1.5 rounded font-bold", role === "本命" ? "bg-amber-400 text-black" : role === "対抗" ? "bg-blue-500 text-white" : "bg-rose-500 text-white")}>{role}</span>}
              <span className="font-black text-[#f9c836] text-lg">{bp.total_power?.toFixed(0) ?? "—"}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
              <Mini label="1着力" v={bp.first_power} />
              <Mini label="2着力" v={bp.second_power} />
              <Mini label="3着力" v={bp.third_power} />
              <Mini label="ST力" v={bp.start_power} />
              <Mini label="モーター" v={bp.motor_power} />
              <Mini label="展示力" v={bp.exhibition_power} />
            </div>
            {bp.reasons?.length > 0 && (
              <div className="mt-2 pt-2 border-t border-[#2c3546]">
                <div className="text-[9px] font-bold text-blue-400 mb-1">理由</div>
                {bp.reasons.slice(0, 2).map((r, i) => <div key={i} className="text-[10px] text-slate-400">・{r}</div>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Mini({ label, v }) {
  return (
    <div className="rounded bg-[#1e232d] py-1">
      <div className="text-slate-500">{label}</div>
      <div className="font-bold text-slate-200 text-xs">{v != null ? (typeof v === "number" ? v.toFixed(0) : v) : "—"}</div>
    </div>
  );
}

function Empty({ msg }) {
  return <div className="py-12 text-center text-slate-500 text-sm">{msg}</div>;
}

function displayGrade(v) { const g = String(v || "").toUpperCase(); return !g || g === "GENERAL" ? "一般" : g; }
function fmtTime(v) { return v ? new Date(v).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"; }