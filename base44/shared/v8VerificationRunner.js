// Independent result settlement. LIVE and post-deadline REPLAY remain distinct.
import {acquireLock,releaseLock} from './concurrencyLock.js';
import {jstDate,dateValid,readV8Rows,canonicalForecasts,canonicalReplayForecasts,latestForecasts,firstBuyForecasts,groupBy} from './v8Repository.js';
import {settleForecast,settleReplayForecast,settleExcludedForecast,settleExternal} from './v8Settlement.js';
import {utcMs} from './v7FeatureObservation.js';

export async function runV8VerifyForecasts(client    ,options    ={}){
  const sr=client.asServiceRole.entities,started=Date.now();
  const dates=Array.isArray(options.dates)?[...new Set(options.dates)]:[jstDate(),jstDate(-1),jstDate(-2)];
  if(!dates.length||dates.length>7||dates.some(day=>!dateValid(day)||day>jstDate()))throw new Error('INVALID_DATES');
  const budgetMs=Math.max(1000,Math.min(80000,Number(options.budgetMs)||70000)),budget=started+budgetMs;
  const maxCreated=Math.max(1,Math.min(120,Math.floor(Number(options.max_created)||100)));
  const summary    ={ok:true,created:0,live:0,replay:0,excluded:0,held:0,existing:0,errors:0,reasons:{}};let lock    =null;
  const hold=(reason       )=>{summary.held++;summary.reasons[reason]=(summary.reasons[reason]||0)+1;};
  try{
    lock=await acquireLock(client,'V8_FORECAST_VERIFY','v8VerifyForecasts',120000);
    if(!lock)return {...summary,skipped:'locked'};
    const query={race_date:{$in:dates}},readBudget=Math.min(budget,Date.now()+30000);
    const [allForecasts,external,existing]=await Promise.all([
      readV8Rows(sr.V8RaceForecast,query,{budget:readBudget,maxPages:70}),
      readV8Rows(sr.V8ExternalPrediction,query,{budget:readBudget,maxPages:20}),
      readV8Rows(sr.V8ForecastVerification,query,{budget:readBudget,maxPages:70})
    ]);
    const source=canonicalForecasts(allForecasts),replays=canonicalReplayForecasts(allForecasts);
    const selected=new Map([...latestForecasts(source.rows),...firstBuyForecasts(source.rows)].map(row=>[row.id,{kind:'FORECAST',row}]));
    for(const row of latestForecasts(replays.rows))selected.set(row.id,{kind:'REPLAY',row});
    const sourceById=new Map([...source.rows,...replays.rows].map(row=>[row.id,row]));
    for(const item of [...selected.values()]){const row=sourceById.get(item.row.comparison?.baseline_id);if(row)selected.set(row.id,{kind:row.record_mode==='REPLAY'?'REPLAY':'FORECAST',row});}
    for(const records of groupBy(external,'record_key').values())if(records.length===1&&records[0].verification_eligible===true)selected.set(records[0].id,{kind:'EXTERNAL',row:records[0]});
    const done=new Set(existing.map(row=>row.source_kind+':'+(row.forecast_id||row.external_id)));
    const waiting=[...selected.values()].filter(item=>utcMs(item.row.deadline)<Date.now()-60000&&!done.has(item.kind+':'+item.row.id));
    const groups=groupBy(waiting,item=>item.row.race_id),raceIds=[...groups.keys()],keys=new Set(existing.map(row=>row.verification_key));
    if(!raceIds.length)return {...summary,remaining_sources:0,completed_at:new Date().toISOString()};
    // Batched reads keep a full day's replay from making three list calls per race.
    const raceBudget=Math.min(budget,Date.now()+30000);
    const [races,allResults,allProof]=await Promise.all([
      readV8Rows(sr.Race,{id:{$in:raceIds}},{budget:raceBudget,maxPages:20}),
      readV8Rows(sr.RaceResult,{race_id:{$in:raceIds}},{budget:raceBudget,maxPages:30}),
      readV8Rows(sr.ResultProvenance,{race_id:{$in:raceIds},evidence_type:'LIVE'},{budget:raceBudget,maxPages:40})
    ]);
    const raceById=groupBy(races,'id'),resultsByRace=groupBy(allResults,'race_id'),proofByRace=groupBy(allProof,'race_id');
    const prepared      =[];
    for(const [raceId,items] of groups){
      if(prepared.length>=maxCreated||Date.now()>=budget-1000)break;
      const matched=raceById.get(raceId)||[],race=matched[0],results=resultsByRace.get(raceId)||[],proof=proofByRace.get(raceId)||[];
      if(matched.length!==1){hold('RACE_IDENTITY_MISSING_OR_AMBIGUOUS');continue;}
      if(race.status==='cancelled'){hold('CANCELLED');continue;}
      const validResults=results.filter(row=>(row.is_finished||row.result_status==='RESULT_FINAL')&&/^[1-6]-[1-6]-[1-6]$/.test(String(row.result_trifecta||'')));
      const outcomes=new Set(validResults.map(row=>row.result_trifecta+':'+row.payout));
      if(outcomes.size!==1){hold(outcomes.size?'RESULT_CONFLICT':'RESULT_PENDING');continue;}
      const eligible=validResults.map(result=>({result,evidence:proof.filter(row=>row.result_id===result.id&&row.result_trifecta===result.result_trifecta&&row.source===result.source)})).filter(row=>row.evidence.length===1);
      if(eligible.length!==1){hold(eligible.length?'RESULT_EVIDENCE_AMBIGUOUS':'RESULT_EVIDENCE_MISSING');continue;}
      const {evidence}=eligible[0];
      for(const item of items){
        if(prepared.length>=maxCreated)break;
        if(item.row.race_key!==race.race_key||utcMs(item.row.deadline)!==utcMs(race.deadline)){hold('RACE_IDENTITY_CHANGED');continue;}
        const input={forecast:item.row,result:results,provenance:evidence[0],now:new Date().toISOString()};
        let output=item.kind==='FORECAST'?settleForecast(input):item.kind==='REPLAY'?settleReplayForecast(input):settleExternal({...input,external:item.row});
        if(!output.ok&&output.reason==='REFUND_OR_CANCELLATION_REQUIRES_REVIEW'&&item.kind!=='EXTERNAL')output=settleExcludedForecast(input);
        if(!output.ok){hold(output.reason||'SETTLEMENT_HELD');continue;}
        if(keys.has(output.record.verification_key)){summary.existing++;continue;}
        prepared.push(output.record);
      }
    }
    if(prepared.length){
      // Recheck the batch immediately before appending. Duplicate readers fail closed.
      const recent=await readV8Rows(sr.V8ForecastVerification,{verification_key:{$in:prepared.map(row=>row.verification_key)}},{budget,maxPages:5});
      for(const row of recent)keys.add(row.verification_key);
      for(const record of prepared){
        if(Date.now()>=budget)break;
        if(keys.has(record.verification_key)){summary.existing++;continue;}
        try{
          const saved=await sr.V8ForecastVerification.create(record);
          if(!saved?.id)throw new Error('SAVE_NOT_CONFIRMED');
          keys.add(record.verification_key);summary.created++;summary[record.source_kind==='REPLAY'?'replay':'live']++;
          if(record.status==='EXCLUDED_REFUND')summary.excluded++;
        }catch{summary.errors++;}
      }
    }
    return {...summary,remaining_sources:Math.max(0,waiting.length-summary.created-summary.existing),completed_at:new Date().toISOString(),duration_ms:Date.now()-started};
  }finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}

