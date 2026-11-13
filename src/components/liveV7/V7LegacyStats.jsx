import React from 'react';
import { isNewFormat, pct, summarizeLegacy } from '@/lib/v7Verification';

// 旧方式の検証記録(verification_versionが無い行)。既存記録は変更せず、参考として別集計する。
export default function V7LegacyStats({ rows, stage, mode, count }) {
  const legacy = rows.filter((row) => !isNewFormat(row));
  if (!legacy.length) return null;
  const stats = summarizeLegacy(legacy, { stage, mode, count });
  return <div className="rounded-lg border border-slate-200 p-3 space-y-1">
    <h3 className="text-sm font-semibold text-slate-700">旧方式の成績（参考・既存記録は変更しません）</h3>
    <p className="text-xs text-slate-500">旧方式は保留の判定がないため、新方式の的中率・回収率とは合算しません。</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm text-slate-700">
      {stats.map((item) => <p key={item.model}>
        {item.model === 'WOMENS' ? '女子戦' : '通常戦'} · {item.n}件 · 的中率 {pct(item.hitRate)} · 回収率 {pct(item.recovery)}
      </p>)}
    </div>
  </div>;
}