// Scheduled immutable DAY_BEFORE -> PRE -> FINAL forecast collection.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {acquireLock,releaseLock} from '../../shared/concurrencyLock.js';
import {selectV7RaceEntries} from '../../shared/v7RaceEntrySelector.js';
import {utcMs} from '../../shared/v7FeatureObservation.js';
import {buildRaceForecast,FORECAST_REVISION} from '../../shared/v8ForecastEngine.js';
import {jstDate,readV8Rows,groupBy,chronological,canonicalForecasts} from '../../shared/v8Repository.js';

const hasExhibition=(entries:any[])=>entries.some(e=>['exhibition_time','exhibition_st','exhibition_course'].some(k=>e[k]!=null&&e[k]!==''));
export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const sr=client.asServiceRole.entities,started=Date.now(),today=jstDate(),tomorrow=jstDate(1);
  const summary:any={ok:true,revision:FORECAST_REVISION,today,tomorrow,races:0,created:0,day_before:0,pre:0,final:0,buys:0,held:0,existing:0,errors:0,reasons:{}};
  const hold=(reason:string)=>{summary.held++;summary.reasons[reason]=(summary.reasons[reason]||0)+1;};
  let lock:any=null;
  try{
    lock=await acquireLock(client,'V8_FORECAST_CAPTURE','v8CaptureForecasts',120000);
    if(!lock)return Response.json({...summary,skipped:'locked'});
    const budget=Date.now()+30000;
    const [races,prior]=await Promise.all([
      readV8Rows(sr.Race,{race_date:{$in:[today,tomorrow]}},{budget,maxPages:8}),
      readV8Rows(sr.V8RaceForecast,{race_date:{$in:[today,tomorrow]}},{budget,maxPages:40})
    ]);
    const uniqueRaces=[...groupBy(races,'race_key').values()].filter(group=>group.length===1).map(g=>g[0]);
    summary.races=uniqueRaces.length;
    summary.duplicate_race_keys=groupBy(races,'race_key').size-uniqueRaces.length;
    const canonical=canonicalForecasts(prior),byRace=groupBy(canonical.rows,'race_id'),saved=new Set(prior.map(p=>p.forecast_key));
    summary.ambiguous_forecast_keys=canonical.conflicts.length;
    const active=uniqueRaces.filter(r=>!['finished','cancelled'].includes(r.status)&&utcMs(r.deadline)>Date.now()+90000);
    // First cover today's closing races; then fill all remaining pre-race plans and tomorrow.
    active.sort((a,b)=>Number(a.race_date!==today)-Number(b.race_date!==today)||utcMs(a.deadline)-utcMs(b.deadline));
    const todo=active.filter(r=>!saved.has(FORECAST_REVISION+':'+r.race_key+':DAY_BEFORE')||r.race_date===today);
    const entryRows=todo.length?await readV8Rows(sr.RaceEntry,{race_id:{$in:todo.map(r=>r.id)}},{budget:Date.now()+25000,maxPages:25}):[];
    const entriesByRace=groupBy(entryRows,'race_id');
    for(const race of todo){
      if(summary.created>=48||Date.now()-started>80000)break;
      if(utcMs(race.deadline)<=Date.now()+90000){hold('CUTOFF');continue;}
      const selected=selectV7RaceEntries(entriesByRace.get(race.id)||[],race);
      if(selected.reason){hold(selected.reason);continue;}
      const entries=selected.entries;
      const isFinal=race.race_date===today&&(race.exhibition_ready===true||hasExhibition(entries));
      const stage=race.race_date===tomorrow?'DAY_BEFORE':isFinal?'FINAL':'PRE';
      const records=byRace.get(race.id)||[];
      if(stage!=='FINAL'&&saved.has(FORECAST_REVISION+':'+race.race_key+':'+stage)){summary.existing++;continue;}
      const lastFinal=records.filter(r=>r.stage==='FINAL').sort(chronological).at(-1);
      if(stage==='FINAL'&&lastFinal&&Date.now()-utcMs(lastFinal.generated_at)<180000){summary.existing++;continue;}
      try{
        const fresh=await sr.Race.get(race.id);
        if(!fresh||fresh.race_key!==race.race_key||['finished','cancelled'].includes(fresh.status)||utcMs(fresh.deadline)<=Date.now()+90000){hold('RACE_CHANGED_OR_CLOSED');continue;}
        const results=await readV8Rows(sr.RaceResult,{race_id:race.id},{budget:Date.now()+8000,maxPages:2});
        if(results.some(r=>r.is_finished||r.result_status==='RESULT_FINAL')){hold('RESULT_ALREADY_AVAILABLE');continue;}
        let prediction:any=null,odds:any=null,weather:any=null;
        if(stage==='FINAL'){
          const readBudget=Date.now()+15000;
          const [predictions,quotes,weathers]=await Promise.all([
            readV8Rows(sr.PredictionV7,{race_id:race.id,stage:'FINAL',source:'SERVER'},{budget:readBudget,maxPages:2}),
            readV8Rows(sr.OddsSnapshot,{race_id:race.id},{budget:readBudget,maxPages:3,sort:'-captured_at'}),
            readV8Rows(sr.V7WeatherObservation,{race_id:race.id,kind:'PRE_REFERENCE'},{budget:readBudget,maxPages:2})
          ]);
          if(predictions.length===1)prediction=predictions[0];
          const eligibleQuotes=quotes.filter(q=>utcMs(q.captured_at)!=null&&utcMs(q.created_date)!=null&&utcMs(q.captured_at)<=Date.now()&&utcMs(q.created_date)<=Date.now()).sort((a,b)=>utcMs(b.captured_at)-utcMs(a.captured_at));
          odds=eligibleQuotes[0]||null;
          if(prediction)prediction={...prediction,pricing_snapshot:eligibleQuotes.find(q=>utcMs(q.captured_at)<=utcMs(prediction.generated_at)&&utcMs(q.created_date)<=utcMs(prediction.generated_at))||null};
          weather=weathers.filter(w=>utcMs(w.observed_at)<=Date.now()&&utcMs(w.observed_at)<utcMs(fresh.deadline)-60000).sort((a,b)=>utcMs(b.observed_at)-utcMs(a.observed_at))[0]||null;
        }
        const baseline=records.filter(r=>r.stage==='DAY_BEFORE').sort(chronological)[0]||records.filter(r=>r.stage==='PRE').sort(chronological)[0]||null;
        const output=buildRaceForecast({race:fresh,entries,stage,now:new Date().toISOString(),baseline,prediction,odds,weather});
        if(!output.ok){hold(output.reason||'BUILD_HELD');continue;}
        if(saved.has(output.record.forecast_key)){summary.existing++;continue;}
        if(utcMs(fresh.deadline)<=Date.now()+90000){hold('CUTOFF');continue;}
        // Re-read the exact logical key before append. Duplicate-key readers fail closed.
        const same=await sr.V8RaceForecast.filter({forecast_key:output.record.forecast_key},'-created_date',2);
        if(!Array.isArray(same))throw new Error('KEY_READ_INVALID');
        if(same.length){summary.existing++;continue;}
        const record=await sr.V8RaceForecast.create(output.record);
        if(!record?.id)throw new Error('SAVE_NOT_CONFIRMED');
        saved.add(output.record.forecast_key);records.push(record);byRace.set(race.id,records);
        summary.created++;summary[stage==='DAY_BEFORE'?'day_before':stage==='PRE'?'pre':'final']++;
        if(record.decision?.status==='BUY')summary.buys++;
        if(utcMs(record.created_date)==null||utcMs(record.created_date)>=utcMs(record.deadline)-60000)hold('PERSISTED_TOO_LATE_EXCLUDED');
      }catch(error:any){summary.errors++;console.error('[V8_CAPTURE]',race.race_key,String(error?.message||error).slice(0,150));}
    }
    return Response.json({...summary,completed_at:new Date().toISOString(),duration_ms:Date.now()-started});
  }catch(error:any){console.error('[V8_CAPTURE] fatal',String(error?.message||error).slice(0,160));return Response.json({ok:false,error:'FORECAST_READ_OR_SAVE_FAILED',details:String(error?.message||error).slice(0,120)},{status:503});}
  finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}