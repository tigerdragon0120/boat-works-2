// One paid backend invocation for the four prospective research pipelines.
// Features must be persisted first. The three consumers then use their original
// immutable inputs, cutoff guards and dedicated locks; no functions.invoke calls.
import {acquireLock,releaseLock} from './concurrencyLock.js';
import {runV7CaptureFeatures} from './v7FeatureCaptureRunner.js';
import {runV7FactorCandidates} from './v7FactorCandidateRunner.js';
import {runV8TheoryTrials} from './v8TheoryTrialRunner.js';
import {runV7BuyShadowTrial} from './v7BuyShadowRunner.js';

const DEFAULT_RUNNERS={
  features:runV7CaptureFeatures,
  factors:runV7FactorCandidates,
  theories:runV8TheoryTrials,
  shadow:runV7BuyShadowTrial,
};
const DAY=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});

export async function runV8ResearchObservations(client,options={},dependencies={}){
  const started=Date.now(),day=DAY(),dryRun=options.dryRun===true;
  // Cooperative deadline: stop starting new reads/records when the budget ends.
  // An already issued SDK write is awaited, never raced or left running behind.
  const budgetMs=Math.min(90000,Math.max(1000,Number(options.budgetMs)||90000));
  const deadlineMs=started+budgetMs;
  const runners={...DEFAULT_RUNNERS,...dependencies.runners};
  const report={ok:true,complete:false,day,dry_run:dryRun,revision:'V8_RESEARCH_BATCH_1',phases:{}};
  let lock=null;
  const runPhase=async(name,phaseDeadline)=>{
    if(Date.now()>=phaseDeadline){
      report.phases[name]={ok:true,complete:false,budget_exhausted:true,skipped:'budget'};
      return;
    }
    try{
      const response=await runners[name](client,{dryRun,deadlineMs:phaseDeadline});
      if(!(response instanceof Response))throw new Error('INVALID_RUNNER_RESPONSE');
      const data=await response.json();
      const errors=Number(data.errors||0)+Number(data.read_errors||0)+Number(data.after_cutoff_saves||0)+Number(data.late_saves||0);
      report.phases[name]={...data,ok:response.ok&&data.ok===true&&errors===0,http_status:response.status};
    }catch(error){
      report.phases[name]={ok:false,error:'RESEARCH_PHASE_FAILED',detail:String(error?.message||error).slice(0,160)};
      console.error('[V8_RESEARCH_BATCH]',name,report.phases[name].detail);
    }
  };
  try{
    lock=dryRun?null:await acquireLock(client,'V8_RESEARCH_BATCH_'+day,'v8ResearchObservations',120000);
    if(!dryRun&&!lock)return {...report,skipped:'locked'};
    await runPhase('features',Math.min(deadlineMs,Date.now()+40000));
    // Independent consumers write different entities. A failing phase cannot
    // prevent the others from saving their own valid pre-deadline observations.
    await Promise.all(['factors','theories','shadow'].map(name=>runPhase(name,deadlineMs)));
    report.ok=Object.values(report.phases).every(phase=>phase.ok===true);
    report.complete=report.ok&&Object.values(report.phases).every(phase=>!phase.budget_exhausted&&!phase.skipped);
    console.info('[V8_RESEARCH_BATCH]',JSON.stringify(report));
    return {...report,status:report.complete?'COMPLETE':'PARTIAL',elapsed_ms:Date.now()-started,completed_at:new Date().toISOString()};
  }finally{
    if(lock)await releaseLock(client,lock).catch(()=>{});
  }
}

// Kept injectable to verify that the HTTP entry point authorizes before touching
// service-role entities. Request input can only request a non-writing dry run.
export function createV8ResearchObservationsHandler(createClient,run=runV8ResearchObservations){
  return async function(req){
    const client=createClient(req);let user=null;
    try{user=await client.auth.me()}catch{}
    if(!user)return Response.json({ok:false,error:'Unauthorized'},{status:401});
    if(user.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
    const body=await req.json().catch(()=>({}));
    try{
      const result=await run(client,{dryRun:body?.dry_run===true});
      return Response.json(result,{status:result.ok?200:503});
    }catch(error){
      console.error('[V8_RESEARCH_BATCH] fatal',String(error?.message||error).slice(0,160));
      return Response.json({ok:false,error:'RESEARCH_BATCH_FAILED'},{status:503});
    }
  };
}
