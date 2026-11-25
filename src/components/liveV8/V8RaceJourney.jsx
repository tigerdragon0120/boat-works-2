import React, {useEffect, useMemo, useState} from 'react';
import {useAuth} from '@/lib/AuthContext';
import RaceScenarioDiagram from './RaceScenarioDiagram';
import V8ExternalPanel from './V8ExternalPanel';
import {buildTicketOdds} from './v8TicketOdds';
import V8SumPanel, {SumTheoryModelDetails} from './V8SumPanel';
import V8RacerEvidencePanel from './V8RacerEvidencePanel';
import {selectJourneyBaseline} from './v8RacerEvidenceView';
import {originalTimingSummary, savedSumView, SUM_LABELS, sumModelStatus, sumTimeText} from './v8SumView';
import {isReplay, latestStudyStage, studyStageLabel, studySettlementIndex, studyProgressLabel} from './v8StudyView';
import {scenarioViews, scenarioSelectionContext, selectedScenarioView} from './v8ScenarioView';
import {BUTTON_CLASS, displayForecastStatus, formatTime, latestStage, timeMs, useClock, useV8Dashboard} from './v8Client';

const TONES={emerald:'border-emerald-200 bg-emerald-50 text-emerald-800',amber:'border-amber-200 bg-amber-50 text-amber-900',sky:'border-sky-200 bg-sky-50 text-sky-800',slate:'border-slate-200 bg-slate-50 text-slate-600'};
const COMPARE={SUPPORTED:'事前の読みを支持',CHANGED:'展示で展開を修正',NO_BASE:'比較元の保存待ち',PARTIAL:'情報が揃うまで保留'};
const THEORIES={UICHI_MAIN:'ういち基本型',UICHI_URA:'裏ういち型',UICHI_NEW_MAIN:'新ういち型',UICHI_NEW_URA:'新裏ういち型',EXHIBITION_RELATIVE:'展示・スタート相対評価（従来式）',SUM_BASIC:'基本SUM',SUM_AMAGASAKI:'尼崎・3項SUM',V8_ALL_FACTOR:'V8多因子評価'};
const score=value=>typeof value==='number'&&Number.isFinite(value)?Math.round(value):null;
const measured=(value,digits=2)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'—';

