import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, Waves } from "lucide-react";
import {
  listTodayRaces, getRaceEntries,
  getV4Prediction, mapV4ToUI, resolveCurrentPrediction, resolveV6Prediction,
  generateV4PredictionForRace,
} from "@/lib/predictionService";
import { cn } from "@/lib/utils";
import PredictionPanel from "@/components/race/PredictionPanel";
import EntryTable from "@/components/race/EntryTable";
import { fetchOnlineData } from "@/lib/dataManagementService";

export default function Venue() {
  const { code } = useParams();
  const [searchParams] = useSearchParams();
  const [races, setRaces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);

  // 選択中レースの詳細データ
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  // currentPrediction: resolveCurrentPredictionの結果(FINAL優先)
  const [current, setCurrent] = useState(null);
  const [v6Current, setV6Current] = useState(null);
  const [predictionVersion, setPredictionVersion] = useState("v4");
  const [preBoats, setPreBoats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [rankMode, setRankMode] = useState("prob");
  const sectionFetchTried = useRef(new Set());

  const loadList = async () => {
    setLoading(true);
    const all = await listTodayRaces({ includeFinished: true });
    const list = (all || []).filter((r) => String(r.venue_code).padStart(2, "0") === String(code).padStart(2, "0"))
      .sort((a, b) => a.race_number - b.race_number);
    setRaces(list);
    setSelectedId((prev) => {
      // ホーム画面で表示していた「現在○R」をURLで明示的に受け取る。
      // これによりiPad/iPhoneやRace.status更新タイミングの差で1Rへ戻らない。
      const requestedRaceNo = Number(searchParams.get("race"));
      const requested = Number.isFinite(requestedRaceNo)
        ? list.find((r) => Number(r.race_number) === requestedRaceNo)
        : null;
      if (requested) return requested.id;
      if (prev && list.some((r) => r.id === prev)) return prev;

      const nowMs = Date.now();
      const nextByDeadline = list.find((r) =>
        r.status !== "finished" &&
        r.status !== "cancelled" &&
        (!r.deadline || new Date(r.deadline).getTime() > nowMs)
      );
      return (nextByDeadline || list[list.length - 1] || list[0])?.id;
    });
    setLoading(false);
  };
  useEffect(() => { loadList(); }, [code]);

  const raceList = useMemo(() => races, [races]);
  const venueName = races[0]?.venue || races[0]?.venue_name || `場コード ${code}`;

  // 選択中レースの詳細読み込み
  const loadDetail = async () => {
    if (!selectedId) return;
    // 前レースのstateを完全クリア
    setCurrent(null);
    setV6Current(null);
    setPreBoats([]);

    const r = races.find((x) => x.id === selectedId);
    setRace(r);
    if (!r) return;
    let es = await getRaceEntries(selectedId);

    // 節間成績が未取得なら、そのレースの公式racelistから自動補完する。
    const hasSection = (es || []).some((e) =>
      e.section_points != null || e.section_st != null || !!e.section_finishes || e.section_momentum != null
    );
    const sectionKey = `${r.race_date}_${String(r.venue_code).padStart(2, "0")}_${r.race_number}`;
    if (!hasSection && !sectionFetchTried.current.has(sectionKey)) {
      sectionFetchTried.current.add(sectionKey);
      try {
        await fetchOnlineData("section", r.race_date, r.venue_code, r.race_number, r.id);
        es = await getRaceEntries(selectedId);
      } catch (err) {
        console.warn("節間成績の自動取得に失敗", sectionKey, err);
      }
    }
    setEntries(es || []);

    // === V4 FINAL自動生成保証 ===
    if (r?.exhibition_ready && r?.deadline) {
      const deadlineMs = new Date(r.deadline).getTime();
      if (deadlineMs > Date.now()) {
        const finCheck = await getV4Prediction(selectedId, "FINAL", r?.race_key);
        if (!finCheck || finCheck.status !== "COMPLETED") {
          try {
            await generateV4PredictionForRace(selectedId, "FINAL", false);
            // 生成後、Race最新状態を再取得
            const updatedRaces = await listTodayRaces({ includeFinished: true });
            const updatedList = (updatedRaces || []).filter((rr) => String(rr.venue_code).padStart(2, "0") === String(code).padStart(2, "0"))
              .sort((a, b) => a.race_number - b.race_number);
            setRaces(updatedList);
            const r2 = updatedList.find((x) => x.id === selectedId);
            if (r2) setRace(r2);
          } catch (e) {
            console.warn("[Venue] V4 FINAL auto-gen failed:", e?.message || e);
          }
        }
      }
    }

    // V4とV6を同時に取得し、タブ切替時に即座に表示する。
    const [resolved, resolvedV6] = await Promise.all([
      resolveCurrentPrediction(selectedId, r?.race_key),
      resolveV6Prediction(selectedId, r?.race_key),
    ]);
    setCurrent(resolved);
    setV6Current(resolvedV6);

    // FINAL表示時のみPRE boat_scoresを取得(PRE→FINAL比較用)
    if (resolved.stage === "FINAL") {
      const preV4 = await getV4Prediction(selectedId, "PRE", r?.race_key);
      if (preV4) {
        const mapped = mapV4ToUI(preV4, "PRE");
        setPreBoats(mapped?.boats || []);
      }
    }
  };
  useEffect(() => { loadDetail(); }, [selectedId, races.length]);

  // 締切直前にバックエンドで生成されたFINAL予想を、ページを開いたままでも反映する。
  // loadDetailのように表示を一度クリアせず、予想部分だけを静かに更新する。
  const refreshPredictions = async () => {
    if (!selectedId) return;
    const selectedRace = races.find((x) => x.id === selectedId);
    if (!selectedRace || selectedRace.status === "finished" || selectedRace.status === "cancelled") return;

    const [resolved, resolvedV6] = await Promise.all([
      resolveCurrentPrediction(selectedId, selectedRace.race_key),
      resolveV6Prediction(selectedId, selectedRace.race_key),
    ]);
    setCurrent(resolved);
    setV6Current(resolvedV6);
  };

  useEffect(() => {
    if (!selectedId) return undefined;
    const intervalId = window.setInterval(() => {
      refreshPredictions().catch((e) => console.warn("[Venue] prediction refresh failed:", e?.message || e));
    }, 15000);
    return () => window.clearInterval(intervalId);
  }, [selectedId, races]);

  const refreshAll = async () => {
    await loadList();
    await refreshPredictions();
  };

  const run = async (stage) => {
    if (!race) return;
    setBusy(true);
    try {
      // V4予想生成(バックエンド関数経由)
      await generateV4PredictionForRace(selectedId, stage, true);
      await loadDetail();
      await loadList();
    } catch (e) {
      alert("予想生成に失敗: " + (e?.message || e));
    }
    setBusy(false);
  };

  if (loading) return <div className="py-24 text-center text-slate-500">読み込み中…</div>;
  if (!raceList.length) return <div className="space-y-4"><Link to="/" className="text-blue-400 text-sm">← レース場一覧へ</Link><div className="py-24 text-center text-slate-500">本日のレースはありません</div></div>;

  // V4/V5はV4予想を基礎にし、V6選択時だけV6保存レコードへ切り替える。
  const displayedCurrent = predictionVersion === "v6" ? v6Current : current;
  const activePred = displayedCurrent?.pred;
  const activeBoats = [...(displayedCurrent?.boats || [])].sort((a, b) => a.boat_number - b.boat_number);
  const allTri = displayedCurrent?.trifectas || [];
  const stage = displayedCurrent?.stage;
  const pendingOdds = predictionVersion === "v4" ? displayedCurrent?.pendingOdds : false;
  const waitingFinalOdds = predictionVersion === "v4" ? displayedCurrent?.waitingFinalOdds : false;

  const probRank = [...allTri].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const evRank = [...allTri].sort((a, b) => b.expected_value - a.expected_value).slice(0, 10);
  const compareData = predictionVersion === "v4" && stage === "FINAL" && preBoats.length && activeBoats.length
    ? [1, 2, 3, 4, 5, 6].map((n) => {
        const pb = preBoats.find((b) => b.boat_number === n);
        const fb = activeBoats.find((b) => b.boat_number === n);
        if (!pb || !fb) return null;
        return { n, pre: pb.total_power, final: fb.total_power, delta: fb.total_power - pb.total_power };
      }).filter(Boolean)
    : [];

  return (
    <div className="text-slate-900 space-y-3">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <Link to="/" className="h-9 px-2.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 flex items-center gap-2 text-xs font-semibold">
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
        <button onClick={refreshAll} className="ml-auto h-9 min-w-9 px-3 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 flex items-center justify-center gap-2 text-xs font-semibold">
          <RefreshCw className="w-4 h-4" /><span className="hidden sm:inline">更新</span>
        </button>
      </div>

      {/* 1R-12R タブ */}
      <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch] pb-1">
        {raceList.map((r) => (
          <button key={r.id} onClick={() => setSelectedId(r.id)}
            className={cn("min-w-[48px] h-10 rounded-md border text-xs font-bold transition active:scale-95 flex flex-col items-center justify-center",
              r.id === selectedId ? "bg-[#f9c836] text-slate-950 border-amber-300" :
              r.status === "finished" ? "bg-white text-slate-600 border-slate-200" :
              "bg-slate-50 text-slate-700 border-slate-300 hover:border-slate-500")}>
            <span>{r.race_number}R</span>
            {r.exhibition_ready && r.id !== selectedId && <span className="text-[8px] text-blue-500">展</span>}
          </button>
        ))}
      </div>

      {/* スプリットレイアウト */}
      {race && (
        <div className="grid lg:grid-cols-[minmax(0,380px)_1fr] gap-3 sm:gap-4">
          <PredictionPanel
            race={race} stage={stage} pendingOdds={pendingOdds} waitingFinalOdds={waitingFinalOdds}
            run={run} busy={busy} entries={entries}
            activePred={activePred} activeBoats={activeBoats} allTri={allTri}
            compareData={compareData}
            predictionVersion={predictionVersion}
            onPredictionVersionChange={setPredictionVersion}
          />
          <EntryTable
            race={race} entries={entries}
            activePred={activePred} activeBoats={activeBoats} allTri={allTri}
            probRank={probRank} evRank={evRank}
            rankMode={rankMode} setRankMode={setRankMode}
            predictionVersion={predictionVersion}
          />
        </div>
      )}
    </div>
  );
}