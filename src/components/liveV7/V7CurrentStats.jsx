import React from 'react';
import { HOLD_LABELS, holdBreakdown, isHeld, isNewFormat, isVerified, pct, summarizeVerified, yen } from '@/lib/v7Verification';

// 新方式(v2)の成績。有効検証だけを集計し、保留は除外件数として必ず表示する。
export default function V7CurrentStats({ rows, stage, mode, count }) {
  const current = rows.filter(isNewFormat);
  const verified = current.filter(isVerified);
  const held = current.filter(isHeld);
  const stats = summarizeVerified(verified, { stage, mode, count });
  const holds = holdBreakdown(current);

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded-md bg-emerald-50 px-2 py-1 font-bold text-emerald-700">有効検証 {verified.length}件</span>
      <span className="rounded-md bg-amber-50 px-2 py-1 font-bold text-amber-800">保留 {held.length}件</span>
      <span className="text-xs text-slate-500">保留は的中率・回収率の分子・分母から除外</span>
    </div>
    {holds.length > 0 && <p className="text-xs text-slate-600">
      保留内訳: {holds.map(([key, value]) => `${HOLD_LABELS[key] || key} ${value}件`).join(' / ')}
    </p>}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {stats.map((item) => <article key={item.model} className="rounded-lg bg-slate-50 p-3 text-sm space-y-1">
        <h3 className="font-semibold">{item.model === 'WOMENS' ? '女子戦' : '通常戦'} · {item.n}件</h3>
        <p>三連単 {item.hits}件 · 的中率 {pct(item.hitRate)}</p>
        <p>仮想投資 {yen(item.n ? item.stake : null)} · 仮想回収率 {pct(item.recovery)}</p>
        <p>各着順 {item.rank.map((value, i) => `${i + 1}着 ${pct(value)}`).join(' / ')}</p>
      </article>)}
    </div>
  </div>;
}