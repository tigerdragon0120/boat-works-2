// One durable WAKU10 observation per race and registered entrant lineup.
// READY observations are immutable. A forecast and the table read this same row.
import {fetchBoatcastText} from './boatcastClient.js';
import {readV8Rows} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';
import {RECENT_LANE_REVISION,RECENT_LANE_SOURCE,RECENT_LANE_PARSER_REVISION,RECENT_LANE_DENOMINATOR,RECENT_LANE_MAX_WINNING_RATE,
  buildRecentLaneIdentity,normalizeRecentLaneSource,normalizeRecentLaneName,recentLaneHash,recentLaneSourceUrl,
  summarizeRecentLaneHistory} from './v8RecentLaneSource.js';

const inFlight=new Map(),failedWrites=new Map();
const iso=ms=>new Date(ms).toISOString();
const empty=(status,reason,snapshot=null)=>({status,snapshot,rows:[],reason});
const bounded=(n,min,max)=>n===null||typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;

export async function loadRecentLaneSnapshots(sr,{raceIds=[],budget=Date.now()+8000}={}){
  const ids=[...new Set(raceIds.filter(id=>typeof id==='string'&&id))];
  if(!ids.length)return {status:'READY',byRaceId:new Map(),rows:[],reason:null};
  if(!sr?.V8RecentLaneSnapshot?.filter)return {status:'UNAVAILABLE',byRaceId:new Map(),rows:[],reason:'SNAPSHOT_ENTITY_UNAVAILABLE'};
  try{
    const rows=await readV8Rows(sr.V8RecentLaneSnapshot,{race_id:{$in:ids}},{budget,maxPages:20});
    const byRaceId=new Map();
    for(const row of rows){const group=byRaceId.get(row.race_id)||[];group.push(row);byRaceId.set(row.race_id,group);}
    return {status:'READY',byRaceId,rows,reason:null};
  }catch{return {status:'READ_FAILED',byRaceId:new Map(),rows:[],reason:'SNAPSHOT_READ_FAILED'};}
}

export async function validateRecentLaneSnapshot(snapshot,{race,entries,now,identity=null}={}){
  const verified=identity||await buildRecentLaneIdentity(race,entries,now);
  if(!verified.ok)return empty('INVALID',verified.reason);
  const at=utcMs(now),created=utcMs(snapshot?.created_date),updated=utcMs(snapshot?.updated_date??snapshot?.created_date),fetched=utcMs(snapshot?.fetched_at);
  if(!snapshot?.id||snapshot.revision!==RECENT_LANE_REVISION||snapshot.source!==RECENT_LANE_SOURCE||snapshot.status!=='READY'
    ||snapshot.snapshot_key!==verified.snapshot_key||snapshot.entrant_signature!==verified.entrant_signature
    ||snapshot.race_id!==race.id||snapshot.race_key!==race.race_key||snapshot.race_date!==race.race_date
    ||String(snapshot.venue_code).padStart(2,'0')!==String(race.venue_code).padStart(2,'0')||Number(snapshot.race_number)!==Number(race.race_number)
    ||snapshot.source_url!==recentLaneSourceUrl(race)||snapshot.parser_revision!==RECENT_LANE_PARSER_REVISION
    ||snapshot.denominator_rule!==RECENT_LANE_DENOMINATOR||created==null||updated==null||fetched==null||updated<created
    ||fetched>updated||created>at||updated>at||fetched>at)return empty('INVALID','SNAPSHOT_IDENTITY_OR_TIME_INVALID',snapshot);
  if(!Array.isArray(snapshot.racers)||snapshot.racers.length!==6||new Set(snapshot.racers.map(row=>row?.boat_number)).size!==6)return empty('INVALID','SNAPSHOT_RACERS_INVALID',snapshot);
  if(snapshot.content_hash!==await recentLaneHash(snapshot.racers))return empty('INVALID','SNAPSHOT_CONTENT_HASH_INVALID',snapshot);
  const available=iso(Math.max(fetched,created,updated)),rows=[];
  for(const racer of snapshot.racers){
    const entry=verified.entry_identity.find(row=>row.boat_number===racer.boat_number);
    const summary=summarizeRecentLaneHistory(racer.history),{row_hash,...raw}=racer;
    if(!entry||racer.revision!==RECENT_LANE_REVISION||racer.source!==RECENT_LANE_SOURCE||racer.status!=='READY'
      ||racer.race_id!==race.id||racer.race_key!==race.race_key||racer.registration_number!==entry.registration_number
      ||racer.identity_status!=='MATCHED_NAME_AND_ENTRY'||!entry.aliases.includes(normalizeRecentLaneName(racer.source_name))
      ||racer.denominator_rule!==RECENT_LANE_DENOMINATOR||!summary.ok||row_hash!==await recentLaneHash(raw)
      ||!bounded(racer.winning_rate,0,RECENT_LANE_MAX_WINNING_RATE)||!bounded(racer.avg_st,0,1)||!bounded(racer.avg_start_order,1,6)
      ||racer.history.some(row=>row.course!==null&&(!Number.isInteger(row.course)||row.course<1||row.course>6)||typeof row.course_inferred!=='boolean'))return empty('INVALID','SNAPSHOT_RACER_INVALID',snapshot);
    for(const key of ['sample_size','normal_sample_size','special_count','absent_count','first_rate','second_rate','third_rate','top2_rate','top3_rate'])
      if(racer[key]!==summary[key])return empty('INVALID','SNAPSHOT_DENOMINATOR_INVALID',snapshot);
    rows.push({...structuredClone(racer),snapshot_id:snapshot.id,snapshot_key:snapshot.snapshot_key,
      source_url:snapshot.source_url,fetched_at:snapshot.fetched_at,available_at:available});
  }
  return {status:'READY',snapshot,rows,reason:null};
}

