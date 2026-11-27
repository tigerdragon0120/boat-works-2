import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as repository from '../base44/shared/v8Repository.js';
import * as settlement from '../base44/shared/v8Settlement.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';
import {hasCompleteResultDetails} from '../base44/shared/v8ResultDetails.js';
import {validateResearchRace} from '../base44/shared/v8ResearchRaceDeadline.js';

const NOW=Date.parse('2026-11-22T11:00:00Z');
const race={id:'race-001',race_key:'2026-11-22_12_08',race_date:'2026-11-22',venue_code:'12',venue_name:'住之江',race_number:8,deadline:'2026-11-22T09:39:00Z',status:'finished',exhibition_ready:true};
const forecast=(stage='PRE',overrides={})=>({id:'replay-'+stage,forecast_key:'V8_FORECAST_1_REPLAY_1:'+race.race_key+':'+stage,revision:'V8_FORECAST_1_REPLAY_1',record_mode:'REPLAY',race_id:race.id,race_key:race.race_key,race_date:race.race_date,deadline:race.deadline,stage,
  generated_at:'2026-11-22T10:55:00Z',created_date:'2026-11-22T10:55:00.100Z',input_as_of:'2026-11-22T10:50:00Z',exhibition_complete:stage==='FINAL',research_tickets:['1-2-3','1-3-2'],decision:{status:'REPLAY'},
  provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true},top_scenario_key:'escape1',scenarios:[{key:'escape1',leader:1,method:'ESCAPE'}],...overrides});
const result={id:'result-001',race_id:race.id,result_status:'RESULT_FINAL',is_finished:true,result_trifecta:'1-2-3',payout:850,source:'LOCAL',finished_at:'2026-11-22T09:42:00Z',winning_method:'逃げ',boats:Array.from({length:6},(_,i)=>({boat_number:i+1,finish_order:i+1}))};
const proof={id:'proof-001',evidence_type:'LIVE',race_id:race.id,race_key:race.race_key,result_id:result.id,result_trifecta:result.result_trifecta,source:'LOCAL',fetched_at:'2026-11-22T10:45:00Z',recorded_at:'2026-11-22T10:45:00.100Z',created_date:'2026-11-22T10:45:00.200Z'};
const settle=row=>settlement.settleReplayForecast({forecast:row,result,provenance:proof,now:new Date(NOW).toISOString()});
const livePre=()=>forecast('PRE',{id:'live-pre',forecast_key:'live-pre',record_mode:'LIVE',generated_at:'2026-11-22T08:00:00Z',created_date:'2026-11-22T08:00:00.100Z',input_as_of:'2026-11-22T07:59:00Z',decision:{status:'WATCH'}});

