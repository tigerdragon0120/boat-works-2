import React, {useEffect, useMemo, useState} from 'react';
import {useAuth} from '@/lib/AuthContext';
import RaceScenarioDiagram from './RaceScenarioDiagram';
import V8ExternalPanel from './V8ExternalPanel';
import {BUTTON_CLASS, STAGES, displayDecision, formatTime, latestStage, timeMs, useClock, useV8Dashboard} from './v8Client';

const TONES={emerald:'border-emerald-200 bg-emerald-50 text-emerald-800',amber:'border-amber-200 bg-amber-50 text-amber-900',sky:'border-sky-200 bg-sky-50 text-sky-800',slate:'border-slate-200 bg-slate-50 text-slate-600'};
const COMPARE={SUPPORTED:'事前の読みを支持',CHANGED:'展示で展開を修正',NO_BASE:'比較元の保存待ち',PARTIAL:'情報が揃うまで保留'};
const THEORIES={UICHI_MAIN:'ういち基本型',UICHI_URA:'裏ういち型',UICHI_NEW_MAIN:'新ういち型',UICHI_NEW_URA:'新裏ういち型',EXHIBITION_RELATIVE:'舟券太郎参考・展示相対評価',V8_ALL_FACTOR:'V8多因子評価'};
const score=value=>typeof value==='number'&&Number.isFinite(value)?Math.round(value):null;
const measured=(value,digits=2)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'—';

