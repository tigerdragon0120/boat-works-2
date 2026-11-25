// Append-only V8 model comparison. Reads only immutable pre-deadline V7FeatureSnapshot.
import {acquireLock,releaseLock} from './concurrencyLock.js';
import {readResearchPaged} from './v8ResearchRead.js';
import {buildTheoryTrial,theoryTrialKey,THEORY_REVISION} from './v8TheoryTrial.js';
import {utcMs} from './v7FeatureObservation.js';
const today=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
export async function runV8TheoryTrials(client, options = {}) {
  const dryRun=options.dryRun===true;
  const stopAt=Number.isFinite(options.deadlineMs)?options.deadlineMs:Infinity;
 const date=today(),sr=client.asServiceRole.entities;
 const summary    ={ok:true,date,revision:THEORY_REVISION,source:0,candidates:0,created:0,dry_run:dryRun,model_changes:0,late:0,errors:0,skipped_existing:0};
 let lock    =null;
 try{
  lock=dryRun?null:await acquireLock(client,'V8_THEORY_'+date,'v8GenerateTheoryTrials',120000);
  if(!dryRun&&!lock)return Response.json({...summary,skipped:'locked'});
  const budget=Math.min(Date.now()+26000,stopAt);
  const [features,existing]=await Promise.all([
   readResearchPaged((q    ,o    )=>sr.V7FeatureSnapshot.filter(q,o).catch(error=>{console.warn('[V8_RESEARCH_READ] V7FeatureSnapshot',Number(error?.response?.status||error?.http_status||error?.status)||null);throw error;}),{race_date:date},{pageSize:200,maxPages:10,deadlineMs:budget}),
   readResearchPaged((q    ,o    )=>sr.V8TheoryTrial.filter(q,o).catch(error=>{console.warn('[V8_RESEARCH_READ] V8TheoryTrial',Number(error?.response?.status||error?.http_status||error?.status)||null);throw error;}),{race_date:date},{pageSize:200,maxPages:10,deadlineMs:budget})
  ]);
  if(!features.complete||!existing.complete)return Response.json({ok:false,error:'PAGED_SOURCE_INCOMPLETE',diagnostic:{features:{error:features.error,page:features.page,rows:features.rows.length,http_status:features.http_status},existing:{error:existing.error,page:existing.page,rows:existing.rows.length,http_status:existing.http_status}}},{status:503});
  const keys=new Set(existing.rows.map(r=>r.trial_key));
  const ready=features.rows.filter(s=>s?.id&&s?.race_key)
    .sort((a,b)=>utcMs(a.deadline)-utcMs(b.deadline));
  summary.source=ready.length;
  for(const s of ready){
   if(Date.now()>=stopAt){summary.budget_exhausted=true;break;}
   if(summary.created+summary.model_changes>=24)break;
   const key=theoryTrialKey(s);
   if(keys.has(key)){summary.skipped_existing++;continue}
   if(utcMs(s.deadline)-Date.now()<90000){summary.late++;continue}
   summary.candidates++;
   try{
    const output=buildTheoryTrial(s,new Date().toISOString());
    if(!output.ok){summary.errors++;continue}
    if(utcMs(s.deadline)-Date.now()<90000){summary.late++;continue}
    if(dryRun){summary.model_changes++;continue;}
    const saved=await sr.V8TheoryTrial.create(output.record);
    if(!saved?.id){summary.errors++;continue}
    keys.add(key);summary.created++;
    if(utcMs(saved.created_date)==null||utcMs(saved.created_date)>=utcMs(s.deadline)-60000)
     console.error('[V8_THEORY] stored_after_cutoff',key);
   }catch(e    ){summary.errors++;console.error('[V8_THEORY] save_failed',key,String(e?.message||e).slice(0,140));}
  }
  return Response.json(summary);
 }catch(e    ){
  console.error('[V8_THEORY] fatal',String(e?.message||e).slice(0,160));
  return Response.json({ok:false,error:'V8_THEORY_FAILED'},{status:503});
 }finally{if(lock)await releaseLock(client,lock).catch(()=>{})}
}
