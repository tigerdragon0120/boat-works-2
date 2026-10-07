import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, Waves } from "lucide-react";
import {
  listTodayRaces, getRaceEntries,
  getV61Stages, ensureV61Final,
  generateV61PredictionForRace, withRetry,
} from "@/lib/predictionService";
import { cn } from "@/lib/utils";
import PredictionPanel from "@/components/race/PredictionPanel";
import EntryTable from "@/components/race/EntryTable";
import RaceResultCard from "@/components/race/RaceResultCard";
import { fetchOnlineData } from "@/lib/dataManagementService";
import { base44 } from "@/api/base44Client";

export default function Venue() {
  const { code } = useParams();
  const [searchParams] = useSearchParams();
  const [races, setRaces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);

  // 選択中レースの詳細データ
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  // v61Stages: 合成(V6.1)の事前予想(PRE)と直前予想(FINAL)。画面の表示ソースはこれだけ。
  const [v61Stages, setV61Stages] = useState({ pre: null, final: null });
  const [stageTab, setStageTab] = useState(null);
  const [predictionVersion, setPredictionVersion] = useState("mix");
  const [busy, setBusy] = useState(false);
  const [rankMode, setRankMode] = useState("prob");
  const [raceResult, setRaceResult] = useState(null);
  const sectionFetchTried = useRef(new Set());
  const exhibitionFetchTried = useRef(new Set());
  // 重複した読み込みを抑えてAPIレート制限に達しないようにする
  const detailSeq = useRef(0);
  const refreshBusy = useRef(false);

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
    // レースを素早く切り替えた時、古い読み込みが走り続けないよう打ち切る
    const seq = ++detailSeq.current;
    const stale = () => seq !== detailSeq.current;
    // 前レースのstateを完全クリア
    // レース切替時は必ず事前予想(PRE)を先に見せる
    setV61Stages({ pre: null, final: null });
    setStageTab("PRE");
    setRaceResult(null);

    const r = races.find((x) => x.id === selectedId);
    setRace(r);
    if (!r) return;
    let es = await getRaceEntries(selectedId, r.race_key);
    if (stale()) return;

    // 節間成績が未取得なら、そのレースの公式racelistから自動補完する。
    const hasSection = (es || []).some((e) =>
      e.section_points != null || e.section_st != null || !!e.section_finishes || e.section_momentum != null
    );
    const sectionKey = `${r.race_date}_${String(r.venue_code).padStart(2, "0")}_${r.race_number}`;
    if (!hasSection && !sectionFetchTried.current.has(sectionKey)) {
      sectionFetchTried.current.add(sectionKey);
      try {
        await fetchOnlineData("section", r.race_date, r.venue_code, r.race_number, r.id);
        es = await getRaceEntries(selectedId, r.race_key);
      } catch (err) {
        console.warn("節間成績の自動取得に失敗", sectionKey, err);
      }
    }
    // 締切60分前〜30分後で展示が未取得なら、画面を開いた時にも1回だけ即時取得する。
    // 5分周期ワーカーが大量の重複Raceで対象レースまで到達できない場合の安全網。
    const activeEntries = (es || []).filter((e) => !e.is_absent && !e.is_scratched);
    const hasCompleteExhibition = activeEntries.length > 0 && activeEntries.every((e) =>
      e.exhibition_time != null && e.exhibition_st != null
    );
    const deadlineMs = r.deadline ? new Date(r.deadline).getTime() : NaN;
    const nowMs = Date.now();
    const inExhibitionWindow = Number.isFinite(deadlineMs) &&
      nowMs >= deadlineMs - 60 * 60 * 1000 && nowMs <= deadlineMs + 30 * 60 * 1000;
    if (!hasCompleteExhibition && inExhibitionWindow && !exhibitionFetchTried.current.has(sectionKey)) {
      exhibitionFetchTried.current.add(sectionKey);
      try {
        const exhibitionResult = await fetchOnlineData("exhibition", r.race_date, r.venue_code, r.race_number, r.id);
        es = await getRaceEntries(selectedId, r.race_key);
        if (exhibitionResult?.data?.exhibition_ready === true) {
          setRace((prev) => prev ? { ...prev, exhibition_ready: true } : prev);
        }
      } catch (err) {
        console.warn("展示データの即時取得に失敗", sectionKey, err);
      }
    }
    if (stale()) return;
    setEntries(es || []);
    let resultRows = await withRetry(() => base44.entities.RaceResult.filter({ race_id: selectedId }, "-finished_at", 1));
    let latestResult = resultRows?.[0] || null;

    // 終了済みレースで旧データが3連単払戻しか持っていない場合、
    // 画面を開いた時に公式結果を再取得して全券種払戻を自動補完する。
    const raceEnded = r.status === "finished" || (Number.isFinite(deadlineMs) && nowMs > deadlineMs);
    // 一部券種だけ保存された結果を「取得済み」と誤判定しない。
    // 主要4券種 + 拡連複(通常3組)が揃うまで公式結果を再取得して補完する。
    const payouts = latestResult?.payouts || {};
    const hasFullPayouts = !!(
      payouts.trifecta?.combination && payouts.trifecta?.payout != null &&
      payouts.trifecta_quinella?.combination && payouts.trifecta_quinella?.payout != null &&
      payouts.exacta?.combination && payouts.exacta?.payout != null &&
      payouts.quinella?.combination && payouts.quinella?.payout != null &&
      Array.isArray(payouts.wide) && payouts.wide.length >= 3
    );
    if (raceEnded && latestResult?.result_trifecta && !hasFullPayouts) {
      try {
        const refreshResult = await fetchOnlineData("result", r.race_date, r.venue_code, r.race_number, r.id);
        if (refreshResult?.data?.ok !== false) {
          resultRows = await withRetry(() => base44.entities.RaceResult.filter({ race_id: selectedId }, "-finished_at", 1));
          latestResult = resultRows?.[0] || latestResult;
        }
      } catch (err) {
        console.warn("払戻全券種の自動補完に失敗", sectionKey, err);
      }
    }
    setRaceResult(latestResult);

    // 合成(V6.1)の事前予想・直前予想を取得し、タブ切替時に即座に表示する。
    const resolvedV61Stages = await getV61Stages(selectedId, r?.race_key);
    if (stale()) return;
    setV61Stages(resolvedV61Stages);

    // === 合成(V6.1) FINAL自動生成保証 ===
    // 展示取得済み・締切前で直前予想が未生成なら背景で生成する。
    // 事前予想の初回表示を待たせないため、ここではawaitしない。
    if (!resolvedV61Stages.final && r?.exhibition_ready && r?.deadline
        && new Date(r.deadline).getTime() > Date.now()) {
      ensureV61Final(r)
        .then(async (ensured) => {
          if (stale() || !ensured) return;
          setV61Stages(await getV61Stages(selectedId, r?.race_key));
        })
        .catch((e) => console.warn("[Venue] V6.1 FINAL auto-gen failed:", e?.message || e));
    }
  };
  useEffect(() => {
    loadDetail().catch((e) => console.warn("[Venue] detail load failed:", e?.message || e));
  }, [selectedId, races.length]);

  // 締切直前にバックエンドで生成されたFINAL予想を、ページを開いたままでも反映する。
  // loadDetailのように表示を一度クリアせず、予想部分だけを静かに更新する。
  const refreshPredictions = async () => {
    if (!selectedId) return;
    // 15秒周期の更新が重なったり、非表示タブで走り続けると
    // APIレート制限に達するため、実行中と非表示中はスキップする。
    if (refreshBusy.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    refreshBusy.current = true;
    try {

    // 展示・オッズは締切直前にバックエンドで更新されるため、
    // 予想だけでなくRace/RaceEntryも再読込して開いたままの画面へ反映する。
    const latestAll = await listTodayRaces({ includeFinished: true });
    const latestList = (latestAll || [])
      .filter((r) => String(r.venue_code).padStart(2, "0") === String(code).padStart(2, "0"))
      .sort((a, b) => a.race_number - b.race_number);
    const selectedRace = latestList.find((x) => x.id === selectedId)
      || latestList.find((x) => x.race_key === race?.race_key);
    if (!selectedRace) return;

    setRaces(latestList);
    setRace(selectedRace);

    const freshEntries = await getRaceEntries(selectedRace.id, selectedRace.race_key);
    setEntries(freshEntries || []);

    // レース終了後にRaceResultが後から入っても、開いたまま結果・払戻を反映する。
    // 取得できなかったときは既存の正常な表示を消さない。
    const latestResult = await withRetry(() => base44.entities.RaceResult.filter({ race_id: selectedRace.id }, "-finished_at", 1));
    if (latestResult?.[0]) setRaceResult(latestResult[0]);

    if (selectedRace.status === "finished" || selectedRace.status === "cancelled") return;
    setV61Stages(await getV61Stages(selectedRace.id, selectedRace.race_key));
    } finally {
      refreshBusy.current = false;
    }
  };

  useEffect(() => {
    if (!selectedId) return undefined;
    // 締切前後30分は15秒、それ以外は60秒で静かに更新する。
    // 開いたままの画面への反映は保ちつつ、APIレート制限に達しない頻度に抑える。
    const deadlineMs = race?.deadline ? new Date(race.deadline).getTime() : NaN;
    const nearDeadline = Number.isFinite(deadlineMs) && Math.abs(Date.now() - deadlineMs) <= 30 * 60 * 1000;
    const intervalId = window.setInterval(() => {
      refreshPredictions().catch((e) => console.warn("[Venue] prediction refresh failed:", e?.message || e));
    }, nearDeadline ? 15000 : 60000);
    return () => window.clearInterval(intervalId);
  }, [selectedId, races, race?.deadline]);

  const refreshAll = async () => {
    await loadList();
    await refreshPredictions();
  };

  const run = async (stage) => {
    if (!race) return;
    setBusy(true);
    try {
      // 表示は合成(V6.1)とV5。V5も合成予想の評価から算出するためV6.1を再実行する。
      await generateV61PredictionForRace(selectedId, stage, true);
      await loadDetail();
      await loadList();
      // 再実行した段階(事前/直前)のタブを表示したままにする
      setStageTab(stage);
    } catch (e) {
      alert("予想生成に失敗: " + (e?.message || e));
    }
    setBusy(false);
  };

  if (loading) return <div className="py-24 text-center text-slate-500">読み込み中…</div>;
  if (!raceList.length) return <div className="space-y-4"><Link to="/" className="text-blue-400 text-sm">← レース場一覧へ</Link><div className="py-24 text-center text-slate-500">本日のレースはありません</div></div>;

  // 合成(V6.1)をメイン予想にし、事前予想(PRE)/直前予想(FINAL)をタブで切り替える。
  // V5は同じ合成予想の評価を参照する展開シナリオ。
  // 既定は事前予想。直前予想はタブを押した時だけ表示する。
  const effectiveStageTab = stageTab === "FINAL" ? "FINAL" : "PRE";
  const displayedCurrent = v61Stages[effectiveStageTab === "FINAL" ? "final" : "pre"];
  const activePred = displayedCurrent?.pred;
  const activeBoats = [...(displayedCurrent?.boats || [])].sort((a, b) => a.boat_number - b.boat_number);
  const allTri = displayedCurrent?.trifectas || [];
  const stage = displayedCurrent?.stage;
  // 直前予想で実オッズが未取得の場合は、その旨を画面上に明示する
  const waitingFinalOdds = stage === "FINAL" && !allTri.some((t) => t.actual_odds != null);
  const pendingOdds = waitingFinalOdds;

  const probRank = [...allTri].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const evRank = [...allTri].sort((a, b) => b.expected_value - a.expected_value).slice(0, 10);
  // 事前予想 → 直前予想 の評価変化(合成V6.1の2段予想を比較)
  const compareSourcePre = v61Stages.pre?.boats || null;
  const compareData = stage === "FINAL" && compareSourcePre?.length && activeBoats.length
    ? [1, 2, 3, 4, 5, 6].map((n) => {
        const pb = compareSourcePre.find((b) => b.boat_number === n);
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

      {race && <RaceResultCard race={race} entries={entries} raceResult={raceResult} />}

      {/* スプリットレイアウト */}
      {race && (
        <div className="grid lg:grid-cols-[minmax(0,380px)_1fr] gap-3 sm:gap-4">
          <PredictionPanel
            race={race} stage={stage} pendingOdds={pendingOdds} waitingFinalOdds={waitingFinalOdds}
            run={run} busy={busy} entries={entries}
            activePred={activePred} activeBoats={activeBoats} allTri={allTri}
            compareData={compareData}
            stageTab={effectiveStageTab} stages={v61Stages} onStageTabChange={setStageTab}
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