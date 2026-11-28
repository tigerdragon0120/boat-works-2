// The public BOATCAST live page reads this daily schedule before rendering
// DeadlineTimeAll (1R..12R). Contract observed in /assets/js/main.js.
// This helper updates only existing Race deadlines, never saved forecasts.
import {dateValid,jstDate,readV8Rows} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

const BASE='https://race.boatcast.jp/api_txt/getHoldingList2_';
const MAX_BYTES=128*1024;
const MAX_AGE_MS=5*60000;
const ACTIVE=new Set(['scheduled','pre','final']);
const CLOSED=new Set(['締切','確定','中止']);
const runtimeFetch=(url,options)=>fetch(url,options);
const venue=value=>typeof value==='string'&&/^(?:0[1-9]|1\d|2[0-4])$/.test(value)?value:null;
const clock=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?value:null;
const httpStatus=error=>Number(error?.http_status??error?.response?.status??error?.status)||null;
const nowIso=()=>new Date().toISOString();

export const officialDeadlineUrl=date=>dateValid(date)?BASE+date.replaceAll('-','')+'.json':null;

export function normalizeOfficialDeadlines(payload,{date,source,now=Date.now()}={}){
  const fail=reason=>({ok:false,reason,deadlines:new Map()});
  if(!dateValid(date)||date!==jstDate(0,now))return fail('SCHEDULE_DATE_INVALID');
  const fetched=utcMs(source?.fetched_at),published=source?.published_at==null?null:utcMs(source.published_at);
  if(source?.url!==officialDeadlineUrl(date)||source?.provider!=='BOATCAST'||source.http_status!==200)return fail('SCHEDULE_SOURCE_INVALID');
  if(fetched==null||fetched>now||now-fetched>MAX_AGE_MS||jstDate(0,fetched)!==date)return fail('SCHEDULE_OBSERVATION_TIME_INVALID');
  if(source?.published_at!=null&&(published==null||published>fetched||fetched-published>MAX_AGE_MS))return fail('SCHEDULE_PUBLICATION_TIME_INVALID');
  if(!payload||payload.res_cd!==0||!Array.isArray(payload.return_info)||!payload.return_info.length||payload.return_info.length>24)return fail('SCHEDULE_PAYLOAD_INVALID');
  const deadlines=new Map(),venues=new Set();
  for(const row of payload.return_info){
    const code=venue(row?.RaceStudiumNo),times=row?.DeadlineTimeAll,cancelled=row?.CancelStatusAll;
    if(!code||venues.has(code))return fail('SCHEDULE_VENUE_AMBIGUOUS');
    venues.add(code);
    if(!Array.isArray(times)||times.length!==12||!Array.isArray(cancelled)||cancelled.length!==12)return fail('SCHEDULE_RACE_SLOTS_INVALID');
    if(typeof row.RecentRace!=='string'||!/^(?:0[1-9]|1[0-2])$/.test(row.RecentRace)
      ||row.DeadlineTime!==times[Number(row.RecentRace)-1])return fail('SCHEDULE_CURRENT_RACE_CONFLICT');
    let previous=-1;
    for(let index=0;index<12;index++){
      const value=times[index],time=clock(value),cancel=cancelled[index];
      if(typeof cancel!=='string'||!time&&!CLOSED.has(value))return fail('SCHEDULE_TIME_AMBIGUOUS');
      if(!time||cancel!=='')continue;
      const deadline=`${date}T${time}:00+09:00`,at=Date.parse(deadline);
      // Never repair a deadline from reordered or conflicting race slots.
      if(at<=previous)return fail('SCHEDULE_TIME_ORDER_INVALID');
      previous=at;
      if(at<=now)continue;
      const raceNumber=index+1,key=`${date}_${code}_${String(raceNumber).padStart(2,'0')}`;
      deadlines.set(key,{race_key:key,venue_code:code,race_number:raceNumber,deadline});
    }
  }
  return {ok:true,reason:null,deadlines};
}

