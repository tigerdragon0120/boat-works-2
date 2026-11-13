// 統合V7の検証集計(サーバー保存分)。
// 集計単位はレース×段階。2件以上ある組は最初の1件も含めて全件を重複保留とし、集計から除外する。
// 予想1件につき最新の照合記録だけを使い、再判定後の二重計上を防ぐ。
// 4件数(未保存・未検証・保留・有効検証)は同じ読み込み時点のデータから1回だけ数える。
import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { jstDate, reconcileV7 } from '@/lib/v7Verification';
import V7CoverageSummary from '@/components/liveV7/V7CoverageSummary';
import V7CurrentStats from '@/components/liveV7/V7CurrentStats';
import V7LegacyStats from '@/components/liveV7/V7LegacyStats';

export default function V7ServerVerification() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [stage, setStage] = useState('FINAL');
  const [mode, setMode] = useState('hit');
  const [count, setCount] = useState(8);

  useEffect(() => {
    let cancelled = false;
    const coverageDates = [jstDate(0), jstDate(-1), jstDate(-2)];
    const since = jstDate(-30);
    Promise.all([
      base44.entities.Race.filter({ race_date: { $in: coverageDates } }, '-created_date', 2000),
      base44.entities.PredictionV7.filter({ race_date: { $gte: since } }, '-created_date', 3000),
      base44.entities.PredictionV7Verification.filter({ race_date: { $gte: since } }, '-verified_at', 3000),
    ]).then(([races, predictions, verifications]) => {
      if (cancelled) return;
      const allPredictions = predictions || [];
      const allVerifications = verifications || [];
      const month = reconcileV7({ predictions: allPredictions, verifications: allVerifications });
      setState({
        coverage: reconcileV7({
          predictions: allPredictions.filter((row) => coverageDates.includes(row.race_date)),
          verifications: allVerifications,
          races: races || [],
        }),
        month,
      });
    }).catch((e) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  return <section data-testid="v7-server-verification" className="rounded-xl border bg-white p-3 space-y-3 mt-3">
    <div>
      <h2 className="font-bold">V7 サーバー検証（全端末・日次照合）</h2>
      <p className="text-sm text-slate-600">別の端末やタブで生成したV7予想も含めて、確定結果と照合した成績です。同一レース×段階に2件以上の予想がある場合は、最初の1件も含めて全件を重複保留とし、代表を決めずに集計から除外します。締切後の保存・締切不明・時刻の矛盾・払戻不足・買い目不足・参照先の不一致も理由別に保留とし、的中率・回収率の分子・分母から除外します（払戻・締切は補完後に再判定）。</p>
    </div>
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <label>段階 <select className="min-h-11 border rounded px-2" value={stage} onChange={(e) => setStage(e.target.value)}><option>PRE</option><option>FINAL</option></select></label>
      <label>方式 <select className="min-h-11 border rounded px-2" value={mode} onChange={(e) => setMode(e.target.value)}><option value="hit">的中率優先</option><option value="value">回収率優先</option></select></label>
      <label>点数 <select className="min-h-11 border rounded px-2" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[4, 6, 8, 12].map((n) => <option key={n} value={n}>{n}点</option>)}</select></label>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">検証データを取得できません：{error}</p>}
    {!state && !error && <p className="text-sm text-slate-600">読み込み中…</p>}
    {state && <V7CoverageSummary summary={state.coverage} />}
    {state && <h3 className="text-sm font-semibold text-slate-800">直近30日の成績（重複保留を除く）</h3>}
    {state && <V7CurrentStats rows={state.month.rows} counts={state.month} stage={stage} mode={mode} count={count} />}
    {state && <V7LegacyStats rows={state.month.rows} stage={stage} mode={mode} count={count} />}
    <p className="text-xs text-slate-600">各組番100円の仮想計算です。有効検証のみを集計し、保留と重複保留は件数のみ表示します。</p>
  </section>;
}