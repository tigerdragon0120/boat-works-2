import React, {useMemo, useState} from 'react';
import {useAuth} from '@/lib/AuthContext';
import {BUTTON_CLASS, FIELD_CLASS, STAGES, formatTime, latestRows, timeMs, useClock, useV8Dashboard, venueName} from './v8Client';

const yen=value=>new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const rate=(numerator,denominator)=>denominator>0?`${(100*numerator/denominator).toFixed(1)}%`:'—';
function stats(rows,kind='research') {
  const valid=rows.filter(row=>row.status==='SETTLED'&&finite(row[`${kind}_stake`])&&row[`${kind}_stake`]>0&&finite(row[`${kind}_return`])&&typeof row[`${kind}_hit`]==='boolean');
  return {n:valid.length,hits:valid.filter(row=>row[`${kind}_hit`]).length,stake:valid.reduce((sum,row)=>sum+row[`${kind}_stake`],0),returns:valid.reduce((sum,row)=>sum+row[`${kind}_return`],0),fees:valid.reduce((sum,row)=>sum+(finite(row.information_fee)?row.information_fee:0),0)};
}
function settlementIndex(rows,field) {return new Map((rows||[]).filter(row=>row.status==='SETTLED'&&row[field]).map(row=>[row[field],row]));}

export default function V8Verification() {
  const {user}=useAuth(),admin=user?.role==='admin',now=useClock();
  const [venue,setVenue]=useState('ALL');
  const {data,loading,error,refresh}=useV8Dashboard({mode:'verification',days:7},admin);
  const summary=useMemo(()=>{
    const all=latestRows(data?.forecasts || [],row=>`${row.race_key}:${row.stage}`), rows=all.filter(row=>venue==='ALL'||String(row.venue_code)===venue);
    const settled=settlementIndex(data?.verifications || [],'forecast_id');
    const byStage=Object.keys(STAGES).map(stage=>{
      const forecasts=rows.filter(row=>row.stage===stage), records=forecasts.map(row=>settled.get(row.id)).filter(Boolean);
      return {stage,forecasts,records,metrics:stats(records),pending:forecasts.filter(row=>!settled.has(row.id)&&(timeMs(row.deadline)??Infinity)<=now).length,upcoming:forecasts.filter(row=>!settled.has(row.id)&&(timeMs(row.deadline)??Infinity)>now).length};
    });
    // First BUY is fixed server-side. Never reconstruct it from the latest FINAL.
    const buyForecasts=(data?.buy_forecasts || []).filter(row=>venue==='ALL'||String(row.venue_code)===venue);
    const buyIndex=settlementIndex(data?.buy_verifications || [],'forecast_id');
    const buyRecords=buyForecasts.map(row=>buyIndex.get(row.id)).filter(row=>row?.buy_selected===true);
    const buyMetrics=stats(buyRecords,'buy');
    const byId=new Map((data?.forecasts || []).map(row=>[row.id,row]));
    const pairs={count:0,improved:0,worsened:0,both_hit:0,both_missed:0,excluded_points:0};
    for (const after of rows.filter(row=>row.stage==='FINAL')) {
      const before=byId.get(after.comparison?.baseline_id || after.baseline_id), a=settled.get(after.id), b=settled.get(before?.id);
      if (!before||!a||!b||typeof a.research_hit!=='boolean'||typeof b.research_hit!=='boolean') continue;
      if (a.research_tickets?.length!==b.research_tickets?.length||a.research_stake!==b.research_stake) {pairs.excluded_points++;continue;}
      pairs.count++;
      if(a.research_hit&&!b.research_hit)pairs.improved++;
      else if(!a.research_hit&&b.research_hit)pairs.worsened++;
      else if(a.research_hit)pairs.both_hit++;
      else pairs.both_missed++;
    }
    const external=(data?.external || []).filter(row=>venue==='ALL'||String(row.venue_code)===venue);
    const extRows=latestRows(external.filter(row=>row.verification_eligible===true),row=>`${row.race_key}:${row.source_name}:${row.forecaster_name}:${row.stage}`);
    const extSettled=settlementIndex([...(data?.verifications || []),...(data?.external_verifications || [])],'external_id');
    const extGroups=new Map();
    for(const row of extRows){
      const key=`${row.source_name}:${row.forecaster_name}:${row.stage}`,group=extGroups.get(key)||{key,source_name:row.source_name,forecaster_name:row.forecaster_name,stage:row.stage,records:[],count:0};
      group.count++;
      const record=extSettled.get(row.id);if(record)group.records.push(record);
      extGroups.set(key,group);
    }
    return {all,rows,settled,byStage,buyMetrics,buyForecasts,buyPending:buyForecasts.filter(row=>!buyIndex.has(row.id)).length,pairs,externalGroups:[...extGroups.values()].map(row=>({...row,metrics:stats(row.records)})),externalExcluded:external.filter(row=>row.verification_eligible!==true).length};
  },[data,venue,now]);
  const venues=useMemo(()=>[...new Map((data?.forecasts || []).map(row=>[String(row.venue_code),venueName(row)])).entries()].sort((a,b)=>Number(a[0])-Number(b[0])),[data?.forecasts]);
  if(!admin)return null;
  const buy=summary.buyMetrics;
  return <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm" aria-label="二段階予想の成績検証">
    <header className="border-b border-slate-100 bg-gradient-to-r from-sky-50 to-white p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-extrabold tracking-[0.2em] text-sky-700">PROSPECTIVE VERIFICATION</p><h2 className="mt-1 text-lg font-black text-slate-900 sm:text-xl">事前・展示後・BUYを、それぞれ検証</h2><p className="mt-2 text-xs leading-6 text-slate-500">直近7日。締切前の保存記録を、確定結果と照合します。</p></div><div className="flex items-center gap-2"><label className="w-36"><span className="sr-only">検証する会場</span><select className={FIELD_CLASS} value={venue} onChange={event=>setVenue(event.target.value)}><option value="ALL">すべての会場</option>{venues.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label><button type="button" className={BUTTON_CLASS} disabled={loading} onClick={()=>void refresh()}>{loading?'読込中…':'再読込'}</button></div></div>
      <div className="mt-4 flex flex-wrap gap-2 text-[11px]"><span className="rounded-full border border-sky-200 bg-white px-3 py-1.5 font-semibold text-sky-800">目標 的中率40％</span><span className="rounded-full border border-sky-200 bg-white px-3 py-1.5 font-semibold text-sky-800">目標 回収率140％</span><span className="self-center text-slate-500">目標値と観測実績を分けて表示</span></div>
    </header>
    <div className="space-y-5 p-4 sm:p-6">
      {error&&<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {!!data?.errors?.length&&<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">一部の照合が完了していません。未照合は的中率・回収率の分母に含めていません。</p>}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-bold text-slate-900">研究用BUYの実績</h3><p className="text-[11px] text-slate-500">初回BUYを固定して検証 · その後の見送りで記録を除外しません</p></div>
        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">{[{label:'照合済みBUY',value:data?`${buy.n}R`:'—',sub:`保存 ${summary.buyForecasts.length}R · 未照合 ${summary.buyPending}R`},{label:'的中率',value:rate(buy.hits,buy.n),sub:`的中 ${buy.hits} / ${buy.n}R`},{label:'回収率',value:rate(buy.returns,buy.stake),sub:'払戻総額 ÷ 検証額の総額'},{label:'舟券損益',value:buy.n?yen(buy.returns-buy.stake):'—',sub:buy.n?`検証額 ${yen(buy.stake)}`:'結果照合後に表示'}].map(item=><div key={item.label} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"><p className="text-[11px] font-semibold text-slate-500">{item.label}</p><p className="mt-1 text-2xl font-black tabular-nums text-slate-900">{item.value}</p><p className="mt-2 text-[10px] leading-5 text-slate-500">{item.sub}</p></div>)}</div>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200"><div className="border-b border-slate-200 bg-slate-50 px-4 py-3"><h3 className="text-sm font-bold text-slate-900">どの段階で、予想が良くなったか</h3><p className="mt-1 text-[11px] text-slate-500">各レース・各段階の最新保存版を1件として集計。比較用買い目の成績です。</p></div><div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="text-[10px] text-slate-500"><tr>{['予想の段階','保存','照合済み','的中率','回収率','結果待ち／未開催'].map(label=><th key={label} className="px-4 py-3 font-semibold">{label}</th>)}</tr></thead><tbody>{summary.byStage.map(group=><tr key={group.stage} className="border-t border-slate-100"><th className="px-4 py-3 font-bold text-slate-800">{STAGES[group.stage]}</th><td className="px-4 py-3 text-slate-600">{group.forecasts.length}R</td><td className="px-4 py-3 text-slate-600">{group.metrics.n}R</td><td className="px-4 py-3 font-semibold text-slate-800">{rate(group.metrics.hits,group.metrics.n)}</td><td className="px-4 py-3 font-semibold text-slate-800">{rate(group.metrics.returns,group.metrics.stake)}</td><td className="px-4 py-3 text-slate-500">{group.pending}R ／ {group.upcoming}R</td></tr>)}</tbody></table></div></div>
      <div className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-bold text-slate-900">展示による修正の効果</h3><span className="text-[11px] text-slate-500">紐づく事前記録と同じ点数・検証額で比較 · {summary.pairs.count}R</span></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{[{label:'不的中 → 的中',value:summary.pairs.improved,tone:'text-emerald-700'},{label:'的中 → 不的中',value:summary.pairs.worsened,tone:'text-rose-700'},{label:'どちらも的中',value:summary.pairs.both_hit,tone:'text-slate-700'},{label:'どちらも不的中',value:summary.pairs.both_missed,tone:'text-slate-700'}].map(item=><div key={item.label} className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">{item.label}</p><p className={`mt-1 text-xl font-bold tabular-nums ${item.tone}`}>{summary.pairs.count?item.value:'—'}<span className="ml-1 text-[10px] font-normal text-slate-400">R</span></p></div>)}</div>{summary.pairs.excluded_points>0&&<p className="mt-2 text-[10px] text-slate-400">点数・検証額が異なる{summary.pairs.excluded_points}Rは、この比較から除外しています。</p>}</div>
      <div className="rounded-xl border border-slate-200 p-4"><h3 className="text-sm font-bold text-slate-900">現地予想屋・公式記者の独立比較</h3><p className="mt-1 text-[11px] leading-5 text-slate-500">締切前に保存した手動記録を集計。履歴資料 {summary.externalExcluded}件は別扱いです。</p>{!summary.externalGroups.length?<p className="mt-4 rounded-lg bg-slate-50 px-3 py-5 text-center text-xs text-slate-500">比較対象の記録が揃うと、予想者ごとの成績を表示します。</p>:<div className="mt-3 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="text-[10px] text-slate-500"><tr>{['予想者・時点','照合／保存','的中率','回収率','点数','情報料込み損益'].map(label=><th key={label} className="px-3 py-2 font-semibold">{label}</th>)}</tr></thead><tbody>{summary.externalGroups.map(group=>{
        const lengths=group.records.map(row=>row.research_tickets?.length).filter(finite),points=lengths.length?`${Math.min(...lengths)}${Math.min(...lengths)!==Math.max(...lengths)?`〜${Math.max(...lengths)}`:''}点`:'—';
        return <tr key={group.key} className="border-t border-slate-100"><th className="px-3 py-3"><span className="block font-bold text-slate-800">{group.forecaster_name}</span><span className="mt-1 block text-[10px] font-normal text-slate-500">{group.source_name} · {STAGES[group.stage]}</span></th><td className="px-3 py-3 text-slate-600">{group.metrics.n}／{group.count}R</td><td className="px-3 py-3 font-semibold text-slate-700">{rate(group.metrics.hits,group.metrics.n)}</td><td className="px-3 py-3 font-semibold text-slate-700">{rate(group.metrics.returns,group.metrics.stake)}</td><td className="px-3 py-3 text-slate-500">{points}</td><td className="px-3 py-3 text-slate-700">{group.metrics.n?yen(group.metrics.returns-group.metrics.stake-group.metrics.fees):'—'}</td></tr>;
      })}</tbody></table></div>}</div>
      {summary.rows.length>0&&<details className="rounded-xl border border-slate-200 px-4 py-3"><summary className="cursor-pointer text-sm font-bold text-slate-800">最近の保存・照合記録</summary><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="text-[10px] text-slate-500"><tr>{['レース','段階','保存時刻','結果','比較用買い目'].map(label=><th key={label} className="py-2 pr-3 font-semibold">{label}</th>)}</tr></thead><tbody>{[...summary.rows].sort((a,b)=>(timeMs(b.generated_at)||0)-(timeMs(a.generated_at)||0)).slice(0,24).map(row=>{const result=summary.settled.get(row.id);return <tr key={row.id} className="border-t border-slate-100"><td className="py-3 pr-3 font-semibold text-slate-700">{venueName(row)} {row.race_number}R</td><td className="py-3 pr-3 text-slate-500">{STAGES[row.stage]}</td><td className="py-3 pr-3 text-slate-500">{formatTime(row.generated_at,true)}</td><td className="py-3 pr-3 font-mono text-slate-700">{result?.result_trifecta || '未照合'}</td><td className={`py-3 pr-3 ${result?.research_hit?'font-semibold text-emerald-700':'text-slate-500'}`}>{result?result.research_hit?'的中':'不的中':'—'}{result?.research_tickets?.length?` · ${result.research_tickets.length}点`:''}</td></tr>;})}</tbody></table></div></details>}
      <p className="border-t border-slate-100 pt-3 text-[10px] leading-5 text-slate-400">回収率は各記録の全買い目の検証額を分母に計算します。結果未照合・中止・締切後の追加資料は、照合済み成績に混ぜません。展示による改善件数は観測上の比較であり、将来の成績を保証するものではありません。</p>
    </div>
  </section>;
}
