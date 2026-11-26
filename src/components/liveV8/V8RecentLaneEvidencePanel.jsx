import React, {useState} from 'react';
import {recentLaneEvidenceView, recentLaneHistoryCells, recentLaneNumber, recentLaneDelta,
  recentLaneTime, recentLaneReason} from './v8RecentLaneView';

const COURSE_COLORS = ['', 'bg-white text-slate-900', 'bg-slate-900 text-white', 'bg-red-600 text-white',
  'bg-blue-600 text-white', 'bg-yellow-400 text-slate-900', 'bg-emerald-600 text-white'];
const FEATURE_LABELS = {RECENT_FINISH_FREQUENCY: '着順の傾向', RECENT_FINISH_POINTS: '勝率（着順点）', RECENT_AVG_ST: '平均ST', RECENT_ST_RANK: 'ST順位'};
const OMISSION_LABELS = {RECENT_FINISH_MISSING: '使える着順履歴なし', RECENT_ST_MISSING: '平均STは未取得', RECENT_ST_RANK_MISSING: 'ST順位は未取得'};
const sampleText = row => row?.sample_size == null ? '出走数未取得' : `${row.sample_size}/10走`;
const sourceHref = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'race.boatcast.jp' ? url.href : null; }
  catch { return null; }
};

function History({row}) {
  const history = recentLaneHistoryCells(row);
  return <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
    <table className="w-full min-w-[440px] table-fixed text-center text-[11px]">
      <caption className="sr-only">{row.player_name}の同じ艇番での過去10走</caption>
      <thead className="bg-slate-50 text-[10px] text-slate-500"><tr><th scope="col" className="w-12 px-1 py-2">履歴</th>{history.map((_, index) => <th key={index} scope="col" className="px-1 py-2 font-semibold">{index === 9 ? '前走' : `${10 - index}走前`}</th>)}</tr></thead>
      <tbody>
        <tr className="border-t border-slate-100"><th scope="row" className="bg-slate-50 px-1 py-2 text-[10px] font-medium text-slate-500">進入</th>{history.map((race, index) => <td key={index} className="px-1 py-2"><span title={race?.course_inferred ? '元データの枠なり表記から補完' : undefined} className={`inline-flex h-5 w-5 items-center justify-center rounded border border-slate-200 font-bold ${COURSE_COLORS[race?.course] || 'bg-slate-50 text-slate-400'}`}>{race?.course ?? '—'}</span></td>)}</tr>
        <tr className="border-t border-slate-100"><th scope="row" className="bg-slate-50 px-1 py-2 text-[10px] font-medium text-slate-500">着順</th>{history.map((race, index) => <td key={index} className={`px-1 py-2 font-bold ${race?.finish_status ? 'text-rose-700' : 'text-slate-800'}`}>{race?.finish_status || race?.finish_order || '—'}</td>)}</tr>
      </tbody>
    </table>
  </div>;
}

function Source({row}) {
  const href = sourceHref(row.source_url);
  return <p className="mt-2 text-[10px] leading-5 text-slate-500">BOATCAST取得 {recentLaneTime(row.fetched_at)}
    {href && <a href={href} target="_blank" rel="noopener noreferrer" className="ml-2 font-semibold text-sky-700 underline underline-offset-2">取得元</a>}
  </p>;
}

function AppliedDetail({row}) {
  if (!row.applied) return <p className="mt-2 text-[11px] leading-5 text-amber-800">{recentLaneReason(row.reason || row.scoring?.omitted_reasons?.[0])}</p>;
  return <div className="mt-2 rounded-lg bg-sky-50 px-3 py-2">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-[11px] font-semibold text-sky-800">艇評価への補正</p><strong className="text-lg font-black tabular-nums text-sky-900">{recentLaneDelta(row.scoring.delta)}</strong></div>
    <p className="mt-1 text-[10px] leading-5 text-slate-600">補正前 {recentLaneNumber(row.scoring.base_before, 1)} → 補正後 {recentLaneNumber(row.scoring.base_after, 1)}。同じ基礎情報で、枠番過去10走を使う前後の差です。</p>
    {!!row.scoring.used_features.length && <p className="mt-1 text-[10px] leading-5 text-slate-600">使用：{row.scoring.used_features.map(key => FEATURE_LABELS[key]).filter(Boolean).join('・')}</p>}
    {row.scoring.omitted_reasons.some(key => OMISSION_LABELS[key]) && <p className="mt-1 text-[10px] leading-5 text-slate-500">{row.scoring.omitted_reasons.map(key => OMISSION_LABELS[key]).filter(Boolean).join('・')}</p>}
    {row.scoring.finish_selection === 'MATCHED_COURSE_HISTORY' && <p className="mt-1 text-[10px] leading-5 text-slate-600">進入変更のため、今回の{row.selected_course}コースと一致する着順履歴 {row.scoring.finish_sample_size ?? '—'}走を参照。下の同枠平均ST・ST順位は補正に使っていません。</p>}
  </div>;
}

