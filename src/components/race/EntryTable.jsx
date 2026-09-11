import React, { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import PlayerPhoto from "@/components/race/PlayerPhoto";
import StartTimingPanel from "@/components/race/StartTimingPanel";
import { base44 } from "@/api/base44Client";


const boatColors = {
  1: "bg-white text-black",
  2: "bg-slate-500 text-slate-900",
  3: "bg-rose-600 text-slate-900",
  4: "bg-blue-600 text-slate-900",
  5: "bg-amber-400 text-black",
  6: "bg-emerald-600 text-slate-900",
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
  SKIP: "bg-slate-700/40 text-slate-600 border-slate-600",
};

const subTabs = ["買い目", "出走表", "直前情報", "オッズ", "3連単", "6艇評価"];
const filterTabs = ["選手成績", "枠番過去10走", "節間成績", "モーター履歴", "全国成績", "当地成績"];

export default function EntryTable({ race, entries, activePred, activeBoats, allTri, probRank, evRank, rankMode, setRankMode }) {
  const [subTab, setSubTab] = useState("出走表");
  const [filter, setFilter] = useState("選手成績");
  const roles = resolveRoleBoats(activePred, activeBoats);
  const displayPred = activePred ? { ...activePred, honmei_boat: roles.honmei, taiko_boat: roles.taiko, ana_boat: roles.ana } : activePred;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col h-full">
      {/* レースタイトル */}
      <div className="px-3 sm:px-4 py-3 border-b border-slate-200">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-400/30 text-blue-300 text-[11px] font-bold">{displayGrade(race.grade)}</span>
          {race.series_day && <span className="text-xs font-bold text-amber-300">{race.is_final_day ? "最終日" : `${race.series_day}日目`}</span>}
          {race.is_womens && <span className="text-pink-400 text-sm" title="女子戦">♥</span>}
          <div className="font-bold text-slate-900 text-sm sm:text-base truncate">{race.event_name || race.race_name || race.race_type || "一般"}</div>
        </div>
        <div className="text-[11px] text-slate-500 mt-1">{race.venue} · {race.race_number}R · 締切 {fmtTime(race.deadline)}</div>
      </div>

      {/* サブタブ */}
      <div className="px-2 sm:px-3 py-2 border-b border-slate-200 flex gap-1 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
        {subTabs.map((t) => (
          <button key={t} onClick={() => setSubTab(t)}
            className={cn("px-2.5 h-8 rounded-md text-xs font-bold whitespace-nowrap transition-colors", subTab === t ? "bg-[#f9c836] text-slate-950" : "text-slate-600 hover:text-slate-900 hover:bg-slate-100")}>
            {t}
          </button>
        ))}
      </div>

      {/* フィルタタブ (出走表時) */}
      {subTab === "出走表" && (
        <div className="px-2 sm:px-3 py-1.5 border-b border-slate-200 flex gap-1 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
          {filterTabs.map((t) => (
            <button key={t} onClick={() => setFilter(t)}
              className={cn("px-2 h-7 rounded text-[11px] font-semibold whitespace-nowrap transition-colors", filter === t ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:text-slate-700")}>
              {t}
            </button>
          ))}
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-auto">
        {subTab === "買い目" && <BetTicketView activePred={displayPred} allTri={allTri} />}
        {subTab === "出走表" && <EntryGrid entries={entries} filter={filter} activeBoats={activeBoats} activePred={displayPred} />}
        {subTab === "直前情報" && <ExhibitionInfo entries={entries} />}
        {subTab === "オッズ" && <OddsView allTri={allTri} />}
        {subTab === "3連単" && <TrifectaView probRank={probRank} evRank={evRank} rankMode={rankMode} setRankMode={setRankMode} />}
        {subTab === "6艇評価" && <BoatEvalView entries={entries} activeBoats={activeBoats} activePred={displayPred} />}
      </div>
    </div>
  );
}

// フィルタ別の列定義 (boat+name+評価は固定、中央のデータ列を切替)
// ※ grid-cols-[...] はリテラル文字列として記述しTailwindのJITに検出させる
const filterCols = {
  "選手成績": {
    gridCls: "grid-cols-[28px_1fr_28px_40px_64px_64px_40px] sm:grid-cols-[32px_1fr_36px_48px_76px_76px_52px]",
    headers: ["FL", "ST", "全国勝率", "当地勝率"],
  },
  "節間成績": {
    gridCls: "grid-cols-[28px_1fr_42px_42px_1fr_46px_40px] sm:grid-cols-[32px_1fr_48px_48px_1fr_56px_52px]",
    headers: ["Pts", "節ST", "今節着順", "勢い"],
  },
  "モーター履歴": {
    gridCls: "grid-cols-[28px_1fr_36px_46px_46px_36px_46px_40px] sm:grid-cols-[32px_1fr_40px_54px_54px_40px_54px_52px]",
    headers: ["MNo", "M2連", "M3連", "BNo", "B2連"],
  },
  "全国成績": {
    gridCls: "grid-cols-[28px_1fr_54px_46px_46px_28px_40px_40px] sm:grid-cols-[32px_1fr_60px_54px_54px_36px_48px_52px]",
    headers: ["勝率", "2連率", "3連率", "FL", "ST"],
  },
  "当地成績": {
    gridCls: "grid-cols-[28px_1fr_54px_46px_46px_28px_40px_40px] sm:grid-cols-[32px_1fr_60px_54px_54px_36px_48px_52px]",
    headers: ["勝率", "2連率", "3連率", "FL", "ST"],
  },
};

function resolveRoleBoats(activePred, activeBoats = []) {
  const rankedFirst = [...activeBoats].sort((a, b) => (b.first_power || 0) - (a.first_power || 0));
  const honmei = activePred?.honmei_boat ?? rankedFirst[0]?.boat_number;
  let taiko = activePred?.taiko_boat;
  if (!taiko || taiko === honmei) {
    taiko = [...activeBoats]
      .filter((b) => b.boat_number !== honmei)
      .sort((a, b) => ((b.second_power || 0) * 0.7 + (b.total_power || 0) * 0.3) - ((a.second_power || 0) * 0.7 + (a.total_power || 0) * 0.3))[0]?.boat_number;
  }
  let ana = activePred?.ana_boat;
  if (!ana || ana === honmei || ana === taiko) {
    ana = [...activeBoats]
      .filter((b) => b.boat_number !== honmei && b.boat_number !== taiko)
      .sort((a, b) => ((b.ana_potential || 0) * 0.7 + (b.first_power || 0) * 0.3) - ((a.ana_potential || 0) * 0.7 + (a.first_power || 0) * 0.3))[0]?.boat_number;
  }
  return { honmei, taiko, ana };
}

function EntryGrid({ entries, filter, activeBoats, activePred }) {
  const [past10ByReg, setPast10ByReg] = useState({});
  const [past10Loading, setPast10Loading] = useState(false);

  const regsKey = useMemo(() => entries.map((e) => e.register_number || e.registration_number || "").filter(Boolean).join(","), [entries]);

  useEffect(() => {
    if (filter !== "枠番過去10走" || !regsKey) return;
    let cancelled = false;
    const loadPast10 = async () => {
      setPast10Loading(true);
      try {
        const pairs = await Promise.all(entries.map(async (e) => {
          const reg = e.register_number || e.registration_number;
          if (!reg) return ["", []];
          const rows = await base44.entities.RacerRaceHistory.filter({ registration_number: String(reg) }, "-race_date", 10).catch(() => []);
          return [String(reg), rows || []];
        }));
        if (!cancelled) setPast10ByReg(Object.fromEntries(pairs.filter(([k]) => k)));
      } finally {
        if (!cancelled) setPast10Loading(false);
      }
    };
    loadPast10();
    return () => { cancelled = true; };
  }, [filter, regsKey]);

  if (!entries.length) return <Empty msg="出走表データがありません" />;
  if (filter === "枠番過去10走") return <Past10Grid entries={entries} historyByReg={past10ByReg} loading={past10Loading} />;
  const roleOf = (n) => {
    if (activePred?.honmei_boat === n) return "本命";
    if (activePred?.taiko_boat === n) return "対抗";
    if (activePred?.ana_boat === n) return "穴";
    if (activePred?.keshi_boat === n) return "消";
    return null;
  };
  const bpOf = (n) => activeBoats.find((b) => b.boat_number === n);
  const cfg = filterCols[filter] || filterCols["選手成績"];

  return (
    <div className="text-[11px]">
      {/* ヘッダ行 */}
      <div className={cn("grid gap-1 px-2 py-1.5 bg-white border-b border-slate-200 text-slate-500 font-bold text-[10px] sticky top-0 items-center", cfg.gridCls)}>
        <div className="text-center">枠</div>
        <div>選手名</div>
        {cfg.headers.map((h) => <div key={h} className="text-center">{h}</div>)}
        <div className="text-center">評価</div>
      </div>
      {entries.map((e) => {
        const bp = bpOf(e.boat_number);
        const role = roleOf(e.boat_number);
        return (
          <div key={e.boat_number} className={cn("grid gap-1 px-2 py-2 border-b border-slate-200 items-center", cfg.gridCls, rowTint[e.boat_number])}>
            <div className="flex justify-center">
              <span className={cn("w-6 h-6 rounded flex items-center justify-center font-black text-xs", boatColors[e.boat_number])}>{e.boat_number}</span>
            </div>
            <div className="min-w-0 flex items-center gap-1.5">
              <PlayerPhoto src={e.player_photo} registrationNumber={e.register_number || e.registration_number} alt={e.player_name} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-slate-900 text-xs truncate">{e.player_name || e.racer_name || `#${e.boat_number}`}</span>
                  {e.player_class && <span className="text-[9px] px-1 rounded bg-slate-700 text-slate-700 font-bold shrink-0">{e.player_class}</span>}
                  {role && <span className={cn("text-[9px] px-1 rounded font-bold shrink-0", role === "本命" ? "bg-amber-400 text-black" : role === "対抗" ? "bg-blue-500 text-slate-900" : role === "穴" ? "bg-rose-500 text-slate-900" : "bg-slate-600 text-slate-700")}>{role}</span>}
                </div>
                <div className="text-[10px] text-slate-500 truncate">{e.register_number || e.registration_number ? `登録${e.register_number || e.registration_number}` : ""}</div>
              </div>
            </div>
            {renderDataCols(filter, e)}
            <div className="text-center">
              {bp ? <span className="font-black text-[#f9c836] text-sm">{bp.total_power?.toFixed(0) ?? "—"}</span> : <span className="text-slate-600">—</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Past10Grid({ entries, historyByReg, loading }) {
  const slot = (e, h, idx) => {
    if (!h) return <div key={idx} className="text-center text-slate-300">—</div>;
    const frame = Number(h.boat_number || h.course || 0);
    const finish = h.finish_order ?? h.finish_status ?? "—";
    const st = h.st != null ? Number(h.st).toFixed(2) : "—";
    return (
      <div key={h.id || idx} className="min-w-[46px] text-center leading-tight">
        <div className="text-[9px] text-slate-500">{10 - idx}走</div>
        <div className="mt-0.5 flex items-center justify-center gap-0.5">
          <span className={cn("w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-black", boatColors[frame] || "bg-slate-200 text-slate-700")}>{frame || "-"}</span>
          <span className="text-[10px] font-bold text-slate-900">{finish}</span>
        </div>
        <div className="text-[9px] text-slate-500 mt-0.5">ST {st}</div>
      </div>
    );
  };

  return (
    <div className="text-[11px] overflow-x-auto">
      <div className="min-w-[930px]">
        <div className="grid grid-cols-[28px_180px_repeat(10,1fr)] gap-1 px-2 py-1.5 bg-white border-b border-slate-200 text-slate-500 font-bold text-[10px] sticky top-0 z-10">
          <div className="text-center">枠</div><div>選手名</div>
          {[10,9,8,7,6,5,4,3,2,1].map((n) => <div key={n} className="text-center">{n}走</div>)}
        </div>
        {entries.map((e) => {
          const reg = String(e.register_number || e.registration_number || "");
          const hist = historyByReg[reg] || [];
          return (
            <div key={e.boat_number} className={cn("grid grid-cols-[28px_180px_repeat(10,1fr)] gap-1 px-2 py-2 border-b border-slate-200 items-center", rowTint[e.boat_number])}>
              <div className="flex justify-center"><span className={cn("w-6 h-6 rounded flex items-center justify-center font-black text-xs", boatColors[e.boat_number])}>{e.boat_number}</span></div>
              <div className="min-w-0 flex items-center gap-1.5">
                <PlayerPhoto src={e.player_photo} registrationNumber={e.register_number || e.registration_number} alt={e.player_name} />
                <div className="min-w-0"><div className="font-bold text-slate-900 text-xs truncate">{e.player_name || e.racer_name || `#${e.boat_number}`}</div><div className="text-[9px] text-slate-500">登録{reg || "—"}</div></div>
              </div>
              {loading && !hist.length
                ? Array.from({ length: 10 }).map((_, i) => <div key={i} className="text-center text-slate-300 animate-pulse">…</div>)
                : Array.from({ length: 10 }).map((_, i) => slot(e, hist[i], i))}
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 text-[10px] text-slate-400">各マスは「枠番・着順・ST」。左が10走前、右が前走です。</div>
    </div>
  );
}

// フィルタ別のデータセル
function renderDataCols(filter, e) {
  const num = (v, d = 2) => (v != null ? Number(v).toFixed(d) : "—");
  const pct = (v) => (v != null ? `${v}%` : "—");

  switch (filter) {
    case "節間成績":
      return [
        <div key="pts" className="text-center font-bold text-slate-900">{e.section_points != null ? e.section_points : "—"}</div>,
        <div key="sst" className="text-center font-mono text-slate-700">{num(e.section_st)}</div>,
        <div key="fin" className="text-center text-slate-700 truncate" title={e.section_finishes || ""}>{e.section_finishes || "—"}</div>,
        <div key="mom" className={cn("text-center font-bold", (e.section_momentum || 0) >= 60 ? "text-emerald-400" : (e.section_momentum || 0) >= 40 ? "text-amber-400" : "text-slate-600")}>{num(e.section_momentum, 0)}</div>,
      ];
    case "モーター履歴":
      return [
        <div key="mno" className="text-center font-bold text-slate-900">{e.motor_number || "—"}</div>,
        <div key="m2" className="text-center"><div className="font-bold text-slate-900">{pct(e.motor_f2_rate ?? e.motor_2rate)}</div></div>,
        <div key="m3" className="text-center text-slate-600">{pct(e.motor_f3_rate ?? e.motor_3rate)}</div>,
        <div key="bno" className="text-center font-bold text-slate-900">{e.boat_number_id || "—"}</div>,
        <div key="b2" className="text-center"><div className="font-bold text-slate-900">{pct(e.boat_f2_rate ?? e.boat_2rate)}</div></div>,
      ];
    case "全国成績":
      return [
        <div key="wr" className="text-center font-bold text-slate-900">{num(e.national_win_rate)}</div>,
        <div key="f2" className="text-center text-slate-700">{pct(e.national_f2_rate ?? e.national_2rate)}</div>,
        <div key="f3" className="text-center text-slate-600">{pct(e.national_f3_rate ?? e.national_3rate)}</div>,
        <div key="fl" className="text-center">{e.f_count > 0 ? <span className="text-rose-400 font-bold">F{e.f_count}</span> : <span className="text-slate-600">—</span>}</div>,
        <div key="st" className="text-center font-mono text-slate-700">{num(e.avg_st)}</div>,
      ];
    case "当地成績":
      return [
        <div key="wr" className="text-center font-bold text-slate-900">{num(e.local_win_rate)}</div>,
        <div key="f2" className="text-center text-slate-700">{pct(e.local_f2_rate ?? e.local_2rate)}</div>,
        <div key="f3" className="text-center text-slate-600">{pct(e.local_f3_rate ?? e.local_3rate)}</div>,
        <div key="fl" className="text-center">{e.f_count > 0 ? <span className="text-rose-400 font-bold">F{e.f_count}</span> : <span className="text-slate-600">—</span>}</div>,
        <div key="st" className="text-center font-mono text-slate-700">{num(e.avg_st)}</div>,
      ];
    default: // 選手成績
      return [
        <div key="fl" className="text-center">{e.f_count > 0 ? <span className="text-rose-400 font-bold">F{e.f_count}</span> : <span className="text-slate-600">—</span>}</div>,
        <div key="st" className="text-center font-mono text-slate-700">{num(e.avg_st)}</div>,
        <div key="nw" className="text-center"><div className="font-bold text-slate-900">{num(e.national_win_rate)}</div><div className="text-[9px] text-slate-500">2連{pct(e.national_f2_rate ?? e.national_2rate)}</div></div>,
        <div key="lw" className="text-center"><div className="font-bold text-slate-900">{num(e.local_win_rate)}</div><div className="text-[9px] text-slate-500">2連{pct(e.local_f2_rate ?? e.local_2rate)}</div></div>,
      ];
  }
}

function ExhibitionInfo({ entries }) {
  if (!entries.length) return <Empty msg="展示データがありません" />;
  return (
    <div className="p-2.5 sm:p-3 space-y-2.5">
      {/* スタート展示パネル */}
      <StartTimingPanel entries={entries} />
      {/* 各艇展示データ詳細 */}
      {entries.map((e) => (
        <div key={e.boat_number} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
          <span className={cn("w-6 h-6 rounded flex items-center justify-center font-black text-xs", boatColors[e.boat_number])}>{e.boat_number}</span>
          <PlayerPhoto src={e.player_photo} registrationNumber={e.register_number || e.registration_number} alt={e.player_name} size="sm" />
          <span className="text-xs font-bold text-slate-900 w-20 truncate">{e.player_name || ""}</span>
          <div className="flex-1 grid grid-cols-4 gap-1 text-center text-[10px]">
            <div><div className="text-slate-500">展示T</div><div className="font-mono font-bold text-slate-900">{e.exhibition_time?.toFixed(2) || "—"}</div></div>
            <div><div className="text-slate-500">展示ST</div><div className="font-mono font-bold text-slate-900">{e.exhibition_st?.toFixed(2) || "—"}</div></div>
            <div><div className="text-slate-500">進入</div><div className="font-bold text-slate-900">{e.exhibition_course || "—"}</div></div>
            <div><div className="text-slate-500">チルト</div><div className="font-bold text-slate-900">{e.tilt?.toFixed(1) || "—"}</div></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function OddsView({ allTri }) {
  if (!allTri?.length) return <Empty msg="オッズデータがありません" />;
  const sorted = [...allTri].sort((a, b) => ((a.actual_odds ?? Infinity) - (b.actual_odds ?? Infinity))).slice(0, 30);
  return (
    <div className="p-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {sorted.map((t) => (
          <div key={t.combination} className="rounded-lg border border-slate-200 bg-white p-2">
            <div className="font-mono font-bold text-slate-900 text-sm">{t.combination}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">実オッズ <span className="font-bold text-slate-900">{t.actual_odds ?? "—"}</span></div>
            <div className="text-[10px] text-slate-500">確率 <span className="font-bold text-slate-900">{t.probability}%</span></div>
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
      <div className="flex gap-1 px-2 py-2 border-b border-slate-200">
        <button onClick={() => setRankMode("prob")} className={cn("px-2.5 h-7 rounded-md text-[11px] font-bold", rankMode === "prob" ? "bg-[#f9c836] text-slate-950" : "bg-slate-100 text-slate-600")}>確率順</button>
        <button onClick={() => setRankMode("ev")} className={cn("px-2.5 h-7 rounded-md text-[11px] font-bold", rankMode === "ev" ? "bg-emerald-500 text-slate-900" : "bg-slate-100 text-slate-600")}>期待値順</button>
      </div>
      {activeTri.map((t) => (
        <div key={t.combination} className="flex items-center px-3 py-2 border-b border-slate-200">
          <span className={cn("inline-flex w-6 h-6 rounded-md items-center justify-center text-[11px] font-bold mr-2", t.rank <= 3 ? "bg-[#f9c836] text-slate-950" : "bg-slate-100 text-slate-600")}>{t.rank}</span>
          <span className="font-mono font-bold text-slate-900 text-base w-16">{t.combination}</span>
          <div className="flex-1 grid grid-cols-3 gap-1 text-center text-[10px]">
            <div><div className="text-slate-500">確率</div><div className="font-bold text-slate-900">{t.probability}%</div></div>
            <div><div className="text-slate-500">実オッズ</div><div className="font-bold text-slate-900">{t.actual_odds ?? "—"}</div></div>
            <div><div className="text-slate-500">期待値</div><div className={cn("font-bold", t.expected_value >= 150 ? "text-emerald-400" : t.expected_value >= 110 ? "text-amber-400" : "text-slate-600")}>{t.expected_value}%</div></div>
          </div>
          <span className={cn("ml-2 px-1.5 h-5 rounded text-[9px] font-bold border flex items-center", judgmentStyle[t.judgment] || judgmentStyle.SKIP)}>{t.judgment}</span>
        </div>
      ))}
    </div>
  );
}

function BetTicketView({ activePred, allTri }) {
  const selected = (allTri || []).filter((t) => t.is_selected).sort((a, b) => (a.ticket_rank || 99) - (b.ticket_rank || 99));
  if (!selected.length) return <Empty msg="買い目データがありません。予想を実行してください。" />;
  const judgment = activePred?.final_judgment || "—";
  return (
    <div className="p-2 space-y-2">
      {/* 判定ヘッダー */}
      <div className="rounded-lg border border-slate-200 bg-white p-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className={cn("px-2 py-0.5 rounded text-xs font-black border", judgmentStyle[judgment] || judgmentStyle.SKIP)}>{judgment}</span>
          <span className="text-xs text-slate-600">{selected.length}点 · {activePred?.ticket_strategy || ""}</span>
        </div>
        <div className="text-[11px] text-slate-600 leading-relaxed">{activePred?.judgment_reason || ""}</div>
        {activePred?.expand_reason && <div className="text-[10px] text-amber-400/80 mt-1">拡張: {activePred.expand_reason}</div>}
      </div>
      {/* 買い目リスト */}
      {selected.map((t) => {
        const odds = t.actual_odds ?? t.current_odds ?? null;
        const ev = t.expected_value;
        return (
          <div key={t.combination} className="rounded-lg border border-slate-200 bg-white p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={cn("w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold", t.ticket_rank <= 3 ? "bg-[#f9c836] text-slate-950" : "bg-slate-100 text-slate-600")}>{t.ticket_rank}</span>
              <span className="font-mono font-black text-slate-900 text-lg tracking-wider flex-1">{t.combination}</span>
              {t.set_group && <span className={cn("px-1.5 h-5 rounded text-[10px] font-bold border flex items-center", t.set_group === "A" ? "text-rose-300 bg-rose-500/10 border-rose-400/30" : t.set_group === "B" ? "text-amber-300 bg-amber-500/10 border-amber-400/30" : "text-slate-600 bg-slate-700/30 border-slate-600")}>{t.set_group}</span>}
            </div>
            <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
              <div><div className="text-slate-500">確率</div><div className="font-bold text-slate-900">{t.probability}%</div></div>
              <div><div className="text-slate-500">オッズ</div><div className="font-bold text-slate-900">{odds ?? "—"}</div></div>
              <div><div className="text-slate-500">期待値</div><div className={cn("font-bold", ev != null && ev >= 120 ? "text-emerald-400" : ev != null && ev >= 90 ? "text-amber-400" : "text-slate-600")}>{ev != null ? `${ev}%` : "—"}</div></div>
              <div><div className="text-slate-500">順位</div><div className="font-bold text-slate-900">{t.rank}/120</div></div>
            </div>
            {t.selection_reason && <div className="text-[10px] text-slate-500 mt-1.5 pt-1.5 border-t border-slate-200">{t.selection_reason}</div>}
          </div>
        );
      })}
      {/* セット分析サマリー */}
      {activePred?.set_probability != null && (
        <div className="rounded-lg border border-slate-200 bg-white p-2.5">
          <div className="text-[10px] font-bold text-blue-400 mb-1.5">セット分析</div>
          <div className="grid grid-cols-2 gap-1.5 text-center text-[10px]">
            <div className="rounded bg-white py-1"><div className="font-bold text-slate-900">{activePred.set_probability}%</div><div className="text-slate-500">セット的中率</div></div>
            <div className="rounded bg-white py-1"><div className="font-bold text-slate-900">{activePred.synthetic_odds != null ? `${activePred.synthetic_odds}倍` : "—"}</div><div className="text-slate-500">合成オッズ</div></div>
            <div className="rounded bg-white py-1"><div className={cn("font-bold", activePred.set_expected_recovery >= 120 ? "text-emerald-400" : "text-slate-900")}>{activePred.set_expected_recovery != null ? `${activePred.set_expected_recovery}%` : "—"}</div><div className="text-slate-500">期待回収率</div></div>
            <div className="rounded bg-white py-1"><div className="font-bold text-slate-900">{activePred.avg_payout != null ? `${activePred.avg_payout}円` : "—"}</div><div className="text-slate-500">平均払戻</div></div>
          </div>
        </div>
      )}
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
          <div key={bp.boat_number} className="rounded-lg border border-slate-200 bg-white p-2.5">
            <div className="flex items-center gap-2 mb-2">
              <span className={cn("w-7 h-7 rounded flex items-center justify-center font-black text-sm", boatColors[bp.boat_number])}>{bp.boat_number}</span>
              <PlayerPhoto src={entry?.player_photo} registrationNumber={entry?.register_number || entry?.registration_number} alt={entry?.player_name} />
              <span className="font-bold text-slate-900 text-sm flex-1 truncate">{entry?.player_name || ""}</span>
              {role && <span className={cn("text-[10px] px-1.5 rounded font-bold", role === "本命" ? "bg-amber-400 text-black" : role === "対抗" ? "bg-blue-500 text-slate-900" : "bg-rose-500 text-slate-900")}>{role}</span>}
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
            {/* RacerRollingStats指標 */}
            {(bp.racer_power_score != null || bp.recent_form_score != null) && (
              <div className="grid grid-cols-4 gap-1 text-center text-[10px] mt-1">
                <Mini label="選手力" v={bp.racer_power_score} />
                <Mini label="直近調子" v={bp.recent_form_score} />
                <Mini label="ST推移" v={bp.st_trend_score} />
                <Mini label="級別推移" v={bp.class_trend_score} />
              </div>
            )}
            {bp.reasons?.length > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-200">
                <div className="text-[9px] font-bold text-blue-400 mb-1">理由</div>
                {bp.reasons.slice(0, 3).map((r, i) => <div key={i} className="text-[10px] text-slate-600">・{r}</div>)}
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
    <div className="rounded bg-white py-1">
      <div className="text-slate-500">{label}</div>
      <div className="font-bold text-slate-900 text-xs">{v != null ? (typeof v === "number" ? v.toFixed(0) : v) : "—"}</div>
    </div>
  );
}

function Empty({ msg }) {
  return <div className="py-12 text-center text-slate-500 text-sm">{msg}</div>;
}

function displayGrade(v) { const g = String(v || "").toUpperCase(); return !g || g === "GENERAL" ? "一般" : g; }
function fmtTime(v) { return v ? new Date(v).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"; }