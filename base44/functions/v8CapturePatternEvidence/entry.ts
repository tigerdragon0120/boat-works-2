// Append-only V8 result-pattern research. Never changes live V7 or BUY.
import {createClientFromRequest} from "npm:@base44/sdk@0.8.60";
import {fetchAllPaged} from "../../shared/pagedFetch.js";
import {acquireLock,releaseLock} from "../../shared/concurrencyLock.js";
import {buildV8Evidence,V8_EVIDENCE_VERSION} from "../../shared/v8PatternEvidence.js";
import {fetchHtml,buildUrl,parseResult} from "../../shared/boatraceOfficialParser.js";
const day=()=>new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
const MAX_PER_RUN=6;
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
  const [racePage,weatherPage,existingPage]=await Promise.all([
   fetchAllPaged((q:any,o:any)=>sr.Race.filter(q,o),{race_date:today},{pageSize:200,maxPages:4,deadlineMs:budget}),
   fetchAllPaged((q:any,o:any)=>sr.V7WeatherObservation.filter(q,o),{race_date:today,kind:"RESULT_ACTUAL"},{pageSize:200,maxPages:6,deadlineMs:budget}),
   fetchAllPaged((q:any,o:any)=>sr.V8PatternEvidence.filter(q,o),{race_date:today},{pageSize:200,maxPages:6,deadlineMs:budget})
  ]);
  if(!racePage.complete||!weatherPage.complete||!existingPage.complete){
    return Response.json({ok:false,error:"SOURCE_INCOMPLETE"},{status:503});
  }
  const races=racePage.rows;
  const weatherByRace=new Map();
  for(const w of weatherPage.rows){
    const arr=weatherByRace.get(w.race_id)||[];arr.push(w);weatherByRace.set(w.race_id,arr);
  }
  const existing=new Set(existingPage.rows.map(x=>x.evidence_key));
  const now=Date.now();
  const ready=races.filter(r=>Date.parse(r.deadline)<now-5*60000&&!existing.has(V8_EVIDENCE_VERSION+":"+r.race_key))
    .sort((a,b)=>Date.parse(b.deadline)-Date.parse(a.deadline));
  counts.attempted=Math.min(MAX_PER_RUN,ready.length);
  for(const race of ready.slice(0,MAX_PER_RUN)){
   try{
    const [results,entries,histories]=await Promise.all([
     sr.RaceResult.filter({race_id:race.id},"-created_date",15),
     sr.RaceEntry.filter({race_id:race.id},"-updated_date",40),
     sr.RacerRaceHistory.filter({race_date:race.race_date,venue_code:race.venue_code,race_number:race.race_number},"-created_date",20)
    ]);
    if(!Array.isArray(results)||results.length>=15||!results.length||!Array.isArray(entries)||!Array.isArray(histories)||entries.length>=40||histories.length>=20){
     counts.rejected++;continue;
    }
    let officialResult=null;
    const validResult=results.find(r=>(r.result_status==="RESULT_FINAL"||r.is_finished===true)&&/^[1-6]-[1-6]-[1-6]$/.test(String(r.result_trifecta||"")));
    if(validResult){
      try{
        const url=buildUrl("raceresult",race.race_date,String(race.venue_code).padStart(2,"0"),race.race_number);
        const response=await fetchHtml(url,0);
        if(response?.ok){
          const parsed=parseResult(response.html,race.race_date,String(race.venue_code).padStart(2,"0"),race.venue_name||"");
          const record=parsed?.data?.venues?.[0]?.results?.[0];
          if(parsed?.ok&&record?.result_trifecta===validResult.result_trifecta){
            officialResult={result_trifecta:record.result_trifecta,entries:record.entries||[],
              winning_method:record.entries?.find(e=>e.finish_order===1)?.winning_method||null};
          }
        }
      }catch(e:any){console.error("[V8_PATTERN] official_read_unavailable",race.race_key,String(e?.message||e).slice(0,100));}
    }
    const built=buildV8Evidence({race,resultRows:results,
      entries,histories,weatherRows:weatherByRace.get(race.id)||[],officialResult,now:new Date().toISOString()});
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