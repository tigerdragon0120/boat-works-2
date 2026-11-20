import React, { useMemo, useState } from 'react';
import { HOLD_LABELS } from '@/lib/v7Verification';

const VENUES = {
  '01': '桐生', '02': '戸田', '03': '江戸川', '04': '平和島',
  '05': '多摩川', '06': '浜名湖', '07': '蒲郡', '08': '常滑',
  '09': '津', '10': '三国', '11': 'びわこ', '12': '住之江',
  '13': '尼崎', '14': '鳴門', '15': '丸亀', '16': '児島',
  '17': '宮島', '18': '徳山', '19': '下関', '20': '若松',
  '21': '芦屋', '22': '福岡', '23': '唐津', '24': '大村',
};
const TICKET_COUNTS = [4, 6, 8, 12];

const number = (n) => Number(n || 0).toLocaleString('ja-JP');
const yen = (n) => Number(n || 0).toLocaleString('ja-JP') + '円';
const percentage = (n) => n == null ? '—' : n.toFixed(1) + '%';
const categoryLabel = (value) => value === 'WOMENS' ? '女子戦' : '一般戦';
const statusLabel = (value) => value === 'VERIFIED' ? '有効検証'
  : value === 'UNVERIFIED' ? '未検証'
  : value === 'LEGACY' ? '旧形式'
  : '保留';

function planOf(row, mode, count) {
  return (row.verification?.plans || []).find((p) => p.key === mode + '_' + count) || null;
}

function judgmentOfPlan(plan) {
  return String(plan?.judgment || '判定なし').toUpperCase();
}

function summarize(entries) {
  let hits = 0;
  let stake = 0;
  let payout = 0;
  for (const item of entries) {
    if (item.plan.hit === true) hits++;
    stake += Number(item.plan.investment || (Number(item.plan.tickets || 0) * 100));
    payout += Number(item.plan.payout || 0);
  }
  return {
    n: entries.length,
    hits,
    stake,
    payout,
    hitRate: entries.length ? hits / entries.length * 100 : null,
    roi: stake ? payout / stake * 100 : null,
  };
}

