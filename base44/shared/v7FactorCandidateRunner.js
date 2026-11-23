// V7+ factor candidates: independent, append-only prospective research.
// Never overwrite V7 predictions, BUY judgments, result records or any input snapshots.
import { acquireLock, releaseLock } from "./concurrencyLock.js";
import { fetchAllPaged } from "./pagedFetch.js";
import { buildFactorCandidate,FACTOR_REVISION } from "./v7FactorCandidate.js";
import { utcMs } from "./v7FeatureObservation.js";

const dateJst=()=>new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
const MAX_PER_RUN=24;
export async function runV7FactorCandidates(client, options = {}) {
  const dryRun=options.dryRun===true;
  const stopAt=Number.isFinite(options.deadlineMs)?options.deadlineMs:Infinity;
  const day=dateJst();
  const sr=client.asServiceRole.entities;
  let lock    =null;
  const report    ={ok:true,day,revision:FACTOR_REVISION,available:0,created:0,dry_run:dryRun,model_changes:0,insufficient:0,
    rejected_late:0,skipped_existing:0,errors:0};
  try{
    lock=dryRun?null:await acquireLock(client,"V7_FACTOR_MODEL_"+day,"v7GenerateFactorCandidates",120000);
    if(!dryRun&&!lock)return Response.json({...report,skipped:"locked"});
    const budget=Math.min(Date.now()+24000,stopAt);
    const [featurePage,existingPage]=await Promise.all([
      fetchAllPaged((q    ,o    )=>sr.V7FeatureSnapshot.filter(q,o),{race_date:day},
        {pageSize:200,maxPages:10,deadlineMs:budget}),
      fetchAllPaged((q    ,o    )=>sr.V7FactorCandidate.filter(q,o),{race_date:day},
        {pageSize:200,maxPages:10,deadlineMs:budget})
    ]);
    if(!featurePage.complete||!existingPage.complete){
      return Response.json({ok:false,error:"PAGED_SOURCE_INCOMPLETE"},{status:503});
    }
    const existing=new Set(existingPage.rows.map(x=>x.candidate_key));
    const ordered=[...featurePage.rows].sort((a,b)=>{
      const stage={LOCK:0,FINAL:1,PRE:2};
      return (stage[a.snapshot_stage]??3)-(stage[b.snapshot_stage]??3)||
        utcMs(a.deadline)-utcMs(b.deadline);
    });
    report.available=ordered.length;
    for(const snap of ordered){
      if(Date.now()>=stopAt){report.budget_exhausted=true;break;}
      if(report.created+report.model_changes>=MAX_PER_RUN)break;
      const key=FACTOR_REVISION+":"+snap.race_key+":"+snap.snapshot_stage;
      if(existing.has(key)){report.skipped_existing++;continue}
      if(utcMs(snap.deadline)==null||Date.now()>utcMs(snap.deadline)-90000){
        report.rejected_late++;continue;
      }
      try{
        const observedAt=new Date().toISOString();
        const result=buildFactorCandidate(snap,observedAt);
        if(!result.ok){report.rejected_late++;continue}
        if(Date.now()>utcMs(snap.deadline)-90000){report.rejected_late++;continue}
        if(dryRun){report.model_changes++;continue;}
        const created=await sr.V7FactorCandidate.create(result.record);
        if(!created?.id){report.errors++;continue}
        report.created++;
        if(result.record.status==="INSUFFICIENT")report.insufficient++;
        existing.add(key);
        if(utcMs(created.created_date)==null||utcMs(created.created_date)>=utcMs(snap.deadline)-60000){
          report.errors++;
          console.error("[V7_FACTOR] stored_after_cutoff",snap.race_key,snap.snapshot_stage);
        }
      }catch(error    ){
        report.errors++;
        console.error("[V7_FACTOR] save_error",snap.race_key,String(error?.message||error).slice(0,150));
      }
    }
    return Response.json({...report,completed_at:new Date().toISOString()});
  }catch(error    ){
    console.error("[V7_FACTOR] fatal",String(error?.message||error).slice(0,180));
    return Response.json({ok:false,error:"FACTOR_GENERATION_FAILED"},{status:503});
  }finally{
    if(lock)await releaseLock(client,lock).catch(()=>{});
  }
}
