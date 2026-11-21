// Append-only V8 result-pattern research. Never changes live V7 or BUY.
import {createClientFromRequest} from "npm:@base44/sdk@0.8.60";
import {fetchAllPaged} from "../../shared/pagedFetch.js";
import {acquireLock,releaseLock} from "../../shared/concurrencyLock.js";
import {buildV8Evidence,V8_EVIDENCE_VERSION} from "../../shared/v8PatternEvidence.js";
const day=()=>new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
const MAX_PER_RUN=15;
export default async function(req:Request):Promise<Response>{
 const client=createClientFromRequest(req);
 let user:any=null;try{user=await client.auth.me()}catch{user=null}
 if(!user)return Response.json({ok:false,error:"Unauthorized"},{status:401});
 if(user.role!=="admin")return Response.json({ok:false,error:"Forbidden"},{status:403});
 const sr=client.asServiceRole.entities;const today=day();
 let lock:any=null;const counts:any={ok:true,date:today,new:0,partial:0,attempted:0,
   skipped:0,rejected:0,errors:0,source_incomplete:false};
 try{
  lock=await acquireLock(client,"V8_PATTERN_"+today,"v8CapturePatternEvidence",120000);
  if(!lock)return Response.json({...counts,status:"locked"});
  const budget=Date.now()+30000;
  const [racePage,resultPage,weatherPage,existingPage]=await Promise.all([
   fetchAllPaged((q:any,o:any)=>sr.Race.filter(q,o),{race_date:today},{pageSize:200,maxPages:4,deadlineMs:budget}),
   fetchAllPaged((q:any,o:any)=>sr.RaceResult.filter(q,o),{result_status:"RESULT_FINAL"},{pageSize:200,maxPages:12,deadlineMs:budget}),
   fetchAllPaged((q:any,o:any)=>sr.V7WeatherObservation.filter(q,o),{race_date:today,kind:"RESULT_ACTUAL"},{pageSize:200,maxPages:6,deadlineMs:budget}),
   fetchAllPaged((q:any,o:any)=>sr.V8PatternEvidence.filter(q,o),{race_date:today},{pageSize:200,maxPages:6,deadlineMs:budget})
  ]);
  if(!racePage.complete||!resultPage.complete||!weatherPage.complete||!existingPage.complete){
    return Response.json({ok:false,error:"SOURCE_INCOMPLETE"},{status:503});
  }
  const races=racePage.rows;
  const byId=new Map(races.map(r=>[r.id,r]));
  const resultsByRace=new Map();
  for(const z of resultPage.rows){
    if(!byId.has(z.race_id))continue;
    const arr=resultsByRace.get(z.race_id)||[];arr.push(z);resultsByRace.set(z.race_id,arr);
  }
  const weatherByRace=new Map();
  for(const w of weatherPage.rows){
    const arr=weatherByRace.get(w.race_id)||[];arr.push(w);weatherByRace.set(w.race_id,arr);
  }
  const existing=new Set(existingPage.rows.map(x=>x.evidence_key));
  const ready=races.filter(r=>resultsByRace.has(r.id)&&!existing.has(V8_EVIDENCE_VERSION+":"+r.race_key))
    .sort((a,b)=>Date.parse(a.deadline)-Date.parse(b.deadline));
  counts.attempted=Math.min(MAX_PER_RUN,ready.length);
  for(const race of ready.slice(0,MAX_PER_RUN)){
   try{
    const [entries,histories]=await Promise.all([
     sr.RaceEntry.filter({race_id:race.id},"-updated_date",40),
     sr.RacerRaceHistory.filter({race_date:race.race_date,venue_code:race.venue_code,race_number:race.race_number},"-created_date",20)
    ]);
    if(!Array.isArray(entries)||!Array.isArray(histories)||entries.length>=40||histories.length>=20){
     counts.rejected++;continue;
    }
    const built=buildV8Evidence({race,resultRows:resultsByRace.get(race.id)||[],
      entries,histories,weatherRows:weatherByRace.get(race.id)||[],now:new Date().toISOString()});
    if(!built.ok){counts.rejected++;continue}
    const created=await sr.V8PatternEvidence.create(built.record);
    if(!created?.id){counts.errors++;continue}
    existing.add(built.record.evidence_key);counts.new++;
    if(built.record.data_quality!=="COMPLETE")counts.partial++;
   }catch(e:any){
    counts.errors++;console.error("[V8_PATTERN] failed",race.race_key,String(e?.message||e).slice(0,160));
   }
  }
  return Response.json({...counts,remaining:Math.max(0,ready.length-MAX_PER_RUN)});
 }catch(e:any){
  console.error("[V8_PATTERN] fatal",String(e?.message||e).slice(0,150));
  return Response.json({ok:false,error:"PATTERN_CAPTURE_FAILED"},{status:503});
 }finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}
