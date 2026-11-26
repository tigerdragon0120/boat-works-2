import React from 'react';
import {venueEvidenceView, venueRateText} from './v8VenueView';

export default function V8VenueEvidencePanel({forecast, race}) {
  const view = venueEvidenceView(forecast?.venue_evidence, race || forecast);
  if (!forecast) return null;
  return <section className="mt-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4" aria-label="場別の展開評価の根拠">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-xs font-black text-sky-900">場別の根拠</h5><span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{view.available ? view.used ? '評価に反映' : '保存した場データ' : view.reason === 'NOT_SAVED' ? '当時の記録なし' : '未取得'}</span></div>
    {!view.available ? <p className="mt-2 text-[11px] leading-6 text-slate-500">{view.reason === 'NOT_SAVED' ? 'この予想には場別データを保存していません。最新の値は後付けしていません。' : 'この予想時点に使える場別データを確認できていません。'}</p> : <>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2"><p className="text-xs font-semibold text-slate-700">実進入1コースの1着率</p><strong className="text-xl font-black tabular-nums text-sky-900">{venueRateText(view.first_rate)}</strong></div>
      <p className="mt-1 text-[10px] leading-5 text-slate-500">集計 {view.period} · 母数：{view.sample_label}</p>
      {view.used && view.inside_favored && <p className="mt-2 text-[11px] leading-5 text-sky-800">場のイン優位を1着候補の評価に反映。外の有力選手は、逆転の裏付けと2・3着への残り方を合わせて比較します。</p>}
      {view.change_note && <p className="mt-2 text-[10px] leading-5 text-slate-500">{view.change_note}</p>}
      <details className="mt-3 border-t border-slate-100 pt-3"><summary className="cursor-pointer text-xs font-semibold text-sky-800">コース成績・決まり手の内訳を見る</summary>
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[440px] text-left text-[11px]">
          <thead className="bg-slate-50 text-[10px] text-slate-500"><tr>{['実進入', '1着率', '2連対率', '3連対率', '勝利時の主な決まり手'].map(label => <th scope="col" key={label} className="px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.course} className="border-t border-slate-100 text-slate-700"><th scope="row" className="whitespace-nowrap px-2 py-2.5">{row.course}コース</th><td className="px-2 py-2.5 tabular-nums">{venueRateText(row.first_rate)}</td><td className="px-2 py-2.5 tabular-nums">{venueRateText(row.top2_rate)}</td><td className="px-2 py-2.5 tabular-nums">{venueRateText(row.top3_rate)}</td><td className="px-2 py-2.5 text-[10px] leading-5">{row.methods.filter(item => item.rate > 0).sort((a,b) => b.rate-a.rate).slice(0,3).map(item => `${item.method} ${venueRateText(item.rate)}`).join('・') || '内訳未取得'}</td></tr>)}</tbody>
        </table></div>
        <p className="mt-2 text-[10px] leading-5 text-slate-500">決まり手は、そのコースで1着になったレースの内訳率です。全出走に対する発生率や件数ではありません。件数が非掲載の場合、標本数の多さは判定していません。</p>
        {view.source_url && <a href={view.source_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[11px] font-semibold text-sky-700 underline underline-offset-2">BOAT RACE公式の場データ</a>}
      </details>
    </>}
  </section>;
}
