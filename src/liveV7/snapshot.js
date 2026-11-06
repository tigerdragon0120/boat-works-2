// Adapter for the existing Race/RaceEntry/OddsSnapshot contract. Read-only.
import {raceKey,timeMs} from '../lib/uiReadGuard.js';
import {MAX_LIVE_ODDS_AGE_MS} from './freshness.js';
import {FEATURE_SPECS} from './engine.js';
const numeric=n=>typeof n==='number'&&Number.isFinite(n);
export function sectionRating(entry){
 // Existing section_points has ambiguous sources. Derive only from observed finishes.
 if(typeof entry.section_finishes!=='string'||!/^([1-6]|F|L|失|欠|転|不)([-, /]+([1-6]|F|L|失|欠|転|不))*$/.test(entry.section_finishes))return null;
 const finishes=entry.section_finishes.split(/[-, /]+/).filter(x=>/^[1-6]$/.test(x)).map(Number);
 if(!finishes.length)return null;
 const pts=[0,10,8,6,4,2,1];let total=0,weight=0;
 finishes.forEach((f,i)=>{const w=1+i*.15;total+=pts[f]*w;weight+=w;});
 return Math.round(total/weight*10)/10;
}
export function buildSnapshot({race,entries,odds=[],observedAt,quality=null},stage){
 if(!race?.id||!['PRE','FINAL'].includes(stage)||timeMs(observedAt)==null)throw Error('レースまたは観測時刻不明');
 const key=raceKey(race.race_key);
 if(!Array.isArray(entries)||entries.length!==6||entries.some(e=>(e.race_key&&raceKey(e.race_key)!==key)||(!e.race_key&&e.race_id!==race.id)))throw Error('出走表のレース識別または6艇が不完全');
 for(const row of [race,...entries])if(row.updated_date&&(timeMs(row.updated_date)==null||timeMs(row.updated_date)>timeMs(observedAt)))throw Error('元データの更新時刻が不明または未来');
 const warnings=[],normalized=entries.map(e=>{
  const r={boat_number:e.boat_number,is_absent:e.is_absent,is_scratched:e.is_scratched};
  for(const spec of FEATURE_SPECS){if(!spec.stages.includes(stage))continue;r[spec.key]=e[spec.key];}
  r.section_points=sectionRating(e);
  r.boat_f2_rate=e.boat_f2_rate;
  r.v7_evidence=e.v7_evidence;
  if(r.section_points==null)warnings.push(`${e.boat_number}号艇：節間着順不足。尺度不明のsection_pointsは使用しません`);
  if(stage==='FINAL'){
   r.exhibition_course=e.exhibition_course;
   if(typeof e.exhibition_st_raw==='number'&&e.exhibition_st_raw<0)r.exhibition_st=e.exhibition_st_raw;
  }
  return r;
 });
 const candidates=stage==='FINAL'?odds.filter(o=>o.race_id===race.id&&(!o.race_key||raceKey(o.race_key)===key)&&o.stage==='FINAL'&&timeMs(o.captured_at)!=null&&timeMs(o.captured_at)<=timeMs(observedAt)&&timeMs(observedAt)-timeMs(o.captured_at)<=MAX_LIVE_ODDS_AGE_MS).sort((a,b)=>timeMs(b.captured_at)-timeMs(a.captured_at)):[];
 const chosen=candidates[0],oddsMap={};
 if(chosen)for(const [k,v] of Object.entries(chosen.odds_map||{}))if(/^[1-6]-[1-6]-[1-6]$/.test(k)&&new Set(k.split('-')).size===3&&numeric(v)&&v>0)oddsMap[k]=v;
 if(stage==='FINAL'&&!Object.keys(oddsMap).length)warnings.push('時点・レース識別・鮮度10分以内を確認できるFINALオッズなし。期待回収は算出しません');
 return {race:{id:race.id,race_key:key,deadline:race.deadline,race_date:race.race_date,venue_code:race.venue_code,race_number:race.race_number,is_womens:race.is_womens,series_name:race.series_name,race_name:race.race_name,series_day:race.series_day,status:race.status,scratched_boats:(race.scratched_boats||[]).map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=6)},entries:normalized,oddsMap,as_of:observedAt,captured_at:observedAt,units:Object.fromEntries(FEATURE_SPECS.map(s=>[s.key,s.unit])),adapter_warnings:warnings,data_quality:structuredClone(quality),provenance:{availability:'FIRST_SEEN_IN_BROWSER',source_updated:[race,...entries].map(r=>({id:r.id||null,updated_date:r.updated_date||null})),odds_id:chosen?.id||null,odds_captured_at:chosen?.captured_at||null,section_basis:'observed_section_finishes_weighted_rating',...(entries[0]?.card_evidence ? {saved_sources:{card:entries[0].card_evidence,exhibition:stage==='FINAL'?entries[0].exhibition_evidence:null,odds:chosen?.source||null}} : {}),independent_time_proof:false}};
}
export function fingerprintInput(snapshot){
 // Observation time alone must not generate a new revision every poll.
 return {race:snapshot.race,entries:snapshot.entries,oddsMap:snapshot.oddsMap,odds_failed:snapshot.data_quality?.rows?.some(row=>row.key==='odds'&&row.failed)??false,units:snapshot.units,provenance:snapshot.provenance};
}