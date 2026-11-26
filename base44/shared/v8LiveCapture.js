// Scheduled immutable DAY_BEFORE -> PRE -> FINAL forecast collection.
import {acquireLock,releaseLock} from './concurrencyLock.js';
import {selectV7RaceEntries} from './v7RaceEntrySelector.js';
import {utcMs} from './v7FeatureObservation.js';
import {buildRaceForecast,FORECAST_REVISION} from './v8ForecastEngine.js';
import {jstDate,readV8Rows,groupBy,chronological,canonicalForecasts} from './v8Repository.js';
import {loadLatestRacerDataset} from './latestRacerStore.js';
import {enrichLatestRacerEntries} from './latestRacerEvidence.js';
import {loadRacerFrameTendencies,emptyFrameTendencies} from './v8RacerTendencies.js';
import {loadRecentLaneSnapshots,ensureRecentLaneSnapshot} from './v8RecentLaneStore.js';
import {loadVenueProfiles,ensureVenueProfile} from './v8VenueStore.js';

const hasExhibition=(entries)=>entries.some(e=>['exhibition_time','exhibition_st','exhibition_course'].some(k=>e[k]!=null&&e[k]!==''));
// Leave room in the shared service-token read quota for exhibition and result collectors.
const MAX_FORECASTS_PER_RUN=24;
// A revision change must not discard the valid, source-rich PRE collected by
// the previous compatible selection policy in favor of an older legacy day.
const compatiblePreviousBaseline=row=>{
  const plan=row.final_selection;
  if(row.revision!=='V8_FORECAST_6_FINAL_SELECTION'||row.record_mode==='REPLAY'||!['DAY_BEFORE','PRE'].includes(row.stage)
    ||plan?.revision!=='V8_FINAL_SELECTION_1'||plan.policy_revision!=='V8_RULE_BUY_1'||plan.stage!==row.stage
    ||!Array.isArray(plan.tickets)||plan.tickets.length<6||plan.tickets.length>12||plan.ticket_count!==plan.tickets.length
    ||new Set(plan.tickets).size!==plan.tickets.length
    ||!plan.tickets.every(ticket=>typeof ticket==='string'&&/^[1-6]-[1-6]-[1-6]$/.test(ticket)&&new Set(ticket.split('-')).size===3)
    ||!Array.isArray(plan.ranked_tickets)||plan.ranked_tickets.length!==plan.tickets.length
    ||!plan.ranked_tickets.every((ticket,index)=>ticket?.rank===index+1&&ticket.ticket===plan.tickets[index]&&Number.isFinite(ticket.score)))return false;
  const heads=[...new Set(plan.tickets.map(ticket=>Number(ticket[0])))];
  return Array.isArray(plan.head_boats)&&plan.head_boats.length===heads.length
    &&new Set(plan.head_boats).size===heads.length&&heads.every(head=>plan.head_boats.includes(head));
};
export const selectCaptureBaseline=records=>{
  const current=records.filter(row=>row.revision===FORECAST_REVISION);
  const compatible=records.filter(compatiblePreviousBaseline);
  const firstStage=(rows,stage)=>rows.filter(row=>row.stage===stage).sort(chronological)[0];
  const latestStage=(rows,stage)=>rows.filter(row=>row.stage===stage).sort(chronological).at(-1);
  const preferSources=rows=>{
    const withBoth=rows.filter(row=>!!row.provenance?.recent_lane_snapshot_id&&!!row.provenance?.venue_snapshot_id);
    const withRecent=rows.filter(row=>!!row.provenance?.recent_lane_snapshot_id);
    const withVenue=rows.filter(row=>!!row.provenance?.venue_snapshot_id);
    return latestStage(withBoth,'DAY_BEFORE')||latestStage(withBoth,'PRE')
      ||latestStage(withRecent,'DAY_BEFORE')||latestStage(withRecent,'PRE')
      ||latestStage(withVenue,'DAY_BEFORE')||latestStage(withVenue,'PRE')
      ||firstStage(rows,'DAY_BEFORE')||firstStage(rows,'PRE');
  };
  return preferSources(current)||preferSources(compatible)
    ||firstStage(records,'DAY_BEFORE')||firstStage(records,'PRE')||null;
};
// A cooperative deadline stops new work; an in-flight database write is always awaited.
// Retrying appends only missing immutable keys, using the same standalone lock.
export async function runV8LiveCapture(client,options={}){
  const sr=client.asServiceRole.entities,started=Date.now(),today=jstDate(),tomorrow=jstDate(1);
  const raceKeys=Array.isArray(options.race_keys)?[...new Set(options.race_keys.filter(k=>typeof k==='string'&&/^\d{4}-\d{2}-\d{2}_\d{2}_\d{2}$/.test(k)))]:null;
  if(raceKeys&&raceKeys.length===0)return {ok:false,error:'INVALID_RACE_KEYS',created:0};
  const scope={race_date:{$in:[today,tomorrow]},...(raceKeys?{race_key:{$in:raceKeys}}:{})};
  const requestedBudget=Number.isFinite(options.timeBudgetMs)?Math.max(0,options.timeBudgetMs):80000;
  const deadlineMs=Math.min(started+requestedBudget,Number.isFinite(options.deadlineMs)?options.deadlineMs:Infinity);
  const phaseBudget=milliseconds=>Math.min(deadlineMs,Date.now()+milliseconds);
  const expired=()=>Date.now()>=deadlineMs;
  const summary={ok:true,revision:FORECAST_REVISION,today,tomorrow,races:0,created:0,day_before:0,pre:0,final:0,buys:0,held:0,existing:0,errors:0,reasons:{}};
  const hold=(reason)=>{summary.held++;summary.reasons[reason]=(summary.reasons[reason]||0)+1;};
  const finish=()=>({...summary,completed_at:new Date().toISOString(),duration_ms:Date.now()-started});
  const stopForBudget=()=>{summary.partial=true;summary.reasons.TIME_BUDGET=(summary.reasons.TIME_BUDGET||0)+1;};
  let lock=null;
  try{
    if(expired()){stopForBudget();return finish();}
    lock=await acquireLock(client,'V8_FORECAST_CAPTURE','v8CaptureForecasts',120000);
    if(!lock)return {...finish(),skipped:'locked'};
    if(expired()){stopForBudget();return finish();}
    const budget=phaseBudget(30000);
    const [races,prior,racerDatasetRead,frameTendencies]=await Promise.all([
      readV8Rows(sr.Race,scope,{budget,maxPages:8}),
      readV8Rows(sr.V8RaceForecast,scope,{budget,maxPages:40}),
      loadLatestRacerDataset(sr,{budget:phaseBudget(15000)})
        .then(dataset=>({dataset,status:dataset?'READY':'ABSENT'}))
        .catch(error=>{console.warn('[V8_RACER_TERM] optional dataset unavailable',String(error?.message||error).slice(0,120));return {dataset:null,status:'READ_FAILED'};}),
      loadRacerFrameTendencies(sr,{asOf:new Date(started).toISOString(),budget:phaseBudget(10000)})
    ]);
    summary.racer_frames=frameTendencies.summary;
    summary.racer_term={status:racerDatasetRead.status,dataset_key:racerDatasetRead.dataset?.metadata?.dataset_key||null,
      term_key:racerDatasetRead.dataset?.metadata?.term_key||null,enriched_forecasts:0,skipped:{}};
    if(expired()){stopForBudget();return finish();}
    const uniqueRaces=[...groupBy(races,'race_key').values()].filter(group=>group.length===1).map(g=>g[0]);
    summary.races=uniqueRaces.length;
    summary.duplicate_race_keys=groupBy(races,'race_key').size-uniqueRaces.length;
    const canonical=canonicalForecasts(prior),byRace=groupBy(canonical.rows,'race_id'),saved=new Set(prior.map(p=>p.forecast_key));
    summary.ambiguous_forecast_keys=canonical.conflicts.length;
    const active=uniqueRaces.filter(r=>!['finished','cancelled'].includes(r.status)&&utcMs(r.deadline)>Date.now()+90000);
    // First cover today's closing races; then fill all remaining pre-race plans and tomorrow.
    active.sort((a,b)=>Number(a.race_date!==today)-Number(b.race_date!==today)||utcMs(a.deadline)-utcMs(b.deadline));
    const todo=active;
    const [entryRows,recentLaneRead,venueRead]=todo.length?await Promise.all([
      readV8Rows(sr.RaceEntry,{race_id:{$in:todo.map(r=>r.id)}},{budget:phaseBudget(25000),maxPages:25}),
      loadRecentLaneSnapshots(sr,{raceIds:todo.map(r=>r.id),budget:phaseBudget(10000)}),
      loadVenueProfiles(sr,{venueCodes:[...new Set(todo.map(r=>String(r.venue_code).padStart(2,'0')))],budget:phaseBudget(10000)})
    ]):[[],{status:'READY',byRaceId:new Map()},{status:'READY',byVenueCode:new Map()}];
    summary.recent_lane={read_status:recentLaneRead.status,ready:0,unavailable:0};
    summary.venue_profiles={read_status:venueRead.status,ready:0,unavailable:0};
    const venueResults=new Map();
    const entriesByRace=groupBy(entryRows,'race_id');
    for(const race of todo){
      if(summary.created>=MAX_FORECASTS_PER_RUN){summary.partial=true;break;}
      if(expired()){stopForBudget();break;}
      if(utcMs(race.deadline)<=Date.now()+90000){hold('CUTOFF');continue;}
      const selected=selectV7RaceEntries(entriesByRace.get(race.id)||[],race);
      if(selected.reason){hold(selected.reason);continue;}
      const entries=selected.entries;
      const isFinal=race.race_date===today&&(race.exhibition_ready===true||hasExhibition(entries));
      const stage=race.race_date===tomorrow?'DAY_BEFORE':isFinal?'FINAL':'PRE';
      const records=byRace.get(race.id)||[];
      // The shared source is acquired once per race identity. A prior forecast
      // without WAKU10 can be supplemented when the source becomes available.
      let recentLane={status:recentLaneRead.status,snapshot:null,rows:[],reason:'SOURCE_READ_UNAVAILABLE'};
      if(recentLaneRead.status==='READY'){
        try{
          recentLane=await ensureRecentLaneSnapshot(client,{race,entries,
            cached:recentLaneRead.byRaceId.get(race.id)||[],now:new Date().toISOString(),
            budget:phaseBudget(6000),allowFetch:true});
          if(recentLane.snapshot?.id){
            const cached=recentLaneRead.byRaceId.get(race.id)||[];
            recentLaneRead.byRaceId.set(race.id,[recentLane.snapshot,...cached.filter(row=>row.id!==recentLane.snapshot.id)]);
          }
        }catch(error){
          console.warn('[V8_WAKU10] optional source unavailable',String(error?.message||error).slice(0,120));
          recentLane={status:'READ_FAILED',snapshot:null,rows:[],reason:'SOURCE_READ_FAILED'};
        }
      }
      const recentSnapshotId=recentLane.status==='READY'?recentLane.snapshot?.id||null:null;
      summary.recent_lane[recentSnapshotId?'ready':'unavailable']++;
      const venueCode=String(race.venue_code).padStart(2,'0');
      if(!venueResults.has(venueCode)){
        let venueResult={status:venueRead.status,profile:null,snapshot:null,reason:'VENUE_READ_UNAVAILABLE'};
        if(venueRead.status==='READY'){
          try{
            venueResult=await ensureVenueProfile(client,{venueCode,cached:venueRead.byVenueCode.get(venueCode)||[],
              now:new Date().toISOString(),budget:phaseBudget(6500),allowFetch:true});
          }catch(error){
            console.warn('[V8_VENUE] optional source unavailable',String(error?.message||error).slice(0,120));
            venueResult={status:'READ_FAILED',profile:null,snapshot:null,reason:'VENUE_READ_FAILED'};
          }
        }
        // Every race at one venue shares this source read/acquisition for the run.
        venueResults.set(venueCode,venueResult);
        summary.venue_profiles[venueResult.status==='READY'?'ready':'unavailable']++;
      }
      const venueResult=venueResults.get(venueCode);
      const venueProfile=venueResult.status==='READY'?venueResult.profile:null;
      const venueSnapshotId=venueProfile?.snapshot_id||null;
      if(expired()){stopForBudget();break;}
      const sameRecentSource=record=>!!record?.provenance&&Object.hasOwn(record.provenance,'recent_lane_snapshot_id')
        &&record.provenance.recent_lane_snapshot_id===recentSnapshotId;
      const priorStage=records.filter(row=>row.revision===FORECAST_REVISION&&row.stage===stage).sort(chronological).at(-1);
      const sameVenueSource=record=>!!record?.provenance&&Object.hasOwn(record.provenance,'venue_read_snapshot_id')
        &&record.provenance.venue_read_snapshot_id===venueSnapshotId;
      // Append a separately saved PRE when a missing source arrives; never replace
      // a rich PRE with a poorer one during a temporary source outage.
      const sourceLost=!!priorStage&&(!recentSnapshotId&&!!priorStage.provenance?.recent_lane_snapshot_id
        ||!venueSnapshotId&&!!priorStage.provenance?.venue_snapshot_id);
      if(stage!=='FINAL'&&(sameRecentSource(priorStage)&&sameVenueSource(priorStage)||sourceLost)){
        summary.existing++;continue;
      }
      const lastFinal=records.filter(r=>r.stage==='FINAL').sort(chronological).at(-1);
      const lastFinalAt=utcMs(lastFinal?.generated_at);
      const lastFinalComplete=lastFinal?.revision===FORECAST_REVISION&&lastFinal?.quality==='CAPTURED'&&lastFinal.exhibition_complete===true
        &&Array.isArray(lastFinal.research_tickets)&&lastFinal.research_tickets.length===8;
      const unchangedInputs=[race,...entries].every(row=>{
        const at=utcMs(row.updated_date||row.created_date);
        return at!=null&&lastFinalAt!=null&&at<=lastFinalAt;
      });
      // Throttle only complete, unchanged forecasts. Exhibition corrections and
      // newly completed inputs must reach the existing source-time/cutoff checks now.
      if(stage==='FINAL'&&lastFinalComplete&&unchangedInputs&&sameRecentSource(lastFinal)&&sameVenueSource(lastFinal)&&Date.now()-lastFinalAt<180000){summary.existing++;continue;}
      try{
        const fresh=await sr.Race.get(race.id);
        if(!fresh||fresh.race_key!==race.race_key||['finished','cancelled'].includes(fresh.status)||utcMs(fresh.deadline)<=Date.now()+90000){hold('RACE_CHANGED_OR_CLOSED');continue;}
        const results=await readV8Rows(sr.RaceResult,{race_id:race.id},{budget:phaseBudget(8000),maxPages:2});
        if(expired()){stopForBudget();break;}
        if(results.some(r=>r.is_finished||r.result_status==='RESULT_FINAL')){hold('RESULT_ALREADY_AVAILABLE');continue;}
        let odds=null,weather=null;
        if(stage==='FINAL'){
          const readBudget=phaseBudget(15000);
          const [quotes,weathers]=await Promise.all([
            readV8Rows(sr.OddsSnapshot,{race_id:race.id},{budget:readBudget,maxPages:3,sort:'-captured_at'}),
            readV8Rows(sr.V7WeatherObservation,{race_id:race.id,kind:'PRE_REFERENCE'},{budget:readBudget,maxPages:2})
          ]);
          const eligibleQuotes=quotes.filter(q=>utcMs(q.captured_at)!=null&&utcMs(q.created_date)!=null&&utcMs(q.captured_at)<=Date.now()&&utcMs(q.created_date)<=Date.now()).sort((a,b)=>utcMs(b.captured_at)-utcMs(a.captured_at));
          odds=eligibleQuotes[0]||null;
          weather=weathers.filter(w=>utcMs(w.observed_at)<=Date.now()&&utcMs(w.observed_at)<utcMs(fresh.deadline)-60000).sort((a,b)=>utcMs(b.observed_at)-utcMs(a.observed_at))[0]||null;
        }
        if(expired()){stopForBudget();break;}
        const baseline=selectCaptureBaseline(records);
        const generatedAt=new Date().toISOString();
        const racerEvidence=enrichLatestRacerEntries({race:fresh,entries,stage,asOf:generatedAt,dataset:racerDatasetRead.dataset});
        for(const entry of racerEvidence.entries){
          const registration=String(entry.registration_number??entry.register_number??'').trim();
          const recentRows=(recentLane.rows||[]).filter(row=>row.registration_number===registration&&row.boat_number===Number(entry.boat_number));
          if(recentRows.length===1)entry.v8_recent_lane=structuredClone(recentRows[0]);
          else delete entry.v8_recent_lane;
          entry.v8_frame_tendencies={registration_number:registration,...structuredClone(frameTendencies.profiles.get(registration)
            ||emptyFrameTendencies({asOf:frameTendencies.summary.as_of,
              status:frameTendencies.summary.status==='READY'?'NO_DATA':frameTendencies.summary.status}))};
        }
        racerEvidence.provenance.dataset_read_status=racerDatasetRead.status;
        const output=buildRaceForecast({race:fresh,entries:racerEvidence.entries,stage,now:generatedAt,baseline,odds,weather,
          originalExhibition:stage==='FINAL'?fresh.original_exhibition:null,venueProfile});
        if(!output.ok){hold(output.reason||'BUILD_HELD');continue;}
        output.record.provenance.racer_term_evidence=racerEvidence.provenance;
        output.record.provenance.recent_lane_snapshot_id=recentSnapshotId;
        output.record.provenance.recent_lane_read_status=recentLane.status;
        output.record.provenance.venue_snapshot_id=output.record.venue_evidence?.profile?.snapshot_id||null;
        output.record.provenance.venue_read_snapshot_id=venueSnapshotId;
        output.record.provenance.venue_read_status=venueResult.status;
        if(racerEvidence.provenance.applied_boats>0){
          output.record.input_as_of=new Date(Math.max(utcMs(output.record.input_as_of),utcMs(racerEvidence.provenance.source.available_at))).toISOString();
        }
        if(saved.has(output.record.forecast_key)){summary.existing++;continue;}
        if(utcMs(fresh.deadline)<=Date.now()+90000){hold('CUTOFF');continue;}
        // Re-read the exact logical key before append. Duplicate-key readers fail closed.
        const same=await sr.V8RaceForecast.filter({forecast_key:output.record.forecast_key},'-created_date',2);
        if(!Array.isArray(same))throw new Error('KEY_READ_INVALID');
        if(same.length){summary.existing++;continue;}
        if(expired()){stopForBudget();break;}
        if(utcMs(fresh.deadline)<=Date.now()+90000){hold('CUTOFF');continue;}
        const record=await sr.V8RaceForecast.create(output.record);
        if(!record?.id)throw new Error('SAVE_NOT_CONFIRMED');
        saved.add(output.record.forecast_key);records.push(record);byRace.set(race.id,records);
        summary.created++;summary[stage==='DAY_BEFORE'?'day_before':stage==='PRE'?'pre':'final']++;
        if(racerEvidence.provenance.applied_boats>0)summary.racer_term.enriched_forecasts++;
        else {const reason=racerEvidence.provenance.reason||'NOT_APPLIED';summary.racer_term.skipped[reason]=(summary.racer_term.skipped[reason]||0)+1;}
        if(record.decision?.status==='BUY')summary.buys++;
        if(utcMs(record.created_date)==null||utcMs(record.created_date)>=utcMs(record.deadline)-60000)hold('PERSISTED_TOO_LATE_EXCLUDED');
      }catch(error){
        if(expired()){stopForBudget();break;}
        const status=error?.http_status??error?.response?.status??error?.status;
        if(Number(status)===429||/rate limit exceeded/i.test(String(error?.message||error))){
          summary.partial=true;summary.reasons.RATE_LIMIT_BACKOFF=(summary.reasons.RATE_LIMIT_BACKOFF||0)+1;break;
        }
        summary.errors++;console.error('[V8_CAPTURE]',race.race_key,String(error?.message||error).slice(0,150));
      }
    }
    return finish();
  }catch(error){if(expired()){stopForBudget();return finish();}console.error('[V8_CAPTURE] fatal',String(error?.message||error).slice(0,160));return {...finish(),ok:false,error:'FORECAST_READ_OR_SAVE_FAILED',details:String(error?.message||error).slice(0,120)};}
  finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}