function raceSlot(row,date){
  const code=venue(row?.venue_code),number=row?.race_number;
  if(!row?.id||row.race_date!==date||!code||!Number.isInteger(number)||number<1||number>12)return null;
  return `${date}_${code}_${String(number).padStart(2,'0')}`;
}
const raceIdentity=(row,date)=>row?.race_key===raceSlot(row,date)?row.race_key:null;

// A confirmed same-day live correction outranks an older HTML card for the
// rest of that day. Unchanged schedules need no write just to renew this proof.
// Freshness is enforced when the live correction is first accepted above.
export function hasConfirmedOfficialDeadline(race,{date=race?.race_date,now=Date.now()}={}){
  if(!dateValid(date)||date!==jstDate(0,now)||!raceIdentity(race,date))return false;
  const source=race.deadline_source,fetched=utcMs(source?.fetched_at),deadline=utcMs(race.deadline);
  if(source?.provider!=='BOATCAST'||source.url!==officialDeadlineUrl(date)||source.http_status!==200
    ||source.race_date!==date||source.venue_code!==race.venue_code||source.race_number!==race.race_number
    ||deadline==null||utcMs(source.deadline)!==deadline||jstDate(0,deadline)!==date
    ||fetched==null||fetched>now||jstDate(0,fetched)!==date)return false;
  if(source.published_at!=null){
    const published=utcMs(source.published_at);
    if(published==null||published>fetched||fetched-published>MAX_AGE_MS)return false;
  }
  return true;
}