test('late reconstruction has its own eligibility and never appears as live or first BUY',()=>{
  const row=forecast('FINAL');
  assert.equal(repository.eligibleReplayForecast(row,NOW),true);
  assert.equal(repository.eligibleForecast(row,NOW),false);
  assert.equal(repository.canonicalForecasts([row],NOW).rows.length,0);
  assert.equal(repository.canonicalReplayForecasts([row],NOW).rows.length,1);
  assert.equal(repository.firstBuyForecasts([{...row,decision:{status:'BUY'}}]).length,0);
  assert.equal(settlement.settleForecast({forecast:row,result,provenance:proof,now:new Date(NOW).toISOString()}).reason,'REPLAY_REQUIRES_SEPARATE_COHORT');
});
test('replay settlement scores all research tickets without creating a BUY result',()=>{
  const out=settle(forecast('FINAL'));
  assert.equal(out.ok,true);assert.equal(out.record.source_kind,'REPLAY');assert.equal(out.record.record_mode,'REPLAY');
  assert.equal(out.record.forecast_id,'replay-FINAL');assert.equal(out.record.research_hit,true);assert.equal(out.record.research_stake,200);assert.equal(out.record.research_return,850);
  assert.equal(out.record.buy_selected,false);assert.equal(out.record.buy_stake,0);assert.equal(out.record.buy_return,0);
  assert.equal(out.record.provenance.prospective_statistics_eligible,false);
});
test('replay requires honest timestamps, result exclusion, whitelisted inputs and complete FINAL',()=>{
  for(const changes of [
    {generated_at:'2026-11-22T09:00:00Z'}, {created_date:'2026-11-22T10:54:59Z'},
    {generated_at:'2026-11-22T11:01:00Z',created_date:'2026-11-22T11:01:00Z'}, {input_as_of:'2026-11-22T10:56:00Z'},
    {provenance:{result_excluded:false,reconstruction:true,input_fields_whitelisted:true}},
    {provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:false}}, {decision:{status:'BUY'}}, {exhibition_complete:false}, {stage:'DAY_BEFORE'}
  ])assert.equal(settle(forecast('FINAL',changes)).reason,'INVALID_REPLAY_SOURCE');
});
test('same-key replay ambiguity is held and its source records stay immutable',()=>{
  const row=forecast('FINAL'),before=JSON.stringify({row,result,proof});
  const canonical=repository.canonicalReplayForecasts([row,{...row,id:'duplicate'}],NOW);
  assert.deepEqual(canonical.conflicts,[row.forecast_key]);assert.equal(canonical.rows.length,0);
  settle(row);assert.equal(JSON.stringify({row,result,proof}),before);
});
test('pipeline coverage prefers live PRE, accepts replay FINAL, and requires both verified sources',()=>{
  const pre=livePre(),replayPre=forecast(),final=forecast('FINAL');
  const liveResult=settlement.settleForecast({forecast:pre,result,provenance:proof,now:new Date(NOW).toISOString()}).record;
  const replayResult=settle(final).record;
  const input={races:[race],forecasts:[pre],replayForecasts:[replayPre,final],verifications:[{...liveResult,id:'v-live'}],replayVerifications:[],now:NOW};
  let out=repository.buildRaceProgress(input);
  assert.equal(out.rows[0].pre.record_mode,'LIVE');assert.equal(out.rows[0].final.record_mode,'REPLAY');assert.equal(out.rows[0].verification.state,'PARTIAL');assert.equal(out.coverage.pending_races,1);
  out=repository.buildRaceProgress({...input,replayVerifications:[{...replayResult,id:'v-replay'}]});
  assert.equal(out.rows[0].status,'VERIFIED');assert.equal(out.coverage.verified_races,1);assert.equal(out.coverage.pending_races,0);
  assert.equal(out.coverage.replay_pre_count,0);assert.equal(out.coverage.replay_final_count,1);
});

