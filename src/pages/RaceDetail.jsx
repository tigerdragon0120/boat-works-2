import React, { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import {
  getRaceEntries,
  getV61Stages, ensureV61Final,
  generateV61PredictionForRace,
} from "@/lib/predictionService";
import PredictionPanel from "@/components/race/PredictionPanel";
import EntryTable from "@/components/race/EntryTable";
import { getRaceResult } from "@/lib/raceResultService";
import { ArrowLeft } from "lucide-react";

export default function RaceDetail() {
  const { id } = useParams();
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  // v61Stages: 合成(V6.1)の事前予想(PRE)と直前予想(FINAL)。
  // { stage, pred, boats, trifectas } — UIの表示ソースはこれだけ。
  const [v61Stages, setV61Stages] = useState({ pre: null, final: null });
  const [stageTab, setStageTab] = useState(null);
  const [predictionVersion, setPredictionVersion] = useState("mix");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rankMode, setRankMode] = useState("prob");
  const [raceResult, setRaceResult] = useState(null);
  // 背景生成の完了時に、既に別レースへ切り替わっていないか確認するための参照
  const activeRaceIdRef = useRef(id);
  useEffect(() => { activeRaceIdRef.current = id; }, [id]);

  const load = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      // 前レースのstateを完全クリア(mergeではなくreplace)
      // レース切替時は必ず事前予想(PRE)を先に見せる
      setV61Stages({ pre: null, final: null });
      setStageTab("PRE");
    }

    const r = await base44.entities.Race.get(id);
    setRace(r);
    const es = await getRaceEntries(id, r?.race_key);
    setEntries(es || []);
    const result = await getRaceResult(r);
    if (activeRaceIdRef.current !== id) return;
    setRaceResult(result);

    // === 合成(V6.1) 予想resolver ===
    // 事前予想(PRE)と直前予想(FINAL)を取得。UIの唯一の表示ソース。
    setV61Stages(await getV61Stages(id, r?.race_key));

    if (!silent) setLoading(false);

    // === 合成(V6.1) FINAL自動生成保証 ===
    // 展示取得済み・締切前で直前予想が未生成なら背景で生成する。
    // 事前予想の初回表示を待たせないため、ここではawaitしない。
    if (r?.exhibition_ready && r?.deadline && new Date(r.deadline).getTime() > Date.now()) {
      ensureV61Final(r)
        .then(async (ensured) => {
          if (!ensured || activeRaceIdRef.current !== id) return;
          const r2 = await base44.entities.Race.get(id);
          setRace(r2);
          setV61Stages(await getV61Stages(id, r2?.race_key));
        })
        .catch((e) => console.warn("[RaceDetail] V6.1 FINAL auto-gen failed:", e?.message || e));
    }
  };

  useEffect(() => { load(); }, [id]);

  // 締切6分前から締切1分後まで、最新FINAL予想を10秒ごとに再取得する。
  // オッズはバックエンドで取得・保存されるため、ここでは画面の古い表示だけを更新する。
  useEffect(() => {
    if (!race?.deadline || race?.status === "finished" || race?.status === "cancelled") return;

    const deadlineMs = new Date(race.deadline).getTime();
    if (!Number.isFinite(deadlineMs)) return;

    const pollStartMs = deadlineMs - 6 * 60 * 1000;
    const pollEndMs = deadlineMs + 60 * 1000;
    const nowMs = Date.now();
    if (nowMs >= pollEndMs) return;

    let intervalId = null;
    let timeoutId = null;
    let refreshInFlight = false;

    const refresh = async () => {
      if (refreshInFlight || Date.now() >= pollEndMs) return;
      refreshInFlight = true;
      try {
        await load({ silent: true });
      } catch (e) {
        console.warn("[RaceDetail] live refresh failed:", e?.message || e);
      } finally {
        refreshInFlight = false;
      }
    };

    const startPolling = () => {
      refresh();
      intervalId = window.setInterval(refresh, 10000);
    };

    if (nowMs >= pollStartMs) {
      startPolling();
    } else {
      timeoutId = window.setTimeout(startPolling, pollStartMs - nowMs);
    }

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [id, race?.deadline, race?.status]);

  const run = async (stage) => {
    setBusy(true);
    try {
      // 表示は合成(V6.1)とV5。V5も合成予想の評価から算出するためV6.1を再実行する。
      await generateV61PredictionForRace(id, stage, true);
      // 再実行後: resolver再実行しcurrentPredictionを完全置き換え
      // PRE stateへmergeせず、最新データで完全replace
      await load();
      // 再実行した段階(事前/直前)のタブを表示したままにする
      setStageTab(stage);
    } catch (e) {
      alert("予想生成に失敗: " + (e?.message || e));
    }
    setBusy(false);
  };

  if (loading) return <div className="py-20 text-center text-slate-500 text-sm">読み込み中…</div>;
  if (!race) return <div className="py-20 text-center text-slate-500">レースが見つかりません</div>;

  // 合成(V6.1)をメイン予想にし、事前予想(PRE)/直前予想(FINAL)をタブで切り替える。
  // 既定は事前予想。直前予想はタブを押した時だけ表示する。
  const effectiveStageTab = stageTab === "FINAL" ? "FINAL" : "PRE";
  const displayedCurrent = v61Stages[effectiveStageTab === "FINAL" ? "final" : "pre"];
  const activePred = displayedCurrent?.pred;
  const activeBoats = [...(displayedCurrent?.boats || [])].sort((a, b) => a.boat_number - b.boat_number);
  const allTri = displayedCurrent?.trifectas || [];
  const stage = displayedCurrent?.stage; // "FINAL" | "PRE" | null
  // 直前予想で実オッズが未取得の場合は、その旨を画面上に明示する
  const waitingFinalOdds = stage === "FINAL" && !allTri.some((t) => t.actual_odds != null);
  const pendingOdds = waitingFinalOdds;

  const probRank = [...allTri].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const evRank = [...allTri].sort((a, b) => b.expected_value - a.expected_value).slice(0, 10);

  // 事前予想 → 直前予想 比較 (FINAL表示時のみ、比較用PREデータを使用)
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
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-[#f9c836] mb-3">
        <ArrowLeft className="w-4 h-4" /> レース一覧
      </Link>

      {raceResult && (raceResult.result_status === "RESULT_FINAL" || raceResult.is_finished) && (
        <div className="mb-4 rounded-xl border-2 border-rose-500 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-bold text-slate-900">🏁 レース結果</h2>
            <span className="rounded-md bg-rose-500 px-3 py-1 text-sm font-bold text-white">確定</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {((raceResult.finish_order?.length ? raceResult.finish_order : (raceResult.result_trifecta || "").split("-").map(Number).filter(Boolean))).slice(0,3).map((boat, i) => (
              <div key={i} className="rounded-lg border bg-slate-50 p-3 text-center">
                <div className="text-xs font-bold text-slate-500">{i + 1}着</div>
                <div className="text-2xl font-black">{boat}号艇</div>
              </div>
            ))}
          </div>
          <div className="border-t pt-3">
            <div className="font-bold mb-2">💴 払戻金</div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {raceResult.payouts?.trifecta && <div className="flex justify-between"><span>3連単 {raceResult.payouts.trifecta.combination}</span><b>{Number(raceResult.payouts.trifecta.payout || 0).toLocaleString()}円</b></div>}
              {raceResult.payouts?.trifecta_quinella && <div className="flex justify-between"><span>3連複 {raceResult.payouts.trifecta_quinella.combination}</span><b>{Number(raceResult.payouts.trifecta_quinella.payout || 0).toLocaleString()}円</b></div>}
              {raceResult.payouts?.exacta && <div className="flex justify-between"><span>2連単 {raceResult.payouts.exacta.combination}</span><b>{Number(raceResult.payouts.exacta.payout || 0).toLocaleString()}円</b></div>}
              {raceResult.payouts?.quinella && <div className="flex justify-between"><span>2連複 {raceResult.payouts.quinella.combination}</span><b>{Number(raceResult.payouts.quinella.payout || 0).toLocaleString()}円</b></div>}
              {!raceResult.payouts?.trifecta && raceResult.result_trifecta && <div className="flex justify-between"><span>3連単 {raceResult.result_trifecta}</span><b>{Number(raceResult.payout || 0).toLocaleString()}円</b></div>}
              {(raceResult.payouts?.wide || []).map((w,i)=><div key={"w"+i} className="flex justify-between"><span>拡連複 {w.combination}</span><b>{Number(w.payout || 0).toLocaleString()}円</b></div>)}
            </div>
          </div>
        </div>
      )}

      {/* スプリットレイアウト: 左=予想サマリー / 右=出走表 */}
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
    </div>
  );
}