// Shared monthly official venue observations. No new scheduler or per-race HTTP.
// PROFILE records are immutable; REFRESH failures only control the next attempt.
import {readV8Rows,jstDate} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';
import {VENUE_PROFILE_REVISION,VENUE_PROFILE_PARSER_REVISION,VENUE_PROFILE_SOURCE,
  canonicalVenueCode,officialVenueProfileUrl,venueProfileSnapshotKey,venueRefreshKey,expectedVenuePeriodEnd,
  parseOfficialVenueProfile,validateVenueProfile,venueProfileContent,venueProfileHash} from './v8VenueProfileSource.js';

const RETRY_MS=24*60*60*1000;
const inFlight=new Map(),attemptCache=new Map();
const iso=at=>new Date(at).toISOString();
const empty=(status,reason)=>({status,profile:null,snapshot:null,reason});
const fallback=(found,status,reason)=>found?{status:'READY',profile:found.profile,snapshot:found.snapshot,reason}:empty(status,reason);
const active=rows=>(rows||[]).filter(row=>row.status!=='SUPERSEDED');
const currentConflict=(rows,code,expected)=>active(rows).filter(row=>row.record_type==='PROFILE'
  &&row.snapshot_key===venueProfileSnapshotKey(code,expected)).length>1;

/** One construction path for live collection and an explicitly authorized source seed. */
export async function makeVenueProfileRecord(profile,{attemptedAt=profile?.fetched_at,now=iso(Date.now())}={}){
  const code=canonicalVenueCode(profile?.venue_code),at=utcMs(now),attempted=utcMs(attemptedAt),fetched=utcMs(profile?.fetched_at);
  if(!code||at==null||attempted==null||fetched==null||attempted>fetched||fetched>at
    ||profile.content_hash!==await venueProfileHash(venueProfileContent(profile)))return null;
  const key=venueProfileSnapshotKey(code,profile.period_end);
  const validated=validateVenueProfile({...profile,snapshot_id:'UNSAVED',snapshot_key:key,available_at:profile.fetched_at},
    {venueCode:code,raceDate:jstDate(1,at),asOf:now});
  if(!validated)return null;
  // No database identity or availability time is invented before the actual write.
  const sourceProfile=JSON.parse(JSON.stringify({...venueProfileContent(validated),status:'READY',
    fetched_at:validated.fetched_at,source_hash:validated.source_hash,content_hash:validated.content_hash}));
  return {revision:VENUE_PROFILE_REVISION,parser_revision:VENUE_PROFILE_PARSER_REVISION,record_type:'PROFILE',
    status:'READY',snapshot_key:key,venue_code:code,venue_name:validated.venue_name,source:VENUE_PROFILE_SOURCE,
    source_url:validated.source_url,period_start:validated.period_start,period_end:validated.period_end,
    expected_period_end:expectedVenuePeriodEnd(attemptedAt),fetched_at:validated.fetched_at,attempted_at:iso(attempted),
    next_retry_at:null,reason:null,source_hash:validated.source_hash,content_hash:validated.content_hash,profile:sourceProfile};
}

export async function loadVenueProfiles(sr,{venueCodes=[],budget=Date.now()+8000}={}){
  const codes=[...new Set(venueCodes.map(canonicalVenueCode).filter(Boolean))],byVenueCode=new Map();
  if(!codes.length)return {status:'READY',byVenueCode,rows:[],reason:null};
  if(!sr?.V8VenueProfileSnapshot?.filter)return {status:'UNAVAILABLE',byVenueCode,rows:[],reason:'VENUE_ENTITY_UNAVAILABLE'};
  try{
    const rows=await readV8Rows(sr.V8VenueProfileSnapshot,{venue_code:{$in:codes}},{budget,maxPages:20});
    for(const row of rows){const group=byVenueCode.get(row.venue_code)||[];group.push(row);byVenueCode.set(row.venue_code,group);}
    return {status:'READY',byVenueCode,rows,reason:null};
  }catch{return {status:'READ_FAILED',byVenueCode,rows:[],reason:'VENUE_READ_FAILED'};}
}

export async function validateStoredVenueProfile(snapshot,{venueCode,asOf}={}){
  const code=canonicalVenueCode(venueCode),at=utcMs(asOf),created=utcMs(snapshot?.created_date),updated=utcMs(snapshot?.updated_date??snapshot?.created_date),fetched=utcMs(snapshot?.fetched_at);
  if(!code||at==null||!snapshot?.id||snapshot.revision!==VENUE_PROFILE_REVISION||snapshot.parser_revision!==VENUE_PROFILE_PARSER_REVISION
    ||snapshot.record_type!=='PROFILE'||snapshot.status!=='READY'||snapshot.venue_code!==code||snapshot.source!==VENUE_PROFILE_SOURCE
    ||snapshot.source_url!==officialVenueProfileUrl(code)||!snapshot.profile||created==null||updated==null||fetched==null
    ||created>updated||fetched>created||updated>at||snapshot.profile.fetched_at!==snapshot.fetched_at
    ||snapshot.profile.period_start!==snapshot.period_start||snapshot.profile.period_end!==snapshot.period_end
    ||snapshot.content_hash!==snapshot.profile.content_hash||snapshot.source_hash!==snapshot.profile.source_hash
    ||snapshot.content_hash!==await venueProfileHash(venueProfileContent(snapshot.profile)))return null;
  const profile=validateVenueProfile({...snapshot.profile,snapshot_id:snapshot.id,snapshot_key:snapshot.snapshot_key,
    available_at:iso(Math.max(created,updated,fetched))},{venueCode:code,raceDate:jstDate(1,at),asOf});
  return profile?{profile,snapshot}:null;
}