function ConditionsPanel({forecast}) {
  if(!forecast)return null;
  const conditions=forecast.conditions || {}, observed=conditions.kind==='PRE_RACE_OBSERVATION', boats=forecast.boats || [];
  const completeExhibition=forecast.exhibition_complete===true;
  const fields=observed?[{label:'天候',value:conditions.weather || '未取得'},{label:'風',value:typeof conditions.wind_speed==='number'?`${conditions.wind_speed} m/s · ${conditions.wind_direction || '方位未確認'}`:'未取得'},{label:'波高',value:typeof conditions.wave_height==='number'?`${conditions.wave_height} cm`:'未取得'}]:[{label:'天気・風の予報',value:'未接続'}];
  return <details className="rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-bold text-slate-800">保存した入力データと取得状況</summary><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{[...fields,{label:'潮位・潮流',value:'未接続'},{label:'周回・直線・回り足タイム',value:'未取得'},{label:'展示進入・ST・タイム',value:forecast.stage!=='FINAL'?'事前予想には不使用':completeExhibition?'6艇確認済み':'一部未取得・要確認'}].map(field=><div key={field.label} className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] leading-5 text-slate-500">{field.label}</p><p className="mt-1 text-xs font-semibold text-slate-800">{field.value}</p></div>)}</div><p className="mt-2 text-[10px] leading-5 text-slate-500">{conditions.observed_at?`気象の取得 ${formatTime(conditions.observed_at,true)}。`:''}気象・潮位による補正は、現在の展開評価には加えていません。未取得を0として扱いません。</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="text-[10px] text-slate-500"><tr>{['艇・選手','想定進入','展示進入','平均ST','展示ST','展示タイム','モーター2連率','コース1着率'].map(label=><th key={label} className="px-2 py-2 font-semibold">{label}</th>)}</tr></thead><tbody>{boats.map(boat=><tr key={boat.boat_number} className="border-t border-slate-100"><th className="px-2 py-2 font-semibold text-slate-800">{boat.boat_number} {boat.player_name || '選手名未取得'}</th><td className="px-2 py-2 text-slate-600">{boat.expected_course ?? '—'}{boat.expected_course_basis==='FRAME_ORDER_ASSUMPTION'?' 仮定':''}</td><td className="px-2 py-2 text-slate-600">{boat.observed_course ?? '—'}</td><td className="px-2 py-2 text-slate-600">{measured(boat.avg_st)}</td><td className={`px-2 py-2 ${boat.exhibition_flying||boat.exhibition_late?'font-semibold text-rose-700':'text-slate-600'}`}>{boat.exhibition_late?'L':boat.exhibition_flying?`F${measured(Math.abs(boat.exhibition_st))}`:measured(boat.exhibition_st)}</td><td className="px-2 py-2 text-slate-600">{measured(boat.exhibition_time)}</td><td className="px-2 py-2 text-slate-600">{typeof boat.motor_2rate==='number'?`${boat.motor_2rate.toFixed(1)}%`:'—'}</td><td className="px-2 py-2 text-slate-600">{typeof boat.course_win_percent==='number'?`${boat.course_win_percent.toFixed(1)}%`:'未取得'}{boat.course_sample_size?` (${boat.course_sample_size}走)`:''}</td></tr>)}</tbody></table></div><p className="mt-2 text-[10px] leading-5 text-slate-500">展示STは本番のSTとは区別し、展示Fをスタートの速さとして加点しません。コース成績は進入コースが明示された値のみ扱います。</p></details>;
}

function TicketList({tickets=[]}) {
  return <div className="flex flex-wrap gap-1.5">{tickets.map(ticket=><span key={ticket} className="rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs font-semibold text-slate-800">{ticket}</span>)}</div>;
}
function ForecastCard({forecast,title,subtitle,step,empty}) {
  const [selected,setSelected]=useState(null);
  useEffect(()=>setSelected(forecast?.top_scenario_key || null),[forecast?.id,forecast?.top_scenario_key]);
  const scenarios=forecast?.scenarios || [], active=scenarios.find(row=>row.key===selected) || scenarios[0];
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
    <header className="mb-3 flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-black text-sky-700">{step}</span><div className="min-w-0"><h4 className="font-bold text-slate-900">{title}</h4><p className="mt-0.5 text-[11px] leading-5 text-slate-500">{forecast?`${STAGES[forecast.stage] || forecast.stage} · ${formatTime(forecast.generated_at,true)} 保存`:subtitle}</p></div></header>
    {!forecast?<div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-5 text-center"><span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-xl text-slate-400">○</span><p className="text-sm font-semibold text-slate-600">{empty}</p><p className="mt-2 max-w-xs text-xs leading-6 text-slate-500">その時点で保存した情報を表示します。後から作った予想で埋めることはありません。</p></div>:<>
      <RaceScenarioDiagram scenario={active} boats={forecast.boats} stage={forecast.stage}/>
      <div className="mt-3 grid grid-cols-2 gap-2">{scenarios.slice(0,6).map(scenario=><button type="button" key={scenario.key} onClick={()=>setSelected(scenario.key)} aria-pressed={active?.key===scenario.key} className={`rounded-lg border px-2.5 py-2 text-left transition ${active?.key===scenario.key?'border-sky-500 bg-sky-50 ring-1 ring-sky-100':'border-slate-200 bg-white hover:border-sky-300'}`}><span className="block text-xs font-bold text-slate-800">{scenario.label}</span><span className="mt-1 block text-[10px] text-slate-500">展開評価 {score(scenario.score) ?? '—'} / 100</span></button>)}</div>
      {active&&<div className="mt-3 rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold leading-6 text-slate-800">{active.reason}</p>{!!active.checkpoints?.length&&<><p className="mt-2 text-[11px] font-bold text-sky-700">{forecast.stage==='FINAL'?'判断の確認項目':'展示で確認すること'}</p><ul className="mt-1 space-y-1 text-[11px] leading-5 text-slate-600">{active.checkpoints.map((text,index)=><li key={index}>・{typeof text==='string'?text:text.label || text.description || '確認項目'}</li>)}</ul></>}</div>}
      {!!forecast.research_tickets?.length&&<details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-600">比較用の買い目を見る（{forecast.research_tickets.length}点）</summary><div className="mt-2"><TicketList tickets={forecast.research_tickets}/></div></details>}
      <p className="mt-3 text-[10px] leading-5 text-slate-400">展開評価は未校正の比較スコアです。発生確率・的中率ではありません。</p>
    </>}
  </article>;
}

function TheoryComparison({rows=[],admin}) {
  const latest=[...rows].sort((a,b)=>(timeMs(b.generated_at) || 0)-(timeMs(a.generated_at) || 0));
  const final=latest.find(row=>['FINAL','LOCK'].includes(row.stage)), pre=latest.find(row=>row.stage==='PRE');
  const [stage,setStage]=useState('FINAL'), record=stage==='FINAL'?final:pre;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-bold text-slate-900">同じレースを、複数の見方で比較</h4><p className="mt-1 text-xs leading-5 text-slate-500">買い目の一致と違いを記録します。評価を多数決でBUYに変換しません。</p></div><div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{[['PRE','展示を使わない評価'],['FINAL','展示後']].map(([key,label])=><button type="button" key={key} onClick={()=>setStage(key)} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${stage===key?'bg-white text-sky-700 shadow-sm':'text-slate-500'}`}>{label}</button>)}</div></div>
    {!record?<p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{admin?'この時点のロジック比較は、まだ保存されていません。':'詳細なロジック比較は管理者の研究画面で確認できます。'}</p>:<>
      <p className="text-[11px] text-slate-500">保存：{formatTime(record.generated_at,true)} · モデル版 {record.revision || '—'}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{(record.models||[]).map(model=><article key={model.key} className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-start justify-between gap-2"><h5 className="text-sm font-bold text-slate-900">{THEORIES[model.key] || model.label}</h5><span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${model.status==='READY'?'bg-sky-50 text-sky-700':'bg-slate-100 text-slate-500'}`}>{model.status==='READY'?'比較可能':'情報不足'}</span></div>{model.key==='EXHIBITION_RELATIVE'&&<p className="mt-2 text-[11px] leading-5 text-slate-500">公開アイデアを参考にした独自式。本人公式のSUM・シンSUMの再現ではありません。</p>}<div className="mt-3"><TicketList tickets={model.tickets || []}/></div>{typeof model.score==='number'&&<p className="mt-3 text-xs text-slate-600">比較評価 <span className="font-bold text-slate-900">{(model.score<=1?model.score*100:model.score).toFixed(1)}</span><span className="ml-1 text-[10px] text-slate-400">未校正</span></p>}</article>)}</div>
    </>}
  </div>;
}

export default function V8RaceJourney({race}) {
  const {user}=useAuth(), admin=user?.role==='admin', now=useClock();
  const {data,loading,error,refresh}=useV8Dashboard({mode:'race',race_id:race?.id},!!race?.id);
  const [tab,setTab]=useState('JOURNEY'),[baseMode,setBaseMode]=useState('AUTO');
  useEffect(()=>{setTab('JOURNEY');setBaseMode('AUTO');},[race?.id]);
  const records=data?.forecasts || [], dayBefore=latestStage(records,'DAY_BEFORE'), pre=latestStage(records,'PRE'), final=latestStage(records,'FINAL');
  const referenceId=final?.comparison?.baseline_id || final?.baseline_id;
  const linked=records.find(row=>row.id===referenceId) || null;
  const baseline=baseMode==='DAY_BEFORE'?dayBefore:baseMode==='PRE'?pre:linked || dayBefore || pre;
  const currentRace=(data?.races || []).find(row=>row.id===race?.id || (row.race_key && row.race_key===race?.race_key)) || race;
  const ambiguous=(data?.ambiguous_race_keys || []).includes(currentRace?.race_key);
  const chosen=final || baseline;
  const decision=displayDecision(ambiguous&&chosen?{...chosen,effective_status:'WAIT'}:chosen,now,currentRace), historicalBuy=final?.decision?.status==='BUY';
  const firstBuy=data?.buy_forecasts?.[0] || null;
  const settles=useMemo(()=>(data?.verifications || []).filter(row=>row.status==='SETTLED' && row.forecast_id===final?.id),[data?.verifications,final?.id]);
  const comparison=final?.comparison, priorChoiceCount=Number(!!dayBefore)+Number(!!pre);
  if (!race?.id) return null;
  return <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm" aria-label="事前展開と展示後の比較">
    <header className="border-b border-slate-100 bg-gradient-to-r from-sky-50 via-white to-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-extrabold tracking-[0.2em] text-sky-700">BOAT WORKS 2 · RACE JOURNEY</p><h3 className="mt-1 text-lg font-black text-slate-900 sm:text-xl">事前の読みから、最終判断へ</h3><p className="mt-1 text-xs leading-6 text-slate-500">保存した展開を残し、展示による変化を確かめる。</p></div><button type="button" disabled={loading} onClick={()=>void refresh()} className={BUTTON_CLASS} aria-label="展開予想を再読込">{loading?'読込中…':'再読込'}</button></div>
      <ol className="mt-4 grid grid-cols-3 gap-2 text-center">{[{label:'事前の展開',ready:!!(dayBefore || pre),detail:dayBefore?'前日保存あり':pre?'当日展示前を保存':'保存待ち'},{label:'展示で照合',ready:!!final,detail:final?COMPARE[comparison?.status] || '展示後を保存':'展示待ち'},{label:'結果で検証',ready:settles.length>0,detail:settles.length?'照合済み':'結果待ち'}].map((step,index)=><li key={step.label} className={`rounded-lg px-2 py-2 ${step.ready?'bg-sky-50':'bg-slate-50'}`}><span className={`block text-xs font-bold ${step.ready?'text-sky-800':'text-slate-500'}`}>{index+1}. {step.label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">{step.detail}</span></li>)}</ol>
    </header>
    <div className="flex overflow-x-auto border-b border-slate-100 px-3 sm:px-5" role="tablist" aria-label="予想の比較内容">{[['JOURNEY','展開とBUY'],['THEORIES','ロジック別'],['EXTERNAL','現地予想屋']].map(([key,label])=><button type="button" role="tab" aria-selected={tab===key} key={key} onClick={()=>setTab(key)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-bold transition sm:px-4 ${tab===key?'border-sky-600 text-sky-800':'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div>
    <div className="space-y-4 p-3 sm:p-5">
      {error&&<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">{error}</p>}
      {!!data?.errors?.length&&<p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">一部の記録を確認できていません。取得済みの記録のみを表示しています。</p>}
      {loading&&!data&&!error?<div role="status" className="grid animate-pulse gap-4 sm:grid-cols-2"><div className="h-64 rounded-xl bg-slate-100"/><div className="h-64 rounded-xl bg-slate-100"/><span className="sr-only">保存済み予想を読み込み中</span></div>:tab==='EXTERNAL'?<V8ExternalPanel race={race} rows={data?.external || []} admin={admin} onSaved={refresh}/>:tab==='THEORIES'?<TheoryComparison rows={data?.theories || []} admin={admin}/>:<>
        {priorChoiceCount>1&&<div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500">表示する事前記録</span>{[['AUTO','照合に使った記録'],['DAY_BEFORE','前日'],['PRE','当日・展示前']].map(([key,label])=><button type="button" key={key} onClick={()=>setBaseMode(key)} className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${baseMode===key?'border-sky-300 bg-sky-50 text-sky-800':'border-slate-200 text-slate-500'}`}>{label}</button>)}</div>}
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <ForecastCard forecast={baseline} title="事前の展開予想" subtitle="前日・展示前の情報で作る読み" step="1" empty="事前の展開は、まだ保存されていません"/>
          <ForecastCard forecast={final} title="展示後の展開予想" subtitle="進入・ST・タイムを加えて照合" step="2" empty="展示情報を待っています"/>
        </div>
        {final&&<div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-bold text-slate-900">展示で何が変わったか</h4><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${comparison?.status==='SUPPORTED'?'bg-emerald-100 text-emerald-800':comparison?.status==='CHANGED'?'bg-amber-100 text-amber-900':'bg-white text-slate-500'}`}>{COMPARE[comparison?.status] || '照合記録を確認中'}</span></div>{linked?<p className="mt-2 text-[11px] text-slate-500">比較元：{STAGES[linked.stage]} {formatTime(linked.generated_at,true)} 保存{baseline?.id!==linked.id?'（現在左側に表示中の版とは異なります）':''}</p>:<p className="mt-2 text-xs leading-5 text-amber-800">この展示後予想に紐づく事前記録がありません。事前から読めていた予想としては集計しません。</p>}<ul className="mt-2 space-y-1 text-xs leading-6 text-slate-700">{(comparison?.changes || []).map((text,index)=><li key={index}>・{text}</li>)}</ul></div>}
        <div className={`rounded-xl border p-4 sm:p-5 ${TONES[decision.tone]}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-extrabold tracking-widest">FINAL DECISION</p><h4 className="mt-1 text-xl font-black">{decision.key==='BUY'?'研究用BUY':decision.label}</h4></div>{final&&<p className="text-[11px]">判定保存 {formatTime(final.generated_at)} / 締切 {formatTime(final.deadline)}</p>}</div>
          {decision.key==='STALE'&&<p className="mt-2 text-xs leading-6">保存後に時間が経過したため、現在のBUY表示を保留しています。オッズと展示情報の再確認を待ちます。</p>}
          {historicalBuy&&decision.key!=='BUY'&&<p className="mt-2 text-xs leading-6">保存時の判定：研究用BUY。現在は{decision.label}です。</p>}
          <ul className="mt-2 space-y-1 text-xs leading-6">{(final?.decision?.reasons || ['事前の展開を確認し、展示後の情報とオッズが揃ってから判定します。']).map((reason,index)=><li key={index}>・{reason}</li>)}</ul>
          {!!final?.decision?.tickets?.length&&<div className="mt-3"><p className="mb-2 text-[11px] font-semibold">保存した判定の買い目 · {final.decision.tickets.length}点</p><TicketList tickets={final.decision.tickets}/></div>}
          {final?.decision?.odds_captured_at&&<p className="mt-3 text-[11px] opacity-80">オッズ取得 {formatTime(final.decision.odds_captured_at)}{final.decision.valid_until?` / 有効期限 ${formatTime(final.decision.valid_until)}`:''}</p>}
          <p className="mt-3 text-[10px] leading-5 opacity-70">実績を蓄積中の研究判定です。的中率40％・回収率140％は目標値です。</p>
        </div>
        {firstBuy&&<div className="rounded-lg border border-slate-200 bg-white px-4 py-3"><p className="text-xs font-semibold text-slate-800">検証上の初回BUY：{formatTime(firstBuy.generated_at,true)} 保存</p><p className="mt-1 text-[11px] leading-5 text-slate-500">この後に判定が変わっても、初回のBUYと買い目を固定して成績を検証します。</p></div>}
        {settles.length>0&&<div className="rounded-xl border border-slate-200 bg-white p-4"><h4 className="text-sm font-bold text-slate-900">結果の照合</h4><div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm"><span className="text-slate-600">確定 <strong className="font-mono text-slate-900">{settles[0].result_trifecta}</strong></span><span className={settles[0].research_hit?'font-bold text-emerald-700':'text-slate-600'}>比較用買い目：{settles[0].research_hit?'的中':'不的中'}</span>{settles[0].buy_selected&&<span className={settles[0].buy_hit?'font-bold text-emerald-700':'text-slate-600'}>BUY：{settles[0].buy_hit?'的中':'不的中'}</span>}</div><p className="mt-2 text-[11px] text-slate-500">照合 {formatTime(settles[0].settled_at,true)} · 着順と買い目を照合した記録です。</p></div>}
        <ConditionsPanel forecast={final || baseline}/>
      </>}
    </div>
  </section>;
}
