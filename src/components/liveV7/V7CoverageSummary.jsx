import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { HOLD_LABELS, holdBreakdown, isHeld, isVerified, jstDate } from '@/lib/v7Verification';

const toMs = (value) => {
  const raw = String(value ?? '').trim().replace(/(\.\d{3})\d+/, '$1');
  if (!raw) return NaN;
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`);
};

// 直近3日分の「未保存・未検証・保留・有効検証」件数。読み取りのみで書き込みは行わない。
export default function V7CoverageSummary() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const dates = [jstDate(0), jstDate(-1), jstDate(-2)];
    Promise.all([
      base44.entities.Race.filter({ race_date: { $in: dates } }, '-created_date', 1200),
      base44.entities.PredictionV7.filter({ race_date: { $in: dates } }, '-created_date', 1200),
      base44.entities.PredictionV7Verification.filter({ race_date: { $in: dates } }, '-verified_at', 1200),
    ]).then(([races, predictions, verifications]) => {
      if (cancelled) return;
      const now = Date.now();
      const closed = (races || []).filter((race) => race.status !== 'cancelled'
        && Number.isFinite(toMs(race.deadline)) && toMs(race.deadline) <= now);
      const predicted = new Set((predictions || []).map((row) => row.race_key));
      const unsaved = closed.filter((race) => !predicted.has(race.race_key)).length;

      const doneHashes = new Set((verifications || []).map((row) => row.record_hash));
      const groups = new Map();
      for (const row of predictions || []) {
        const key = `${row.race_key}::${row.stage}`;
        const list = groups.get(key) || [];
        list.push(row);
        groups.set(key, list);
      }
      const unverified = [...groups.values()]
        .filter((list) => !list.some((row) => doneHashes.has(row.record_hash))).length;

      const rows = verifications || [];
      setData({
        closed: closed.length,
        unsaved,
        unverified,
        held: rows.filter(isHeld).length,
        verified: rows.filter(isVerified).length,
        holds: holdBreakdown(rows),
        dates,
      });
    }).catch((e) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p role="alert" className="text-sm text-amber-800">保存状況を取得できません：{error}</p>;
  if (!data) return <p className="text-sm text-slate-600">保存状況を読み込み中…</p>;

  return <div className="rounded-lg border border-slate-200 p-3 space-y-2">
    <h3 className="text-sm font-semibold text-slate-800">直近3日の保存・検証状況</h3>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
      <div className="rounded-md bg-slate-50 p-2"><div className="text-lg font-black">{data.unsaved}<span className="text-xs font-normal">R</span></div><div className="text-[11px] text-slate-500">未保存（締切済み{data.closed}R中）</div></div>
      <div className="rounded-md bg-slate-50 p-2"><div className="text-lg font-black">{data.unverified}<span className="text-xs font-normal">件</span></div><div className="text-[11px] text-slate-500">未検証（照合待ち）</div></div>
      <div className="rounded-md bg-amber-50 p-2"><div className="text-lg font-black text-amber-800">{data.held}<span className="text-xs font-normal">件</span></div><div className="text-[11px] text-amber-700">保留（集計除外）</div></div>
      <div className="rounded-md bg-emerald-50 p-2"><div className="text-lg font-black text-emerald-700">{data.verified}<span className="text-xs font-normal">件</span></div><div className="text-[11px] text-emerald-700">有効検証</div></div>
    </div>
    {data.holds.length > 0 && <p className="text-xs text-slate-600">
      保留内訳: {data.holds.map(([key, value]) => `${HOLD_LABELS[key] || key} ${value}件`).join(' / ')}
    </p>}
  </div>;
}