async function availableProfile(rows,code,asOf){
  const at=utcMs(asOf),groups=new Map();
  for(const row of active(rows)){
    if(row.record_type!=='PROFILE'||row.venue_code!==code||[row.created_date,row.updated_date??row.created_date,row.fetched_at].some(value=>utcMs(value)>at))continue;
    const group=groups.get(row.snapshot_key)||[];group.push(row);groups.set(row.snapshot_key,group);
  }
  const candidates=[];
  for(const group of groups.values()){
    if(group.length!==1)continue;
    const result=await validateStoredVenueProfile(group[0],{venueCode:code,asOf});if(result)candidates.push(result);
  }
  candidates.sort((a,b)=>b.profile.period_end.localeCompare(a.profile.period_end)||utcMs(b.profile.available_at)-utcMs(a.profile.available_at));
  return candidates[0]||null;
}

function refreshState(rows,key,asOf){
  const found=active(rows).filter(row=>row.snapshot_key===key&&row.record_type==='REFRESH');
  if(found.length>1)return {blocked:true,reason:'VENUE_REFRESH_CONFLICT',row:null};
  const row=found[0]||null;if(!row)return {blocked:false,row:null};
  const created=utcMs(row.created_date),updated=utcMs(row.updated_date??row.created_date),retry=utcMs(row.next_retry_at),at=utcMs(asOf);
  if(row.status!=='FAILED'||created==null||updated==null||created>updated||updated>at||retry==null)return {blocked:true,reason:'VENUE_REFRESH_INVALID',row};
  return {blocked:retry>at,reason:row.reason||'VENUE_REFRESH_PENDING',row};
}

async function fetchOfficialVenue(code,timeoutMs){
  const url=officialVenueProfileUrl(code);
  try{
    const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(Math.max(1,Math.floor(timeoutMs)))});
    if(response.status!==200)return {ok:false,reason:'VENUE_SOURCE_HTTP_'+response.status};
    if(response.url){
      const final=new URL(response.url);
      if(!['www.boatrace.jp','boatrace.jp'].includes(final.hostname)||final.pathname!=='/owpc/pc/data/stadium'||final.searchParams.get('jcd')!==code)return {ok:false,reason:'VENUE_SOURCE_REDIRECT_INVALID'};
    }
    const html=await response.text(),at=iso(Date.now());
    return parseOfficialVenueProfile(html,{venueCode:code,sourceUrl:url,fetchedAt:at,now:at});
  }catch{return {ok:false,reason:'VENUE_SOURCE_FETCH_FAILED'};}
}

