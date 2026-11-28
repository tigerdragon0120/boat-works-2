// Build result work only after both ledgers have been read completely. A closed
// clock is collection eligibility; only a valid official result can repair status.
import {dateValid,jstDate,readV8Rows} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';
import {resolveOfficialResults} from './resultEvidenceRules.js';

const ACTIVE_OR_FINISHED=new Set(['scheduled','pre','final','finished']);
const DISRUPTED=new Set(['CANCELLED','POSTPONED']);
const MIN_RESULT_DELAY_MS=5*60000;
const RECENT_WINDOW_MS=60*60000;
const PRIORITY_INTERVAL_MS=5*60000;
const RACE_FIELDS=['id','race_key','race_date','venue_code','venue_name','venue','race_number','deadline','status',
  'schedule_status','schedule_reason','updated_date'];
const RESULT_FIELDS=['id','race_id','race_key','source','result_trifecta','payout','is_finished','result_status','finished_at','updated_date'];
const positivePayout=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>0;
const finalResult=row=>row?.result_status==='RESULT_FINAL'||row?.result_status==null&&row?.is_finished===true;

function slotKey(row,raceDate){
  if(!row||row.race_date!==raceDate||typeof row.venue_code!=='string'||!/^(?:0[1-9]|1\d|2[0-4])$/.test(row.venue_code)
    ||!Number.isInteger(row.race_number)||row.race_number<1||row.race_number>12)return null;
  return `${raceDate}_${row.venue_code}_${String(row.race_number).padStart(2,'0')}`;
}

function orderedCandidates(rows,now){
  const byRecent=(a,b)=>utcMs(b.deadline)-utcMs(a.deadline)||a.race_key.localeCompare(b.race_key);
  const recent=rows.filter(row=>utcMs(row.deadline)>=now-RECENT_WINDOW_MS).sort(byRecent);
  const older=rows.filter(row=>utcMs(row.deadline)<now-RECENT_WINDOW_MS).sort(byRecent);
  if(!older.length)return {candidates:recent,priority_mode:'RECENT_ONLY'};
  const interval=Math.floor(now/PRIORITY_INTERVAL_MS),offset=Math.floor(interval/3)%older.length;
  const backlog=[...older.slice(offset),...older.slice(0,offset)];
  if(!recent.length)return {candidates:backlog,priority_mode:'BACKLOG_ONLY'};
  // Two intervals favor newly finished races. One interval rotates an older
  // missing result to the front, so repeated source failures cannot starve it.
  if(interval%3===2)return {candidates:[backlog[0],...recent,...backlog.slice(1)],priority_mode:'BACKLOG_TURN'};
  return {candidates:[...recent,...backlog],priority_mode:'RECENT_FIRST'};
}

export function planResultCollection(races,results,{raceDate,now=Date.now()}={}){
  if(!Number.isFinite(now)||!dateValid(raceDate)||raceDate>jstDate(0,now))throw new Error('RESULT_COLLECTION_DATE_INVALID');
  if(!Array.isArray(races)||!Array.isArray(results))throw new Error('RESULT_COLLECTION_SNAPSHOT_INVALID');
  const summary={races:[],total:races.length,candidates:[],status_repairs:[],skipped:0,cancelled:0,not_due:0,held:[],
    read_counts:{races:races.length,results:results.length},priority_mode:'RECENT_ONLY'};
  const ids=new Map(),keys=new Map(),byRace=new Map();
  for(const race of races){
    if(typeof race?.id==='string'&&race.id)ids.set(race.id,(ids.get(race.id)||0)+1);
    for(const key of new Set([race?.race_key,slotKey(race,raceDate)].filter(Boolean)))keys.set(key,(keys.get(key)||0)+1);
  }
  for(const result of results){
    if(!result?.id||typeof result.race_id!=='string'||!ids.has(result.race_id))throw new Error('RESULT_COLLECTION_RESULT_IDENTITY_INVALID');
    const group=byRace.get(result.race_id)||[];group.push(result);byRace.set(result.race_id,group);
  }
  const hold=(race,reason)=>summary.held.push({race_id:race?.id||null,race_key:race?.race_key||null,reason});
  for(const race of races){
    const key=slotKey(race,raceDate);
    if(typeof race?.id!=='string'||!race.id||!key||race.race_key!==key){hold(race,'RACE_IDENTITY_INVALID');continue;}
    if(ids.get(race.id)!==1||keys.get(key)!==1){hold(race,'RACE_IDENTITY_AMBIGUOUS');continue;}
    summary.races.push(race);
    if(race.status==='cancelled'||DISRUPTED.has(race.schedule_status)){summary.cancelled++;continue;}
    if(!ACTIVE_OR_FINISHED.has(race.status)){hold(race,'RACE_STATUS_INVALID');continue;}
    const deadline=utcMs(race.deadline);
    if(typeof race.deadline!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(race.deadline)
      ||deadline==null||jstDate(0,deadline)!==raceDate){hold(race,'RACE_DEADLINE_INVALID');continue;}
    if(now<deadline+MIN_RESULT_DELAY_MS){summary.not_due++;continue;}
    const resultRows=byRace.get(race.id)||[];
    if(resultRows.some(row=>row.race_key!=null&&row.race_key!==race.race_key)){hold(race,'RESULT_IDENTITY_MISMATCH');continue;}
    const resolved=resolveOfficialResults(resultRows,{raceId:race.id,complete:true});
    if(resolved.status==='conflict'||resolved.status==='incomplete'){hold(race,resolved.hold_reason);continue;}
    if(resolved.status==='ready'){
      // Older collectors marked an RS1-only result FINAL with payout=0. Keep
      // these races eligible for a later real payout; do not erase that record.
      const result=resultRows.find(row=>finalResult(row)&&positivePayout(row.payout));
      if(result){
        if(race.status==='finished')summary.skipped++;
        else summary.status_repairs.push({race,result});
        continue;
      }
    }
    summary.candidates.push(race);
  }
  return {...summary,...orderedCandidates(summary.candidates,now)};
}

export async function readResultCollectionPlan(client,{raceDate,deadlineMs=Date.now()+15000,now=Date.now()}={}){
  if(!Number.isFinite(now)||!dateValid(raceDate)||raceDate>jstDate(0,now))throw new Error('RESULT_COLLECTION_DATE_INVALID');
  if(!Number.isFinite(deadlineMs)||deadlineMs<=Date.now())throw new Error('RESULT_COLLECTION_TIME_BUDGET');
  const sr=client?.asServiceRole?.entities;
  if(!sr?.Race?.filter||!sr?.RaceResult?.filter)throw new Error('RESULT_COLLECTION_ENTITY_UNAVAILABLE');
  const races=await readV8Rows(sr.Race,{race_date:raceDate},{budget:deadlineMs,maxPages:4,sort:'deadline',fields:RACE_FIELDS});
  const results=races.length?await readV8Rows(sr.RaceResult,{race_id:{$in:races.map(row=>row.id)}},
    {budget:deadlineMs,maxPages:4,sort:'-finished_at',fields:RESULT_FIELDS}):[];
  // readV8Rows throws on partial pages, timeouts or malformed responses. They
  // must not be reinterpreted as a successful zero-result collection.
  return planResultCollection(races,results,{raceDate,now});
}