const source=readFileSync(new URL('../base44/shared/v8VerificationRunner.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const executable=stripTypeScriptTypes(source).replace(/^export /gm,'');
const imports=['jstDate','dateValid','readV8Rows','canonicalForecasts','canonicalReplayForecasts','latestForecasts','firstBuyForecasts','groupBy','isCompleteFinalForecast'];
const factory=new Function('createClientFromRequest','acquireLock','releaseLock',...imports,'settleForecast','settleReplayForecast','settleExcludedForecast','settleExternal','utcMs','SETTLEMENT_REVISION','hasCompleteResultDetails','validateResearchRace',executable+'\nreturn {runV8VerifyForecasts};');
const matches=(row,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]):row[key]===value);
const makeProvider=()=>{
  const data={Race:[race],RaceResult:[result],ResultProvenance:[proof],V8RaceForecast:[forecast(),forecast('FINAL')],V8ExternalPrediction:[],V8ForecastVerification:[]},calls=[];
  const entities=Object.fromEntries(Object.entries(data).map(([name,rows])=>[name,{
    async filter(query,options){calls.push({name,query});assert.equal(typeof options,'object');return {items:rows.filter(row=>matches(row,query)),has_more:false};},
    async create(input){const row={...input,id:name+'-'+rows.length,created_date:new Date().toISOString()};rows.push(row);return row;}
  }]));
  const client={auth:{me:async()=>({role:'admin'})},asServiceRole:{entities}};
  const handlers=factory(()=>client,async()=> 'lock',async()=>{},...imports.map(name=>repository[name]),settlement.settleForecast,settlement.settleReplayForecast,settlement.settleExcludedForecast,settlement.settleExternal,utcMs,settlement.SETTLEMENT_REVISION,hasCompleteResultDetails,validateResearchRace);
  return {client,data,calls,...handlers};
};
test('actual worker batches result reads and reruns without duplicating completed replay settlements',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const env=makeProvider(),first=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date],budgetMs:10000,max_created:10});
  assert.equal(first.created,2);assert.equal(first.replay,2);assert.equal(first.live,0);assert.equal(first.errors,0);assert.equal(first.remaining_sources,0);
  assert.equal(env.calls.filter(call=>call.name==='RaceResult').length,1);assert.equal(env.calls.filter(call=>call.name==='ResultProvenance').length,1);
  assert.equal(env.calls.filter(call=>call.name==='V8ForecastVerification').length,2);
  const second=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date],budgetMs:10000,max_created:10});
  assert.equal(second.created,0);assert.equal(env.data.V8ForecastVerification.length,2);
});
test('worker budget batch size resumes pending stages on a later call',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const env=makeProvider();
  const first=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date],max_created:1});assert.equal(first.created,1);assert.equal(first.remaining_sources,1);
  const second=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date],max_created:1});assert.equal(second.created,1);assert.equal(second.remaining_sources,0);
});
test('refund evidence produces an exclusion receipt without fabricated loss or return',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const env=makeProvider();
  env.data.RaceResult[0]={...result,refund_boats:[6]};
  const out=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date]});
  assert.equal(out.created,2);assert.equal(out.excluded,2);
  for(const row of env.data.V8ForecastVerification){assert.equal(row.status,'EXCLUDED_REFUND');assert.equal(Object.hasOwn(row,'research_return'),false);assert.equal(Object.hasOwn(row,'research_hit'),false);}
  const progress=repository.buildRaceProgress({races:[race],replayForecasts:env.data.V8RaceForecast,replayVerifications:env.data.V8ForecastVerification,now:NOW});
  assert.equal(progress.rows[0].status,'RESULT_EXCLUDED');assert.equal(progress.coverage.pending_races,0);assert.equal(progress.coverage.verified_races,0);assert.equal(progress.coverage.fully_completed_races,1);
});

test('old-revision settlement does not block rechecking after complete official details arrive',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});const env=makeProvider();
  const old={...settle(forecast('PRE')).record,id:'old-receipt',revision:'V8_SETTLEMENT_1',verification_key:'V8_SETTLEMENT_1:REPLAY:replay-PRE:'+result.id};
  env.data.V8ForecastVerification.push(old);
  env.data.RaceResult[0]={...result,boats:[],finish_order:[]};
  const held=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date]});
  assert.equal(held.created,0);assert.equal(held.reasons.RESULT_DETAILS_PENDING,1);
  assert.equal(env.data.V8ForecastVerification.length,1);
  env.data.RaceResult[0]=structuredClone(result);
  const recovered=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date]});
  assert.equal(recovered.created,2);assert.equal(env.data.V8ForecastVerification.length,3);
  assert.deepEqual(env.data.V8ForecastVerification[0],old);
  for(const row of env.data.V8ForecastVerification.slice(1)){assert.equal(row.revision,'V8_SETTLEMENT_2');assert.equal(row.provenance.result_details_complete,true);}
  const repeat=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date]});assert.equal(repeat.created,0);
});