export async function refreshOfficialDeadlines(client,{date,deadlineMs=Date.now()+8000,fetcher=runtimeFetch}={}){
  const source={provider:'BOATCAST',url:officialDeadlineUrl(date),fetched_at:null,http_status:null};
  const result={ok:false,updated:0,checked:0,reason:null,source,updated_keys:[]};
  const stop=reason=>({...result,reason});
  if(!dateValid(date)||date!==jstDate())return stop('SCHEDULE_DATE_INVALID');
  const budget=Math.min(Number.isFinite(deadlineMs)?deadlineMs:Date.now(),Date.now()+8000);
  if(budget<=Date.now())return stop('SCHEDULE_TIME_BUDGET');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(3500,budget-Date.now()));
  let payload;
  try{
    const response=await fetcher(source.url,{signal:controller.signal,redirect:'manual',headers:{Accept:'application/json'}});
    source.http_status=Number(response.status)||null;
    source.fetched_at=nowIso();
    if(response.status!==200)return stop(`SCHEDULE_HTTP_${source.http_status||0}`);
    if(response.url&&response.url!==source.url)return stop('SCHEDULE_SOURCE_INVALID');
    const declared=Number(response.headers?.get?.('content-length'));
    if(Number.isFinite(declared)&&declared>MAX_BYTES)return stop('SCHEDULE_PAYLOAD_TOO_LARGE');
    const text=await response.text();
    source.fetched_at=nowIso();
    const modified=response.headers?.get?.('last-modified');
    if(modified){
      const at=Date.parse(modified);
      if(!Number.isFinite(at))return stop('SCHEDULE_PUBLICATION_TIME_INVALID');
      source.published_at=new Date(at).toISOString();
    }
    if(text.length>MAX_BYTES)return stop('SCHEDULE_PAYLOAD_TOO_LARGE');
    try{payload=JSON.parse(text);}catch{return stop('SCHEDULE_JSON_INVALID');}
  }catch(error){
    source.fetched_at=nowIso();
    return stop(error?.name==='AbortError'?'SCHEDULE_FETCH_TIMEOUT':'SCHEDULE_FETCH_FAILED');
  }finally{clearTimeout(timer);}
  if(Date.now()>=budget)return stop('SCHEDULE_TIME_BUDGET');
  const normalized=normalizeOfficialDeadlines(payload,{date,source});
  if(!normalized.ok)return stop(normalized.reason);
  const entity=client?.asServiceRole?.entities?.Race;
  if(!entity?.filter||!entity?.updateMany)return stop('SCHEDULE_RACE_ENTITY_UNAVAILABLE');
  let rows;
  try{
    rows=await readV8Rows(entity,{race_date:date},{budget,maxPages:4,
      fields:['id','race_key','race_date','venue_code','race_number','deadline','status','updated_date','deadline_source']});
  }catch(error){return stop(httpStatus(error)?`SCHEDULE_READ_HTTP_${httpStatus(error)}`:'SCHEDULE_READ_FAILED');}
  const counts=new Map();
  for(const row of rows)for(const key of new Set([row?.race_key,raceSlot(row,date)].filter(Boolean)))counts.set(key,(counts.get(key)||0)+1);
  let issue=null;
  const candidates=[];
  for(const row of rows){
    const key=raceIdentity(row,date);
    if(!key){issue=issue||'SCHEDULE_RACE_IDENTITY_INVALID';continue;}
    if(counts.get(key)!==1){issue=issue||'SCHEDULE_RACE_IDENTITY_AMBIGUOUS';continue;}
    if(!ACTIVE.has(row.status))continue;
    const expected=normalized.deadlines.get(key);
    if(!expected)continue;
    result.checked++;
    const oldTime=utcMs(row.deadline),updated=utcMs(row.updated_date),previousSource=utcMs(row.deadline_source?.fetched_at);
    if(oldTime==null||updated!=null&&updated>Date.now()||previousSource!=null&&previousSource>utcMs(source.fetched_at)){
      issue=issue||'SCHEDULE_RACE_TIME_INVALID';continue;
    }
    if(oldTime===Date.parse(expected.deadline))continue;
    candidates.push({row,expected});
  }
  // Correct the nearest official deadlines first if this short phase runs out
  // of budget. An old deadline may already be in the past and remains eligible.
  candidates.sort((a,b)=>Date.parse(a.expected.deadline)-Date.parse(b.expected.deadline));
  const attempted=[];
  for(const {row,expected} of candidates){
    if(Date.now()>=budget-750){issue=issue||'SCHEDULE_TIME_BUDGET';break;}
    if(Date.parse(expected.deadline)<=Date.now())continue;
    const query={id:row.id,race_key:row.race_key,race_date:date,venue_code:row.venue_code,race_number:row.race_number,
      status:row.status,deadline:row.deadline,...(row.updated_date?{updated_date:row.updated_date}:{})};
    const evidence={...source,race_date:date,venue_code:expected.venue_code,race_number:expected.race_number,deadline:expected.deadline};
    attempted.push({id:row.id,...expected});
    try{
      // One conditional write stores the corrected deadline and its source.
      // Concurrent completion or deadline corrections cannot be overwritten.
      await entity.updateMany(query,{$set:{deadline:expected.deadline,deadline_source:evidence}});
    }catch(error){
      issue=issue|| (httpStatus(error)?`SCHEDULE_SAVE_HTTP_${httpStatus(error)}`:'SCHEDULE_SAVE_FAILED');
      break;
    }
  }
  if(attempted.length){
    try{
      const saved=await readV8Rows(entity,{id:{$in:attempted.map(row=>row.id)}},{budget,maxPages:3,
        fields:['id','race_key','race_date','venue_code','race_number','status','deadline','deadline_source']});
      for(const expected of attempted){
        const matches=saved.filter(row=>row.id===expected.id);
        if(matches.length!==1||raceIdentity(matches[0],date)!==expected.race_key||!ACTIVE.has(matches[0].status)
          ||matches[0].deadline!==expected.deadline||matches[0].deadline_source?.url!==source.url
          ||matches[0].deadline_source?.fetched_at!==source.fetched_at){issue=issue||'SCHEDULE_SAVE_NOT_CONFIRMED';continue;}
        result.updated++;result.updated_keys.push(expected.race_key);
      }
    }catch(error){issue=issue||(httpStatus(error)?`SCHEDULE_VERIFY_HTTP_${httpStatus(error)}`:'SCHEDULE_SAVE_NOT_CONFIRMED');}
  }
  return {...result,ok:issue==null,reason:issue};
}