function Metric({ label, value, sub, emphasis }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className={emphasis ? 'mt-1 text-2xl font-black text-emerald-700' : 'mt-1 text-2xl font-black text-slate-900'}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function Filter({ label, value, onChange, options }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-600">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900">
        {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </label>
  );
}

export default function V7DetailedReport({ groups, fetchedAt, onReload, loading }) {
  const [stage, setStage] = useState('FINAL');
  const [model, setModel] = useState('ALL');
  const [mode, setMode] = useState('hit');
  const [ticketCount, setTicketCount] = useState(8);
  const [judgment, setJudgment] = useState('ALL');
  const [showAll, setShowAll] = useState(false);

  const allVerified = useMemo(() => groups.filter((r) => r.status === 'VERIFIED'), [groups]);
  const inScope = useMemo(() => groups.filter((r) =>
    r.stage === stage && (model === 'ALL' || r.model === model)
  ), [groups, stage, model]);

  const verified = useMemo(() => inScope.filter((r) => r.status === 'VERIFIED'), [inScope]);
  const held = inScope.filter((r) => String(r.status).startsWith('HELD_'));
  const unverified = inScope.filter((r) => r.status === 'UNVERIFIED').length;
  const legacy = inScope.filter((r) => r.status === 'LEGACY').length;

  const allPlans = useMemo(() => verified
    .map((row) => ({ row, plan: planOf(row, mode, ticketCount) }))
    .filter((item) => !!item.plan), [verified, mode, ticketCount]);

  const selected = allPlans.filter((item) => judgment === 'ALL' || judgmentOfPlan(item.plan) === judgment);
  const selectedStats = summarize(selected);
  const buy = allPlans.filter((item) => judgmentOfPlan(item.plan) === 'BUY');
  const buyStats = summarize(buy);

  const allTicketStats = TICKET_COUNTS.map((count) => ({
    count,
    stat: summarize(verified.map((row) => ({ row, plan: planOf(row, mode, count) })).filter((item) => !!item.plan)),
  }));

  const daily = useMemo(() => {
    const dates = [...new Set(inScope.map((row) => row.raceDate).filter(Boolean))].sort().reverse();
    return dates.map((date) => {
      const records = inScope.filter((row) => row.raceDate === date);
      const plans = records.filter((r) => r.status === 'VERIFIED')
        .map((row) => ({ row, plan: planOf(row, mode, ticketCount) }))
        .filter((item) => !!item.plan);
      const target = plans.filter((item) => judgment === 'ALL' || judgmentOfPlan(item.plan) === judgment);
      const buys = plans.filter((item) => judgmentOfPlan(item.plan) === 'BUY');
      return {
        date,
        verified: records.filter((row) => row.status === 'VERIFIED').length,
        held: records.filter((row) => String(row.status).startsWith('HELD_')).length,
        total: summarize(target),
        buy: summarize(buys),
      };
    });
  }, [inScope, mode, ticketCount, judgment]);

  const detailed = useMemo(() => [...selected].sort((a, b) =>
    String(b.row.raceDate).localeCompare(String(a.row.raceDate)) ||
    Number(b.row.raceNumber || 0) - Number(a.row.raceNumber || 0) ||
    String(b.row.venueCode).localeCompare(String(a.row.venueCode))
  ), [selected]);

  const holdReasons = useMemo(() => {
    const counts = {};
    for (const item of held) {
      const reason = item.verification?.hold_reason || String(item.status).replace('HELD_', '');
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [held]);

  const dateMin = groups.reduce((min, row) => row.raceDate && (!min || row.raceDate < min) ? row.raceDate : min, '');
  const dateMax = groups.reduce((max, row) => row.raceDate && (!max || row.raceDate > max) ? row.raceDate : max, '');

  return (
    <div className="space-y-5" data-testid="v7-detailed-report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">V7 サーバー検証</h2>
          <p className="mt-1 text-xs text-slate-600">
            全端末共通の保存済み予想と確定照合記録を集計。端末内の参考記録は使用しません。
          </p>
          <p className="mt-1 text-xs text-slate-500">
            取得対象は直近30日・{dateMin || '—'}〜{dateMax || '—'}／最終読込 {fetchedAt || '—'}
          </p>
        </div>
        <button type="button" onClick={onReload} disabled={loading}
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 disabled:opacity-60">
          {loading ? '更新中…' : '最新データを再読込'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="全段階の有効検証" value={number(allVerified.length) + '組'} sub="PREとFINALの合計" emphasis />
        <Metric label={stage + ' 有効検証'} value={number(verified.length) + '組'} sub={model === 'ALL' ? '一般戦と女子戦' : categoryLabel(model)} />
        <Metric label="保留" value={number(held.length) + '組'} sub="的中・回収率から除外" />
        <Metric label="未検証" value={number(unverified) + '組'} sub={legacy ? '旧形式 ' + legacy + '組は別扱い' : '照合待ち'} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <h3 className="mb-3 text-sm font-bold text-slate-800">集計条件</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Filter label="予想段階" value={stage} onChange={(v) => { setStage(v); setShowAll(false); }}
            options={[{ value: 'FINAL', label: '直前予想（FINAL）' }, { value: 'PRE', label: '事前予想（PRE）' }]} />
          <Filter label="対象レース" value={model} onChange={(v) => { setModel(v); setShowAll(false); }}
            options={[{ value: 'ALL', label: 'すべて' }, { value: 'OPEN', label: '一般戦' }, { value: 'WOMENS', label: '女子戦' }]} />
          <Filter label="買い目方式" value={mode} onChange={setMode}
            options={[{ value: 'hit', label: '的中率優先' }, { value: 'value', label: '回収率優先' }]} />
          <Filter label="買い目点数" value={String(ticketCount)} onChange={(v) => setTicketCount(Number(v))}
            options={TICKET_COUNTS.map((n) => ({ value: String(n), label: n + '点' }))} />
          <Filter label="V7判定" value={judgment} onChange={(v) => { setJudgment(v); setShowAll(false); }}
            options={[{ value: 'ALL', label: 'すべて（WATCH含む）' }, { value: 'BUY', label: 'BUYのみ' }, { value: 'WATCH', label: 'WATCHのみ' }, { value: 'SKIP', label: 'SKIPのみ' }]} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="選択条件の検証件数" value={number(selectedStats.n) + '件'} sub={judgment === 'ALL' ? 'BUY・WATCH・SKIP込み' : judgment + '判定のみ'} />
        <Metric label="的中数・的中率" value={number(selectedStats.hits) + '件'} sub={'的中率 ' + percentage(selectedStats.hitRate)} emphasis />
        <Metric label="仮想回収率" value={percentage(selectedStats.roi)} sub={'投資 ' + yen(selectedStats.stake)} />
        <Metric label="仮想払戻" value={yen(selectedStats.payout)} sub="1組番100円で計算" />
      </div>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 sm:p-4">
        <h3 className="text-sm font-black text-emerald-900">V7 BUY判定だけの成績</h3>
        <p className="mt-1 text-xs text-emerald-900/80">上の判定フィルターとは別に、選択中の予想段階・レース種別・点数・方式のBUYだけを集計します。</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="BUY対象" value={number(buyStats.n) + '件'} sub={buyStats.n ? '実際のV7 BUY判定' : '対象がまだありません'} />
          <Metric label="BUY的中" value={number(buyStats.hits) + '件'} sub="BUYしたと仮定した的中数" />
          <Metric label="BUY的中率" value={percentage(buyStats.hitRate)} sub="件数が少ないと変動大" emphasis />
          <Metric label="BUY仮想回収率" value={percentage(buyStats.roi)} sub={'投資 ' + yen(buyStats.stake)} />
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          現行V7の保存済みBUY判定を使用。別途研究中の新しいBUY候補の成績は含みません。
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <h3 className="text-sm font-black text-slate-900">4・6・8・12点の比較</h3>
        <p className="mt-1 text-xs text-slate-500">対象は選択中の段階・レース種別・方式の有効検証全件（BUY以外も含む）。点数を押すと詳細が切り替わります。</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {allTicketStats.map(({ count, stat }) => (
            <button type="button" key={count} onClick={() => setTicketCount(count)}
              className={ticketCount === count
                ? 'rounded-lg border-2 border-sky-500 bg-sky-50 p-3 text-left'
                : 'rounded-lg border border-slate-200 bg-slate-50 p-3 text-left'}>
              <div className="text-sm font-black text-slate-900">{count}点</div>
              <div className="mt-1 text-xs text-slate-600">{stat.n}件・的中 {stat.hits}件</div>
              <div className="text-sm font-bold text-slate-900">的中率 {percentage(stat.hitRate)}</div>
              <div className="text-xs text-slate-600">回収率 {percentage(stat.roi)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <h3 className="text-sm font-black text-slate-900">日別の検証結果</h3>
        <p className="mt-1 text-xs text-slate-500">上の集計条件を反映。最新の日付から表示します。</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-left text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr><th className="p-2">日付</th><th className="p-2 text-right">有効</th><th className="p-2 text-right">保留</th>
                <th className="p-2 text-right">的中</th><th className="p-2 text-right">的中率</th><th className="p-2 text-right">回収率</th>
                <th className="p-2 text-right">BUY件数</th><th className="p-2 text-right">BUY的中率</th></tr>
            </thead>
            <tbody>
              {daily.map((item) => (
                <tr key={item.date} className="border-t border-slate-100">
                  <td className="p-2 font-semibold text-slate-800">{item.date}</td>
                  <td className="p-2 text-right">{item.verified}</td>
                  <td className="p-2 text-right">{item.held}</td>
                  <td className="p-2 text-right">{item.total.hits}/{item.total.n}</td>
                  <td className="p-2 text-right">{percentage(item.total.hitRate)}</td>
                  <td className="p-2 text-right">{percentage(item.total.roi)}</td>
                  <td className="p-2 text-right">{item.buy.n}</td>
                  <td className="p-2 text-right">{percentage(item.buy.hitRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!daily.length && <p className="p-4 text-sm text-slate-500">対象データはありません。</p>}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <h3 className="text-sm font-black text-slate-900">保留の理由</h3>
        {holdReasons.length ? (
          <div className="mt-2 space-y-1">
            {holdReasons.map(([reason, count]) => (
              <div key={reason} className="flex items-center justify-between border-b border-slate-100 py-2 text-xs">
                <span className="text-slate-700">{HOLD_LABELS[reason] || reason}</span>
                <span className="font-bold text-amber-800">{count}組</span>
              </div>
            ))}
          </div>
        ) : <p className="mt-2 text-sm text-slate-500">この条件では保留はありません。</p>}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-slate-900">レース別の検証履歴</h3>
          <span className="text-xs text-slate-500">{number(detailed.length)}件のうち{Math.min(showAll ? detailed.length : 30, detailed.length)}件表示</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">保存された実際の結果・V7判定・選択点数の的中を表示。新しい順です。</p>
        {detailed.length ? (
          <div className="mt-3 space-y-2">
            {detailed.slice(0, showAll ? detailed.length : 30).map(({ row, plan }) => (
              <div key={row.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-slate-900">
                    {row.raceDate}　{VENUES[row.venueCode] || row.venueCode} {row.raceNumber}R
                    <span className="ml-2 font-normal text-slate-500">{categoryLabel(row.model)}</span>
                  </span>
                  <div className="flex gap-2">
                    <span className={judgmentOfPlan(plan) === 'BUY' ? 'rounded bg-sky-100 px-2 py-1 font-bold text-sky-800' : 'rounded bg-slate-200 px-2 py-1 font-bold text-slate-700'}>{judgmentOfPlan(plan)}</span>
                    <span className={plan.hit === true ? 'rounded bg-emerald-100 px-2 py-1 font-bold text-emerald-800' : 'rounded bg-rose-100 px-2 py-1 font-bold text-rose-800'}>{plan.hit === true ? '的中' : '不的中'}</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-slate-700">
                  <span>確定三連単 <strong>{row.verification?.actual_result || '—'}</strong></span>
                  <span>{ticketCount}点・投資 {yen(plan.investment)}</span>
                  <span>払戻 {yen(plan.payout)}</span>
                  <span>レース別回収率 {percentage(Number(plan.investment) > 0 ? Number(plan.payout || 0) / Number(plan.investment) * 100 : null)}</span>
                </div>
              </div>
            ))}
            {detailed.length > 30 &&
              <button type="button" onClick={() => setShowAll((v) => !v)}
                className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700">
                {showAll ? '直近30件に戻す' : '全' + number(detailed.length) + '件を表示'}
              </button>}
          </div>
        ) : <p className="mt-3 rounded-lg bg-slate-50 p-5 text-center text-sm text-slate-600">
          この条件に該当する有効検証はありません。別の段階・買い目・判定を選んでください。
        </p>}
      </section>

      <p className="text-xs leading-5 text-slate-500">
        有効検証だけを的中率・回収率に算入します。保留・未検証・旧形式は除外し、
        PREとFINALは重複して購入件数に数えません。各組番100円の仮想計算であり、
        実投票成績ではありません。通信やデータ取得が不完全な場合は数値を表示せずエラーを示します。
      </p>
    </div>
  );
}
