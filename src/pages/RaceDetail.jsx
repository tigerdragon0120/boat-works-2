import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import {
  getRaceEntries, getPrediction, getBoatPredictions, getTrifectaPredictions,
  generateAndSavePrediction, getSettings,
  getV4Prediction, mapV4ToUI,
} from "@/lib/predictionService";
import PredictionPanel from "@/components/race/PredictionPanel";
import EntryTable from "@/components/race/EntryTable";
import { ArrowLeft } from "lucide-react";

export default function RaceDetail() {
  const { id } = useParams();
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [pre, setPre] = useState(null);
  const [fin, setFin] = useState(null);
  const [preBoats, setPreBoats] = useState([]);
  const [finBoats, setFinBoats] = useState([]);
  const [preTri, setPreTri] = useState([]);
  const [finTri, setFinTri] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("FINAL");
  const [rankMode, setRankMode] = useState("prob");

  // V4優先取得、なければV3フォールバック
  const loadStage = async (raceId, stage, raceKey) => {
    const v4 = await getV4Prediction(raceId, stage, raceKey);
    if (v4) {
      const mapped = mapV4ToUI(v4, stage);
      return { pred: mapped.pred, boats: mapped.boats, trifectas: mapped.trifectas };
    }
    const v3 = await getPrediction(raceId, stage);
    if (v3) {
      const boats = await getBoatPredictions(v3.id);
      const trifectas = await getTrifectaPredictions(v3.id);
      return { pred: v3, boats, trifectas };
    }
    return { pred: null, boats: [], trifectas: [] };
  };

  const load = async () => {
    setLoading(true);
    const r = await base44.entities.Race.get(id);
    setRace(r);
    const es = await getRaceEntries(id);
    setEntries(es || []);
    // V4優先、V3フォールバックでPRE/FINAL取得
    const [preData, finData] = await Promise.all([
      loadStage(id, "PRE", r?.race_key),
      loadStage(id, "FINAL", r?.race_key),
    ]);
    // 完全置き換え(mergeではなくreplace)
    setPre(preData.pred); setFin(finData.pred);
    setPreBoats(preData.boats); setFinBoats(finData.boats);
    setPreTri(preData.trifectas); setFinTri(finData.trifectas);
    if (finData.pred) {
      setView("FINAL");
    } else if (preData.pred) {
      setView("PRE");
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [id]);

  const run = async (stage) => {
    setBusy(true);
    try {
      const settings = await getSettings();
      await generateAndSavePrediction(race, entries, settings, stage, {});
      // FINAL再実行後: V4 FINALを再取得し画面stateを完全置き換え
      await load();
    } catch (e) {
      alert("予想生成に失敗: " + e.message);
    }
    setBusy(false);
  };

  if (loading) return <div className="py-20 text-center text-slate-500 text-sm">読み込み中…</div>;
  if (!race) return <div className="py-20 text-center text-slate-500">レースが見つかりません</div>;

  const activePred = view === "FINAL" ? fin : pre;
  const activeBoats = (view === "FINAL" ? finBoats : preBoats).sort((a, b) => a.boat_number - b.boat_number);
  const allTri = view === "FINAL" ? finTri : preTri;
  const probRank = [...allTri].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const evRank = [...allTri].sort((a, b) => b.expected_value - a.expected_value).slice(0, 10);

  // PRE→FINAL比較
  const compareData = preBoats.length && finBoats.length
    ? [1, 2, 3, 4, 5, 6].map((n) => {
        const pb = preBoats.find((b) => b.boat_number === n);
        const fb = finBoats.find((b) => b.boat_number === n);
        if (!pb || !fb) return null;
        return { n, pre: pb.total_power, final: fb.total_power, delta: fb.total_power - pb.total_power };
      }).filter(Boolean)
    : [];

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#f9c836] mb-3">
        <ArrowLeft className="w-4 h-4" /> レース一覧
      </Link>

      {/* スプリットレイアウト: 左=予想サマリー(動画枠代わり) / 右=出走表 */}
      <div className="grid lg:grid-cols-[minmax(0,380px)_1fr] gap-3 sm:gap-4">
        <PredictionPanel
          race={race} pre={pre} fin={fin} view={view} setView={setView}
          run={run} busy={busy} entries={entries}
          activePred={activePred} activeBoats={activeBoats} allTri={allTri}
          compareData={compareData}
        />
        <EntryTable
          race={race} entries={entries}
          activePred={activePred} activeBoats={activeBoats} allTri={allTri}
          probRank={probRank} evRank={evRank}
          rankMode={rankMode} setRankMode={setRankMode}
        />
      </div>
    </div>
  );
}