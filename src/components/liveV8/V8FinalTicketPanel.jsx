import React from 'react';
import TicketList from './V8TicketList';
import {formatTime} from './v8Client';
import {finalSelectionView, finalSelectionDecision, finalSelectionOdds, finalSelectionResultView} from './v8FinalTicketsView';

const TONE = {emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800', amber: 'border-amber-200 bg-amber-50 text-amber-900', sky: 'border-sky-200 bg-sky-50 text-sky-800', slate: 'border-slate-200 bg-slate-50 text-slate-600'};
const RESULT_LABEL = {PENDING: '結果照合待ち', NOT_RECORDED: '最終選抜は未記録', INVALID: '保存内容の確認待ち', EXCLUDED_REFUND: '返還等・集計対象外'};
const yen = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString()}円` : '—';

export default function V8FinalTicketPanel({forecast, baseline, verification, race, now, blocked=false}) {
  const view = finalSelectionView(forecast), decision = finalSelectionDecision(forecast, race, now, {blocked});
  const odds = finalSelectionOdds(forecast, race, now, blocked), result = finalSelectionResultView(forecast, verification);
  const prior = finalSelectionView(baseline), plan = view.plan;
  const changed = view.available && prior.available ? view.tickets.filter(ticket => !prior.tickets.includes(ticket)).length : null;
  const final = forecast?.stage === 'FINAL';
  return <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white" aria-label="展示後の最終買い目">
    <header className="border-b border-slate-100 bg-sky-50/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-black text-sky-700">3</span><div><h4 className="text-base font-black text-slate-900">{final ? '展示後の最終買い目' : '展示後に絞る最終買い目'}</h4><p className="mt-1 text-[11px] leading-5 text-slate-500">場・選手・展示を合わせた評価順で、6〜12点を選抜します。</p></div></div><span className={`rounded-full border px-3 py-1 text-sm font-black ${TONE[decision.tone]}`}>{decision.label}{view.available ? ` · ${view.count}点` : ''}</span></div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11px] text-slate-500"><span>締切 {formatTime(race?.deadline || forecast?.deadline)}</span>{forecast&&<span>{final?'展示後':'展示前'}保存 {formatTime(forecast.generated_at,true)}</span>}{decision.key === 'BUY' && <span className="font-semibold text-emerald-800">判定有効 {formatTime(plan.valid_until)}</span>}</div>
      {decision.detail && <p className="mt-2 text-xs leading-6 text-slate-600">{decision.detail}</p>}
    </header>
    <div className="space-y-4 p-4 sm:p-5">
      {!view.available ? <p className="rounded-xl bg-slate-50 px-4 py-5 text-sm leading-7 text-slate-600">{!forecast?'展示情報が揃うと、事前の候補から最終買い目を絞って保存します。':view.kind==='LEGACY'?'この予想の最終選抜は当時保存されていません。保存済みの総合研究8点・展開別8点は、それぞれの検証欄で確認できます。':view.kind==='REPLAY'?'事後補完の予想は最終BUYの対象外です。各展開と総合研究の買い目で検証します。':view.kind==='INVALID'?'最終買い目の保存内容を確認しています。確認できた記録から表示します。':'最終候補を選ぶための入力情報を待っています。'}</p> : <>
        {!final && <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs leading-6 text-sky-900">現在は展示前の候補です。展示後に選手の配置と点数を見直し、最終判定を保存します。</p>}
        <div><h5 className="text-sm font-bold text-slate-900">{final?'最終選抜':'展示前の候補'} {view.count}点 · 推定順位</h5><p className="mt-1 text-xs leading-6 text-slate-600">{typeof plan.selection_reason==='string'?plan.selection_reason:'保存した候補順位から選抜しています。'}</p>{changed!==null&&final&&<p className="mt-1 text-[11px] text-slate-500">事前 {prior.count}点 → 展示後 {view.count}点 · 新しく入った買い目 {changed}点</p>}</div>
        {!!view.roles.length && <details className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
          <summary className="cursor-pointer text-xs font-bold text-sky-800">1着の軸・2／3着候補を選んだ理由</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{view.roles.map(row=><article key={row.boat_number} className="rounded-lg bg-slate-50 p-3"><div className="flex flex-wrap items-baseline justify-between gap-1"><h6 className="text-xs font-bold text-slate-800">{row.boat_number}号艇 {row.player_name}</h6><span className="text-[10px] text-slate-500">{row.course}コース</span></div><p className="mt-1 text-[11px] font-bold text-sky-800">{row.label}</p><ul className="mt-2 space-y-1 text-[11px] leading-5 text-slate-600">{row.reasons.map((reason,index)=><li key={index}>・{reason}</li>)}</ul>{!!row.reverse_support.length&&<p className="mt-2 text-[10px] leading-5 text-slate-500">逆転の裏付け：{row.reverse_support.map(item=>item.label).join('・')}</p>}</article>)}</div>
        </details>}
        <TicketList tickets={view.tickets} rankedRows={view.ranked} oddsView={odds} race={race} now={now}/>
        {Array.isArray(plan.gate_checks)&&plan.gate_checks.length>0&&<details className="rounded-xl border border-slate-200 px-3 py-3 sm:px-4"><summary className="cursor-pointer text-xs font-bold text-slate-700">保存時のBUY・保留の判断理由</summary><ul className="mt-3 space-y-2">{plan.gate_checks.map((check,index)=><li key={check.key||index} className="flex items-start gap-2 text-[11px] leading-5"><span className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${check.status==='PASS'?'bg-emerald-50 text-emerald-700':check.status==='BLOCK'?'bg-rose-50 text-rose-700':'bg-amber-50 text-amber-800'}`}>{check.status==='PASS'?'確認済':check.status==='BLOCK'?'見送り':'保留'}</span><span><strong className="text-slate-800">{check.label}</strong>{typeof check.detail==='string'&&<span className="block text-slate-500">{check.detail}</span>}</span></li>)}</ul></details>}
      </>}
      <p className="text-[10px] leading-5 text-slate-500">展開評価と推定順位は未校正の比較評価です。発生確率・的中確率を表すものではありません。</p>
      <div className="border-t border-slate-100 pt-4"><h5 className="text-sm font-bold text-slate-900">4. 最終選抜の結果検証</h5><div className="mt-3 rounded-xl bg-slate-50 p-3"><p className={`text-base font-black ${result.hit?'text-emerald-700':'text-slate-700'}`}>{!final?'展示後の最終選抜を保存後に照合':result.status==='SETTLED'?result.hit?'的中':'不的中':RESULT_LABEL[result.status]||'結果照合待ち'}</p>{final&&result.status==='SETTLED'&&<><p className="mt-1 text-[11px] leading-5 text-slate-600">最終 {result.count}点 · 検証額 {yen(result.result.stake)} / 払戻 {yen(result.result.return)} · 各100円</p>{result.hit&&<p className="mt-1 text-[11px] font-semibold text-emerald-700">推定 {result.result.hit_rank}位の買い目が的中</p>}<p className="mt-1 text-[10px] text-slate-500">保存時の判定：{result.result.decision_status} · {result.result.buy_selected?'BUY対象の記録':'最終候補全点の検証'}</p></>}{final&&view.available&&result.status==='PENDING'&&<p className="mt-1 text-[11px] leading-5 text-slate-500">最終候補 {view.count}点を各100円、合計{yen(view.count*100)}で照合します。</p>}</div><p className="mt-2 text-[10px] leading-5 text-slate-500">最終選抜全点・BUY判定の成績は、総合研究8点・各展開8点の成績と分けて集計します。</p></div>
    </div>
  </section>;
}
