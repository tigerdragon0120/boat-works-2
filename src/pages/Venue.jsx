import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, Waves } from "lucide-react";
import {
  listTodayRaces, getRaceEntries, getPrediction, getBoatPredictions, getTrifectaPredictions,
  generateAndSavePrediction, getSettings,
} from "@/lib/predictionService";
import { decideBetPlan } from "@/lib/predictionEngine";
import { cn } from "@/lib/utils";
import PredictionPanel from "@/components/race/PredictionPanel";
import EntryTable from "@/components/race/EntryTable";

export default function Venue() {
  const { code } = useParams();
  const [races, setRaces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);

  // 選択中レースの詳細データ
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [pre, setPre] = useState(null);
  const [fin, setFin] = useState(null);
  const [preBoats, setPreBoats] = useState([]);
  const [finBoats, setFinBoats] = useState([]);
  const [preTri, setPreTri] = useState([]);
  const [finTri, setFinTri] = useState([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("FINAL");
  const [rankMode, setRankMode] = useState("prob");

  const loadList = async () => {
    setLoading(true);
    const all = await listTodayRaces({ includeFinished: true });
    const list = (all || []).filter((r) => String(r.venue_code).padStart(2, "0") === String(code).padStart(2, "0"))
      .sort((a, b) => a.race_number - b.race_number);
    setRaces(list);
    setSelectedId((prev) => prev && list.some((r) => r.id === prev) ? prev : (list.find((r) => r.status !== "finished") || list[list.length - 1] || list[0])?.id);
    setLoading(false);
  };
  useEffect(() => { loadList(); }, [code]);

  const raceList = useMemo(() => races, [races]);
  const venueName = races[0]?.venue || races[0]?.venue_name || `場コード ${code}`;

  // 選択中レースの詳細読み込み
  const loadDetail = async () => {
    if (!selectedId) return;
    const r = races.find((x) => x.id === selectedId);
    setRace(r);
    if (!r) return;
    const es = await getRaceEntries(selectedId);
    setEntries(es || []);
    const p = await getPrediction(selectedId, "PRE");
    const f = await getPrediction(selectedId, "FINAL");
    setPre(p); setFin(f);
    if (p) {
      setPreBoats(await getBoatPredictions(p.id));
      setPreTri(await getTrifectaPredictions(p.id));
    } else { setPreBoats([]); setPreTri([]); }
    if (f) {
      setFinBoats(await getBoatPredictions(f.id));
      setFinTri(await getTrifectaPredictions(f.id));
      setView("FINAL");
    } else if (p) {
      setView("PRE");
    }
  };
  useEffect(() => { loadDetail(); }, [selectedId, races]);

  const run = async (stage) => {
    if (!race) return;
    setBusy(true);
    try {
      const settings = await getSettings();
      await generateAndSavePrediction(race, entries, settings, stage, {});
      await loadDetail();
      await loadList();
    } catch (e) {
      alert("予想生成に失敗: " + e.message);
    }
    setBusy(false);
  };

  if (loading) return <div className="py-24 text-center text-slate-500">読み込み中…</div>;
  if (!raceList.length) return <div className="space-y-4"><Link to="/" className="text-blue-400 text-sm">← レース場一覧へ</Link><div className="py-24 text-center text-slate-500">本日のレースはありません</div></div>;

  const activePred = view === "FINAL" ? fin : pre;
  const activeBoats = (view === "FINAL" ? finBoats : preBoats).sort((a, b) => a.boat_number - b.boat_number);
  const allTri = view === "FINAL" ? finTri : preTri;
  const probRank = [...allTri].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const evRank = [...allTri].sort((a, b) => b.expected_value - a.expected_value).slice(0, 10);
  const betPlan = activePred ? decideBetPlan(allTri, { min_confidence: 40 }, { dataConfidence: activePred.data_confidence, stage: view }) : null;
  const compareData = preBoats.length && finBoats.length
    ? [1, 2, 3, 4, 5, 6].map((n) => {
        const pb = preBoats.find((b) => b.boat_number === n);
        const fb = finBoats.find((b) => b.boat_number === n);
        if (!pb || !fb) return null;
        return { n, pre: pb.total_power, final: fb.total_power, delta: fb.total_power - pb.total_power };
      }).filter(Boolean)
    : [];

  return (
    <div className="text-slate-100 space-y-3">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <Link to="/" className="h-9 px-2.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 flex items-center gap-2 text-xs font-semibold">
          <ArrowLeft className="w-4 h-4" /><span className="hidden xs:inline">レース場一覧</span>
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-blue-600/15 border border-blue-500/30 flex items-center justify-center shrink-0">
            <Waves className="w-4 h-4 text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="font-black text-lg sm:text-xl truncate">{venueName}</div>
            <div className="text-[9px] sm:text-[10px] tracking-widest text-slate-500">VENUE {String(code).padStart(2, "0")}</div>
          </div>
        </div>
        <button onClick={loadList} className="ml-auto h-9 min-w-9 px-3 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-2 text-xs font-semibold">
          <RefreshCw className="w-4 h-4" /><span className="hidden sm:inline">更新</span>
        </button>
      </div>

      {/* 1R-12R タブ */}
      <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch] pb-1">
        {raceList.map((r) => (
          <button key={r.id} onClick={() => setSelectedId(r.id)}
            className={cn("min-w-[48px] h-10 rounded-md border text-xs font-bold transition active:scale-95 flex flex-col items-center justify-center",
              r.id === selectedId ? "bg-[#f9c836] text-slate-950 border-amber-300" :
              r.status === "finished" ? "bg-slate-900 text-slate-600 border-slate-800" :
              "bg-slate-800/80 text-slate-300 border-slate-700 hover:border-slate-500")}>
            <span>{r.race_number}R</span>
            {r.prediction_grade && r.id !== selectedId && <span className="text-[8px] text-slate-500">{r.prediction_grade}</span>}
          </button>
        ))}
      </div>

      {/* スプリットレイアウト */}
      {race && (
        <div className="grid lg:grid-cols-[minmax(0,380px)_1fr] gap-3 sm:gap-4">
          <PredictionPanel
            race={race} pre={pre} fin={fin} view={view} setView={setView}
            run={run} busy={busy} entries={entries}
            activePred={activePred} activeBoats={activeBoats} allTri={allTri}
            betPlan={betPlan} compareData={compareData}
          />
          <EntryTable
            race={race} entries={entries}
            activePred={activePred} activeBoats={activeBoats} allTri={allTri}
            probRank={probRank} evRank={evRank}
            rankMode={rankMode} setRankMode={setRankMode}
          />
        </div>
      )}
    </div>
  );
}