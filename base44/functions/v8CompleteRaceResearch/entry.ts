// Persistent whole-day recovery: official inputs -> missing hypotheses -> result verification.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {acquireLock,releaseLock} from '../../shared/concurrencyLock.js';
import {jstDate,dateValid,readV8Rows,buildRaceProgress} from '../../shared/v8Repository.js';
import {selectResearchDay,researchDayComplete} from '../../shared/v8ResearchQueue.js';
import {recoverRaceResearchInputs} from '../../shared/v8ResearchRecovery.js';
import {runV8ReplayForecasts} from '../../shared/v8ReplayCapture.js';
import {runV8VerifyForecasts} from '../../shared/v8VerificationRunner.js';
import {SETTLEMENT_REVISION} from '../../shared/v8Settlement.js';

export async function runV8CompleteRaceResearch(client:any,options:any={}){
  const sr=client.asServiceRole.entities,started=Date.now(),today=jstDate();
  const requested=options.race_date||null;
  if(requested&&(!dateValid(requested)||requested>today))throw new Error('INVALID_RESEARCH_DATE');
  const budget=started+90000,remaining=()=>Math.max(0,budget-Date.now());
  const summary:any={ok:true,date:null,recovery:null,forecasts:null,verification:null,coverage:null,errors:[]};
  let lock:any=null,day:any=null;
  try{
    lock=await acquireLock(client,'V8_COMPLETE_RACE_RESEARCH','v8CompleteRaceResearch',120000);
    if(!lock)return {...summary,skipped:'locked'};
    const queue=await readV8Rows(sr.V8ResearchDay,{}, {budget:Date.now()+10000,maxPages:20});
    const target=requested||today;
    if(!queue.some((row:any)=>row.race_date===target)){
      const created=await sr.V8ResearchDay.create({race_date:target,status:'PENDING',attempt_count:0,recovery_cursor:0,replay_cursor:0});
      if(!created?.id)throw new Error('RESEARCH_DAY_SAVE_NOT_CONFIRMED');
      queue.push(created);
    }
    day=selectResearchDay(queue,today,requested);
    if(!day)return {...summary,skipped:'no_pending_dates'};
    summary.date=day.race_date;
    await sr.V8ResearchDay.update(day.id,{status:'RUNNING',last_attempt_at:new Date().toISOString(),attempt_count:Number(day.attempt_count||0)+1,last_error:''});
    // Live capture keeps its own priority workflow. Recovery never waits for an open browser.
    try{summary.recovery=await recoverRaceResearchInputs(client,{date:day.race_date,budgetMs:Math.min(26000,remaining()-55000),max_races:40,cursor:Number(day.recovery_cursor||0)});}
    catch(error:any){summary.errors.push({phase:'INPUTS',reason:String(error?.message||'INPUT_RECOVERY_FAILED').slice(0,120)});}
    if(remaining()>12000){
      try{summary.forecasts=await runV8ReplayForecasts(client,{date:day.race_date,max_races:40,budgetMs:Math.min(30000,remaining()-12000),cursor:Number(day.replay_cursor||0)});}
      catch(error:any){summary.errors.push({phase:'FORECASTS',reason:String(error?.message||'FORECAST_RECOVERY_FAILED').slice(0,120)});}
    }
    if(remaining()>10000){
      try{summary.verification=await runV8VerifyForecasts(client,{dates:[day.race_date],max_created:120,budgetMs:Math.min(30000,remaining()-7000)});}
      catch(error:any){summary.errors.push({phase:'VERIFICATION',reason:String(error?.message||'VERIFICATION_FAILED').slice(0,120)});}
    }
    const readBudget=Date.now()+Math.max(1000,Math.min(15000,remaining()));
    const [races,forecasts,verifications]=await Promise.all([
      readV8Rows(sr.Race,{race_date:day.race_date},{budget:readBudget,maxPages:4}),
      readV8Rows(sr.V8RaceForecast,{race_date:day.race_date},{budget:readBudget,maxPages:40}),
      readV8Rows(sr.V8ForecastVerification,{race_date:day.race_date},{budget:readBudget,maxPages:40})
    ]);
    const results=races.length?await readV8Rows(sr.RaceResult,{race_id:{$in:races.map((row:any)=>row.id)}},{budget:readBudget,maxPages:6}):[];
    const currentVerifications=verifications.filter((row:any)=>row.revision===SETTLEMENT_REVISION);
    const progress=buildRaceProgress({races,forecasts:forecasts.filter((row:any)=>row.record_mode!=='REPLAY'),replayForecasts:forecasts.filter((row:any)=>row.record_mode==='REPLAY'),verifications:currentVerifications.filter((row:any)=>row.source_kind==='FORECAST'),replayVerifications:currentVerifications.filter((row:any)=>row.source_kind==='REPLAY'),results});
    summary.coverage=progress.coverage;
    summary.pending=progress.rows.filter((row:any)=>!['VERIFIED','RESULT_EXCLUDED','CANCELLED'].includes(row.status)).map((row:any)=>({race_key:row.race_key,status:row.status,missing:row.missing}));
    summary.ok=summary.errors.length===0&&Number(summary.forecasts?.errors||0)===0&&Number(summary.verification?.errors||0)===0;
    const complete=researchDayComplete(progress.coverage,races);
    const update:any={status:complete?'COMPLETE':'PARTIAL',coverage:progress.coverage,recovery_cursor:summary.recovery?.next_cursor??day.recovery_cursor??0,replay_cursor:summary.forecasts?.next_cursor??day.replay_cursor??0,input_failures:summary.recovery?.failures||[],last_summary:{...summary,pending:summary.pending.slice(0,200)},last_error:summary.errors.map((row:any)=>row.phase+':'+row.reason).join(' / ').slice(0,500)};
    if(complete)update.completed_at=new Date().toISOString();
    await sr.V8ResearchDay.update(day.id,update);
    return {...summary,status:update.status,duration_ms:Date.now()-started,completed_at:new Date().toISOString()};
  }catch(error:any){
    const reason=String(error?.message||'RESEARCH_PIPELINE_FAILED').split('\n')[0].replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/[a-f0-9]{64,}/gi,'[redacted]').slice(0,160);
    if(day?.id)await sr.V8ResearchDay.update(day.id,{status:'PARTIAL',last_error:reason}).catch(()=>{});
    return {...summary,ok:false,error:reason,duration_ms:Date.now()-started};
  }finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const body=await req.json().catch(()=>({}));
  return Response.json(await runV8CompleteRaceResearch(client,{race_date:body.race_date}));
}
