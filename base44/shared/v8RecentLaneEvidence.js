// Frozen BOATCAST same-frame history. These scores are comparison rules,
// not win probabilities, and overlapping histories are never pooled as samples.
import {normalizeRecentLaneName,summarizeRecentLaneHistory,recentLaneSourceUrl,RECENT_LANE_MAX_WINNING_RATE} from './v8RecentLaneSource.js';

export const RECENT_LANE_EVIDENCE_REVISION='V8_RECENT_LANE_EVIDENCE_1';
export const RECENT_LANE_REVISION='V8_RECENT_LANE_1';
export const RECENT_LANE_PRIOR_STRENGTH=20;
const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const bound=(value,min,max)=>finite(value)&&value>=min&&value<=max?value:null;
const lane=value=>Number.isInteger(value)&&value>=1&&value<=6?value:null;
const round=value=>finite(value)?Math.round(value*1000)/1000:null;
const time=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;
  const ms=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)?value:value+'Z');
  return Number.isFinite(ms)?ms:null;
};
const registration=entry=>String(entry?.registration_number??entry?.register_number??'').trim();
const rateKeys=['first_rate','second_rate','third_rate','top2_rate','top3_rate'];
const rawKeys=['winning_rate','avg_st','avg_start_order','sample_size','normal_sample_size','special_count','absent_count',...rateKeys,'history'];

/** Revalidate saved evidence at the forecast boundary, including reused PRE data. */
export function validatedRecentLaneSnapshot(value,{race,entry,asOf}={}){
  const now=time(asOf),available=time(value?.available_at),fetched=time(value?.fetched_at),deadline=time(race?.deadline);
  const number=lane(Number(entry?.boat_number)),reg=registration(entry);
  if(value?.revision!==RECENT_LANE_REVISION||value.source!=='BOATCAST_WAKU10'||value.status!=='READY'
    ||value.identity_status!=='MATCHED_NAME_AND_ENTRY'||value.race_id!==race?.id||value.race_key!==race?.race_key
    ||number===null||value.boat_number!==number||!/^\d{4}$/.test(reg)||String(value.registration_number)!==reg
    ||now===null||available===null||fetched===null||deadline===null||fetched>available||available>now||available>=deadline-60000
    ||!value.snapshot_id||!value.snapshot_key||!value.row_hash||value.source_url!==recentLaneSourceUrl(race)
    ||value.denominator_rule!=='KNOWN_STARTS_EXCLUDING_ABSENT'||!Array.isArray(value.history)||value.history.length>10)return null;
  const names=[entry?.player_name,entry?.racer_name];
  const profile=entry?.v8_racer_profile;
  if(profile?.revision==='V8_RACER_PROFILE_1'&&String(profile.registration_number)===reg
    &&time(profile.source?.available_at)!==null&&time(profile.source.available_at)<=now)names.push(profile.player_name);
  const sourceName=normalizeRecentLaneName(value.source_name);
  if(!sourceName||!names.some(name=>normalizeRecentLaneName(name)===sourceName))return null;
  const history=[];
  for(const item of value.history){
    if(!item||typeof item!=='object'||typeof item.course_inferred!=='boolean')return null;
    const course=item.course==null?null:lane(item.course);
    if(item.course!=null&&course===null||item.course_inferred&&course!==number)return null;
    history.push({finish_order:item.finish_order??null,finish_status:item.finish_status??null,course,
      course_inferred:item.course_inferred,code:item.code==null?null:String(item.code)});
  }
  const summary=summarizeRecentLaneHistory(history);
  if(!summary?.ok||summary.sample_size>10)return null;
  for(const key of ['sample_size','normal_sample_size','special_count','absent_count'])if(value[key]!==summary[key])return null;
  // Rates are recomputed from immutable rows rather than trusting supplied percentages.
  return {revision:RECENT_LANE_REVISION,source:'BOATCAST_WAKU10',status:'READY',race_id:race.id,race_key:race.race_key,
    boat_number:number,registration_number:reg,source_name:String(value.source_name),identity_status:value.identity_status,
    snapshot_id:String(value.snapshot_id),snapshot_key:String(value.snapshot_key),row_hash:String(value.row_hash),
    source_url:String(value.source_url),fetched_at:value.fetched_at,available_at:value.available_at,
    // Official winning points may include SG (+2) and final-race (+1) bonuses:
    // https://www.boatrace.jp/owpc/pc/extra/enjoy/guide/jiten/17/y_164.html
    winning_rate:bound(value.winning_rate,0,RECENT_LANE_MAX_WINNING_RATE),avg_st:bound(value.avg_st,0,1),avg_start_order:bound(value.avg_start_order,1,6),
    sample_size:summary.sample_size,normal_sample_size:summary.normal_sample_size,special_count:summary.special_count,
    absent_count:summary.absent_count,...Object.fromEntries(rateKeys.map(key=>[key,summary[key]??null])),
    denominator_rule:'KNOWN_STARTS_EXCLUDING_ABSENT',history};
}

