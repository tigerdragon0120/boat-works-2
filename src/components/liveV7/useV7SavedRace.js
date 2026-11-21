import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { loadRaceEvidence } from '@/lib/resultEvidence';
import { adaptSavedStage, selectSavedStage, latestDisplayOddsSnapshot } from '@/liveV7/savedDisplayAdapter';

// 予想の読み取りを最優先にする。オッズ/結果APIの失敗で保存済み予想を消さない。
const EMPTY = {
  stages: { PRE: null, FINAL: null }, displayOdds: null, evidence: null,
  resultCandidate: null, resultConflict: false, error: null, loading: true,
};

async function loadSavedPredictions(race) {
  // race_key はV7台帳の固定識別子。Race.idで読めない場合にもこのキーから復旧する。
  let byKey = null;
  try {
    byKey = await base44.entities.PredictionV7.filter(
      { race_key: race.race_key }, '-created_date', 30,
    );
  } catch {
    // 一時的なrace_key検索失敗時だけ、固定race_idによる取得を試す。
  }
  if (Array.isArray(byKey) && byKey.length >= 30) {
    throw new Error('V7予想の取得結果が不完全です');
  }
  const matching = Array.isArray(byKey)
    ? byKey.filter((p) => p?.race_id === race.id) : [];
  if (matching.length) return matching;

  // 同期遅延などによるrace_key検索0件のときだけ、race_idで再確認する。
  const byId = await base44.entities.PredictionV7.filter(
    { race_id: race.id }, '-created_date', 30,
  );
  if (!Array.isArray(byId) || byId.length >= 30) {
    throw new Error('V7予想の再取得に失敗しました');
  }
  return byId.filter((p) => p?.race_key === race.race_key);
}

export default function useV7SavedRace(race) {
  const [data, setData] = useState(EMPTY);
  useEffect(() => {
    if (!race?.id || !race?.race_key) return;
    let active = true;
    const load = async () => {
      // 各APIは独立して扱い、オッズ/確定結果の一時障害を予想0件に見せない。
      const predictionsTask = loadSavedPredictions(race);
      const oddsTask = base44.entities.OddsSnapshot.filter(
        { race_id: race.id, stage: 'FINAL' }, '-captured_at', 30,
      );
      const resultTask = base44.entities.RaceResult.filter(
        { race_id: race.id }, '-created_date', 30,
      );
      const [predictionResult, oddsResult, resultResult] = await Promise.allSettled([
        predictionsTask, oddsTask, resultTask,
      ]);
      if (!active) return;

      const errors = [];
      const predictionRows = predictionResult.status === 'fulfilled' ? predictionResult.value : null;
      if (!Array.isArray(predictionRows)) {
        errors.push('V7予想の取得に失敗しました');
      }
      const oddsRows = oddsResult.status === 'fulfilled' && Array.isArray(oddsResult.value)
        ? oddsResult.value : [];
      if (oddsResult.status === 'rejected') errors.push('オッズの取得に失敗しました');
      const resultRows = resultResult.status === 'fulfilled' && Array.isArray(resultResult.value)
        ? resultResult.value : [];
      if (resultResult.status === 'rejected') errors.push('結果の取得に失敗しました');
      if (resultRows.length >= 30) errors.push('結果の候補を読み切れませんでした');

      const now = Date.now();
      const stages = predictionRows ? {
        PRE: adaptSavedStage(selectSavedStage(predictionRows, 'PRE', race), oddsRows, now),
        FINAL: adaptSavedStage(selectSavedStage(predictionRows, 'FINAL', race), oddsRows, now),
      } : { PRE: null, FINAL: null };

      const displayOdds = latestDisplayOddsSnapshot(oddsRows, race.id, race.deadline, now);
      const completed = resultRows.filter((r) =>
        r?.race_id === race.id && (r.is_finished === true || r.result_status === 'RESULT_FINAL') &&
        /^[1-6]-[1-6]-[1-6]$/.test(String(r.result_trifecta || '')) &&
        new Set(String(r.result_trifecta).split('-')).size === 3,
      );
      const combinations = new Set(completed.map((r) => String(r.result_trifecta)));
      const resultConflict = combinations.size > 1;
      const resultCandidate = combinations.size === 1 ? completed[0] : null;
      // V7の予想を先に表示。結果証跡の取得完了を待って画面を空白にしない。
      if (active) setData((prev) => ({
        stages, displayOdds, evidence: prev.evidence, resultCandidate, resultConflict,
        error: errors.length ? errors.join('／') : null,
        loading: false,
      }));
      const deadline = Date.parse(race.deadline || '');
      if (race.status === 'finished' || (Number.isFinite(deadline) && now >= deadline)) {
        const evidence = await loadRaceEvidence(race.id);
        if (active) setData((prev) => ({ ...prev, evidence }));
      }
    };
    setData(EMPTY);
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 45000);
    return () => { active = false; window.clearInterval(timer); };
  }, [race?.id, race?.race_key, race?.deadline]);
  return data;
}