export async function ensureVenueProfile(client,{venueCode,cached,now=iso(Date.now()),budget=Date.now()+6500,allowFetch=false}={}){
  const sr=client?.asServiceRole?.entities,code=canonicalVenueCode(venueCode),at=utcMs(now),expected=expectedVenuePeriodEnd(now);
  if(!code||at==null||!expected)return empty('INVALID','VENUE_REQUEST_INVALID');
  if(!sr?.V8VenueProfileSnapshot?.filter)return empty('UNAVAILABLE','VENUE_ENTITY_UNAVAILABLE');
  let rows=cached;
  if(rows===undefined){
    const loaded=await loadVenueProfiles(sr,{venueCodes:[code],budget});
    if(loaded.status!=='READY')return empty(loaded.status,loaded.reason);rows=loaded.byVenueCode.get(code)||[];
  }
  if(!Array.isArray(rows))return empty('READ_FAILED','VENUE_CACHE_INVALID');
  let found=await availableProfile(rows,code,now);
  if(currentConflict(rows,code,expected))return fallback(found,'CONFLICT','VENUE_PROFILE_CONFLICT');
  if(found?.profile.period_end===expected)return fallback(found,'MISSING',null);
  const key=venueRefreshKey(code,expected),state=refreshState(rows,key,now);
  if(state.blocked)return fallback(found,'COOLDOWN',state.reason);
  if(!allowFetch)return fallback(found,'MISSING',found?'VENUE_OLDER_PERIOD':'VENUE_SAVED_PROFILE_MISSING');
  if(Math.abs(Date.now()-at)>60000)return fallback(found,'MISSING','VENUE_LIVE_ACQUISITION_ONLY');
  if(attemptCache.get(key)?.until>Date.now())return fallback(found,'COOLDOWN',attemptCache.get(key).reason);
  if(inFlight.has(key))return inFlight.get(key);
  const acquire=(async()=>{
    const entity=sr.V8VenueProfileSnapshot;
    const read=()=>readV8Rows(entity,{venue_code:code},{budget,maxPages:8});
    try{rows=await read();}catch{return fallback(found,'READ_FAILED','VENUE_READ_FAILED');}
    found=await availableProfile(rows,code,iso(Date.now()));
    if(currentConflict(rows,code,expected))return fallback(found,'CONFLICT','VENUE_PROFILE_CONFLICT');
    if(found?.profile.period_end===expected)return fallback(found,'MISSING',null);
    let retry=refreshState(rows,key,iso(Date.now()));
    if(retry.blocked)return fallback(found,'COOLDOWN',retry.reason);
    if(retry.row&&typeof entity.updateMany!=='function')return fallback(found,'WRITE_FAILED','VENUE_CONDITIONAL_WRITE_UNAVAILABLE');
    if(budget-Date.now()<4000)return fallback(found,'BUDGET','VENUE_SOURCE_BUDGET_EXHAUSTED');
    const attempted=iso(Date.now()),source=await fetchOfficialVenue(code,Math.min(3000,budget-Date.now()-1000));
    let reason=source.ok?(source.profile.period_end===expected?null:'VENUE_SOURCE_PERIOD_NOT_CURRENT'):source.reason;
    if(Date.now()>=budget)return fallback(found,'BUDGET','VENUE_SOURCE_BUDGET_EXHAUSTED');
    try{rows=await read();}catch{return fallback(found,'READ_FAILED','VENUE_READ_FAILED');}
    if(source.ok){
      const profile=source.profile,profileKey=venueProfileSnapshotKey(code,profile.period_end);
      let matches=active(rows).filter(row=>row.snapshot_key===profileKey);
      if(matches.length>1)return fallback(found,'CONFLICT','VENUE_PROFILE_CONFLICT');
      if(!matches.length){
        if(Date.now()>=budget)return fallback(found,'BUDGET','VENUE_WRITE_BUDGET_EXHAUSTED');
        const record=await makeVenueProfileRecord(profile,{attemptedAt:attempted});
        if(!record)return fallback(found,'INVALID','VENUE_SOURCE_RECORD_INVALID');
        try{await entity.create(record);rows=await read();}catch{return fallback(found,'WRITE_FAILED','VENUE_PROFILE_WRITE_FAILED');}
        matches=active(rows).filter(row=>row.snapshot_key===profileKey);
        if(matches.length!==1)return fallback(found,'CONFLICT','VENUE_PROFILE_CONFLICT');
      }
      found=await availableProfile(rows,code,iso(Date.now()));
      if(found?.profile.period_end===expected){attemptCache.delete(key);return fallback(found,'MISSING',null);}
    }
    // An older but valid source remains usable while publication catches up.
    // The retry state is separate, so its refresh never changes a source already used by PRE.
    reason=reason||'VENUE_SOURCE_NOT_USABLE';
    attemptCache.set(key,{until:Date.now()+RETRY_MS,reason});
    if(Date.now()>=budget)return fallback(found,'BUDGET',reason);
    retry=refreshState(rows,key,iso(Date.now()));
    if(retry.blocked)return fallback(found,'COOLDOWN',retry.reason);
    const record={revision:VENUE_PROFILE_REVISION,parser_revision:VENUE_PROFILE_PARSER_REVISION,record_type:'REFRESH',status:'FAILED',
      snapshot_key:key,venue_code:code,source:VENUE_PROFILE_SOURCE,source_url:officialVenueProfileUrl(code),
      expected_period_end:expected,attempted_at:attempted,next_retry_at:iso(Date.now()+RETRY_MS),reason};
    try{
      if(retry.row){
        if(typeof entity.updateMany!=='function')return fallback(found,'WRITE_FAILED','VENUE_CONDITIONAL_WRITE_UNAVAILABLE');
        const query={id:retry.row.id,snapshot_key:key,status:'FAILED',record_type:'REFRESH'};
        if(retry.row.updated_date!=null)query.updated_date=retry.row.updated_date;
        await entity.updateMany(query,{$set:record});
      }else await entity.create(record);
      rows=await read();
      if(active(rows).filter(row=>row.snapshot_key===key).length!==1)return fallback(found,'CONFLICT','VENUE_REFRESH_CONFLICT');
    }catch{return fallback(found,'WRITE_FAILED','VENUE_REFRESH_WRITE_FAILED');}
    return fallback(found,'FAILED',reason);
  })();
  inFlight.set(key,acquire);
  try{return await acquire;}finally{inFlight.delete(key);}
}
