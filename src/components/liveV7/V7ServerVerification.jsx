// 統合V7の検証集計(サーバー保存分)。
// 新方式(v2)の有効検証だけで的中率・回収率を計算し、保留は件数のみ表示する。
// 旧方式の記録は変更せず、別集計として参考表示する。
import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import V7CoverageSummary from '@/components/liveV7/V7CoverageSummary';
import V7CurrentStats from '@/components/liveV7/V7CurrentStats';
import V7LegacyStats from '@/components/liveV7/V7LegacyStats';

export default function V7ServerVerification() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [stage, setStage] = useState('FINAL');
  const [mode, setMode] = useState('hit');
  const [count, setCount] = useState(8);

  useEffect(() => {
    let cancelled = false;
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    base44.entities.PredictionV7Verification
      .filter({ race_date: { $gte: since } }, '-verified_at', 2000)
      .then((list) => { if (!cancelled) setRows(list || []); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  return <section data-testid="v7-server-verification" className="rounded-xl border bg-white p-3 space-y-3 mt-3">
    <div>
      <h2 className="font-bold">V7 サーバー検証（全端末・日次照合）</h2>
      <p className="text-sm text-slate-600">別の端末やタブで生成したV7予想も含めて、確定結果と照合した成績です。同一レース×段階の重複、締切後の保存、締切不明、時刻の矛盾、払戻不足、買い目不足、参照先の不一致は理由別に保留とし、的中率・回収率の分子・分母から除外します。</p>
    </div>
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <label>段階 <select className="min-h-11 border rounded px-2" value={stage} onChange={(e) => setStage(e.target.value)}><option>PRE</option><option>FINAL</option></select></label>
      <label>方式 <select className="min-h-11 border rounded px-2" value={mode} onChange={(e) => setMode(e.target.value)}><option value="hit">的中率優先</option><option value="value">回収率優先</option></select></label>
      <label>点数 <select className="min-h-11 border rounded px-2" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[4, 6, 8, 12].map((n) => <option key={n} value={n}>{n}点</option>)}</select></label>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">検証データを取得できません：{error}</p>}
    <V7CoverageSummary />
    {!rows && !error && <p className="text-sm text-slate-600">読み込み中…</p>}
    {rows && <V7CurrentStats rows={rows} stage={stage} mode={mode} count={count} />}
    {rows && <V7LegacyStats rows={rows} stage={stage} mode={mode} count={count} />}
    <p className="text-xs text-slate-600">各組番100円の仮想計算です。有効検証のみを集計し、保留は件数のみ表示します。</p>
  </section>;
}