// Read-only API. Public forecasts and private external evidence have separate access paths.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {jstDate,dateValid,readV8Rows,canonicalForecasts,canonicalReplayForecasts,latestForecasts,firstBuyForecasts,currentDecision,groupBy,publicRow,buildRaceProgress,isCompleteFinalForecast} from '../../shared/v8Repository.js';
import {utcMs} from '../../shared/v7FeatureObservation.js';
import {SETTLEMENT_REVISION} from '../../shared/v8Settlement.js';
import {selectDisplayOddsSnapshot} from '../../shared/v8DisplayOdds.js';

const compactRace=(r:any)=>({id:r.id,race_key:r.race_key,race_date:r.race_date,venue_code:r.venue_code,venue_name:r.venue_name||r.venue,race_number:r.race_number,deadline:r.deadline,status:r.status,exhibition_ready:r.exhibition_ready,is_womens:r.is_womens,series_name:r.series_name});
// Verification consumes an index of immutable predictions, not the boat/source
// documents used by race detail. Project before paging to bound DB transfer and
// memory, then enforce the same whitelist on the returned overview payload.
const verificationFields:Record<string,string[]>={
  Race:['id','race_key','race_date','venue_code','venue_name','venue','race_number','deadline','status','exhibition_ready','is_womens','series_name'],
  V8RaceForecast:['id','revision','forecast_key','race_id','race_key','race_date','venue_code','venue_name','race_number','deadline','stage','record_mode',
    'generated_at','created_date','input_as_of','quality','exhibition_complete','research_tickets','comparison.baseline_id','baseline_id',
    'decision.status','decision.tickets','decision.valid_until','decision.odds_captured_at',
    'provenance.result_excluded','provenance.reconstruction','provenance.input_fields_whitelisted',
    'final_selection.revision','final_selection.status','final_selection.stage','final_selection.probability_calibrated',
    'final_selection.tickets','final_selection.ticket_count','final_selection.policy_revision',
    'final_selection.ranked_tickets.rank','final_selection.ranked_tickets.ticket','final_selection.ranked_tickets.score'],
  V8ForecastVerification:['id','revision','verification_key','source_kind','forecast_id','external_id','race_id','race_key','race_date','venue_code','venue_name',
    'race_number','stage','status','research_tickets','research_hit','research_stake','research_return','information_fee','result_trifecta',
    'final_selection_result','buy_selected','created_date'],
  V8ExternalPrediction:['id','use_scope','verification_eligible','race_id','race_key','race_date','venue_code','venue_name','race_number',
    'source_name','forecaster_name','stage','generated_at','recorded_at','created_date'],
};
const fieldTree=(fields:string[])=>{
  const tree:any={};
  for(const field of fields){
    const keys=field.split('.');let branch=tree;
    keys.forEach((key,index)=>{if(index===keys.length-1)branch[key]=true;else branch=branch[key]||(branch[key]={});});
  }
  return tree;
};
const verificationTrees=Object.fromEntries(Object.entries(verificationFields).map(([name,fields])=>[name,fieldTree(fields)]));
const projectOverview=(value:any,tree:any):any=>{
  if(value==null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>projectOverview(item,tree));
  const out:any={};
  for(const [key,branch] of Object.entries(tree))if(Object.hasOwn(value,key))out[key]=branch===true?value[key]:projectOverview(value[key],branch);
  return out;
};
const safeReadCode=(error:any)=>{
  const codes=['read_budget_exhausted','page_read_failed_or_timed_out','page_format_invalid','page_row_invalid_or_repeated','terminal_cursor_invalid','continuation_invalid_or_repeated','page_safety_limit','retry_budget_exhausted'];
  return codes.some(code=>error?.message==='INCOMPLETE_READ:'+code)?error.message:'READ_FAILED';
};
const safeErrorKind=(error:any)=>['Error','TypeError','RangeError','ReferenceError','SyntaxError','URIError','AggregateError','AbortError','TimeoutError'].includes(error?.name)?error.name:'UnknownError';
export default async function(req:Request):Promise<Response>{
  const started=Date.now(),client=createClientFromRequest(req);let user:any=null,body:any={};
  try{user=await client.auth.me()}catch{}
  try{body=await req.json()}catch{return Response.json({ok:false,error:'INVALID_JSON'},{status:400});}
  if(!body||typeof body!=='object'||Array.isArray(body))return Response.json({ok:false,error:'INVALID_BODY'},{status:400});
  const mode=body.mode||'day',admin=user?.role==='admin',sr=client.asServiceRole.entities;
  if(!['day','race','verification'].includes(mode))return Response.json({ok:false,error:'INVALID_MODE'},{status:400});
  if(mode==='verification'&&!admin)return Response.json({ok:false,error:'Forbidden'},{status:403});
  const now=Date.now(),budget=now+35000;
  let phase='READ_RACES';
  const readCounts:Record<string,number>={},readElapsed:Record<string,number>={},selectedCounts:Record<string,number>={};
  const diagnosticState=()=>({phase,mode,elapsed_ms:Math.max(0,Date.now()-started),read_rows:{...readCounts},read_ms:{...readElapsed},selected_rows:{...selectedCounts}});
  const publicOverview=(name:string,row:any)=>mode==='verification'?projectOverview(publicRow(row),verificationTrees[name]):publicRow(row);
  const readEntity=async(name:string,filter:any,options:any)=>{
    const readStarted=Date.now();
    try{
      const fields=mode==='verification'?verificationFields[name]:null;
      const rows=await readV8Rows(sr[name],filter,{...options,...(fields?{fields}:{})});
      readCounts[name]=(readCounts[name]||0)+rows.length;readElapsed[name]=(readElapsed[name]||0)+Math.max(0,Date.now()-readStarted);
      return rows;
    }
    catch(error:any){
      const code=safeReadCode(error);
      readElapsed[name]=(readElapsed[name]||0)+Math.max(0,Date.now()-readStarted);
      const wrapped:any=new Error(code);wrapped.read_context=name;wrapped.read_kind=safeErrorKind(error);
      if(Number.isInteger(error?.http_status)&&error.http_status>=100&&error.http_status<=599)wrapped.http_status=error.http_status;
      throw wrapped;
    }
  };
  try{
    let query:any={},raceQuery:any={},races:any[]=[],dates:string[]=[];
    if(mode==='race'){
      if(typeof body.race_id!=='string'||!/^[a-zA-Z0-9_-]{5,80}$/.test(body.race_id))return Response.json({ok:false,error:'INVALID_RACE'},{status:400});
      const race=await sr.Race.get(body.race_id);
      if(!race?.id)return Response.json({ok:false,error:'RACE_NOT_FOUND'},{status:404});
      if(typeof race.race_key!=='string'||!race.race_key)return Response.json({ok:false,error:'RACE_IDENTITY_UNVERIFIED'},{status:409});
      // A single ID lookup cannot establish uniqueness of the logical race.
      // Read the whole key group so race/day views apply the same ambiguity guard.
      races=await readEntity('Race',{race_key:race.race_key},{budget,maxPages:16});
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
      races=await readEntity('Race',raceQuery,{budget,maxPages:16});
    }
    phase='READ_RECORDS';
    const [raw,externalRaw,verificationRaw,theories,displayOdds]=await Promise.all([
      readEntity('V8RaceForecast',query,{budget,maxPages:90}),
      admin&&mode!=='day'?readEntity('V8ExternalPrediction',query,{budget,maxPages:30}):Promise.resolve([]),
      readEntity('V8ForecastVerification',{...query,...(!admin?{source_kind:{$in:['FORECAST','REPLAY']}}:{})},{budget,maxPages:90}),
      admin&&mode==='race'?readEntity('V8TheoryTrial',query,{budget,maxPages:6}):Promise.resolve([]),
      // Optional display data travels with the existing race request. It does not
      // create another paid function invocation or make forecast reads depend on odds.
      mode==='race'&&races.length===1
        ?readEntity('OddsSnapshot',{race_id:races[0].id},{budget:Math.min(budget,Date.now()+6000),maxPages:4,sort:'-captured_at'})
          .then(rows=>{const snapshot=selectDisplayOddsSnapshot(rows,races[0],now);return {status:snapshot?'AVAILABLE':'MISSING',snapshot};})
          .catch(()=>({status:'UNAVAILABLE',snapshot:null}))
        :Promise.resolve({status:'MISSING',snapshot:null})
    ]);
    phase='SELECT_RACES';
    const allRaceKeys=new Set(races.map(r=>r.race_key).filter(Boolean));
    const raceGroups=groupBy(races,'race_key');
    const ambiguousRaceKeys=[...raceGroups.entries()].filter(([,g])=>g.length!==1).map(([key])=>key);
    races=[...raceGroups.values()].filter(g=>g.length===1).map(g=>g[0]);
    const validRaceIds=new Set(races.map(r=>r.id));
    selectedCounts.races=races.length;
    phase='SELECT_FORECASTS';
    const canonical=canonicalForecasts(raw.filter(f=>validRaceIds.has(f.race_id)),now);
    const liveStages=canonical.rows.filter(row=>row.stage!=='FINAL'||isCompleteFinalForecast(row));
    const latest=latestForecasts(liveStages),buys=firstBuyForecasts(liveStages);
    const replayCanonical=canonicalReplayForecasts(raw.filter(f=>validRaceIds.has(f.race_id)),now);
    const replayLatest=latestForecasts(replayCanonical.rows.filter(row=>row.stage!=='FINAL'||isCompleteFinalForecast(row)));
    const byId=new Map([...canonical.rows,...replayCanonical.rows].map(r=>[r.id,r]));
    const selected=new Map(latest.map(r=>[r.id,r]));
    const replaySelected=new Map(replayLatest.map(r=>[r.id,r]));
    // Include the actual referenced baseline even when another version exists.
    for(const final of [...latest,...replayLatest].filter(r=>r.stage==='FINAL')){const id=final.comparison?.baseline_id,row=id&&byId.get(id);if(row&&['DAY_BEFORE','PRE'].includes(row.stage))(row.record_mode==='REPLAY'?replaySelected:selected).set(id,row);}
    const ids=new Set(selected.keys()),replayIds=new Set(replaySelected.keys()),buyIds=new Set(buys.map(b=>b.id));
    selectedCounts.forecasts=selected.size;selectedCounts.replay_forecasts=replaySelected.size;selectedCounts.buy_forecasts=buys.length;
    phase='SELECT_VERIFICATIONS';
    const external=externalRaw.filter(r=>r.use_scope==='PRIVATE_RESEARCH');
    const externalIds=new Set(external.map(r=>r.id));
    // Earlier ledgers did not require outcomes for every active boat. Preserve
    // those rows but publish only the current, fully checked settlement cohort.
    const verificationGroups=groupBy(verificationRaw.filter(row=>row.revision===SETTLEMENT_REVISION),'verification_key');
    const settlements=[...verificationGroups.values()].filter(g=>g.length===1).map(g=>g[0]);
    const verified=settlements.filter(v=>v.source_kind==='FORECAST'?ids.has(v.forecast_id):v.source_kind==='EXTERNAL'&&admin&&externalIds.has(v.external_id));
    const replayVerified=settlements.filter(v=>v.source_kind==='REPLAY'&&replayIds.has(v.forecast_id));
    const buyVerified=settlements.filter(v=>v.source_kind==='FORECAST'&&buyIds.has(v.forecast_id));
    selectedCounts.verifications=verified.length;selectedCounts.replay_verifications=replayVerified.length;
    selectedCounts.buy_verifications=buyVerified.length;selectedCounts.external=external.length;
    const racesById=new Map(races.map(r=>[r.id,r]));
    const finals=new Map(latest.filter(r=>r.stage==='FINAL').map(r=>[r.race_id,r]));
    const raceKeys=allRaceKeys;
    const captured=new Set([...latest,...replayLatest].map(r=>r.race_key));
    phase='BUILD_PROGRESS';
    const progress=buildRaceProgress({races,forecasts:[...selected.values()],replayForecasts:[...replaySelected.values()],verifications:verified,replayVerifications:replayVerified,now});
    phase='BUILD_RESPONSE';
    const publicForecast=(f:any)=>({...publicOverview('V8RaceForecast',f),effective_status:currentDecision(f,racesById.get(f.race_id),now)});
    const publicVerification=(v:any)=>publicOverview('V8ForecastVerification',v);
    const payload={ok:true,mode,generated_at:new Date(now).toISOString(),race_date:dates[0]||races[0]?.race_date,
      races:races.map(compactRace),forecasts:[...selected.values()].map(publicForecast),
      ...(mode==='race'?{display_odds:displayOdds}:{}),
      replay_forecasts:[...replaySelected.values()].map(row=>({...publicOverview('V8RaceForecast',row),effective_status:'REPLAY'})),replay_verifications:replayVerified.map(publicVerification),race_progress:progress.rows,
      buy_forecasts:buys.map(publicForecast),
      verifications:verified.map(publicVerification),buy_verifications:buyVerified.map(publicVerification),
      external:external.map(row=>publicOverview('V8ExternalPrediction',row)),theories:theories.map(publicRow),ambiguous_race_keys:ambiguousRaceKeys,
      coverage:{...progress.coverage,expected_races:raceKeys.size,pending_races:progress.coverage.pending_races+ambiguousRaceKeys.length,captured_races:captured.size,missing_races:[...raceKeys].filter(k=>!captured.has(k)).length,
        day_before_count:latest.filter(f=>f.stage==='DAY_BEFORE').length,pre_count:latest.filter(f=>f.stage==='PRE').length,final_count:finals.size,
        active_buy_count:[...finals.values()].filter(f=>currentDecision(f,racesById.get(f.race_id),now)==='BUY').length,
        ambiguous_race_keys:ambiguousRaceKeys.length,ambiguous_forecast_keys:canonical.conflicts.length+replayCanonical.conflicts.length,ambiguous_verification_keys:[...verificationGroups.values()].filter(g=>g.length!==1).length},
      errors:canonical.conflicts.length||replayCanonical.conflicts.length?['予想キーの重複がある記録を保留しました']:[],
      policies:{buy_evaluation:'FIRST_PUBLISHED_BUY_PER_RACE',forecast_evaluation:'LATEST_STAGE_BEFORE_DEADLINE',replay_evaluation:'POST_DEADLINE_RECONSTRUCTION_SEPARATE_COHORT',all_races_research:true,stake_per_ticket:100,research_only:true,external_automatic_collection:'NOT_CONNECTED',weather_forecast:'NOT_CONNECTED',tide:'NOT_CONNECTED'}
    };
    phase='SERIALIZE_RESPONSE';
    const response=Response.json(payload,{headers:{'Cache-Control':'private, no-store'}});
    if(mode==='verification')console.info('[V8_READ_DONE]',JSON.stringify(diagnosticState()));
    return response;
  }catch(error:any){
    const contexts=['Race','V8RaceForecast','V8ExternalPrediction','V8ForecastVerification','V8TheoryTrial'];
    const diagnostic:any={context:contexts.includes(error?.read_context)?error.read_context:'RACE_OR_FORMAT',code:safeReadCode(error),
      kind:safeErrorKind({name:error?.read_kind||error?.name}),...diagnosticState()};
    if(Number.isInteger(error?.http_status)&&error.http_status>=100&&error.http_status<=599)diagnostic.http_status=error.http_status;
    console.error('[V8_READ]',JSON.stringify(diagnostic));
    return Response.json({ok:false,error:'READ_INCOMPLETE',diagnostic,message:'データを最後まで確認できないため表示を保留しました。再読込してください。'},{status:503});
  }
}
