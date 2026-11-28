import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, Waves } from "lucide-react";
import {
  listTodayRaces, getRaceEntries,
  getV61Stages, ensureV61Final,
  generateV61PredictionForRace,
  getV62Stages, ensureV62Final, generateV62PredictionForRace,
  getV63Stages, ensureV63Final, generateV63PredictionForRace,
  getV64Stages, ensureV64Final, generateV64PredictionForRace,
  getV65Stages, ensureV65Final, generateV65PredictionForRace,
} from "@/lib/predictionService";
import { cn } from "@/lib/utils";
import EntryTable from "@/components/race/EntryTable";
import RaceResultCard from "@/components/race/RaceResultCard";
import UnifiedRaceView from "@/components/liveV7/UnifiedRaceView";
import { fetchOnlineData } from "@/lib/dataManagementService";
import { getRaceResult } from "@/lib/raceResultService";
import { base44 } from "@/api/base44Client";

export default function Venue() {
  const { code } = useParams();
  const [searchParams] = useSearchParams();
  const todayJst = new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Tokyo'});
  const requestedDate = searchParams.get('date');
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate||'') && Number.isFinite(Date.parse(requestedDate+'T00:00:00Z')) ? requestedDate : todayJst;
  const requestedRace = searchParams.get('race');
  const [races, setRaces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listNotice, setListNotice] = useState(null);

  // 選択中レースの詳細データ
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [v8ForecastSnapshots, setV8ForecastSnapshots] = useState(null);
  // v61Stages: 合成(V6.1)の事前予想(PRE)と直前予想(FINAL)。画面の表示ソースはこれだけ。
  const [v61Stages, setV61Stages] = useState({ pre: null, final: null });
  // v62Stages: V6.2(回収率重視)の事前予想(PRE)と直前予想(FINAL)。
  // V6.2タブを開いた時だけ読み込む。
  const [v62Stages, setV62Stages] = useState({ pre: null, final: null });
  // v63Stages: V6.3(V4・V6.2・V5統合)の事前予想と直前予想。V6.3タブを開いた時だけ読み込む。
  const [v63Stages, setV63Stages] = useState({ pre: null, final: null });
  // v64Stages: V6.4(V6.1・V6.2・V6.3合議)の事前予想と直前予想。V6.4タブを開いた時だけ読み込む。
  const [v64Stages, setV64Stages] = useState({ pre: null, final: null });
  // v65Stages: V6.5(女子戦・的中率特化)の事前予想と直前予想。女子戦のレースだけ読み込む。
  const [v65Stages, setV65Stages] = useState({ pre: null, final: null });
  const [stageTab, setStageTab] = useState(null);
  const [predictionVersion, setPredictionVersion] = useState("mix");
  const [busy, setBusy] = useState(false);
  const [rankMode, setRankMode] = useState("prob");
  const [raceResult, setRaceResult] = useState(null);
  const sectionFetchTried = useRef(new Set());
  const exhibitionFetchTried = useRef(new Set());
  // 保存データの読取と外部補完は別々に管理する。補完中もDBを読めるようにする。
  const detailSeq = useRef(0);
  const savedReadSeq = useRef(0);
  const savedRefreshInFlight = useRef(null);
  const collectionInFlight = useRef(new Map());
  const resultInFlight = useRef(new Map());
  const latestRaceRef = useRef(null);
  const selectionScope = useRef(null);
  const selectionKey = `${selectedDate}:${String(code).padStart(2, '0')}:${selectedId || ''}`;
  if (selectionScope.current?.key !== selectionKey) selectionScope.current = { key: selectionKey };
  const listSeq = useRef(0);

  // Initial load and background refresh must read the same selected JST date.
  const readVenueRaces = async ({ force = false } = {}) => {
    const currentDay = selectedDate === todayJst;
    const all = currentDay ? await listTodayRaces({ includeFinished: true, raceDate: selectedDate, force })
      : await base44.entities.Race.filter({race_date:selectedDate,venue_code:{$in:[String(code).padStart(2,'0'),String(Number(code))]}},'race_number',100);
    if (!Array.isArray(all) || (!currentDay && all.length >= 100)) throw new Error('レース情報を最後まで確認できませんでした');
    return all.filter((r) => r.race_date === selectedDate && String(r.venue_code).padStart(2, "0") === String(code).padStart(2, "0"))
      .sort((a, b) => a.race_number - b.race_number);
  };

  const loadList = async ({ force = false } = {}) => {
    const request = ++listSeq.current;
    setLoading(true);
    try {
    const list = await readVenueRaces({ force });
    if (request !== listSeq.current) return;
    if (!list.length) {
      setListNotice(`${selectedDate} のレース情報はまだ確認できません。番組の取得待ち、または非開催の可能性があります。`);
      return;
    }
    setRaces(list);
    setListNotice(null);
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
    } catch (error) {
      if (request === listSeq.current) setListNotice('選択日のレース情報を読み込めませんでした。取得済みの表示を保ったまま、再読込をお待ちしています。');
      console.warn('[Venue] race list load failed:', error?.message || error);
    } finally {
      if (request === listSeq.current) setLoading(false);
    }
  };
  useEffect(() => {
    detailSeq.current++; void loadList();
    return () => { listSeq.current++; detailSeq.current++; };
  }, [code,selectedDate,requestedRace]);

  const raceList = useMemo(() => races.filter(r=>r.race_date===selectedDate && String(r.venue_code).padStart(2,'0')===String(code).padStart(2,'0')), [races,selectedDate,code]);
  const visibleRace = race?.id===selectedId && race?.race_date===selectedDate && String(race?.venue_code).padStart(2,'0')===String(code).padStart(2,'0');
  // A closed race must not trap users on an empty V7 view when a future race is available.
  const nextOpenRace = useMemo(() => {
    const now = Date.now();
    return raceList.find(r => r.id !== selectedId && !['finished','cancelled'].includes(r.status) &&
      r.deadline && Number.isFinite(Date.parse(r.deadline)) && Date.parse(r.deadline) > now);
  }, [raceList, selectedId]);

  const venueName = raceList[0]?.venue || raceList[0]?.venue_name || `場コード ${code}`;

  const captureScope = () => ({ view: selectionScope.current, detail: detailSeq.current });
  const isCurrentScope = (scope) => scope.view === selectionScope.current && scope.detail === detailSeq.current;

  // DB読取だけを行う。外部取得・予想生成・結果補完は表示の完了条件にしない。
  const readSavedDetail = async ({ initialRace = null, refreshList = true, force = false, scope = captureScope() } = {}) => {
    if (!selectedId || !isCurrentScope(scope)) return null;
    const request = ++savedReadSeq.current;
    const stale = () => !isCurrentScope(scope) || request !== savedReadSeq.current;
    let selectedRace = initialRace || (latestRaceRef.current?.id === selectedId ? latestRaceRef.current : raceList.find((r) => r.id === selectedId));
    try {
      if (refreshList) {
        const listRequest = ++listSeq.current;
        const latestList = await readVenueRaces({ force });
        if (stale() || listRequest !== listSeq.current) return null;
        setLoading(false);
        if (!latestList.length) {
          setListNotice('選択日の最新番組が未取得のため、直前に確認できた内容を表示しています。');
          return null;
        }
        selectedRace = latestList.find((r) => r.id === selectedId)
          || latestList.find((r) => selectedRace?.race_key && r.race_key === selectedRace.race_key);
        if (!selectedRace) {
          setListNotice('選択中のレースを最新番組で確認できないため、取得済みの表示を保持しています。');
          return null;
        }
        setRaces(latestList);
        if (selectedRace.id !== selectedId) {
          setSelectedId(selectedRace.id);
          return null;
        }
      }
      if (!selectedRace || selectedRace.race_date !== selectedDate || String(selectedRace.venue_code).padStart(2, '0') !== String(code).padStart(2, '0')) return null;
      latestRaceRef.current = selectedRace;
      setRace(selectedRace);
      const freshEntries = await getRaceEntries(selectedRace.id, selectedRace.race_key);
      if (stale()) return null;
      if (!Array.isArray(freshEntries)) throw new Error('出走表の保存データを確認できませんでした');
      if (freshEntries.length) setEntries(freshEntries);
      setListNotice(null);
      return { race: selectedRace, entries: freshEntries, scope };
    } catch (error) {
      if (!stale()) setListNotice('最新情報を更新できませんでした。取得済みの表示を保持しています。');
      console.warn('[Venue] saved detail read failed:', error?.message || error);
      return null;
    }
  };

  // 結果APIは未取得結果を外部から補完するため、出走表の読取とは独立させる。
  const refreshRaceResult = async (r, scope) => {
    if (!isCurrentScope(scope) || resultInFlight.current.has(r.id)) return;
    const token = {};
    resultInFlight.current.set(r.id, token);
    try {
      const result = await getRaceResult(r);
      if (isCurrentScope(scope) && result) setRaceResult(result);
    } catch (error) {
      console.warn('[Venue] result refresh failed:', error?.message || error);
    } finally {
      if (resultInFlight.current.get(r.id) === token) resultInFlight.current.delete(r.id);
    }
  };

  // 外部補完は同一レースで重ねない。この待ち時間はDBの表示pollを止めない。
  const completeRaceData = async (r, es, { initial = false, scope } = {}) => {
    const currentRace = () => latestRaceRef.current?.id === r.id ? latestRaceRef.current : r;
    const canCollect = () => isCurrentScope(scope) && !['finished', 'cancelled'].includes(currentRace().status)
      && !['CANCELLED', 'POSTPONED'].includes(currentRace().schedule_status);
    if (!canCollect() || collectionInFlight.current.has(r.id)) return;
    const token = {};
    collectionInFlight.current.set(r.id, token);
    const sectionKey = `${r.race_date}_${String(r.venue_code).padStart(2, '0')}_${r.race_number}`;
    const collect = async (type) => {
      if (!canCollect()) return;
      try {
        await fetchOnlineData(type, r.race_date, r.venue_code, r.race_number, r.id);
      } catch (error) {
        console.warn(`[Venue] ${type} supplement failed:`, sectionKey, error?.message || error);
      }
      if (isCurrentScope(scope)) await readSavedDetail({ force: true, scope });
    };
    try {
      const hasSection = (es || []).some((e) => e.section_points != null || e.section_st != null || !!e.section_finishes || e.section_momentum != null);
      if (!hasSection && !sectionFetchTried.current.has(sectionKey)) {
        sectionFetchTried.current.add(sectionKey);
        await collect('section');
      }
      if (!canCollect()) return;
      const activeEntries = (es || []).filter((e) => !e.is_absent && !e.is_scratched);
      const hasCompleteExhibition = activeEntries.length > 0 && activeEntries.every((e) => e.exhibition_time != null && e.exhibition_st != null);
      const minsToDeadline = (Date.parse(currentRace().deadline || '') - Date.now()) / 60000;
      const initialExhibition = initial && !hasCompleteExhibition && minsToDeadline <= 60 && minsToDeadline >= -30 && !exhibitionFetchTried.current.has(sectionKey);
      if (initialExhibition || (!initial && minsToDeadline <= 60 && minsToDeadline > 0)) {
        if (initialExhibition) exhibitionFetchTried.current.add(sectionKey);
        await collect('exhibition');
      }
      const minsToOddsDeadline = (Date.parse(currentRace().deadline || '') - Date.now()) / 60000;
      if (!initial && minsToOddsDeadline <= 25 && minsToOddsDeadline > 0) await collect('odds');
    } finally {
      if (collectionInFlight.current.get(r.id) === token) collectionInFlight.current.delete(r.id);
    }
  };

  const loadDetail = async () => {
    if (!selectedId) return;
    ++detailSeq.current;
    const scope = captureScope();
    const r = raceList.find((x) => x.id === selectedId);
    // 切替直後に前レースの艇・結果を新しいレース名の下へ表示しない。
    setEntries([]);
    setRaceResult(null);
    setV8ForecastSnapshots(null);
    latestRaceRef.current = r || null;
    setRace(r || null);
    if (!r) return;
    const saved = await readSavedDetail({ initialRace: r, refreshList: false, scope });
    if (!saved) return;
    void refreshRaceResult(saved.race, scope);
    void completeRaceData(saved.race, saved.entries, { initial: true, scope });
  };
  useEffect(() => {
    loadDetail().catch((e) => console.warn("[Venue] detail load failed:", e?.message || e));
  }, [selectedId, races.length]);

  // V6.2タブを開いた時だけV6.2予想を読み込む。
  // 直前予想が未生成なら背景で生成する(V6.1と同じ挙動)。
  useEffect(() => {
    if (predictionVersion !== "v62" || !selectedId || !race) return undefined;
    let cancelled = false;
    const raceKey = race.race_key;
    (async () => {
      const stages = await getV62Stages(selectedId, raceKey);
      if (cancelled) return;
      setV62Stages(stages);
      if (stages.final || !race.exhibition_ready) return;
      const ensured = await ensureV62Final(race);
      if (cancelled || !ensured) return;
      setV62Stages(await getV62Stages(selectedId, raceKey));
    })().catch((e) => console.warn("[Venue] V6.2 load failed:", e?.message || e));
    return () => { cancelled = true; };
  }, [predictionVersion, selectedId, race?.race_key, race?.exhibition_ready]);

  // V6.3タブを開いた時だけV6.3予想を読み込む。未生成なら背景で生成する。
  useEffect(() => {
    if (predictionVersion !== "v63" || !selectedId || !race) return undefined;
    let cancelled = false;
    const raceKey = race.race_key;
    (async () => {
      const stages = await getV63Stages(selectedId, raceKey);
      if (cancelled) return;
      setV63Stages(stages);
      if (stages.final || !race.exhibition_ready) return;
      await generateV63PredictionForRace(selectedId, "FINAL", false).catch(() => null);
      if (cancelled) return;
      setV63Stages(await getV63Stages(selectedId, raceKey));
    })().catch((e) => console.warn("[Venue] V6.3 load failed:", e?.message || e));
    return () => { cancelled = true; };
  }, [predictionVersion, selectedId, race?.race_key, race?.exhibition_ready]);

  // V6.4タブを開いた時だけV6.4予想を読み込む。未生成なら背景で生成する。
  useEffect(() => {
    if (predictionVersion !== "v64" || !selectedId || !race) return undefined;
    let cancelled = false;
    const raceKey = race.race_key;
    (async () => {
      const stages = await getV64Stages(selectedId, raceKey);
      if (cancelled) return;
      setV64Stages(stages);
      if (stages.final || !race.exhibition_ready) return;
      await generateV64PredictionForRace(selectedId, "FINAL", false).catch(() => null);
      if (cancelled) return;
      setV64Stages(await getV64Stages(selectedId, raceKey));
    })().catch((e) => console.warn("[Venue] V6.4 load failed:", e?.message || e));
    return () => { cancelled = true; };
  }, [predictionVersion, selectedId, race?.race_key, race?.exhibition_ready]);

  // V6.5(女子戦)タブを開いた時だけV6.5予想を読み込む。未生成なら背景で生成する。
  useEffect(() => {
    if (predictionVersion !== "v65" || !selectedId || !race) return undefined;
    let cancelled = false;
    const raceKey = race.race_key;
    (async () => {
      const stages = await getV65Stages(selectedId, raceKey);
      if (cancelled) return;
      setV65Stages(stages);
      if (stages.final || !race.exhibition_ready) return;
      await generateV65PredictionForRace(selectedId, "FINAL", false).catch(() => null);
      if (cancelled) return;
      setV65Stages(await getV65Stages(selectedId, raceKey));
    })().catch((e) => console.warn("[Venue] V6.5 load failed:", e?.message || e));
    return () => { cancelled = true; };
  }, [predictionVersion, selectedId, race?.race_key, race?.exhibition_ready]);

  // 締切直前にバックエンドで生成されたFINAL予想を、ページを開いたままでも反映する。
  // loadDetailのように表示を一度クリアせず、予想部分だけを静かに更新する。
  const refreshPredictions = async ({ force = false } = {}) => {
    if (!selectedId) return;
    if (!force && typeof document !== "undefined" && document.hidden) return;
    const scope = captureScope();
    // DB poll同士だけをまとめる。手動更新・別レースは遅い旧読取を待たない。
    if (!force && savedRefreshInFlight.current && isCurrentScope(savedRefreshInFlight.current.scope)) return;
    const token = { scope };
    savedRefreshInFlight.current = token;
    try {
      const saved = await readSavedDetail({ force, scope });
      if (!saved) return;
      void refreshRaceResult(saved.race, saved.scope);
      void completeRaceData(saved.race, saved.entries, { scope: saved.scope });
      // この画面の予想はUnifiedRaceViewのV8/V7。表示に使わないV6生成は起動しない。
    } finally {
      if (savedRefreshInFlight.current === token) savedRefreshInFlight.current = null;
    }
  };

  const refreshDeadlineMs = Date.parse(race?.deadline || '');
  const nearDeadline = Number.isFinite(refreshDeadlineMs) && Math.abs(Date.now() - refreshDeadlineMs) <= 30 * 60 * 1000;
  useEffect(() => {
    if (!selectedId || !visibleRace) {
      const waitingTimer = window.setInterval(() => { if (!document.hidden) void loadList(); }, 90000);
      return () => window.clearInterval(waitingTimer);
    }
    // 締切前後30分は20秒、それ以外は90秒。外部補完の完了を待たず保存値を読む。
    const intervalId = window.setInterval(() => {
      void refreshPredictions();
    }, nearDeadline ? 20000 : 90000);
    return () => window.clearInterval(intervalId);
  }, [selectedId, visibleRace, race?.deadline, nearDeadline, selectedDate, code]);

  const refreshAll = async () => {
    if (selectedId && visibleRace) await refreshPredictions({ force: true });
    else await loadList({ force: true });
  };

  const run = async (stage) => {
    if (!race) return;
    setBusy(true);
    try {
      // V6.2タブ表示中はV6.2を再実行する。それ以外は合成(V6.1)を再実行する
      // (V5も合成予想の評価から算出するためV6.1を再実行する)。
      if (predictionVersion === "v62") {
        await generateV62PredictionForRace(selectedId, stage, true);
      } else if (predictionVersion === "v63") {
        await generateV63PredictionForRace(selectedId, stage, true);
      } else if (predictionVersion === "v64") {
        await generateV64PredictionForRace(selectedId, stage, true);
      } else if (predictionVersion === "v65") {
        await generateV65PredictionForRace(selectedId, stage, true);
      } else {
        await generateV61PredictionForRace(selectedId, stage, true);
      }
      await loadDetail();
      if (predictionVersion === "v62") {
        setV62Stages(await getV62Stages(selectedId, race?.race_key));
      } else if (predictionVersion === "v63") {
        setV63Stages(await getV63Stages(selectedId, race?.race_key));
      } else if (predictionVersion === "v64") {
        setV64Stages(await getV64Stages(selectedId, race?.race_key));
      } else if (predictionVersion === "v65") {
        setV65Stages(await getV65Stages(selectedId, race?.race_key));
      }
      await loadList();
      // 再実行した段階(事前/直前)のタブを表示したままにする
      setStageTab(stage);
    } catch (e) {
      // 保存後の応答だけがレート制限になる場合があるため、DBを再確認して表示を回復する。
      let recovered = false;
      try {
        if (predictionVersion === "v62") {
          const refreshed = await getV62Stages(selectedId, race?.race_key);
          setV62Stages(refreshed);
          recovered = !!refreshed[stage === "FINAL" ? "final" : "pre"];
        } else if (predictionVersion === "v63") {
          const refreshed = await getV63Stages(selectedId, race?.race_key);
          setV63Stages(refreshed);
          recovered = !!refreshed[stage === "FINAL" ? "final" : "pre"];
        } else if (predictionVersion === "v64") {
          const refreshed = await getV64Stages(selectedId, race?.race_key);
          setV64Stages(refreshed);
          recovered = !!refreshed[stage === "FINAL" ? "final" : "pre"];
        } else if (predictionVersion === "v65") {
          const refreshed = await getV65Stages(selectedId, race?.race_key);
          setV65Stages(refreshed);
          recovered = !!refreshed[stage === "FINAL" ? "final" : "pre"];
        } else {
          const refreshed = await getV61Stages(selectedId, race?.race_key);
          setV61Stages(refreshed);
          recovered = !!refreshed[stage === "FINAL" ? "final" : "pre"];
        }
        if (recovered) setStageTab(stage);
      } catch {
        recovered = false;
      }
      if (!recovered) alert("予想生成に失敗: " + (e?.message || e));
    }
    setBusy(false);
  };

  if (loading && !raceList.length) return <div className="py-24 text-center text-slate-500">{selectedDate} のレースを読み込み中…</div>;
  if (!raceList.length) return <div className="space-y-4"><Link to="/" className="text-blue-400 text-sm">← レース場一覧へ</Link><div className="space-y-4 py-16 text-center text-sm text-slate-500"><p>{listNotice || `${selectedDate} のレース情報をまだ取得できていません`}</p><button type="button" onClick={()=>void loadList()} className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700">再読込</button></div></div>;

  // 合成(V6.1)をメイン予想にし、事前予想(PRE)/直前予想(FINAL)をタブで切り替える。
  // V5は同じ合成予想の評価を参照する展開シナリオ。
  // 既定は事前予想。直前予想はタブを押した時だけ表示する。
  const effectiveStageTab = stageTab === "FINAL" ? "FINAL" : "PRE";
  // 表示ソースは選択中のエンジン(V6.2タブ選択時はV6.2予想)
  const displayStages = predictionVersion === "v62" ? v62Stages
    : predictionVersion === "v63" ? v63Stages
    : predictionVersion === "v64" ? v64Stages
    : predictionVersion === "v65" ? v65Stages
    : v61Stages;
  const displayedCurrent = displayStages[effectiveStageTab === "FINAL" ? "final" : "pre"];
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
  const compareSourcePre = displayStages.pre?.boats || null;
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
            <div className="text-[9px] sm:text-[10px] tracking-widest text-slate-500">VENUE {String(code).padStart(2, "0")} · {selectedDate}</div>
          </div>
        </div>
        <button onClick={refreshAll} className="ml-auto h-9 min-w-9 px-3 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 flex items-center justify-center gap-2 text-xs font-semibold">
          <RefreshCw className="w-4 h-4" /><span className="hidden sm:inline">更新</span>
        </button>
      </div>

      {listNotice && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">{listNotice}</p>}

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

      {visibleRace && <RaceResultCard race={race} entries={entries} raceResult={raceResult} />}

      {/* 表示は一つ。展示前は展開、展示後はV7 FINAL。 */}
      {visibleRace && <UnifiedRaceView key={race.id} race={race} entries={entries} nextOpenRace={nextOpenRace} onSelectNextRace={() => nextOpenRace && setSelectedId(nextOpenRace.id)} onForecastSnapshots={setV8ForecastSnapshots} />}

      {visibleRace && <section className="rounded-xl border border-slate-200 bg-white p-3">
        <h2 className="font-bold mb-3 text-slate-900">出走表・展示・選手情報</h2>
        <EntryTable
          race={race} entries={entries}
          activePred={null} activeBoats={[]} allTri={[]}
          probRank={[]} evRank={[]}
          rankMode={rankMode} setRankMode={setRankMode}
          predictionVersion="v7"
          v8Forecasts={v8ForecastSnapshots?.race_id === race.id ? v8ForecastSnapshots : null}
        />
      </section>}
    </div>
  );
}
