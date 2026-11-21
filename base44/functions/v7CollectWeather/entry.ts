// Independent venue-weather observation pipeline. Does NOT modify Race, results,
// existing V7 predictions, BUY selection or V7+ factor weights.
import {createClientFromRequest} from "npm:@base44/sdk@0.8.60";
import {fetchAllPaged} from "../../shared/pagedFetch.js";
import {acquireLock,releaseLock} from "../../shared/concurrencyLock.js";
import {fetchHtml,buildUrl,parseResult} from "../../shared/boatraceOfficialParser.js";
import {parseWeatherEvidence,weatherObservation} from "../../shared/v7WeatherEvidence.js";
const dateJst=()=>new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Tokyo"});
const MAX=10;
export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);
  let user:any=null;try{user=await client.auth.me()}catch{user=null}
  if(!user)return Response.json({ok:false,error:"Unauthorized"},{status:401});
  if(user.role!=="admin")return Response.json({ok:false,error:"Forbidden"},{status:403});
  const sr=client.asServiceRole.entities;
  const day=dateJst();
  let lock:any=null;
  const report:any={ok:true,day,attempted:0,saved:0,pre:0,result:0,partial:0,no_weather:0,
    source_mismatch:0,fetch_failed:0,late:0,errors:0,seen:0};
  try{
    lock=await acquireLock(client,"V7_WEATHER_CAPTURE_"+day,"v7CollectWeather",120000);
    if(!lock)return Response.json({...report,skipped:"locked"});
    const budget=Date.now()+20000;
    const [racePage,priorPage]=await Promise.all([
      fetchAllPaged((q:any,o:any)=>sr.Race.filter(q,o),{race_date:day},{pageSize:200,maxPages:4,deadlineMs:budget}),
      fetchAllPaged((q:any,o:any)=>sr.V7WeatherObservation.filter(q,o),{race_date:day},{pageSize:200,maxPages:6,deadlineMs:budget}),
    ]);
    if(!racePage.complete||!priorPage.complete)return Response.json({ok:false,error:"INPUT_READ_INCOMPLETE"},{status:503});
    const saved=new Set(priorPage.rows.map(x=>x.observation_key));
    const now=Date.now(),jobs:any[]=[];
    for(const race of racePage.rows){
      const deadline=Date.parse(String(race.deadline||""));
      if(!Number.isFinite(deadline)||!race.id||!race.race_key)continue;
      const left=(deadline-now)/60000;
      if(left>3&&left<=30&&race.status!=="cancelled"){
        const period=left>10?"EARLY":"LATE";
        const key="PRE_REFERENCE:"+race.race_key+":"+period;
        if(!saved.has(key))jobs.push({race,kind:"PRE_REFERENCE",key,distance:Math.abs(left-8)});
      }
      // A result-page reading can be associated with THIS race only if its trifecta
      // independently matches the stored completed result. No fabricated result weather.
      if(left<-7&&left>=-45){
        const key="RESULT_ACTUAL:"+race.race_key;
        if(!saved.has(key))jobs.push({race,kind:"RESULT_ACTUAL",key,distance:Math.abs(left+18)+10});
      }
    }
    jobs.sort((a,b)=>a.distance-b.distance);
    report.seen=jobs.length;
    for(const job of jobs.slice(0,MAX)){
      const {race,kind,key}=job;
      const deadline=Date.parse(race.deadline);
      if(kind==="PRE_REFERENCE"&&Date.now()>=deadline-60000){report.late++;continue;}
      const url=buildUrl(kind==="PRE_REFERENCE"?"beforeinfo":"raceresult",race.race_date,
        String(race.venue_code).padStart(2,"0"),race.race_number);
      report.attempted++;
      try{
        const res=await fetchHtml(url,0);
        if(!res?.ok||!res.html){report.fetch_failed++;continue}
        const parsed=parseWeatherEvidence(res.html,kind,race.race_date);
        if(!parsed.ok){report.no_weather++;continue}
        let resultTrifecta=null;
        if(kind==="RESULT_ACTUAL"){
          const actual=await sr.RaceResult.filter({race_id:race.id},"-created_date",10);
          const valid=actual.filter(r=>(r.is_finished===true||r.result_status==="RESULT_FINAL")
            && /^[1-6]-[1-6]-[1-6]$/.test(String(r.result_trifecta||"")));
          const combos=new Set(valid.map(r=>r.result_trifecta));
          if(combos.size!==1){report.source_mismatch++;continue}
          const official=parseResult(res.html,race.race_date,race.venue_code,race.venue_name||"");
          const sourceCombo=official?.data?.venues?.[0]?.results?.[0]?.result_trifecta;
          if(!official?.ok||sourceCombo!==[...combos][0]){report.source_mismatch++;continue}
          resultTrifecta=sourceCombo;
        }
        const observedAt=new Date().toISOString();
        const output=weatherObservation({race,kind,parsed,observedAt,resultTrifecta,sourceUrl:url});
        if(!output||output.observation_key!==key){report.late++;continue}
        const created=await sr.V7WeatherObservation.create(output);
        if(!created?.id){report.errors++;continue}
        saved.add(key);report.saved++;report[kind==="PRE_REFERENCE"?"pre":"result"]++;
        if(output.quality==="PARTIAL")report.partial++;
        if(kind==="PRE_REFERENCE"&&(!created.created_date||Date.parse(String(created.created_date)+"Z")>=deadline-60000))
          console.error("[V7_WEATHER] PERSIST_AFTER_CUTOFF",key);
      }catch(error:any){
        report.errors++;
        console.error("[V7_WEATHER] FETCH_SAVE_ERROR",race.race_key,String(error?.message||error).slice(0,140));
      }
    }
    return Response.json({...report,completed_at:new Date().toISOString()});
  }catch(error:any){
    console.error("[V7_WEATHER] FATAL",String(error?.message||error).slice(0,150));
    return Response.json({ok:false,error:"WEATHER_CAPTURE_FAILED"},{status:503});
  }finally{
    if(lock)await releaseLock(client,lock).catch(()=>{});
  }
}