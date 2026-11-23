// Automatic admin-only V7 feature capture. Independent append-only observation pipeline.
// Reads Race/RaceEntry/PredictionV7/OddsSnapshot and writes ONLY V7FeatureSnapshot.
// In-flight and after-race backfills cannot create prediction-time observations.
import { acquireLock, releaseLock } from "./concurrencyLock.js";
import { fetchAllPaged } from "./pagedFetch.js";
import { buildV7FeatureObservation, FEATURE_REVISION, utcMs } from "./v7FeatureObservation.js";

const MAX_NEW_PER_RUN=24;
const DAY=()=>new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
const STAGES=["PRE","FINAL","LOCK"];
function targetsForRace(race, pred, now, saved) {
  const deadline=utcMs(race.deadline);
  if(deadline==null || !race.race_key || !race.id || ["finished","cancelled"].includes(race.status))return [];
  const left=(deadline-now)/60000;
  if(left<=2||left>120)return [];
  const base=FEATURE_REVISION+":"+race.race_key+":";
  const out=[];
  const pre=pred?.PRE||null;
  const final=pred?.FINAL||null;
  if(left>=15&&left<=120&&race.exhibition_ready!==true&&pre&&!saved.has(base+"PRE"))out.push("PRE");
  if(left>=5&&left<=45&&final&&!saved.has(base+"FINAL"))out.push("FINAL");
  if(left>=2&&left<=9&&final&&!saved.has(base+"LOCK"))out.push("LOCK");
  return out;
}

export async function runV7CaptureFeatures(client, options = {}) {
  const dryRun=options.dryRun===true;
  const stopAt=Number.isFinite(options.deadlineMs)?options.deadlineMs:Infinity;
  const sr=client.asServiceRole.entities;
  const day=DAY();
  const summary    ={ok:true,day,dry_run:dryRun,revision:FEATURE_REVISION,races:0,candidates:0,created:0,
    partial:0,skipped_existing:0,skipped_source:0,errors:0,late_saves:0,model_changes:0};
  let lockId    =null;
  try{
    lockId=dryRun?null:await acquireLock(client,"V7_FEATURE_CAPTURE_"+day,"v7CaptureFeatures",3*60*1000);
    if(!dryRun&&!lockId)return Response.json({...summary,skipped:"locked"});
    const budget=Math.min(Date.now()+35000,stopAt);
    const [racePage,predPage,savedPage]=await Promise.all([
      fetchAllPaged((q    ,o    )=>sr.Race.filter(q,o),{race_date:day},{pageSize:200,maxPages:3,deadlineMs:budget}),
      fetchAllPaged((q    ,o    )=>sr.PredictionV7.filter(q,o),{race_date:day},{pageSize:200,maxPages:4,deadlineMs:budget}),
      fetchAllPaged((q    ,o    )=>sr.V7FeatureSnapshot.filter(q,o),{race_date:day},{pageSize:200,maxPages:7,deadlineMs:budget}),
    ]);
    if(!racePage.complete||!predPage.complete||!savedPage.complete){
      return Response.json({ok:false,error:"INPUT_READ_INCOMPLETE",races:racePage.error||null,
        preds:predPage.error||null,features:savedPage.error||null},{status:503});
    }
    const saved=new Set(savedPage.rows.map(r=>r.snapshot_key));
    const byRace=new Map();
    for(const p of predPage.rows){
      if(!p?.race_key||!STAGES.slice(0,2).includes(p.stage)||!p?.record_hash)continue;
      const key=p.race_key+"|"+p.stage;
      const list=byRace.get(key)||[];
      list.push(p);
      byRace.set(key,list);
    }
    const now=Date.now();
    const jobs=[];
    for(const race of racePage.rows){
      const preCandidates=byRace.get(race.race_key+"|PRE")||[];
      const finalCandidates=byRace.get(race.race_key+"|FINAL")||[];
      if(preCandidates.length>1||finalCandidates.length>1)continue;
      const pred={PRE:preCandidates[0]||null,FINAL:finalCandidates[0]||null};
      const stages=targetsForRace(race,pred,now,saved);
      for(const stage of stages)jobs.push({race,pred,stage});
    }
    jobs.sort((a,b)=>{
      const x={LOCK:0,FINAL:1,PRE:2};
      return x[a.stage]-x[b.stage]||utcMs(a.race.deadline)-utcMs(b.race.deadline);
    });
    summary.races=racePage.rows.length;
    summary.candidates=jobs.length;
    for(const job of jobs.slice(0,MAX_NEW_PER_RUN)){
      if(Date.now()>=stopAt){summary.budget_exhausted=true;break;}
      const {race,pred,stage}=job;
      const name=FEATURE_REVISION+":"+race.race_key+":"+stage;
      if(saved.has(name)){summary.skipped_existing++;continue}
      if(utcMs(race.deadline)-Date.now()<90000){summary.skipped_source++;continue}
      try{
        const [entries,odds]=await Promise.all([
          sr.RaceEntry.filter({race_id:race.id},"-updated_date",40),
          sr.OddsSnapshot.filter({race_id:race.id},"-captured_at",60),
        ]);
        if(!Array.isArray(entries)||!Array.isArray(odds)||entries.length>=40||odds.length>=60){
          summary.skipped_source++;continue;
        }
        const observedAt=new Date().toISOString();
        const output=buildV7FeatureObservation({
          race,entries,odds,pre:pred.PRE,final:pred.FINAL,stage,observedAt,
        });
        if(!output.ok){summary.skipped_source++;continue}
        // One more deadline check before immutable write.
        if(utcMs(race.deadline)-Date.now()<90000){summary.skipped_source++;continue}
        if(dryRun){summary.model_changes++;continue}
        // The key is already read at start and held under a feature-only process lock.
        // Never update/delete previous snapshots even if source data is corrected.
        const created=await sr.V7FeatureSnapshot.create(output.record);
        if(!created?.id){summary.errors++;continue}
        saved.add(name);
        summary.created++;
        if(output.record.status==="PARTIAL")summary.partial++;
        const stored=utcMs(created.created_date);
        if(stored==null||stored>=utcMs(race.deadline)-60000){
          summary.late_saves++;
          console.error("[V7_FEATURES] late_or_unverified_persistence",race.race_key,stage);
        }
      }catch(error    ){
        summary.errors++;
        console.error("[V7_FEATURES] capture_failure",race.race_key,stage,
          String(error?.message||error).slice(0,180));
      }
    }
    return Response.json({...summary,completed_at:new Date().toISOString()});
  }catch(error    ){
    console.error("[V7_FEATURES] top_level_error",String(error?.message||error).slice(0,220));
    return Response.json({ok:false,error:"V7_FEATURE_CAPTURE_FAILED",detail:String(error?.message||error).slice(0,140)},{status:503});
  }finally{
    if(lockId)await releaseLock(client,lockId).catch(()=>{});
  }
}
