// 統合V7の検証集計(サーバー保存分)。
// 端末内のローカル集計と違い、別端末・別タブで生成された予想も含めて照合する。
import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const yen = (value) => (value == null ? '—' : `${value.toLocaleString('ja-JP')}円`);

// 同一レース・同一段階・同一モデルでは、締切前の初回予想だけを代表として数える。
function firstPerRace(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.race_key}|${row.stage}|${row.model}`;
    const previous = map.get(key);
    if (!previous || String(row.generated_at) < String(previous.generated_at)) map.set(key, row);
  }
  return [...map.values()];
}

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
      .filter({ race_date: { $gte: since } }, '-verified_at', 1000)
      .then((list) => { if (!cancelled) setRows(list || []); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  const summaries = useMemo(() => {
    if (!rows) return [];
    const base = firstPerRace(rows).filter((row) => row.stage === stage);
    return ['OPEN', 'WOMENS'].map((model) => {
      const list = base.filter((row) => row.model === model);
      const rank = [0, 0, 0];
      let n = 0, hits = 0, stake = 0, payout = 0, missing = false;
      for (const row of list) {
        const plan = row.plans?.find((item) => item.key === `${mode}_${count}`);
        if (!plan) continue;
        n++;
        stake += plan.investment || 0;
        (row.rank_hits || []).forEach((hit, i) => { if (hit && i < 3) rank[i]++; });
        if (!plan.hit) continue;
        hits++;
        if (plan.payout == null) missing = true;
        else payout += plan.payout;
      }
      return {
        model, n, hits, stake,
        hitRate: n ? hits / n : null,
        recovery: n && stake && !missing ? payout / stake : null,
        rank: rank.map((value) => (n ? value / n : null)),
      };
    });
  }, [rows, stage, mode, count]);

  return <section data-testid="v7-server-verification" className="rounded-xl border bg-white p-3 space-y-3 mt-3">
    <div>
      <h2 className="font-bold">V7 サーバー検証（全端末・日次照合）</h2>
      <p className="text-sm text-slate-600">別の端末やタブで生成したV7予想も含めて、確定結果と照合した成績です。同一レースは締切前の初回予想だけを数えます。</p>
    </div>
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <label>段階 <select className="min-h-11 border rounded px-2" value={stage} onChange={(e) => setStage(e.target.value)}><option>PRE</option><option>FINAL</option></select></label>
      <label>方式 <select className="min-h-11 border rounded px-2" value={mode} onChange={(e) => setMode(e.target.value)}><option value="hit">的中率優先</option><option value="value">回収率優先</option></select></label>
      <label>点数 <select className="min-h-11 border rounded px-2" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[4, 6, 8, 12].map((n) => <option key={n} value={n}>{n}点</option>)}</select></label>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">検証データを取得できません：{error}</p>}
    {!rows && !error && <p className="text-sm text-slate-600">読み込み中…</p>}
    {rows && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {summaries.map((item) => <article key={item.model} className="rounded-lg bg-slate-50 p-3 text-sm space-y-1">
        <h3 className="font-semibold">{item.model === 'WOMENS' ? '女子戦' : '通常戦'} · {item.n}件</h3>
        <p>三連単 {item.hits}件 · 的中率 {pct(item.hitRate)}</p>
        <p>仮想投資 {yen(item.n ? item.stake : null)} · 仮想回収率 {pct(item.recovery)}</p>
        <p>各着順 {item.rank.map((value, i) => `${i + 1}着 ${pct(value)}`).join(' / ')}</p>
      </article>)}
    </div>}
    <p className="text-xs text-slate-600">各組番100円の仮想計算です。確定払戻が欠ける的中は回収率を未算出とします。</p>
  </section>;
}