function selectSnapshot(rows,key){
  // Administrative retirement keeps the original payload and forecast references intact.
  // Only active observations compete; normal acquisition never retires or edits one.
  const matches=(rows||[]).filter(row=>row.snapshot_key===key&&row.status!=='SUPERSEDED');
  return matches.length>1?{duplicate:true,row:null}:{duplicate:false,row:matches[0]||null};
}

async function existingResult(selected,context){
  if(selected.duplicate)return empty('CONFLICT','SNAPSHOT_DUPLICATE');
  const row=selected.row;
  if(!row)return null;
  if(row.status==='READY')return validateRecentLaneSnapshot(row,context);
  if(row.status!=='FAILED'||row.revision!==RECENT_LANE_REVISION||row.source!==RECENT_LANE_SOURCE
    ||row.entrant_signature!==context.identity.entrant_signature||row.race_id!==context.race.id)return empty('INVALID','SNAPSHOT_STATE_INVALID',row);
  const available=utcMs(row.updated_date??row.created_date),retry=utcMs(row.next_retry_at),at=utcMs(context.now);
  if(available==null||available>at||retry==null)return empty('INVALID','SNAPSHOT_FAILURE_TIME_INVALID',row);
  return retry>at?empty('COOLDOWN',row.reason||'SOURCE_RETRY_PENDING',row):null;
}

