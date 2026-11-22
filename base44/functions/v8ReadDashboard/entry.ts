// Read-only API. Public forecasts and private external evidence have separate access paths.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {jstDate,dateValid,readV8Rows,canonicalForecasts,latestForecasts,firstBuyForecasts,currentDecision,groupBy,publicRow} from '../../shared/v8Repository.js';
import {utcMs} from '../../shared/v7FeatureObservation.js';

const compactRace=(r:any)=>({id:r.id,race_key:r.race_key,race_date:r.race_date,venue_code:r.venue_code,venue_name:r.venue_name||r.venue,race_number:r.race_number,deadline:r.deadline,status:r.status,exhibition_ready:r.exhibition_ready,is_womens:r.is_womens,series_name:r.series_name});
export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null,body:any={};
  try{user=await client.auth.me()}catch{}
  try{body=await req.json()}catch{return Response.json({ok:false,error:'INVALID_JSON'},{status:400});}
  if(!body||typeof body!=='object'||Array.isArray(body))return Response.json({ok:false,error:'INVALID_BODY'},{status:400});
  const mode=body.mode||'day',admin=user?.role==='admin',sr=client.asServiceRole.entities;
  if(!['day','race','verification'].includes(mode))return Response.json({ok:false,error:'INVALID_MODE'},{status:400});
  if(mode==='verification'&&!admin)return Response.json({ok:false,error:'Forbidden'},{status:403});
  const now=Date.now(),budget=now+35000;
  try{
    let query:any={},raceQuery:any={},races:any[]=[],dates:string[]=[];
    if(mode==='race'){
      if(typeof body.race_id!=='string'||!/^[a-zA-Z0-9_-]{5,80}$/.test(body.race_id))return Response.json({ok:false,error:'INVALID_RACE'},{status:400});
      const race=await sr.Race.get(body.race_id);
      if(!race?.id)return Response.json({ok:false,error:'RACE_NOT_FOUND'},{status:404});
      if(typeof race.race_key!=='string'||!race.race_key)return Response.json({ok:false,error:'RACE_IDENTITY_UNVERIFIED'},{status:409});
      // A single ID lookup cannot establish uniqueness of the logical race.
      // Read the whole key group so race/day views apply the same ambiguity guard.
      races=await readV8Rows(sr.Race,{race_key:race.race_key},{budget,maxPages:16});
      if(!races.some(r=>r.id===race.id&&r.race_key===race.race_key))return Response.json({ok:false,error:'RACE_IDENTITY_CHANGED'},{status:409});
      dates=[race.race_date];query={race_id:race.id};
    }else{
      if(mode==='day'){
        const day=body.race_date||jstDate();
        if(!dateValid(day)||day<jstDate(-31)||day>jstDate(1))return Response.json({ok:false,error:'INVALID_DATE'},{status:400});
        dates=[day];
      }else{
        const days=Number(body.days??7);
        if(!Number.isInteger(days)||days<1||days>7)return Response.json({ok:false,error:'DAYS_MUST_BE_1_TO_7'},{status:400});
        dates=Array.from({length:days},(_,i)=>jstDate(-i));
      }
      query={race_date:{$in:dates}};raceQuery=query;
      races=await readV8Rows(sr.Race,raceQuery,{budget,maxPages:16});
    }
    const [raw,externalRaw,verificationRaw,theories]=await Promise.all([
      readV8Rows(sr.V8RaceForecast,query,{budget,maxPages:90}),
      admin&&mode!=='day'?readV8Rows(sr.V8ExternalPrediction,query,{budget,maxPages:30}):Promise.resolve([]),
      mode==='verification'||mode==='race'?readV8Rows(sr.V8ForecastVerification,{...query,...(!admin?{source_kind:'FORECAST'}:{})},{budget,maxPages:90}):Promise.resolve([]),
      admin&&mode==='race'?readV8Rows(sr.V8TheoryTrial,query,{budget,maxPages:6}):Promise.resolve([])
    ]);
    const allRaceKeys=new Set(races.map(r=>r.race_key).filter(Boolean));
    const raceGroups=groupBy(races,'race_key');
    const ambiguousRaceKeys=[...raceGroups.entries()].filter(([,g])=>g.length!==1).map(([key])=>key);
    races=[...raceGroups.values()].filter(g=>g.length===1).map(g=>g[0]);
    const validRaceIds=new Set(races.map(r=>r.id));
    const canonical=canonicalForecasts(raw.filter(f=>validRaceIds.has(f.race_id)),now),latest=latestForecasts(canonical.rows),buys=firstBuyForecasts(canonical.rows);
    const byId=new Map(canonical.rows.map(r=>[r.id,r]));
    const selected=new Map(latest.map(r=>[r.id,r]));
    // Include the actual referenced baseline even when another version exists.
    for(const final of latest.filter(r=>r.stage==='FINAL')){const id=final.comparison?.baseline_id; if(id&&byId.has(id))selected.set(id,byId.get(id));}
    const ids=new Set(selected.keys()),buyIds=new Set(buys.map(b=>b.id));
    const external=externalRaw.filter(r=>r.use_scope==='PRIVATE_RESEARCH');
    const externalIds=new Set(external.map(r=>r.id));
    const verificationGroups=groupBy(verificationRaw,'verification_key');
    const settlements=[...verificationGroups.values()].filter(g=>g.length===1).map(g=>g[0]);
    const verified=settlements.filter(v=>v.source_kind==='FORECAST'?ids.has(v.forecast_id):admin&&externalIds.has(v.external_id));
    const racesById=new Map(races.map(r=>[r.id,r]));
    const finals=new Map(latest.filter(r=>r.stage==='FINAL').map(r=>[r.race_id,r]));
    const raceKeys=allRaceKeys;
    const captured=new Set(latest.map(r=>r.race_key));
    const publicForecast=(f:any)=>({...publicRow(f),effective_status:currentDecision(f,racesById.get(f.race_id),now)});
    return Response.json({ok:true,mode,generated_at:new Date(now).toISOString(),race_date:dates[0]||races[0]?.race_date,
      races:races.map(compactRace),forecasts:[...selected.values()].map(publicForecast),
      buy_forecasts:buys.map(publicForecast),
      verifications:verified.map(publicRow),buy_verifications:settlements.filter(v=>v.source_kind==='FORECAST'&&buyIds.has(v.forecast_id)).map(publicRow),
      external:external.map(publicRow),theories:theories.map(publicRow),ambiguous_race_keys:ambiguousRaceKeys,
      coverage:{expected_races:raceKeys.size,captured_races:captured.size,missing_races:[...raceKeys].filter(k=>!captured.has(k)).length,
        day_before_count:latest.filter(f=>f.stage==='DAY_BEFORE').length,pre_count:latest.filter(f=>f.stage==='PRE').length,final_count:finals.size,
        active_buy_count:[...finals.values()].filter(f=>currentDecision(f,racesById.get(f.race_id),now)==='BUY').length,
        ambiguous_race_keys:ambiguousRaceKeys.length,ambiguous_forecast_keys:canonical.conflicts.length,ambiguous_verification_keys:[...verificationGroups.values()].filter(g=>g.length!==1).length},
      errors:canonical.conflicts.length?['予想キーの重複がある記録を保留しました']:[],
      policies:{buy_evaluation:'FIRST_PUBLISHED_BUY_PER_RACE',forecast_evaluation:'LATEST_STAGE_BEFORE_DEADLINE',stake_per_ticket:100,research_only:true,external_automatic_collection:'NOT_CONNECTED',weather_forecast:'NOT_CONNECTED',tide:'NOT_CONNECTED'}
    },{headers:{'Cache-Control':'private, no-store'}});
  }catch(error:any){console.error('[V8_READ]',String(error?.message||error).slice(0,150));return Response.json({ok:false,error:'READ_INCOMPLETE',message:'データを最後まで確認できないため表示を保留しました。再読込してください。'},{status:503});}
}