test('progress prefers completed LIVE then completed REPLAY and never treats a partial FINAL as finished',()=>{
 const pre=livePre(),partial={...livePre(),id:'live-partial',forecast_key:'live-partial',stage:'FINAL',exhibition_complete:false,generated_at:'2026-11-22T09:10:00Z',created_date:'2026-11-22T09:10:00.100Z'},replay=forecast('FINAL');
 const settledPre={...settlement.settleForecast({forecast:pre,result,provenance:proof,now:new Date(NOW).toISOString()}).record,id:'pre-settled'};
 const settledReplay={...settle(replay).record,id:'replay-settled'};
 const args={races:[race],forecasts:[pre,partial],replayForecasts:[replay],verifications:[settledPre],replayVerifications:[settledReplay],now:NOW};
 const before=JSON.stringify(args),fallback=repository.buildRaceProgress(args);
 assert.equal(fallback.rows[0].final.forecast_id,replay.id);assert.equal(fallback.rows[0].status,'VERIFIED');assert.equal(JSON.stringify(args),before);
 const complete={...partial,id:'live-complete',forecast_key:'live-complete',exhibition_complete:true,generated_at:'2026-11-22T08:40:00Z',created_date:'2026-11-22T08:40:00.100Z'};
 const settledComplete={...settlement.settleForecast({forecast:complete,result,provenance:proof,now:new Date(NOW).toISOString()}).record,id:'live-complete-settled'};
 const preferLive=repository.buildRaceProgress({...args,forecasts:[pre,complete,partial],verifications:[settledPre,settledComplete]});
 assert.equal(preferLive.rows[0].final.forecast_id,complete.id);assert.equal(preferLive.rows[0].final.record_mode,'LIVE');assert.equal(preferLive.rows[0].status,'VERIFIED');
 const waiting=repository.buildRaceProgress({...args,replayForecasts:[],replayVerifications:[]});
 assert.equal(waiting.rows[0].final.state,'PENDING');assert.equal(waiting.rows[0].status,'FINAL_PENDING');assert.equal(waiting.coverage.final_available_count,0);
});

test('worker verifies an earlier complete LIVE FINAL and complete REPLAY while leaving partial history untouched',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:NOW});const env=makeProvider(),pre=livePre();
 const complete={...pre,id:'complete-live',forecast_key:'complete-live',stage:'FINAL',exhibition_complete:true,generated_at:'2026-11-22T08:40:00Z',created_date:'2026-11-22T08:40:00.100Z'};
 const partial={...complete,id:'partial-live',forecast_key:'partial-live',exhibition_complete:false,generated_at:'2026-11-22T09:10:00Z',created_date:'2026-11-22T09:10:00.100Z',decision:{status:'BUY'}};
 env.data.V8RaceForecast.splice(0,env.data.V8RaceForecast.length,pre,complete,partial,forecast('FINAL'));
 const before=JSON.stringify(env.data.V8RaceForecast),out=await env.runV8VerifyForecasts(env.client,{dates:[race.race_date]});
 assert.equal(out.created,3);assert.equal(out.live,2);assert.equal(out.replay,1);
 assert.deepEqual(env.data.V8ForecastVerification.map(row=>row.forecast_id).sort(),['complete-live','live-pre','replay-FINAL']);
 assert.equal(JSON.stringify(env.data.V8RaceForecast),before);
});

