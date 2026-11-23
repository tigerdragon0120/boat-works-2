import {useEffect, useState} from 'react';
import {useCreditSavingRead} from '@/hooks/useCreditSavingRead';
import {base44} from '@/api/base44Client';
import {isReplay} from './v8StudyView';
import {dashboardPollInterval} from './v8Polling';

export const STAGES = {DAY_BEFORE:'前日', PRE:'当日・展示前', FINAL:'展示後'};
export const VENUES = ['','桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑','津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島','宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'];
export const FIELD_CLASS = 'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100';
export const BUTTON_CLASS = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-sky-300 hover:bg-sky-50 disabled:cursor-wait disabled:opacity-50';

export function timeMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) text += 'Z';
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : null;
}
export function jstDate(offset=0) {
  const shifted = new Date(Date.now()+offset*86400000);
  return shifted.toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
}
export function formatTime(value, withDate=false) {
  const parsed=timeMs(value);
  if (parsed==null) return '時刻不明';
  return new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', ...(withDate?{month:'numeric',day:'numeric'}:{}), hour:'2-digit',minute:'2-digit'}).format(parsed);
}
export function venueName(row) { return row?.venue_name || VENUES[Number(row?.venue_code)] || '会場未確認'; }
export function raceHref(row) { return `/venue/${String(row.venue_code).padStart(2,'0')}?race=${Number(row.race_number)}&date=${encodeURIComponent(row.race_date || jstDate())}`; }
export function safeURL(value) {
  try { const url=new URL(value); return url.protocol==='https:' || url.protocol==='http:' ? url.href : null; } catch { return null; }
}
export function latestRows(rows, keyFn) {
  const selected = new Map();
  for (const row of rows || []) {
    if (!row?.id) continue;
    const key=keyFn(row), current=selected.get(key);
    if (!key) continue;
    const value=timeMs(row.generated_at || row.recorded_at || row.created_date) ?? 0;
    const previous=timeMs(current?.generated_at || current?.recorded_at || current?.created_date) ?? 0;
    if (!current || value>previous || (value===previous && String(row.id).localeCompare(String(current.id))>0)) selected.set(key,row);
  }
  return [...selected.values()];
}
export function latestStage(rows, stage) { return latestRows((rows||[]).filter(row=>row.stage===stage),row=>row.race_key || row.race_id)[0] || null; }
export function displayDecision(forecast, now=Date.now(), race=null) {
  const sourceDeadline=timeMs(forecast?.deadline),currentDeadline=timeMs(race?.deadline);
  const deadline=sourceDeadline!=null&&currentDeadline!=null?Math.min(sourceDeadline,currentDeadline):currentDeadline ?? sourceDeadline;
  const effective=forecast?.effective_status || forecast?.decision?.effective_status;
  if (race?.status==='cancelled' || effective==='CANCELLED') return {key:'CANCELLED',label:'中止',tone:'slate'};
  if (isReplay(forecast)) return {key:'REPLAY',label:'事後検証',tone:'sky'};
  if (race?.status==='finished' || effective==='CLOSED') return {key:'CLOSED',label:'締切済',tone:'slate'};
  if (deadline!=null && deadline<=now) return {key:'CLOSED',label:'締切済',tone:'slate'};
  if (effective==='WAIT') return {key:'WAIT',label:'再確認待ち',tone:'amber'};
  if (!forecast) return {key:'WAIT',label:'取得待ち',tone:'slate'};
  if (race && ((race.id && forecast.race_id!==race.id) || (race.race_key && forecast.race_key!==race.race_key) || currentDeadline==null || (sourceDeadline!=null&&sourceDeadline!==currentDeadline))) return {key:'WAIT',label:'レース情報の再確認待ち',tone:'amber'};
  if (forecast.stage!=='FINAL') return {key:'PRE',label:'展示待ち',tone:'sky'};
  const status=effective || forecast.decision?.status || 'WAIT';
  if (status==='BUY') {
    const oddsAt=timeMs(forecast.decision?.odds_captured_at);
    const validity=timeMs(forecast.decision?.valid_until);
    if (deadline==null || validity==null || oddsAt==null || oddsAt>now || now-oddsAt>=300000 || now>=deadline-60000 || now>=validity) return {key:'STALE',label:'再確認待ち',tone:'amber'};
    return {key:'BUY',label:'研究用BUY',tone:'emerald'};
  }
  return {
    WATCH:{key:'WATCH',label:'候補・保留',tone:'amber'},
    SKIP:{key:'SKIP',label:'見送り',tone:'slate'},
    WAIT:{key:'WAIT',label:'情報待ち',tone:'slate'},
  }[status] || {key:'WAIT',label:'判定待ち',tone:'slate'};
}
async function readV8Dashboard(parameters) {
  try {
    const response=await base44.functions.invoke('v8ReadDashboard',parameters);
    const data=response?.data;
    if (!data || data.ok!==true || data.complete===false) throw new Error(data?.message || '必要な記録をすべて取得できませんでした。時間を置いて再読込してください。');
    return data;
  } catch (error) {
    if(error?.response?.data?.diagnostic) console.warn('[V8 dashboard read]',JSON.stringify(error.response.data.diagnostic));
    throw error;
  }
}
export function useV8Dashboard(parameters, enabled=true) {
  return useCreditSavingRead({operation:'v8ReadDashboard',parameters,enabled,read:readV8Dashboard,interval:dashboardPollInterval});
}
export function useClock() {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(timer);},[]);
  return now;
}
export function parseTickets(text) {
  const tokens=String(text||'').normalize('NFKC').replace(/[−―—]/g,'-').trim().split(/[\s,、]+/).filter(Boolean);
  const result=new Set();
  for (let token of tokens) {
    if (/^[1-6]{3}$/.test(token)) token=token.split('').join('-');
    const match=/^([1-6]+)-([1-6]+)-([1-6]+)$/.exec(token);
    if (!match) throw new Error(`買い目「${token}」を確認してください。例：1-2-3、1-234-56`);
    for (const a of match[1]) for (const b of match[2]) for (const c of match[3]) if(new Set([a,b,c]).size===3) result.add(`${a}-${b}-${c}`);
  }
  if (!result.size) throw new Error('重複する艇を除き、有効な買い目を1点以上入力してください');
  return [...result];
}
