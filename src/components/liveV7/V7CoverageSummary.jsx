import React from 'react';
import { HOLD_LABELS } from '@/lib/v7Verification';

function Tile({ value, unit, label, tone, valueTone }) {
  return <div className={`rounded-md p-2 ${tone}`}>
    <div className={`text-lg font-black ${valueTone}`}>{value}<span className="text-xs font-normal">{unit}</span></div>
    <div className="text-[11px] text-slate-500">{label}</div>
  </div>;
}

// 画面の4件数。照合処理と同じ集計単位(レース×段階=1組、2件以上は全件重複保留)で数えた値を表示する。
export default function V7CoverageSummary({ summary }) {
  if (!summary) return null;
  const checked = summary.verified + summary.held + summary.unverified + summary.legacy;

  return <div className="rounded-lg border border-slate-200 p-3 space-y-2">
    <h3 className="text-sm font-semibold text-slate-800">直近30日の保存・検証状況</h3>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
      <Tile value={summary.unsaved} unit="R" label="未保存（締切済みで予想なし）" tone="bg-slate-50" valueTone="text-slate-900" />
      <Tile value={summary.unverified} unit="組" label="未検証（照合待ち）" tone="bg-slate-50" valueTone="text-slate-900" />
      <Tile value={summary.held} unit="組" label="保留（集計除外）" tone="bg-amber-50" valueTone="text-amber-800" />
      <Tile value={summary.verified} unit="組" label="有効検証" tone="bg-emerald-50" valueTone="text-emerald-700" />
    </div>
    <p className="text-[11px] text-slate-600">
      照合対象{summary.groups}組 ＝ 有効検証{summary.verified} ＋ 保留{summary.held} ＋ 未検証{summary.unverified}{summary.legacy ? ` ＋ 旧方式${summary.legacy}` : ''}（合計{checked}組）
      <br />
      重複保留 {summary.duplicateGroups}組（{summary.duplicateRecords}件）は代表を決めず全件を集計から除外（予想{summary.records}件）
    </p>
    {summary.holds.length > 0 && <p className="text-xs text-slate-600">
      保留内訳: {summary.holds.map(([key, value]) => `${HOLD_LABELS[key] || key} ${value}組`).join(' / ')}
    </p>}
  </div>;
}