function ConditionsPanel({forecast}) {
  if(!forecast)return null;
  const conditions=forecast.conditions || {}, observed=conditions.kind==='PRE_RACE_OBSERVATION', boats=forecast.boats || [];
  const completeExhibition=forecast.exhibition_complete===true;
  const fields=observed?[{label:'天候',value:conditions.weather || '未取得'},{label:'風',value:typeof conditions.wind_speed==='number'?`${conditions.wind_speed} m/s · ${conditions.wind_direction || '方位未確認'}`:'未取得'},{label:'波高',value:typeof conditions.wave_height==='number'?`${conditions.wave_height} cm`:'未取得'}]:[{label:'天気・風の予報',value:'未接続'}];
  return <details className="rounded-xl border border-slate-200 bg-white p-4">
    <summary className="cursor-pointer text-sm font-bold text-slate-800">保存した入力データと取得状況</summary>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[...fields,{label:'潮位・潮流',value:'未接続'},{label:'1周・周り足・直線タイム',value:originalTimingSummary(forecast)},{label:'SUM評価',value:savedSumView(forecast).label},{label:'展示進入・ST・タイム',value:forecast.stage!=='FINAL'?'事前予想には不使用':completeExhibition?'出走艇を確認済み':'一部未取得・要確認'}].map(field=><div key={field.label} className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] leading-5 text-slate-500">{field.label}</p><p className="mt-1 text-xs font-semibold text-slate-800">{field.value}</p></div>)}
    </div>
    <p className="mt-2 text-[10px] leading-5 text-slate-500">{conditions.observed_at?`気象の取得 ${formatTime(conditions.observed_at,true)}。`:''}気象・潮位による補正は、現在の展開評価には加えていません。未取得を0として扱いません。</p>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-xs">
        <thead className="text-[10px] text-slate-500"><tr>{['艇・選手','想定進入','展示進入','平均ST','展示ST','展示タイム','1周','周り足','直線','モーター2連率','コース1着率'].map(label=><th scope="col" key={label} className="px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{boats.map(boat=><tr key={boat.boat_number} className="border-t border-slate-100">
          <th scope="row" className="px-2 py-2 font-semibold text-slate-800">{boat.boat_number} {boat.player_name || '選手名未取得'}{boat.active===false&&<span className="ml-1 text-[10px] font-normal text-slate-500">欠場</span>}</th>
          <td className="px-2 py-2 text-slate-600">{boat.expected_course ?? '—'}{boat.expected_course_basis==='FRAME_ORDER_ASSUMPTION'?' 仮定':''}</td>
          <td className="px-2 py-2 text-slate-600">{boat.observed_course ?? '—'}</td>
          <td className="px-2 py-2 text-slate-600">{measured(boat.avg_st)}</td>
          <td className={`px-2 py-2 ${boat.exhibition_flying||boat.exhibition_late?'font-semibold text-rose-700':'text-slate-600'}`}>{boat.exhibition_late?'L':boat.exhibition_flying?`F${measured(Math.abs(boat.exhibition_st))}`:measured(boat.exhibition_st)}</td>
          <td className="px-2 py-2 text-slate-600">{measured(boat.exhibition_time)}</td>
          <td className="px-2 py-2 text-slate-600">{sumTimeText(boat.lap_time)}</td>
          <td className="px-2 py-2 text-slate-600">{sumTimeText(boat.turn_time)}</td>
          <td className="px-2 py-2 text-slate-600">{sumTimeText(boat.straight_time)}</td>
          <td className="px-2 py-2 text-slate-600">{typeof boat.motor_2rate==='number'?`${boat.motor_2rate.toFixed(1)}%`:'—'}</td>
          <td className="px-2 py-2 text-slate-600">{typeof boat.course_win_percent==='number'?`${boat.course_win_percent.toFixed(1)}%`:'未取得'}{boat.course_sample_size?` (${boat.course_sample_size}走)`:''}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="mt-2 text-[10px] leading-5 text-slate-500">展示STは本番のSTとは区別し、展示Fをスタートの速さとして加点しません。タイムの単位は秒です。コース成績は進入コースが明示された値のみ扱います。</p>
  </details>;
}

const TICKET_COLORS=['','bg-white text-slate-900 border-slate-400','bg-slate-900 text-white border-slate-900','bg-red-600 text-white border-red-600','bg-blue-600 text-white border-blue-600','bg-yellow-400 text-slate-900 border-yellow-400','bg-emerald-600 text-white border-emerald-600'];
function TicketList({tickets=[],displayOdds,race,now,blocked=false}) {
  const odds=buildTicketOdds({tickets,displayOdds,race,now,blocked});
  if(!tickets.length)return null;
  const unavailable=['UNAVAILABLE','INVALID'].includes(odds.status);
  const quoteLabel=odds.historical?'締切前の参考値':odds.stale?'更新待ち・前回取得値':'取得時点の参考値';
  return <div className="space-y-3">
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-xs font-bold text-sky-900">合成オッズ（{tickets.length}点）</span>
        <strong className="text-2xl font-black tabular-nums text-sky-900">{odds.composite==null?'—':odds.composite.toLocaleString('ja-JP',{minimumFractionDigits:2,maximumFractionDigits:2})}{odds.composite!=null&&<span className="ml-1 text-xs font-semibold">倍</span>}</strong>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5">
        <span className="font-semibold text-slate-600">{unavailable?'オッズの確認待ち':`${odds.available}/${odds.total}点取得${odds.composite==null?'・全点取得後に計算':''}`}</span>
        {odds.capturedAt&&<span className={odds.stale?'font-semibold text-amber-800':'text-slate-500'}>オッズ取得 {formatTime(odds.capturedAt,true)} · {quoteLabel}</span>}
      </div>
      <p className="mt-2 text-[10px] leading-5 text-slate-500">払戻額をそろえる配分での参考倍率です。検証成績は各買い目100円で計算します。</p>
    </div>
    <ol role="list" aria-label="三連単の買い目と取得オッズ" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2 sm:gap-3">
    {tickets.map((ticket,index)=>{
      const value=String(ticket), boats=value.split('-');
      const valid=/^[1-6]-[1-6]-[1-6]$/.test(value)&&new Set(boats).size===3;
      return <li key={`${value}-${index}`} data-ticket={value} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-3 text-slate-900 shadow-sm">
        <span className="sr-only">{valid?`買い目${index+1}：${boats.map((boat,position)=>`${position+1}着${boat}号艇`).join('、')}`:`買い目${index+1}：${value}`}</span>
        <div aria-hidden="true" className="flex items-center gap-3">
          <span className="w-5 shrink-0 pt-5 text-center text-xs font-bold tabular-nums text-slate-500">{String(index+1).padStart(2,'0')}</span>
          {valid?<div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr_auto_1fr] items-end gap-1">
            {boats.map((boat,position)=><React.Fragment key={position}>
              {position>0&&<span className="pb-2.5 text-sm font-bold text-slate-400">−</span>}
              <div className="flex min-w-0 flex-col items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-500">{position+1}着</span>
                <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border text-xl font-black ${TICKET_COLORS[Number(boat)]}`}>{boat}</span>
              </div>
            </React.Fragment>)}
          </div>:<strong className="min-w-0 break-all text-xl">{value}</strong>}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs">
          <span className="text-slate-500">オッズ</span>
          <strong className="tabular-nums text-slate-800">{odds.quotes[value]==null?<span className="font-medium text-slate-400">{unavailable?'確認待ち':'未取得'}</span>:<>{odds.quotes[value].toLocaleString('ja-JP',{minimumFractionDigits:1,maximumFractionDigits:1})}<span className="ml-1 text-[10px] font-medium text-slate-500">倍</span></>}</strong>
        </div>
      </li>;
    })}
    </ol>
  </div>;
}
function ForecastCard({forecast,verification,selectionMode='',title,subtitle,step,empty,displayOdds,race,now,oddsBlocked,emptyDetail='出走表・選手情報を確認して予想を保存します。締切後の補完分も検証用の記録として蓄積します。'}) {
  const [selection,setSelection]=useState(null);
  const views=useMemo(()=>scenarioViews(forecast,verification),[forecast,verification]);
  const selectionContext=scenarioSelectionContext(forecast,selectionMode);
  useEffect(()=>{
    if(selection&&(selection.context!==selectionContext||!views.some(view=>view.scenario.key===selection.key)))setSelection(null);
  },[selection,selectionContext,views]);
  const activeView=selectedScenarioView(views,selection,forecast,selectionMode);
  const active=activeView?.scenario;
  return <article aria-label={title} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
    <header className="mb-3 flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-black text-sky-700">{step}</span><div className="min-w-0"><h4 className="font-bold text-slate-900">{title}</h4><p className="mt-0.5 text-[11px] leading-5 text-slate-500">{forecast?`${studyStageLabel(forecast)} · ${formatTime(forecast.generated_at,true)} 保存`:subtitle}</p>{forecast&&<span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${isReplay(forecast)?'bg-violet-50 text-violet-700':'bg-sky-50 text-sky-700'}`}>{isReplay(forecast)?'事後検証・補完した予想':'締切前に保存'}</span>}</div></header>
    {!forecast?<div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-5 text-center"><span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-xl text-slate-400">○</span><p className="text-sm font-semibold text-slate-600">{empty}</p><p className="mt-2 max-w-xs text-xs leading-6 text-slate-500">{emptyDetail}</p></div>:<>
      <RaceScenarioDiagram scenario={active} boats={forecast.boats} stage={forecast.stage==='FINAL'&&forecast.racer_evidence?.course_basis==='EXPECTED'?'PRE':forecast.stage}/>
      <p className="mt-3 text-[11px] leading-5 text-slate-600">展開を選ぶと、その展開の買い目と合成オッズに切り替わります。</p>
      <div role="group" aria-label={`${title}の展開選択`} className="mt-2 grid grid-cols-2 gap-2">{views.map(view=>{
        const scenario=view.scenario, chosen=active?.key===scenario.key;
        return <button type="button" key={scenario.key} onClick={()=>setSelection({context:selectionContext,key:scenario.key})} aria-pressed={chosen} className={`min-w-0 rounded-lg border px-2.5 py-2 text-left transition ${chosen?'border-sky-500 bg-sky-50 ring-1 ring-sky-100':'border-slate-200 bg-white hover:border-sky-300'}`}>
          <span className="block text-xs font-bold text-slate-800">{scenario.label}</span>
          <span className="mt-1 block text-[10px] text-slate-500">展開評価 {score(scenario.score) ?? '—'} / 100</span>
          <span className="mt-1 block text-[10px] font-semibold leading-4 text-sky-800">{view.available?`${view.tickets.length}点 · ${view.sourceLabel}`:view.sourceLabel}</span>
          {view.result&&<span className={`mt-1 block text-[10px] font-bold ${view.settled&&view.result.hit?'text-emerald-700':'text-slate-600'}`}>{view.resultLabel}</span>}
        </button>;
      })}</div>
      {active&&<div className="mt-3 rounded-lg bg-slate-50 p-3"><p className="text-xs font-semibold leading-6 text-slate-800">{active.reason}</p>{!!active.checkpoints?.length&&<><p className="mt-2 text-[11px] font-bold text-sky-700">{forecast.stage==='FINAL'?'判断の確認項目':'展示で確認すること'}</p><ul className="mt-1 space-y-1 text-[11px] leading-5 text-slate-600">{active.checkpoints.map((text,index)=><li key={index}>・{typeof text==='string'?text:text.label || text.description || '確認項目'}</li>)}</ul></>}</div>}
      <V8RacerEvidencePanel forecast={forecast} scenario={active}/>
      <V8SumPanel forecast={forecast}/>
      {activeView&&<section aria-label="選択した展開の買い目" data-scenario-key={active.key} className="mt-4 rounded-xl border border-sky-200 bg-sky-50/30 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-sm font-black text-slate-900">{active.label}の買い目{activeView.available?`（${activeView.tickets.length}点）`:''}</h5>
          <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${activeView.reconstructed?'bg-amber-50 text-amber-800':'bg-white text-sky-800'}`}>{activeView.sourceLabel}</span>
        </div>
        <p className="mt-1 text-[11px] leading-5 text-slate-600">{active.leader}号艇が「{({ESCAPE:'逃げ',SASHI:'差し',MAKURI:'まくり',MAKURISASHI:'まくり差し'})[active.method] || active.method}」で1着になる展開の組み合わせです。</p>
        {activeView.reconstructed&&<p className="mt-2 text-[11px] leading-5 text-amber-800">当時保存したデータから展開別の買い目を計算しています。当時の保存済み買い目とは区別して表示します。</p>}
        {activeView.available?<>
          <div className="mt-3"><TicketList tickets={activeView.tickets} displayOdds={displayOdds} race={race} now={now} blocked={oddsBlocked}/></div>
          <div className="mt-3 rounded-lg bg-white px-3 py-2">
            <p className={`text-xs font-bold ${activeView.settled&&activeView.result.hit?'text-emerald-700':'text-slate-700'}`}>この展開の買い目：{activeView.resultLabel}</p>
            {activeView.settled&&<p className="mt-1 text-[11px] leading-5 text-slate-500">検証額 {activeView.result.stake.toLocaleString()}円 / 払戻 {activeView.result.returned.toLocaleString()}円 · 1点100円</p>}
            {activeView.excluded&&<p className="mt-1 text-[11px] leading-5 text-slate-500">返還等があるため、的中率・回収率の集計対象外です。</p>}
          </div>
        </>:<p className="mt-3 rounded-lg bg-white p-3 text-xs leading-6 text-slate-500">この展開の買い目を計算できる保存データが揃っていません。</p>}
      </section>}
      {!!forecast.research_tickets?.length&&<details className="mt-4 border-t border-slate-100 pt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-600">V8の総合買い目・保存済み（{forecast.research_tickets.length}点）</summary><p className="mt-2 text-[11px] leading-5 text-slate-500">複数の展開をまとめて選んだ買い目です。総合の検証成績はこちらの買い目で集計します。</p><div className="mt-2"><TicketList tickets={forecast.research_tickets} displayOdds={displayOdds} race={race} now={now} blocked={oddsBlocked}/></div></details>}
      <p className="mt-3 text-[10px] leading-5 text-slate-400">展開評価は未校正の比較スコアです。発生確率・的中率ではありません。</p>
    </>}
  </article>;
}

function TheoryComparison({rows=[],admin,displayOdds,race,now,oddsBlocked}) {
  const latest=[...rows].sort((a,b)=>(timeMs(b.generated_at) || 0)-(timeMs(a.generated_at) || 0));
  const final=latest.find(row=>['FINAL','LOCK'].includes(row.stage)), pre=latest.find(row=>row.stage==='PRE');
  const [stage,setStage]=useState('FINAL'), record=stage==='FINAL'?final:pre;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-bold text-slate-900">同じレースを、複数の見方で比較</h4><p className="mt-1 text-xs leading-5 text-slate-500">各ロジックの買い目を独立して保存し、一致と違いを比較します。</p></div><div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{[['PRE','展示を使わない評価'],['FINAL','展示後']].map(([key,label])=><button type="button" key={key} onClick={()=>setStage(key)} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${stage===key?'bg-white text-sky-700 shadow-sm':'text-slate-500'}`}>{label}</button>)}</div></div>
    {!record?<p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{admin?'この時点のロジック比較は、まだ保存されていません。':'詳細なロジック比較は管理者の研究画面で確認できます。'}</p>:<>
      <p className="text-[11px] text-slate-500">保存：{formatTime(record.generated_at,true)} · モデル版 {record.revision || '—'}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{(record.models||[]).map(model=><article key={model.key} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4"><div className="flex items-start justify-between gap-2"><h5 className="text-sm font-bold text-slate-900">{THEORIES[model.key] || model.label}</h5><span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${model.status==='READY'?'bg-sky-50 text-sky-700':'bg-slate-100 text-slate-500'}`}>{SUM_LABELS[model.key]?sumModelStatus(model):model.status==='READY'?'比較可能':'情報不足'}</span></div>{model.key==='EXHIBITION_RELATIVE'&&<p className="mt-2 text-[11px] leading-5 text-slate-500">従来の独自式です。基本SUM・尼崎3項SUMは別のモデルで比較します。</p>}<SumTheoryModelDetails model={model}/><div className="mt-3"><TicketList tickets={model.tickets || []} displayOdds={displayOdds} race={race} now={now} blocked={oddsBlocked}/></div>{typeof model.score==='number'&&<p className="mt-3 text-xs text-slate-600">比較評価 <span className="font-bold text-slate-900">{(model.score<=1?model.score*100:model.score).toFixed(1)}</span><span className="ml-1 text-[10px] text-slate-400">未校正</span></p>}</article>)}</div>
    </>}
  </div>;
}

export default function V8RaceJourney({race}) {
  const {user}=useAuth(), admin=user?.role==='admin', now=useClock();
  const {data,loading,error,refresh}=useV8Dashboard({mode:'race',race_id:race?.id},!!race?.id);
  const [tab,setTab]=useState('JOURNEY'),[baseMode,setBaseMode]=useState('AUTO');
  useEffect(()=>{setTab('JOURNEY');setBaseMode('AUTO');},[race?.id]);
  const liveRecords=data?.forecasts || [], replayRecords=data?.replay_forecasts || [], records=[...liveRecords,...replayRecords];
  const dayBefore=latestStage(liveRecords,'DAY_BEFORE'), pre=latestStage(liveRecords,'PRE') || latestStage(replayRecords,'PRE'), final=latestStudyStage(liveRecords,'FINAL') || latestStudyStage(replayRecords,'FINAL');
  const referenceId=final?.comparison?.baseline_id || final?.baseline_id;
  const linked=records.find(row=>row.id===referenceId) || null;
  const baseline=selectJourneyBaseline({mode:baseMode,linked,pre,dayBefore});
  const currentRace=(data?.races || []).find(row=>row.id===race?.id || (row.race_key && row.race_key===race?.race_key)) || race;
  const ambiguous=(data?.ambiguous_race_keys || []).includes(currentRace?.race_key);
  const oddsBlocked=!!error||!data||data.complete===false||ambiguous;
  const progress=(data?.race_progress || []).find(row=>row.race_id===currentRace?.id);
  const chosen=final || baseline;
  const decision=displayForecastStatus(chosen,now,currentRace,{ambiguous,unavailable:!!error||!data||data.complete===false});
  const finalEmpty=error||!data||ambiguous
    ? {title:'展示後予想の保存状況を確認できません',detail:'保存記録を確認できていません。時間を置いて再読込してください。',step:'確認待ち'}
    : decision.key==='CANCELLED'
    ? {title:'レースは中止になりました',detail:'このレースの展示後予想は保存されていません。',step:'中止'}
    : ['CLOSED','REPLAY'].includes(decision.key)
    ? currentRace?.exhibition_ready===true
      ? {title:'検証用の展示後予想を補完します',detail:'取得した展示情報から予想を作り、確定結果と照合します。補完分は事後検証として保存します。',step:'予想補完待ち'}
      : {title:'展示データの再取得を待っています',detail:'締切後も展示情報を収集し、展示後予想と結果検証を補完します。',step:'展示再取得待ち'}
    : currentRace?.exhibition_ready===true
    ? {title:'展示後予想の保存を待っています',detail:'展示情報は取得済みです。展示後予想の保存を確認してから表示します。',step:'保存待ち'}
    : {title:'展示情報を待っています',detail:'展示の進入・ST・タイムを取得後、展示後予想を保存して表示します。',step:'展示待ち'};
  const settlementMap=useMemo(()=>studySettlementIndex([...(data?.verifications || []),...(data?.replay_verifications || [])]),[data?.verifications,data?.replay_verifications]);
  const finalSettlement=settlementMap.get(final?.id), baselineSettlement=settlementMap.get(baseline?.id);
  const settles=finalSettlement?[finalSettlement]:[];
  const comparison=final?.comparison, priorChoiceCount=Number(!!dayBefore)+Number(!!pre);
  if (!race?.id) return null;
  return <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm" aria-label="事前展開と展示後の比較">
    <header className="border-b border-slate-100 bg-gradient-to-r from-sky-50 via-white to-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-extrabold tracking-[0.2em] text-sky-700">BOAT WORKS 2 · RACE JOURNEY</p><h3 className="mt-1 text-lg font-black text-slate-900 sm:text-xl">事前の読みから、展示・結果の検証へ</h3><p className="mt-1 text-xs leading-6 text-slate-500">全レースの予想を蓄積し、展示で変わった読みを結果と照合する。</p></div><button type="button" disabled={loading} onClick={()=>void refresh()} className={BUTTON_CLASS} aria-label="展開予想を再読込">{loading?'読込中…':'再読込'}</button></div>
      <ol className="mt-4 grid grid-cols-3 gap-2 text-center">{[{label:'事前の展開',ready:!!(dayBefore || pre),detail:baseline?isReplay(baseline)?'事後補完済み':baseline.stage==='DAY_BEFORE'?'前日保存あり':'展示前を保存':'補完待ち'},{label:'展示で照合',ready:!!final,detail:final?isReplay(final)?'事後補完済み':COMPARE[comparison?.status] || '展示後を保存':finalEmpty.step},{label:'結果で検証',ready:!!(finalSettlement&&baselineSettlement),detail:finalSettlement&&baselineSettlement?'2段階を照合済み':finalSettlement||baselineSettlement?'一部照合済み':progress?studyProgressLabel(progress):'結果照合待ち'}].map((step,index)=><li key={step.label} className={`rounded-lg px-2 py-2 ${step.ready?'bg-sky-50':'bg-slate-50'}`}><span className={`block text-xs font-bold ${step.ready?'text-sky-800':'text-slate-500'}`}>{index+1}. {step.label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">{step.detail}</span></li>)}</ol>
    </header>
    <div className="flex overflow-x-auto border-b border-slate-100 px-3 sm:px-5" role="tablist" aria-label="予想の比較内容">{[['JOURNEY','展開・結果検証'],['THEORIES','ロジック別'],['EXTERNAL','現地予想屋']].map(([key,label])=><button type="button" role="tab" aria-selected={tab===key} key={key} onClick={()=>setTab(key)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-bold transition sm:px-4 ${tab===key?'border-sky-600 text-sky-800':'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div>
    <div className="space-y-4 p-3 sm:p-5">
      {error&&<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">{error}</p>}
      {!!data?.errors?.length&&<p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">一部の記録を確認できていません。取得済みの記録のみを表示しています。</p>}
      {loading&&!data&&!error?<div role="status" className="grid animate-pulse gap-4 sm:grid-cols-2"><div className="h-64 rounded-xl bg-slate-100"/><div className="h-64 rounded-xl bg-slate-100"/><span className="sr-only">保存済み予想を読み込み中</span></div>:tab==='EXTERNAL'?<V8ExternalPanel race={race} rows={data?.external || []} admin={admin} onSaved={refresh}/>:tab==='THEORIES'?<TheoryComparison rows={data?.theories || []} admin={admin} displayOdds={data?.display_odds} race={currentRace} now={now} oddsBlocked={oddsBlocked}/>:<>
        {(isReplay(baseline)||isReplay(final))&&<div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-xs leading-6 text-violet-800"><strong>事後検証の記録を含みます。</strong> 締切後に取得・再計算した分も、予想と結果の比較に使います。保存時刻を残し、締切前に出した予想の成績と分けて集計します。</div>}
        {priorChoiceCount>1&&<div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500">表示する事前記録</span>{[['AUTO',linked?'照合に使った記録':'最新の事前記録'],['DAY_BEFORE','前日'],['PRE','当日・展示前']].map(([key,label])=><button type="button" key={key} onClick={()=>setBaseMode(key)} className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${baseMode===key?'border-sky-300 bg-sky-50 text-sky-800':'border-slate-200 text-slate-500'}`}>{label}</button>)}</div>}
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <ForecastCard forecast={baseline} verification={baselineSettlement} selectionMode={baseMode} displayOdds={data?.display_odds} race={currentRace} now={now} oddsBlocked={oddsBlocked} title="事前の展開予想" subtitle="展示情報を使わない展開の読み" step="1" empty="事前情報からの予想を補完します"/>
          <ForecastCard forecast={final} verification={finalSettlement} displayOdds={data?.display_odds} race={currentRace} now={now} oddsBlocked={oddsBlocked} title="展示後の展開予想" subtitle="進入・ST・タイムを加えて照合" step="2" empty={finalEmpty.title} emptyDetail={finalEmpty.detail}/>
        </div>
        {final&&<div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-bold text-slate-900">展示で何が変わったか</h4><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${comparison?.status==='SUPPORTED'?'bg-emerald-100 text-emerald-800':comparison?.status==='CHANGED'?'bg-amber-100 text-amber-900':'bg-white text-slate-500'}`}>{COMPARE[comparison?.status] || '照合記録を確認中'}</span></div>{linked?<p className="mt-2 text-[11px] text-slate-500">比較元：{studyStageLabel(linked)}{isReplay(linked)?'（事後検証）':''} {formatTime(linked.generated_at,true)} 保存{baseline?.id!==linked.id?'（現在左側に表示中の版とは異なります）':''}</p>:<p className="mt-2 text-xs leading-5 text-amber-800">この展示後予想に紐づく事前記録を確認中です。補完が済むと、展示を加える前後で結果を比較できます。</p>}<ul className="mt-2 space-y-1 text-xs leading-6 text-slate-700">{(comparison?.changes || []).map((text,index)=><li key={index}>・{text}</li>)}</ul></div>}
        <div className={`rounded-xl border p-4 sm:p-5 ${TONES[decision.tone]}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-extrabold tracking-widest">V8総合買い目の保存・検証状況</p><h4 className="mt-1 text-xl font-black">{decision.label}</h4></div><p className="text-[11px]">締切 {formatTime(currentRace?.deadline || final?.deadline)}</p></div>
          {final?<>
            <p className="mt-3 text-sm font-bold">展示後のV8総合買い目 {final.research_tickets.length}点を保存済み</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-white/70 p-3"><p className="text-[10px] font-semibold opacity-70">保存した時点</p><p className="mt-1 text-sm font-bold">{formatTime(final.generated_at,true)} · {isReplay(final)?'締切後の事後補完':'締切前に保存'}</p></div><div className="rounded-lg bg-white/70 p-3"><p className="text-[10px] font-semibold opacity-70">確定結果との照合</p><p className="mt-1 text-sm font-bold">{finalSettlement?finalSettlement.status==='EXCLUDED_REFUND'?'返還等を確認・成績集計外':'照合済み':'未照合・結果照合待ち'}</p></div></div>
            <p className="mt-3 text-[11px] leading-6">総合の検証額は1点100円、{final.research_tickets.length}点で{(final.research_tickets.length*100).toLocaleString()}円です。展開別の結果は、上の各展開を選ぶと確認できます。</p>
          </>:<p className="mt-3 text-xs leading-6">{finalEmpty.detail}</p>}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-bold text-slate-900">3. 総合買い目の結果検証</h4>{(finalSettlement||baselineSettlement)&&<span className="text-xs text-slate-600">確定 <strong className="font-mono text-base text-slate-900">{(finalSettlement||baselineSettlement).result_trifecta || '返還等を確認'}</strong></span>}</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{[{label:'事前の展開予想',forecast:baseline,result:baselineSettlement},{label:'展示後の展開予想',forecast:final,result:finalSettlement}].map(item=><div key={item.label} className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-bold text-slate-700">{item.label}{isReplay(item.forecast)&&<span className="ml-2 text-[10px] font-normal text-violet-700">事後検証</span>}</p><p className={`mt-2 text-lg font-black ${item.result?.research_hit?'text-emerald-700':'text-slate-700'}`}>{item.result?item.result.status==='EXCLUDED_REFUND'?'返還等を確認':item.result.research_hit?'的中':'不的中':item.forecast?'結果照合待ち':'予想補完待ち'}</p>{!item.result&&item.forecast&&<p className="mt-1 text-[11px] leading-5 text-slate-500">V8の買い目 {item.forecast.research_tickets?.length || 0}点を保存済み · 1点100円で照合</p>}{item.result?.status==='SETTLED'&&<p className="mt-1 text-[11px] leading-5 text-slate-500">{item.result.research_tickets?.length || 0}点 · 検証額 {Number(item.result.research_stake || 0).toLocaleString()}円 / 払戻 {Number(item.result.research_return || 0).toLocaleString()}円</p>}{item.result?.status==='EXCLUDED_REFUND'&&<p className="mt-1 text-[11px] leading-5 text-slate-500">返還等があるため、的中率・回収率の集計対象外です。</p>}</div>)}</div>
          {finalSettlement?.status==='SETTLED'&&baselineSettlement?.status==='SETTLED'?<p className="mt-3 text-xs font-semibold text-sky-800">展示を加えた変化：{baselineSettlement.research_hit?finalSettlement.research_hit?'どちらも的中':'的中 → 不的中':finalSettlement.research_hit?'不的中 → 的中':'どちらも不的中'}</p>:<p className="mt-3 text-[11px] leading-5 text-slate-500">{finalSettlement&&baselineSettlement?'返還等を含むため、成績比較の対象外として検証記録を保存しました。':'予想と確定結果が揃った段階から照合し、2段階の検証記録を蓄積します。'}</p>}
          {!!settles.length&&<p className="mt-2 text-[10px] text-slate-400">照合 {formatTime(settles[0].settled_at,true)}</p>}
        </div>
        <ConditionsPanel forecast={final || baseline}/>
      </>}
    </div>
  </section>;
}
