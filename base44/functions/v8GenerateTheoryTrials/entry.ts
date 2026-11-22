// Append-only V8 model comparison. Reads only immutable pre-deadline V7FeatureSnapshot.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {acquireLock,releaseLock} from '../../shared/concurrencyLock.js';
import {fetchAllPaged} from '../../shared/pagedFetch.js';
import {buildTheoryTrial,THEORY_REVISION} from '../../shared/v8TheoryTrial.js';
import {utcMs} from '../../shared/v7FeatureObservation.js';
const today=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
export default async function(req:Request):Promise<Response>{
 const client=createClientFromRequest(req);let user:any=null;
 try{user=await client.auth.me()}catch{user=null}
 if(!user)return Response.json({ok:false,error:'Unauthorized'},{status:401});
 if(user.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
 const date=today(),sr=client.asServiceRole.entities;
 const summary:any={ok:true,date,revision:THEORY_REVISION,source:0,candidates:0,created:0,late:0,errors:0,skipped_existing:0};
 let lock:any=null;
 try{
  lock=await acquireLock(client,'V8_THEORY_'+date,'v8GenerateTheoryTrials',120000);
  if(!lock)return Response.json({...summary,skipped:'locked'});
  const budget=Date.now()+26000;
  const [features,existing]=await Promise.all([
   fetchAllPaged((q:any,o:any)=>sr.V7FeatureSnapshot.filter(q,o),{race_date:date},{pageSize:200,maxPages:10,deadlineMs:budget}),
   fetchAllPaged((q:any,o:any)=>sr.V8TheoryTrial.filter(q,o),{race_date:date},{pageSize:200,maxPages:10,deadlineMs:budget})
  ]);
  if(!features.complete||!existing.complete)return Response.json({ok:false,error:'PAGED_SOURCE_INCOMPLETE'},{status:503});
  const keys=new Set(existing.rows.map(r=>r.trial_key));
  const ready=features.rows.filter(s=>s?.id&&s?.race_key)
    .sort((a,b)=>utcMs(a.deadline)-utcMs(b.deadline));
  summary.source=ready.length;
  for(const s of ready){
   if(summary.created>=24)break;
   const key=THEORY_REVISION+':'+s.race_key+':'+s.snapshot_stage;
   if(keys.has(key)){summary.skipped_existing++;continue}
   if(utcMs(s.deadline)-Date.now()<90000){summary.late++;continue}
   summary.candidates++;
   try{
    const output=buildTheoryTrial(s,new Date().toISOString());
    if(!output.ok){summary.errors++;continue}
    if(utcMs(s.deadline)-Date.now()<90000){summary.late++;continue}
    const saved=await sr.V8TheoryTrial.create(output.record);
    if(!saved?.id){summary.errors++;continue}
    keys.add(key);summary.created++;
    if(utcMs(saved.created_date)==null||utcMs(saved.created_date)>=utcMs(s.deadline)-60000)
     console.error('[V8_THEORY] stored_after_cutoff',key);
   }catch(e:any){summary.errors++;console.error('[V8_THEORY] save_failed',key,String(e?.message||e).slice(0,140));}
  }
  return Response.json(summary);
 }catch(e:any){
  console.error('[V8_THEORY] fatal',String(e?.message||e).slice(0,160));
  return Response.json({ok:false,error:'V8_THEORY_FAILED'},{status:503});
 }finally{if(lock)await releaseLock(client,lock).catch(()=>{})}
}