export async function ensureRecentLaneSnapshot(client,{race,entries,cached,now=new Date().toISOString(),budget=Date.now()+8000,allowFetch=false}={}){
  const sr=client?.asServiceRole?.entities;
  if(!sr?.V8RecentLaneSnapshot?.filter)return empty('UNAVAILABLE','SNAPSHOT_ENTITY_UNAVAILABLE');
  const identity=await buildRecentLaneIdentity(race,entries,now);
  if(!identity.ok)return empty('INVALID',identity.reason);
  let rows=cached;
  if(rows===undefined){
    const loaded=await loadRecentLaneSnapshots(sr,{raceIds:[race.id],budget});
    if(loaded.status!=='READY')return empty(loaded.status,loaded.reason);
    rows=loaded.byRaceId.get(race.id)||[];
  }
  if(!Array.isArray(rows))return empty('READ_FAILED','SNAPSHOT_CACHE_INVALID');
  const context={race,entries,now,identity};
  const existing=await existingResult(selectSnapshot(rows,identity.snapshot_key),context);
  if(existing)return existing;
  if(!allowFetch)return empty('MISSING','SAVED_SNAPSHOT_MISSING');
  // New source acquisition is live-only; historical consumers must read a saved observation.
  if(Math.abs(Date.now()-utcMs(now))>60000)return empty('MISSING','LIVE_ACQUISITION_ONLY');
  if(failedWrites.get(identity.snapshot_key)>Date.now())return empty('COOLDOWN','SNAPSHOT_WRITE_RETRY_PENDING');
  if(inFlight.has(identity.snapshot_key))return inFlight.get(identity.snapshot_key);
  const acquire=(async()=>{
    const entity=sr.V8RecentLaneSnapshot;
    const readCurrent=async()=>selectSnapshot(await readV8Rows(entity,{snapshot_key:identity.snapshot_key},{budget,maxPages:2}),identity.snapshot_key);
    let selected;
    try{selected=await readCurrent();}catch{return empty('READ_FAILED','SNAPSHOT_READ_FAILED');}
    const current=await existingResult(selected,{...context,now:iso(Date.now())});
    if(current)return current;
    if(selected.row&&typeof entity.updateMany!=='function')return empty('WRITE_FAILED','SNAPSHOT_CONDITIONAL_WRITE_UNAVAILABLE',selected.row);
    if(budget-Date.now()<4000)return empty('BUDGET','SOURCE_BUDGET_EXHAUSTED');
    const attempted=iso(Date.now());
    // Abort the actual HTTP operation. No background Promise.race fetch/retry or per-racer request.
    let source;
    try{source=await fetchBoatcastText({venueCode:String(race.venue_code).padStart(2,'0'),raceDate:race.race_date,
      raceNumber:Number(race.race_number),dataType:'WAKU10',timeoutMs:Math.min(3000,budget-Date.now()-1000),maxRetries:0});}
    catch{source={ok:false,status:null};}
    const observed=iso(Date.now());
    const normalized=source?.ok?await normalizeRecentLaneSource({text:source.text,metadata:source.metadata,race,entries,identity,now:observed}):null;
    const success=normalized?.ok===true;
    const reason=success?null:normalized?.reason||(source?.status===404?'SOURCE_NOT_PUBLISHED':'SOURCE_FETCH_FAILED');
    const delay=source?.status===404||normalized&&!normalized.ok?30*60*1000:5*60*1000;
    const record={revision:RECENT_LANE_REVISION,snapshot_key:identity.snapshot_key,race_id:race.id,race_key:race.race_key,
      race_date:race.race_date,venue_code:String(race.venue_code).padStart(2,'0'),race_number:Number(race.race_number),
      entrant_signature:identity.entrant_signature,entry_identity:identity.entry_identity,source:RECENT_LANE_SOURCE,
      status:success?'READY':'FAILED',source_url:recentLaneSourceUrl(race),fetched_at:success?normalized.fetched_at:null,
      attempted_at:attempted,next_retry_at:success?null:iso(Date.now()+delay),reason,
      parser_revision:RECENT_LANE_PARSER_REVISION,content_hash:success?normalized.content_hash:null,
      racers:success?normalized.racers:[],denominator_rule:RECENT_LANE_DENOMINATOR};
    if(Date.now()>=budget)return empty('BUDGET','SOURCE_BUDGET_EXHAUSTED');
    // A simultaneous table/capture request may have completed while the source was fetched.
    // Never overwrite a READY observation; ambiguous duplicate keys fail closed.
    try{selected=await readCurrent();}catch{return empty('READ_FAILED','SNAPSHOT_READ_FAILED');}
    const completed=await existingResult(selected,{...context,now:iso(Date.now())});
    if(completed&&completed.status!=='COOLDOWN')return completed;
    if(Date.now()>=budget)return empty('BUDGET','SNAPSHOT_WRITE_BUDGET_EXHAUSTED');
    let saved;
    try{
      // Writes are always awaited, including when the cooperative budget expires in flight.
      if(selected.row){
        // This conditional mutation cannot overwrite a row another isolate made READY
        // between our last read and this write. Never fall back to an unconditional update.
        if(typeof entity.updateMany!=='function')return empty('WRITE_FAILED','SNAPSHOT_CONDITIONAL_WRITE_UNAVAILABLE',selected.row);
        const condition={id:selected.row.id,snapshot_key:identity.snapshot_key,status:'FAILED'};
        if(selected.row.updated_date!=null)condition.updated_date=selected.row.updated_date;
        await entity.updateMany(condition,{$set:record});
      }else{
        await entity.create(record);
      }
      // Even a successful create can race another isolate. Hold duplicate logical keys
      // instead of appending further attempts or exposing one arbitrarily selected row.
      const reread=await readCurrent();
      if(reread.duplicate||!reread.row)return empty('CONFLICT','SNAPSHOT_SAVE_UNCONFIRMED');
      saved=reread.row;
    }catch{failedWrites.set(identity.snapshot_key,Date.now()+5*60*1000);return empty('WRITE_FAILED','SNAPSHOT_WRITE_FAILED');}
    failedWrites.delete(identity.snapshot_key);
    if(saved.status!=='READY')return empty('FAILED',saved.reason||reason||'SOURCE_RETRY_PENDING',saved);
    // New observations use the real completion time; the caller generates its forecast afterward.
    return validateRecentLaneSnapshot(saved,{...context,now:iso(Date.now())});
  })();
  inFlight.set(identity.snapshot_key,acquire);
  try{return await acquire;}finally{inFlight.delete(identity.snapshot_key);}
}

export function recentLaneSnapshotResponse(result){
  const ready=result.status==='READY',rows=ready?result.rows:[],snapshot=result.snapshot;
  return {ok:ready,status:result.status,reason:result.reason||null,snapshot:ready?snapshot:null,rows,
    // Compatibility payload is derived from the same saved rows, never fetched separately.
    racers:rows.map(row=>({lane:row.boat_number,name:row.source_name,registration_number:row.registration_number,
      winRate:row.winning_rate,avgSt:row.avg_st,stRank:row.avg_start_order,
      past10:row.history.map(item=>({finish:item.finish_order==null?item.finish_status:String(item.finish_order),
        course:item.course,code:item.code,course_inferred:item.course_inferred}))})),
    metadata:{source:RECENT_LANE_SOURCE,source_url:snapshot?.source_url||null,
      fetched_at:snapshot?.fetched_at||null,available_at:rows[0]?.available_at||null,
      snapshot_id:ready?snapshot.id:null,snapshot_key:snapshot?.snapshot_key||null,cache:ready?'SAVED':'MISSING',
      next_retry_at:snapshot?.next_retry_at||null}};
}