test('a corrected timetable settles first BUY and latest FINAL and clears coverage without rewriting forecasts',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-28T00:00:00Z')});
 const env=makeProvider(),updatedRace={...race,race_key:'2026-11-27_17_10',race_date:'2026-11-27',venue_code:'17',race_number:10,
   deadline:'2026-11-27T14:21:00+09:00'};
 const firstTickets=['1-4-3','1-3-4','1-4-5','1-3-5','1-4-2','1-5-4','1-5-3','1-3-2','1-4-6','1-3-6','1-5-2'];
 const lastTickets=['1-4-3','1-4-2','1-4-5','1-2-4','1-5-4','1-4-6','1-2-3','1-2-5','1-3-4','1-5-3','4-1-3','4-1-2'];
 const makeFinal=(id,generated,created,input,tickets)=>({...updatedRace,id,race_id:race.id,stage:'FINAL',record_mode:'LIVE',forecast_key:id,
   revision:'V8_FORECAST_7_HEAD_COVERAGE',deadline:'2026-11-27T14:22:00+09:00',generated_at:generated,created_date:created,input_as_of:input,
   exhibition_complete:true,research_tickets:firstTickets.slice(0,8),decision:{status:'BUY',tickets},
   final_selection:{revision:'V8_FINAL_SELECTION_1',status:'BUY',tickets,ticket_count:tickets.length}});
 const first=makeFinal('first-buy','2026-11-27T05:06:13.019Z','2026-11-27T05:06:13.310000','2026-11-27T05:06:07.548Z',firstTickets);
 const latest=makeFinal('latest-final','2026-11-27T05:16:10.972Z','2026-11-27T05:16:11.405000','2026-11-27T05:16:09.036Z',lastTickets);
 const pre={...first,id:'pre-same-deadline',forecast_key:'pre-same-deadline',stage:'PRE',deadline:updatedRace.deadline,
   generated_at:'2026-11-27T00:25:56.736Z',created_date:'2026-11-27T00:25:56.992000',input_as_of:'2026-11-27T00:25:00Z',
   final_selection:null,exhibition_complete:false,decision:{status:'WATCH'}};
 latest.comparison={baseline_id:pre.id};
 const updatedResult={...result,result_trifecta:'5-4-1',payout:13000,finished_at:'2026-11-27T05:35:09.095Z',
   boats:[5,4,1,2,3,6].map((boat,index)=>({boat_number:boat,finish_order:index+1}))};
 const updatedProof={...proof,race_key:updatedRace.race_key,result_trifecta:'5-4-1',fetched_at:'2026-11-27T05:35:08.696Z',
   recorded_at:'2026-11-27T05:35:09.353Z',created_date:'2026-11-27T05:35:09.697000'};
 env.data.Race.splice(0,1,updatedRace);env.data.RaceResult.splice(0,1,updatedResult);env.data.ResultProvenance.splice(0,1,updatedProof);
 env.data.V8RaceForecast.splice(0,env.data.V8RaceForecast.length,pre,first,latest);
 const before=JSON.stringify(env.data.V8RaceForecast),out=await env.runV8VerifyForecasts(env.client,{dates:[updatedRace.race_date]});
 assert.equal(out.created,3);assert.equal(out.held,0);assert.equal(out.errors,0);assert.equal(out.remaining_sources,0);
 const firstReceipt=env.data.V8ForecastVerification.find(row=>row.forecast_id===first.id);
 const lastReceipt=env.data.V8ForecastVerification.find(row=>row.forecast_id===latest.id);
 assert.equal(firstReceipt.final_selection_result.stake,1100);assert.equal(lastReceipt.final_selection_result.stake,1200);
 assert.equal(firstReceipt.final_selection_result.hit,false);assert.equal(lastReceipt.final_selection_result.hit,false);
 assert.equal(firstReceipt.provenance.race_deadline_reconciliation.saved_deadline,first.deadline);
 assert.equal(lastReceipt.provenance.race_deadline_reconciliation.current_deadline,updatedRace.deadline);
 const progress=repository.buildRaceProgress({races:env.data.Race,forecasts:env.data.V8RaceForecast,
   verifications:env.data.V8ForecastVerification,results:env.data.RaceResult});
 assert.equal(progress.coverage.pending_races,0);assert.equal(progress.rows[0].status,'VERIFIED');
 assert.equal(progress.rows[0].final.forecast_id,latest.id);assert.equal(progress.rows[0].pre.forecast_id,pre.id);
 assert.equal(JSON.stringify(env.data.V8RaceForecast),before);
 const repeated=await env.runV8VerifyForecasts(env.client,{dates:[updatedRace.race_date]});
 assert.equal(repeated.created,0);assert.equal(env.data.V8ForecastVerification.length,3);
});