function validBaseline(value,race,now){
  const generated=time(value?.generated_at),created=time(value?.created_date),deadline=time(race?.deadline);
  return !!value?.id&&value.race_id===race?.id&&value.race_key===race?.race_key&&value.race_date===race?.race_date
    &&['DAY_BEFORE','PRE'].includes(value.stage)&&value.record_mode!=='REPLAY'
    &&generated!==null&&created!==null&&deadline!==null&&generated<=now&&created<=now
    &&generated<deadline-60000&&created<deadline-60000
    &&value.recent_lane_evidence?.revision===RECENT_LANE_EVIDENCE_REVISION
    &&Array.isArray(value.recent_lane_evidence.boats);
}

export function buildRecentLaneEvidence({race,entries=[],stage,now,baseline=null,exhibitionComplete=false,replay=false}={}){
  const reuseAllowed=!replay&&stage==='FINAL'&&validBaseline(baseline,race,time(now));
  const observed=stage==='FINAL'&&exhibitionComplete===true;
  let reused=0,current=0,changed=false;
  const boats=entries.map(entry=>{
    const number=lane(Number(entry.boat_number)),reg=registration(entry);
    const selected=observed?lane(Number(entry.exhibition_course))
      :lane(Number(entry.expected_entry_course??entry.entry_course))??number;
    const candidate=replay?null:validatedRecentLaneSnapshot(entry.v8_recent_lane,{race,entry,asOf:now});
    const old=reuseAllowed?baseline.recent_lane_evidence.boats.filter(row=>row.boat_number===number&&row.registration_number===reg):[];
    const previous=old.length===1?validatedRecentLaneSnapshot(old[0].snapshot,{race,entry,asOf:baseline.generated_at}):null;
    const snapshot=previous||candidate,sourceBasis=previous?'BASELINE_SNAPSHOT':candidate?'CURRENT_SNAPSHOT':'UNAVAILABLE';
    if(previous)reused++;else if(candidate)current++;
    if(previous&&candidate&&(previous.snapshot_id!==candidate.snapshot_id||previous.row_hash!==candidate.row_hash))changed=true;
    const sameFrame=selected===number;
    const selectedHistory=snapshot?(sameFrame?snapshot.history:snapshot.history.filter(row=>row.course===selected&&row.course_inferred===false)):[];
    const summary=summarizeRecentLaneHistory(selectedHistory);
    const n=summary?.ok?summary.sample_size:0;
    const frequency=n?summary.first_rate*.5+summary.top2_rate*.3+summary.top3_rate*.2:null;
    const points=summary?.normal_sample_size>0?(sameFrame?snapshot?.winning_rate:summary?.winning_rate):null;
    // Preserve published points (up to 13); only their comparison-score
    // contribution is bounded to 100, never interpreted as a probability.
    const finish=finite(frequency)?finite(points)?frequency*.8+Math.min(100,points*10)*.2:frequency:null;
    const startAllowed=!!snapshot&&snapshot.sample_size>0&&sameFrame;
    const reason=replay?'REPLAY_CURRENT_SOURCE_EXCLUDED':!snapshot?entry.v8_recent_lane?'SOURCE_INVALID':'SOURCE_NOT_AVAILABLE'
      :!snapshot.sample_size?'NO_KNOWN_STARTS':!n?'NO_MATCHING_COURSE_STARTS':'READY';
    const omitted=[];
    if(snapshot&&!sameFrame)omitted.push('COURSE_CHANGED_AGGREGATE_ST_EXCLUDED');
    if(snapshot&&!n)omitted.push('RECENT_FINISH_MISSING');
    if(startAllowed&&!finite(snapshot.avg_st))omitted.push('RECENT_ST_MISSING');
    if(startAllowed&&!finite(snapshot.avg_start_order))omitted.push('RECENT_ST_RANK_MISSING');
    return {boat_number:number,registration_number:reg,lane:number,selected_course:selected,
      selected_course_basis:observed?'EXHIBITION_CONFIRMED':'EXPECTED',status:snapshot?.sample_size?'READY':'UNAVAILABLE',reason,
      source_basis:sourceBasis,snapshot,
      ...Object.fromEntries(['snapshot_id','snapshot_key','row_hash','source_url','fetched_at','available_at','source_name','identity_status']
        .map(key=>[key,snapshot?.[key]??null])),
      raw:snapshot?Object.fromEntries(rawKeys.map(key=>[key,clone(snapshot[key])])):null,
      scoring:{used:false,applied:false,used_features:[],reason,omitted_reasons:omitted,
        finish_sample_size:n,finish_selection:sameFrame?'SAME_FRAME_HISTORY':'MATCHED_COURSE_HISTORY',
        blend_weight:round(n/(n+RECENT_LANE_PRIOR_STRENGTH)),
        start_blend_weight:round(startAllowed?snapshot.sample_size/(snapshot.sample_size+RECENT_LANE_PRIOR_STRENGTH):0),
        recent_frequency_score:round(frequency),recent_finish_score:round(finish),
        winning_rate_used:finite(frequency)&&finite(points),recent_winning_rate:finite(points)?points:null,
        recent_avg_st:startAllowed?snapshot.avg_st:null,recent_avg_start_order:startAllowed?snapshot.avg_start_order:null,
        finish_reference_kind:null,start_reference_kind:null,finish_before:null,finish_after:null,
        start_before:null,start_after:null,base_before:null,base_after:null,delta:null}};
  });
  const ready=boats.filter(row=>row.status==='READY').length;
  const basis=reused&&current?'MIXED':reused?'BASELINE_SNAPSHOT':current?'CURRENT_SNAPSHOT':'UNAVAILABLE';
  const frozen=reused===boats.length&&boats.length>0;
  const note=stage!=='FINAL'?null:frozen
    ?changed?'枠番過去10走は更新されていますが、比較には事前保存と同じ履歴を使用しています。':'枠番過去10走は事前保存と同じ履歴を使用しています。'
    :reused?'一部の選手は事前保存の枠番履歴を使用しています。追加した履歴と展示の変化を区別して記録しています。'
      :current?'事前保存に同じ枠番履歴がないため、今回保存済みの履歴を追加しています。履歴の追加と展示の変化を区別してください。':null;
  return {revision:RECENT_LANE_EVIDENCE_REVISION,source:'BOATCAST_WAKU10',as_of:now,
    status:ready===boats.length&&ready?'READY':ready?'PARTIAL':'UNAVAILABLE',source_basis:basis,
    baseline_id:reuseAllowed?baseline.id:null,baseline_snapshot_reused:frozen,current_snapshot_changed:changed,change_note:note,
    prior_strength:RECENT_LANE_PRIOR_STRENGTH,score_type:'UNCALIBRATED_COMPARISON_RULE',history_dates_available:false,boats};
}

export function recentLaneEvidenceKey(evidence){
  const rows=(evidence?.boats||[]).filter(row=>row.snapshot&&row.status==='READY')
    .map(row=>[row.boat_number,row.registration_number,row.snapshot_id,row.snapshot_key,row.row_hash,row.available_at])
    .sort((a,b)=>a[0]-b[0]);
  if(!rows.length)return 'NO_RECENT';
  let hash=2166136261;
  for(const char of JSON.stringify(rows)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return 'RECENT_'+(hash>>>0).toString(16).padStart(8,'0');
}
