import React, {useEffect, useMemo, useState} from 'react';
import {Clock} from 'lucide-react';
import {BUTTON_CLASS, FIELD_CLASS, STAGES, displayDecision, formatTime, jstDate, latestRows, raceHref, timeMs, useClock, useV8Dashboard, venueName} from './v8Client';

const CHIP={emerald:'bg-emerald-50 text-emerald-800 ring-emerald-200',sky:'bg-sky-50 text-sky-800 ring-sky-200',amber:'bg-amber-50 text-amber-900 ring-amber-200',slate:'bg-slate-100 text-slate-600 ring-slate-200'};
const ORDER={BUY:0,WATCH:1,PRE:2,WAIT:3,STALE:4,SKIP:5,CLOSED:6,CANCELLED:7};
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;

export default function V8DailyBoard({onSelectRace}) {
  const [date,setDate]=useState(jstDate()),[venue,setVenue]=useState('ALL'),[filter,setFilter]=useState('ALL'),[limit,setLimit]=useState(12);
  const now=useClock(),{data,loading,error,refresh}=useV8Dashboard({mode:'day',race_date:date});
  useEffect(()=>{setLimit(12);setVenue('ALL');setFilter('ALL');},[date]);
  useEffect(()=>setLimit(12),[venue,filter]);
  const rows=useMemo(()=>{
    const stageRows=latestRows(data?.forecasts || [],row=>`${row.race_key || row.race_id}:${row.stage}`), byRace=new Map();
    for (const forecast of stageRows) {
      const key=forecast.race_id, previous=byRace.get(key), rank={DAY_BEFORE:0,PRE:1,FINAL:2};
      if (!previous || (rank[forecast.stage]??-1)>(rank[previous.stage]??-1)) byRace.set(key,forecast);
    }
    const actualRaces=new Map((data?.races || []).map(race=>[race.id,race]));
    for (const forecast of stageRows) if(!actualRaces.has(forecast.race_id)) actualRaces.set(forecast.race_id,{...forecast,id:forecast.race_id});
    const ambiguous=new Set(data?.ambiguous_race_keys || []);
    return [...actualRaces.values()].map(race=>{
      const forecast=byRace.get(race.id) || null;
      return {race,forecast,decision:displayDecision(ambiguous.has(race.race_key)&&forecast?{...forecast,effective_status:'WAIT'}:forecast,now,race)};
    }).sort((a,b)=>(ORDER[a.decision.key]??9)-(ORDER[b.decision.key]??9) || (numeric(b.forecast?.priority_score)??-1)-(numeric(a.forecast?.priority_score)??-1) || (timeMs(a.race.deadline)??Infinity)-(timeMs(b.race.deadline)??Infinity));
  },[data,now]);
  const venues=useMemo(()=>[...new Map(rows.map(({race})=>[String(race.venue_code),venueName(race)])).entries()].sort((a,b)=>Number(a[0])-Number(b[0])),[rows]);
  const visible=rows.filter(row=>(venue==='ALL'||String(row.race.venue_code)===venue)&&(filter==='ALL'||(filter==='BUY'?row.decision.key==='BUY':filter==='CANDIDATE'?['WATCH','PRE'].includes(row.decision.key):!row.forecast)));
  const buys=rows.filter(row=>row.decision.key==='BUY').length, captured=rows.filter(row=>row.forecast).length;
  const coverage=data?.coverage || {},expected=numeric(coverage.expected_races)??rows.length, missing=numeric(coverage.missing_races)??Math.max(0,expected-captured);
  const upcoming=rows.filter(({race,decision})=>!['CLOSED','CANCELLED'].includes(decision.key)&&(timeMs(race.deadline)??0)>now).sort((a,b)=>timeMs(a.race.deadline)-timeMs(b.race.deadline));
  const nextRace=upcoming[0]?.race || null, minutesToDeadline=nextRace?Math.ceil((timeMs(nextRace.deadline)-now)/60000):null;
  const countdown=minutesToDeadline==null?'':minutesToDeadline<60?`${minutesToDeadline}分`:`${Math.floor(minutesToDeadline/60)}時間${minutesToDeadline%60?minutesToDeadline%60+'分':''}`;
  return <div className="space-y-3">
    {nextRace&&<a href={raceHref(nextRace)} aria-label={`次の締切：${venueName(nextRace)} ${nextRace.race_number}R`} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 shadow-sm transition hover:border-rose-400">
      <div className="flex items-center gap-2"><Clock className="h-5 w-5 shrink-0 text-rose-600" aria-hidden="true"/><span className="rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white">{minutesToDeadline<=10?'締切間近':'次の締切'}</span><strong className="text-base font-black text-slate-900">{venueName(nextRace)} {nextRace.race_number}R</strong></div>
      <div className="flex items-baseline gap-2"><span className="text-[11px] text-slate-500">締切</span><strong className="text-xl font-black tabular-nums text-rose-600">{formatTime(nextRace.deadline,date!==jstDate())}</strong><span className="text-xs font-bold text-rose-700">あと {countdown}</span></div>
      <div className="ml-auto text-right"><p className="text-[10px] text-slate-500">選択日の全{expected}R</p><p className="text-sm font-bold text-slate-800">締切前 {upcoming.length}R</p></div>
    </a>}
    <section className="overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-sm" aria-label="全レースの予想とBUY候補">
    <header className="border-b border-slate-100 bg-gradient-to-br from-sky-50 via-white to-white p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-extrabold tracking-[0.2em] text-sky-700">DAILY RACE SELECTION</p><h2 className="mt-1 text-xl font-black tracking-tight text-slate-900 sm:text-2xl">一日のレースから、選び抜く。</h2><p className="mt-2 max-w-xl text-xs leading-6 text-slate-500">前日の展開を保存し、展示とオッズを確認。条件が整ったレースを上に表示します。</p></div><button type="button" disabled={loading} onClick={()=>void refresh()} className={BUTTON_CLASS}>{loading?'読込中…':'再読込'}</button></div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">{[[jstDate(),'今日'],[jstDate(1),'明日']].map(([value,label])=><button type="button" key={label} onClick={()=>setDate(value)} className={`rounded-md px-4 py-1.5 text-xs font-bold ${date===value?'bg-sky-700 text-white':'text-slate-500 hover:bg-slate-50'}`}>{label}</button>)}</div><label><span className="sr-only">対象日</span><input type="date" value={date} onChange={event=>{if(event.target.value)setDate(event.target.value);}} className={`${FIELD_CLASS} max-w-44`}/></label></div><p className="text-[11px] leading-5 text-slate-400">{data?.generated_at?`確認 ${formatTime(data.generated_at,true)}`:'サーバー保存記録を確認'}<span className="block">表示中は1分ごとに更新</span></p></div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{[{label:'対象レース',value:expected,suffix:'R',tone:'text-slate-900'},{label:'事前・展示後を保存',value:numeric(coverage.captured_races)??captured,suffix:'R',tone:'text-sky-800'},{label:'現在の研究用BUY',value:buys,suffix:'R',tone:'text-emerald-700'},{label:'まだ未取得',value:missing,suffix:'R',tone:'text-slate-500'}].map(item=><div key={item.label} className="rounded-xl border border-slate-100 bg-white px-3 py-3"><p className="text-[10px] font-semibold text-slate-500 sm:text-[11px]">{item.label}</p><p className={`mt-1 text-2xl font-black tabular-nums ${item.tone}`}>{data?item.value:'—'}<span className="ml-1 text-xs font-medium text-slate-400">{item.suffix}</span></p></div>)}</div>
    </header>
    <div className="space-y-4 p-4 sm:p-6">
      {error&&<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm leading-6 text-rose-800">{error}</p>}
      {!!data?.errors?.length&&<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">一部の情報に取得待ちがあります。保存記録がないレースは未取得として表示します。</p>}
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-1.5">{[['ALL','すべて'],['BUY','研究用BUY'],['CANDIDATE','候補・展示待ち'],['MISSING','未取得']].map(([key,label])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter===key?'border-sky-300 bg-sky-50 text-sky-800':'border-slate-200 bg-white text-slate-500 hover:border-sky-200'}`}>{label}</button>)}</div><label className="w-36"><span className="sr-only">会場</span><select value={venue} onChange={event=>setVenue(event.target.value)} className={FIELD_CLASS}><option value="ALL">すべての会場</option>{venues.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label></div>
      {loading&&!data&&!error?<div className="grid animate-pulse gap-3 md:grid-cols-2 xl:grid-cols-3" role="status">{[1,2,3].map(value=><div key={value} className="h-48 rounded-xl bg-slate-100"/>)}<span className="sr-only">全レースの予想を読み込み中</span></div>:!visible.length?<div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-9 text-center"><h3 className="text-sm font-bold text-slate-700">{filter==='BUY'?'現在、条件を満たす研究用BUYはありません':rows.length?'この条件に該当するレースはありません':'この日付のレース・予想を取得中です'}</h3><p className="mt-2 text-xs leading-6 text-slate-500">{date>jstDate()?'翌日の番組が取得できたレースから、前日の展開予想を保存します。':'展示やオッズの更新に合わせて、保存された判定が反映されます。'}</p></div>:<>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visible.slice(0,limit).map(({race,forecast,decision})=>{
          const scenario=forecast?.scenarios?.find(row=>row.key===forecast.top_scenario_key) || forecast?.scenarios?.[0];
          const common={className:'group block h-full min-w-0 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-sky-400 hover:shadow-sm'};
          const content=<>
            <div className="flex items-start justify-between gap-2"><div><h3 className="text-base font-black text-slate-900">{venueName(race)} <span className="ml-1 font-mono text-lg">{race.race_number}R</span></h3><p className="mt-1 text-[11px] text-slate-500">締切 {formatTime(race.deadline)}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ring-inset ${CHIP[decision.tone]}`}>{decision.key==='BUY'?'研究用BUY':decision.label}</span></div>
            <div className="mt-3 min-h-16 rounded-lg bg-slate-50 px-3 py-2"><p className="text-sm font-bold text-slate-800">{scenario?.label || '展開予想の保存待ち'}</p><p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500">{forecast?.decision?.reasons?.[0] || scenario?.reason || '番組と出走データが揃い次第、予想を保存します。'}</p></div>
            <div className="mt-3 flex items-end justify-between gap-2"><div><p className="text-[10px] text-slate-400">{forecast?`${STAGES[forecast.stage] || '保存記録'} · ${formatTime(forecast.generated_at)}`:'保存記録なし'}</p>{numeric(forecast?.priority_score)!=null&&<p className="mt-1 text-[11px] text-slate-500">比較評価 <span className="font-bold text-slate-800">{Math.round(forecast.priority_score)}</span> / 100</p>}</div><span className="text-xs font-bold text-sky-700 group-hover:text-sky-900">展開を見る ↗</span></div>
          </>;
          return typeof onSelectRace==='function'?<button key={race.id} type="button" {...common} onClick={()=>onSelectRace(race)}>{content}</button>:<a key={race.id} {...common} href={raceHref(race)}>{content}</a>;
        })}</div>
        {visible.length>limit&&<div className="text-center"><button type="button" onClick={()=>setLimit(limit+12)} className={BUTTON_CLASS}>さらに12レースを表示（残り{visible.length-limit}R）</button></div>}
      </>}
      <p className="border-t border-slate-100 pt-3 text-[10px] leading-5 text-slate-400">BUY件数を固定せず、判定条件を満たしたレースだけを表示します。比較評価は未校正の順位付けです。締切直前・オッズの有効期限切れは再確認待ちになります。</p>
    </div>
    </section>
  </div>;
}
