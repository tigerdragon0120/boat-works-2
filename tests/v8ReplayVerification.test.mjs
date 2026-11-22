import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as repository from '../base44/shared/v8Repository.js';
import * as settlement from '../base44/shared/v8Settlement.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';

const NOW=Date.parse('2026-11-22T11:00:00Z');
const race={id:'race-001',race_key:'2026-11-22_12_08',race_date:'2026-11-22',venue_code:'12',venue_name:'住之江',race_number:8,deadline:'2026-11-22T09:39:00Z',status:'finished',exhibition_ready:true};
const forecast=(stage='PRE',overrides={})=>({id:'replay-'+stage,forecast_key:'V8_FORECAST_1_REPLAY_1:'+race.race_key+':'+stage,revision:'V8_FORECAST_1_REPLAY_1',record_mode:'REPLAY',race_id:race.id,race_key:race.race_key,race_date:race.race_date,deadline:race.deadline,stage,
  generated_at:'2026-11-22T10:55:00Z',created_date:'2026-11-22T10:55:00.100Z',input_as_of:'2026-11-22T10:50:00Z',exhibition_complete:stage==='FINAL',research_tickets:['1-2-3','1-3-2'],decision:{status:'REPLAY'},
  provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true},top_scenario_key:'escape1',scenarios:[{key:'escape1',leader:1,method:'ESCAPE'}],...overrides});
const result={id:'result-001',race_id:race.id,result_status:'RESULT_FINAL',is_finished:true,result_trifecta:'1-2-3',payout:850,source:'LOCAL',finished_at:'2026-11-22T09:42:00Z',winning_method:'逃げ'};
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
const imports=['jstDate','dateValid','readV8Rows','canonicalForecasts','canonicalReplayForecasts','latestForecasts','firstBuyForecasts','groupBy'];
const factory=new Function('createClientFromRequest','acquireLock','releaseLock',...imports,'settleForecast','settleReplayForecast','settleExcludedForecast','settleExternal','utcMs',executable+'\nreturn {runV8VerifyForecasts};');
const matches=(row,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]):row[key]===value);
const makeProvider=()=>{
  const data={Race:[race],RaceResult:[result],ResultProvenance:[proof],V8RaceForecast:[forecast(),forecast('FINAL')],V8ExternalPrediction:[],V8ForecastVerification:[]},calls=[];
  const entities=Object.fromEntries(Object.entries(data).map(([name,rows])=>[name,{
    async filter(query,options){calls.push({name,query});assert.equal(typeof options,'object');return {items:rows.filter(row=>matches(row,query)),has_more:false};},
    async create(input){const row={...input,id:name+'-'+rows.length,created_date:new Date().toISOString()};rows.push(row);return row;}
  }]));
  const client={auth:{me:async()=>({role:'admin'})},asServiceRole:{entities}};
  const handlers=factory(()=>client,async()=> 'lock',async()=>{},...imports.map(name=>repository[name]),settlement.settleForecast,settlement.settleReplayForecast,settlement.settleExcludedForecast,settlement.settleExternal,utcMs);
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
