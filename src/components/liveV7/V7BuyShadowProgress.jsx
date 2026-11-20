import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';

const num = (n) => Number(n || 0).toLocaleString('ja-JP');
const money = (n) => num(n) + '円';
const pct = (numerator, denominator) => denominator ? (numerator / denominator * 100).toFixed(1) + '%' : '—';
const dateValue = (v) => {
  const raw = String(v || '').trim().replace(/(\\.\\d{3})\\d+/, '$1');
  if (!raw) return null;
  // DBのcreated_dateはTZのないUTC。JSTのブラウザーでもUTCとして比較する。
  const normalized = /(Z|[+-]\\d{2}:?\\d{2})$/.test(raw) ? raw : raw + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
};
const LIMIT = 200;
const TICKET_KEY = 'hit_8';
const buyTarget = 100;
const MODEL_LABEL = { OPEN: '一般戦', WOMENS: '女子戦' };

async function getAllTrials() {
  const rows = [];
  let cursor;
  const cursors = new Set();
  const ids = new Set();
  for (let pageNo = 1; pageNo <= 30; pageNo++) {
    const page = await base44.entities.V7BuyShadowTrial.filter({}, {
      sort: '-created_date', limit: LIMIT, ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page?.items) || typeof page?.has_more !== 'boolean') {
      throw new Error('台帳のページ取得に失敗しました（' + pageNo + 'ページ）');
    }
    for (const row of page.items) {
      if (!row?.id || ids.has(row.id)) throw new Error('台帳の重複・不完全な取得を検出しました');
      ids.add(row.id);
      rows.push(row);
    }
    if (!page.has_more) {
      if (page.next_cursor) throw new Error('最終ページのカーソル不一致');
      return rows;
    }
    if (!page.next_cursor || cursors.has(page.next_cursor)) {
      throw new Error('続きのページを安全に取得できません');
    }
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  throw new Error('台帳が6,000件を超えました。集計範囲の見直しが必要です');
}

function metric(label, value, note) {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-1 text-xl font-black text-slate-900">{value}</div>
    {note && <div className="mt-1 text-[11px] text-slate-500">{note}</div>}
  </div>;
}

function resultFor(row, verifiedByHash) {
  const v = verifiedByHash.get(row.prediction_hash);
  if (!v) return null;
  const p = (v.plans || []).find((entry) => entry.key === TICKET_KEY);
  return p || null;
}

function stats(rows, verifiedByHash) {
  const assessed = rows.map((row) => ({ row, plan: resultFor(row, verifiedByHash) })).filter((x) => x.plan);
  const hits = assessed.filter((x) => x.plan.hit === true).length;
  const stake = assessed.reduce((n, x) => n + Number(x.plan.investment || 800), 0);
  const payout = assessed.reduce((n, x) => n + Number(x.plan.payout || 0), 0);
  return { total: rows.length, n: assessed.length, pending: rows.length - assessed.length,
    hits, hitRate: pct(hits, assessed.length), roi: stake ? pct(payout, stake) : '—', stake, payout };
}

export default function V7BuyShadowProgress({ groups = [] }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState('OPEN');

  const reload = async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try { setRows(await getAllTrials()); }
    catch (err) { setRows(null); setError(err?.message || '記録を取得できませんでした'); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (isAdmin) void reload(); }, [isAdmin]);

  const verifiedByHash = useMemo(() => {
    const map = new Map();
    for (const group of groups) {
      if (group.status === 'VERIFIED' && group.prediction?.record_hash && group.verification)
        map.set(group.prediction.record_hash, group.verification);
    }
    return map;
  }, [groups]);

  const view = useMemo(() => {
    const originals = (rows || []).filter((r) => r.model === model);
    const first = new Map();
    for (const row of [...originals].sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)))) {
      if (!first.has(row.trial_key)) first.set(row.trial_key, row);
    }
    const records = [...first.values()].sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)));
    const invalid = records.filter((row) => {
      const created = dateValue(row.created_date);
      const cutoff = dateValue(row.cutoff_at);
      return created == null || cutoff == null || created >= cutoff;
    });
    const valid = records.filter((row) => !invalid.includes(row));
    const buys = valid.filter((row) => row.decision === 'BUY');
    const skips = valid.filter((row) => row.decision === 'SKIP');
    const unknown = valid.filter((row) => row.decision === 'UNDETERMINED');
    const currentBuys = valid.filter((row) => row.current_buy_judgment === 'BUY' && row.prediction_hash);
    return { records, invalid, buys, skips, unknown, duplicates: originals.length - records.length,
      buyStats: stats(buys, verifiedByHash), currentStats: stats(currentBuys, verifiedByHash) };
  }, [rows, model, verifiedByHash]);

  if (!isAdmin) return null;

  return <section className="rounded-xl border border-sky-200 bg-white p-3 space-y-4 sm:p-4" data-testid="v7-buy-shadow-progress">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-lg font-black text-slate-900">V7 BUY候補・自動検証</h2>
        <p className="mt-1 text-xs text-slate-600">管理者用・研究中。現行のBUY判定や買い目には反映されません。</p>
        <p className="mt-1 text-xs text-slate-500">固定条件：8点中1号艇1着5点以上／充足率95%以上／8点すべて8倍以上／締切60秒前までに保存</p>
      </div>
      <button type="button" onClick={reload} disabled={loading} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold disabled:opacity-60">{loading ? '読込中…' : 'データ更新'}</button>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-sm text-slate-700">対象
        <select value={model} onChange={(event) => setModel(event.target.value)}
          className="ml-2 min-h-11 rounded-lg border border-slate-300 bg-white px-2">
          <option value="OPEN">一般戦</option>
          <option value="WOMENS">女子戦</option>
        </select>
      </label>
      <div className="text-xs text-slate-500">BUY候補100件を初期評価の目安に、的中率40%以上を研究目標とします。</div>
    </div>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {!rows && !error && <p className="text-sm text-slate-500">台帳を読み込み中…</p>}
    {rows && <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {metric('新BUY候補', num(view.buys.length) + '件', '目安100件／' + Math.min(100, view.buys.length) + '%到達')}
        {metric('BUY的中率', view.buyStats.hitRate, view.buyStats.hits + '的中／' + view.buyStats.n + '件の結果確定')}
        {metric('BUY仮想回収率', view.buyStats.roi, '各組番100円・8点')}
        {metric('結果待ち', num(view.buyStats.pending) + '件', '結果未照合は分母に含めない')}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {metric('SKIP', num(view.skips.length) + '件')}
        {metric('未判定', num(view.unknown.length) + '件', 'データ欠落など')}
        {metric('現行BUYの的中率', view.currentStats.hitRate, view.currentStats.n + '件で比較')}
        {metric('現行BUYの回収率', view.currentStats.roi, '同じ記録対象内の比較')}
      </div>
      {(view.invalid.length > 0 || view.duplicates > 0) &&
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          時刻不成立{view.invalid.length}件、重複{view.duplicates}件は集計対象から除外しました。
        </p>}
      <div>
        <h3 className="mb-2 text-sm font-bold text-slate-800">最新30件の判定記録</h3>
        {!view.records.length && <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">まだ記録がありません。定期Workflowが対象レースを検出すると表示します。</p>}
        <div className="space-y-2">
          {view.records.slice(0,30).map((row) => {
            const p = resultFor(row, verifiedByHash);
            const timely = dateValue(row.created_date) != null && dateValue(row.cutoff_at) != null && dateValue(row.created_date) < dateValue(row.cutoff_at);
            return <div key={row.id} className="rounded-lg border border-slate-200 p-3 text-xs">
              <div className="flex flex-wrap justify-between gap-2">
                <strong>{row.race_date}・{String(row.venue_code || '').padStart(2,'0')}場 {row.race_number}R</strong>
                <span className="font-bold">{row.decision} / {timely ? '締切前保存' : '保存時刻未確認'}</span>
              </div>
              <p className="mt-1 text-slate-600">
                イン{row.inside_count ?? '—'}点／充足率{row.coverage == null ? '—' : (Number(row.coverage)*100).toFixed(1)+'%'}／最低オッズ{row.min_odds ?? '—'}倍
              </p>
              <p className="mt-1 text-slate-600">{row.reason || '—'} ／ 既存BUY {row.current_buy_judgment || '—'} ／ 8点の実結果 {p ? (p.hit ? '的中' : '不的中') : '未照合'}</p>
            </div>;
          })}
        </div>
      </div>
      <p className="text-[11px] leading-5 text-slate-500">
        予想を保存した後のオッズでさかのぼって判定することはありません。データはBase44の独立台帳に追記されます。
        時刻証跡はBase44の保存時刻による運用上の確認であり、第三者による改変不能の証明ではありません。
        研究中の成績であり、購入推奨ではありません。
      </p>
    </>}
  </section>;
}
