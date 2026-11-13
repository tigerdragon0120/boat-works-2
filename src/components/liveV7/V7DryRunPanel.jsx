import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';

// 確認モード(書き込みなし)で照合を試し、追記候補と直近30日の保存済み有効件数を区別して表示する
export default function V7DryRunPanel({ saved }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('verifyV7Daily', { days: 3, dry_run: true });
      setResult(res?.data || null);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const snap = result?.snapshot || null;

  return <div className="rounded-lg border border-slate-200 p-3 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-slate-800">確認モード（直近3日・書き込みなし）</h3>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="min-h-11 rounded-md border border-slate-300 px-3 text-sm font-semibold disabled:opacity-60"
      >
        {busy ? '照合中…' : '照合を試す'}
      </button>
    </div>
    <p className="text-sm text-slate-700">
      保存済みの有効件数 {saved?.verified ?? 0}組（保留 {saved?.held ?? 0}組／未検証 {saved?.unverified ?? 0}組）
    </p>
    {error && <p role="alert" className="text-sm text-red-700">確認モードを実行できません：{error}</p>}
    {result && <>
      <p className="text-sm font-semibold text-slate-800">
        確認モードの候補 {result.would_write ?? 0}件（有効検証 {result.verified ?? 0}件／保留 {result.held ?? 0}件）
      </p>
      <p className="text-xs text-slate-600">
        うち判定変更 {result.rejudged ?? 0}件・新規 {result.new_records ?? 0}件・変更なし {result.skipped_already ?? 0}件
      </p>
      {snap && <p className="text-xs text-slate-600">
        照合後の見込み: 有効検証 {snap.verified}組／保留 {snap.held}組／未検証 {snap.unverified}組（照合対象{snap.groups}組・重複保留{snap.duplicate_groups}組）
      </p>}
      <p className="text-xs text-slate-500">確認モードは記録を保存しません。候補は保存済みの有効件数とは別に数えています。</p>
    </>}
  </div>;
}