export default function V8RecentLaneEvidencePanel({forecast, scenario}) {
  const view = recentLaneEvidenceView(forecast, scenario?.leader);
  const [selection, setSelection] = useState(null);
  const context = `${forecast?.id || forecast?.forecast_key || ''}:${scenario?.leader || ''}`;
  if (!forecast) return null;
  const leader = view.leader;
  const detail = view.rows.find(row => row.boat_number === (selection?.context === context ? selection.boat : scenario?.leader)) || leader || view.rows[0];
  const metrics = [['勝率（着順点）', recentLaneNumber(leader?.winning_rate)], ['平均ST', recentLaneNumber(leader?.avg_st)], ['ST順位', recentLaneNumber(leader?.avg_start_order, 1)]];
  return <section className="mt-3 rounded-xl border border-sky-200 bg-white p-3 sm:p-4" aria-label="予想に使った枠番過去10走">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-xs font-black text-sky-900">枠番過去10走</h5>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${leader?.applied ? 'bg-sky-100 text-sky-900' : 'bg-slate-100 text-slate-600'}`}>{view.legacy ? '当時の記録なし' : leader?.applied ? '枠番過去10走を反映' : leader?.available ? '保存済み・補正なし' : '未取得'}</span>
    </div>
    {view.legacy ? <p className="mt-2 text-xs leading-6 text-slate-500">当時の枠番過去10走と補正量は保存されていません。最新のデータは、この予想へ後付けしていません。</p> : !leader ? <p className="mt-2 text-xs leading-6 text-slate-500">この展開の選手に対応する枠番過去10走の記録がありません。</p> : <>
      <p className="mt-3 text-xs font-bold text-slate-800">{leader.boat_number}号艇 {leader.player_name}<span className="ml-2 text-[10px] font-medium text-slate-500">登録 {leader.registration_number}</span></p>
      <div className="mt-2 grid grid-cols-3 gap-1.5">{metrics.map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 px-2 py-2"><p className="text-[10px] text-slate-500">{label}</p><p className="mt-1 text-base font-bold tabular-nums text-slate-800">{value}</p></div>)}</div>
      <p className="mt-2 text-[10px] leading-5 text-slate-500">同じ{leader.boat_number}号艇での出走 {sampleText(leader)}{leader.normal_sample_size != null ? ` · 正常着順 ${leader.normal_sample_size}走` : ''}{leader.special_count > 0 ? ` · F/L等 ${leader.special_count}走` : ''}{leader.absent_count > 0 ? ` · 欠場 ${leader.absent_count}走を除外` : ''}</p>
      <AppliedDetail row={leader}/>
      {leader.available && <Source row={leader}/>}
      <p className="mt-1 text-[10px] leading-5 text-slate-500">勝率は掲載元が集計した着順点の平均です。1着率（%）とは異なります。平均STの単位は秒です。</p>
      {forecast.stage === 'FINAL' && leader.source_basis === 'BASELINE_SNAPSHOT' && <p className="mt-1 text-[10px] leading-5 text-slate-500">事前に保存した同じ枠番過去10走を使い、展示による変化を比較しています。</p>}
      {view.evidence?.change_note && <p className="mt-1 text-[10px] leading-5 text-slate-500">{view.evidence.change_note}</p>}
    </>}
    {!!view.rows.length && <details className="mt-3 border-t border-slate-100 pt-3">
      <summary className="cursor-pointer text-xs font-bold text-sky-800">6艇への反映・10走の履歴を見る</summary>
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[590px] text-left text-[11px] text-slate-600">
          <caption className="sr-only">全6艇の枠番過去10走とV8への反映状況</caption>
          <thead className="bg-slate-50 text-[10px] text-slate-500"><tr>{['艇・選手', '出走数', '勝率（点）', '平均ST', 'ST順位', '艇評価への補正', '適用状態'].map(label => <th key={label} scope="col" className="whitespace-nowrap px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.boat_number} className={`border-t border-slate-100 ${row.boat_number === scenario?.leader ? 'bg-sky-50/60' : ''}`}>
            <th scope="row" className="whitespace-nowrap px-2 py-2.5 font-semibold text-slate-700">{row.boat_number} {row.player_name}{!row.active ? '（欠場）' : ''}</th>
            <td className="px-2 py-2.5 tabular-nums">{sampleText(row)}</td><td className="px-2 py-2.5 tabular-nums">{recentLaneNumber(row.winning_rate)}</td>
            <td className="px-2 py-2.5 tabular-nums">{recentLaneNumber(row.avg_st)}</td><td className="px-2 py-2.5 tabular-nums">{recentLaneNumber(row.avg_start_order, 1)}</td>
            <td className="px-2 py-2.5 font-semibold tabular-nums text-sky-800">{recentLaneDelta(row.scoring.delta)}</td>
            <td className="px-2 py-2.5 text-[10px]" title={row.applied ? undefined : recentLaneReason(row.reason)}>{row.applied ? '反映済み' : row.available ? '補正なし' : '未取得'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {detail && <div className="mt-4">
        <label className="text-[11px] font-bold text-slate-700">10走の履歴
          <select aria-label="枠番過去10走を確認する選手" className="ml-2 max-w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs text-slate-800" value={detail.boat_number} onChange={event => setSelection({context, boat: Number(event.target.value)})}>
            {view.rows.map(row => <option key={row.boat_number} value={row.boat_number}>{row.boat_number}号艇 {row.player_name}</option>)}
          </select>
        </label>
        {detail.available ? <><History row={detail}/><Source row={detail}/><p className="mt-1 text-[10px] leading-5 text-slate-500">元データの同枠履歴を保存しています。各走の日付は提供されていないため、長期成績の出走数には足していません。</p></> : <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600">{recentLaneReason(detail.reason)}</p>}
        <AppliedDetail row={detail}/>
      </div>}
    </details>}
  </section>;
}
