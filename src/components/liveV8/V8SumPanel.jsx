import React from 'react';
import {formatTime, safeURL} from './v8Client';
import {finiteSumValue, savedSumView, SUM_LABELS, sumAvailability, sumDifferenceText, sumModelStatus, sumTimeText} from './v8SumView';

function SumValues({model, activeCount, selected = false, acquisitionReasons = []}) {
  if (!model || model.status === 'UNSUPPORTED_VENUE') return null;
  const withTurn = model.key === 'SUM_AMAGASAKI';
  const rows = Array.isArray(model.boats) ? model.boats : [];
  const count = activeCount || (Number.isInteger(model.active_count) ? model.active_count : null);
  const ready = model.status === 'READY';
  const availability = sumAvailability({...model,acquisition_reasons:acquisitionReasons});
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h6 className="text-xs font-bold text-slate-800">{SUM_LABELS[model.key] || model.label} <span className="ml-1 font-normal text-slate-500">{withTurn ? '展示＋1周＋周り足' : '展示＋1周'}</span></h6>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${selected ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-600'}`}>{selected ? '予想に反映' : sumModelStatus({...model,acquisition_reasons:acquisitionReasons})}</span>
    </div>
    {ready && <p className="text-[11px] text-slate-500">{count ? `出走${count}艇` : '出走艇'}の合算平均：<strong className="font-semibold tabular-nums text-slate-700">{finiteSumValue(model.mean) ? model.mean.toFixed(3) : '—'}秒</strong></p>}
    {rows.length ? <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className={`w-full text-right text-[11px] tabular-nums ${withTurn ? 'min-w-[400px]' : 'min-w-[340px]'}`}>
        <caption className="sr-only">{SUM_LABELS[model.key] || model.label}の保存したタイムと計算結果</caption>
        <thead className="bg-slate-50 text-[10px] text-slate-500"><tr>{['艇', '展示', '1周', ...(withTurn ? ['周り足'] : []), '合算', '平均との差'].map(label => <th scope="col" key={label} className="whitespace-nowrap px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.boat_number} className="border-t border-slate-100">
          <th scope="row" className="px-2 py-2 text-slate-800">{row.boat_number}号艇</th>
          <td className="px-2 py-2 text-slate-600">{sumTimeText(row.exhibition_time)}</td>
          <td className="px-2 py-2 text-slate-600">{sumTimeText(row.lap_time)}</td>
          {withTurn && <td className="px-2 py-2 text-slate-600">{sumTimeText(row.turn_time)}</td>}
          <td className="px-2 py-2 font-semibold text-slate-800">{sumTimeText(row.total)}</td>
          <td className={`px-2 py-2 font-bold ${finiteSumValue(row.delta) && row.delta > 0 ? 'text-sky-700' : 'text-slate-600'}`}>{sumDifferenceText(row.delta)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="text-[11px] leading-5 text-slate-500">{model.status==='WAIT_EXHIBITION'?'展示前の予想にはSUMを使いません。':availability.detail}</p>}
    {!ready && rows.length > 0 && <p className="text-[11px] leading-5 text-slate-500">{availability.detail}</p>}
  </div>;
}

function EvidenceSource({evidence}) {
  const source = safeURL(evidence?.source_url);
  const exhibitionSource = safeURL(evidence?.exhibition_source_url);
  if (!evidence?.captured_at && !source && !evidence?.exhibition_captured_at) return null;
  return <div className="space-y-1 text-[10px] leading-5 text-slate-500">
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {evidence?.captured_at && <span>1周などの取得 {formatTime(evidence.captured_at, true)}</span>}
      {source && <a href={source} target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-700 underline underline-offset-2">オリジナル展示の取得元</a>}
    </p>
    {(evidence?.exhibition_captured_at || exhibitionSource) && <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {evidence?.exhibition_captured_at && <span>展示タイムの取得 {formatTime(evidence.exhibition_captured_at, true)}</span>}
      {exhibitionSource && <a href={exhibitionSource} target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-700 underline underline-offset-2">展示タイムの取得元</a>}
    </p>}
  </div>;
}

export function SumTheoryModelDetails({model}) {
  if (!SUM_LABELS[model?.key]) return null;
  const evidence = model.sum_evidence;
  return <div className="mt-2 space-y-2">
    <p className="text-[11px] leading-5 text-slate-500">公開資料で確認した合算方法に基づく比較です。買い目への変換はBOAT WORKS 2の独自式です。</p>
    {evidence && !['READY','WAIT_EXHIBITION','UNSUPPORTED_VENUE'].includes(evidence.status) && <p className="text-[11px] leading-5 text-slate-600">{sumAvailability(evidence).detail}</p>}
    {model.missing?.includes('SUM_NO_DIFFERENCE') && <p className="text-[11px] leading-5 text-slate-600">全艇の合算が同じため、SUMだけでは買い目を絞りません。</p>}
    {evidence && evidence.status !== 'UNSUPPORTED_VENUE' && <details className="rounded-lg bg-slate-50 p-2.5">
      <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">SUMの内訳</summary>
      <div className="mt-3 space-y-3"><SumValues model={evidence} activeCount={evidence.active_count} acquisitionReasons={evidence.acquisition_reasons}/><EvidenceSource evidence={evidence}/>
        <p className="text-[10px] leading-5 text-slate-500">平均との差は「出走艇の合算平均 − 各艇の合算」。＋は平均より速く、−は遅い値です。単位は秒です。{evidence.mean_basis === 'ACTIVE_STARTERS_EXTENSION' ? '欠場艇を除いた平均は独自拡張です。' : ''}</p>
      </div>
    </details>}
  </div>;
}

export default function V8SumPanel({forecast}) {
  const view = savedSumView(forecast);
  if (view.state === 'PRE') return null;
  const ready = view.state === 'READY';
  return <section aria-label="保存したSUM評価" className={`mt-3 rounded-xl border p-3 ${ready ? 'border-sky-200 bg-sky-50/60' : 'border-slate-200 bg-slate-50'}`}>
    <p className={`text-xs font-bold ${ready ? 'text-sky-900' : 'text-slate-700'}`}>{view.label}</p>
    <p className="mt-1 text-[11px] leading-5 text-slate-600">{ready
      ? `${view.selected.formula || (view.selected.key === 'SUM_AMAGASAKI' ? '展示＋1周＋周り足' : '展示＋1周')}を、${view.activeCount ? `出走${view.activeCount}艇` : '出走艇'}の平均と比較しています。`
      : view.state === 'LEGACY' ? 'この予想を保存した時点ではSUMを計測していません。'
      : view.detail}</p>
    {ready && <p className="mt-1 text-[10px] leading-5 text-slate-500">買い目への反映はBOAT WORKS 2の独自評価です。</p>}
    {view.models.length > 0 && <details className="mt-2 border-t border-slate-200/80 pt-2">
      <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">SUMの内訳と取得元</summary>
      <div className="mt-3 space-y-4">
        {view.models.map(model => <SumValues key={model.key} model={model} activeCount={view.activeCount} selected={view.applied && model.key === view.selected?.key} acquisitionReasons={view.evidence.acquisition_reasons}/>)}
        <p className="text-[10px] leading-5 text-slate-500">平均との差は「出走艇の合算平均 − 各艇の合算」。＋は平均より速く、−は遅い値です。単位は秒です。{view.evidence.mean_basis === 'ACTIVE_STARTERS_EXTENSION' ? '欠場艇を除いた平均は独自拡張です。' : ''}</p>
        <EvidenceSource evidence={view.evidence}/>
      </div>
    </details>}
  </section>;
}
