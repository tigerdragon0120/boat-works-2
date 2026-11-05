import {winningDividend} from './resultInput.js';
import {MAX_LIVE_ODDS_AGE_MS} from './freshness.js';
import {timeMs} from '../lib/uiReadGuard.js';
const finite=n=>typeof n==='number'&&Number.isFinite(n);
function timeRange(rows){const values=rows.map(r=>r.updated_date).filter(t=>timeMs(t)!=null).sort((a,b)=>timeMs(a)-timeMs(b));return {oldest:values[0]||null,newest:values.at(-1)||null,unknown:rows.length-values.length};}
export function buildDataQuality({race,entries=[],odds=[],result=null,logs=[],logError=null,observedAt=null}){
 const rows=[];
 function group(key,label,source,items,has,fetchType=null,note=''){
  const times=timeRange(items),events=logs.filter(l=>l.fetch_type===fetchType&&timeMs(l.fetched_at)!=null&&(timeMs(observedAt)==null||timeMs(l.fetched_at)<=timeMs(observedAt))&&(!l.race_id||l.race_id===race.id)).sort((a,b)=>timeMs(b.fetched_at)-timeMs(a.fetched_at)),last=events[0],count=items.filter(has).length,total=items===entries?6:Math.max(1,items.length);
  rows.push({key,label,source,count,total,missing:total-count,...times,lastAttempt:last?.fetched_at||null,lastStatus:last?.status||'UNKNOWN',failed:!!last&&last.status!=='success',note});
 }
 group('race','当日レース・締切',race.sync_source||'既存Race（同期元未記録）',[race],r=>!!r.race_key&&!!r.deadline);
 group('entries','出走表','既存RaceEntry',entries,e=>Number.isInteger(e.boat_number));
 group('course','展示進入','既存RaceEntry',entries,e=>Number.isInteger(e.exhibition_course)&&e.exhibition_course>=1&&e.exhibition_course<=6,'exhibition');
 group('st','展示ST','既存RaceEntry',entries,e=>finite(e.exhibition_st_raw)||finite(e.exhibition_st),'exhibition');
 group('time','展示タイム','既存RaceEntry',entries,e=>finite(e.exhibition_time),'exhibition');
 group('motor','モーター2連率','既存RaceEntry',entries,e=>finite(e.motor_f2_rate));
 group('section','節間着順','既存RaceEntry',entries,e=>typeof e.section_finishes==='string'&&!!e.section_finishes,'section');
 group('pointRate','得点率','RaceEntry.point_rate / qualifying_point_rate',entries,e=>finite(e.point_rate)||finite(e.qualifying_point_rate),null,'V7は尺度混在を避け、得点率の追加補正を行いません');
 rows.push({key:'waku10',label:'枠番過去10走',source:'fetchBoatcastWaku10（既存表示用）',count:null,total:null,missing:null,oldest:null,newest:null,unknown:null,lastAttempt:null,lastStatus:'NOT_COLLECTED',failed:false,note:'この予想入力では取得・使用していません。画面表示用の返却データと保存済み統計は別です'});
 const finalOdds=odds.filter(o=>o.race_id===race.id&&o.stage==='FINAL').sort((a,b)=>(timeMs(b.captured_at)||0)-(timeMs(a.captured_at)||0))[0];
 const priced=Object.entries(finalOdds?.odds_map||{}).filter(([k,v])=>/^[1-6]-[1-6]-[1-6]$/.test(k)&&new Set(k.split('-')).size===3&&finite(v)&&v>0).length;
 group('odds','三連単オッズ',finalOdds?.source||'OddsSnapshot（取得元未記録）',finalOdds?[finalOdds]:[],()=>priced>0,'odds');
 Object.assign(rows.at(-1),{capturedAt:finalOdds?.captured_at||null,stale:timeMs(observedAt)!=null&&timeMs(finalOdds?.captured_at)!=null&&timeMs(observedAt)-timeMs(finalOdds.captured_at)>MAX_LIVE_ODDS_AGE_MS,future:timeMs(observedAt)!=null&&timeMs(finalOdds?.captured_at)>timeMs(observedAt),priced,note:'取得時刻のあるFINALオッズだけをV7で使用。欠場時の必要組合せ数は変わります'});
 group('result','結果・三連単払戻','既存RaceResult',result?[result]:[],r=>!!r.result_trifecta&&winningDividend(r)!=null,'result');
 return {rows,logError,sourceFreshness:'UNVERIFIED',note:'保存行の更新時刻は元サイト取得時刻の証明ではありません。読込成功だけでは最新取得済みと判定しません。'};
}