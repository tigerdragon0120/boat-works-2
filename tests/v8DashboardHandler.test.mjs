// Execute the real dashboard handler and cursor reader with an in-memory provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as repository from '../base44/shared/v8Repository.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';
import {SETTLEMENT_REVISION} from '../base44/shared/v8Settlement.js';
import {isReplay} from '../src/components/liveV8/v8StudyView.js';

const handlerSource=readFileSync(new URL('../base44/functions/v8ReadDashboard/entry.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const executable=stripTypeScriptTypes(handlerSource).replace('export default async function','return async function');
const names=['jstDate','dateValid','readV8Rows','canonicalForecasts','canonicalReplayForecasts','latestForecasts','firstBuyForecasts','currentDecision','groupBy','publicRow','buildRaceProgress'];
const factory=new Function('createClientFromRequest',...names,'utcMs','SETTLEMENT_REVISION',executable);
const clientSource=readFileSync(new URL('../src/components/liveV8/v8Client.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const displayDecision=new Function('isReplay',clientSource+'\nreturn displayDecision;')(isReplay);
const NOW=Date.parse('2026-11-23T05:30:00.000Z');
const race={id:'race-001',race_key:'2026-11-23_01_08',race_date:'2026-11-23',venue_code:'01',venue_name:'桐生',race_number:8,deadline:'2026-11-23T06:00:00Z',status:'scheduled'};
const forecast=(stage='FINAL')=>({
  id:'forecast-'+stage,forecast_key:'V8_FORECAST_1:'+race.race_key+':'+stage+':one',
  race_id:race.id,race_key:race.race_key,race_date:race.race_date,stage,deadline:race.deadline,
  generated_at:stage==='DAY_BEFORE'?'2026-11-22T10:00:00Z':'2026-11-23T05:20:00Z',
  created_date:stage==='DAY_BEFORE'?'2026-11-22T10:00:00Z':'2026-11-23T05:20:00Z',
  decision:{status:stage==='FINAL'?'BUY':'WATCH',odds_captured_at:'2026-11-23T05:29:00Z',valid_until:'2026-11-23T05:34:00Z'},
});
const matches=(record,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'&&'$in' in value?value.$in.includes(record[key]):record[key]===value);

async function exercise(t,{body={mode:'race',race_id:race.id},raceRows=[race],forecasts=[forecast()],verifications=[],failRaceCursor=false,raceReadErrors=[],raceLookupError=null,mockReadTimers=false}={}){
  t.mock.timers.enable({apis:mockReadTimers?['Date','setTimeout']:['Date'],now:NOW});
  t.mock.method(console,'error',()=>{});
  const calls=[];
  const rowsByEntity={Race:raceRows,V8RaceForecast:forecasts,V8ExternalPrediction:[],V8ForecastVerification:verifications,V8TheoryTrial:[]};
  const sr={};
  for(const [name,rows] of Object.entries(rowsByEntity)){
    sr[name]={
      get:async id=>{if(raceLookupError)throw raceLookupError;return id===race.id?structuredClone(race):null;},
      async filter(query,options){
        calls.push({entity:name,query:structuredClone(query),options:structuredClone(options)});
        assert.equal(typeof options,'object');
        if(name==='Race'&&raceReadErrors.length)throw raceReadErrors.shift();
        if(name==='Race'&&options.cursor&&failRaceCursor)throw new Error('read failed on second page');
        const selected=rows.filter(row=>matches(row,query));
        const offset=options.cursor?Number(options.cursor.slice('cursor-'.length)):0;
        const page=selected.slice(offset,offset+options.limit),more=offset+options.limit<selected.length;
        return {items:structuredClone(page),has_more:more,next_cursor:more?'cursor-'+(offset+options.limit):null};
      },
    };
  }
  const client={auth:{me:async()=>null},asServiceRole:{entities:sr}};
  const handler=factory(()=>client,...names.map(name=>repository[name]),utcMs,SETTLEMENT_REVISION);
  const response=await handler(new Request('https://test.invalid/dashboard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
  return {response,body:await response.json(),calls};
}

test('valid DAY_BEFORE and PRE API records render exhibition-waiting rather than recheck-waiting',async(t)=>{
  const out=await exercise(t,{forecasts:[forecast('DAY_BEFORE'),forecast('PRE')]});
  assert.equal(out.response.status,200);
  assert.equal(out.body.forecasts.length,2);
  for(const row of out.body.forecasts){
    assert.equal(row.effective_status,'WATCH');
    const displayed=displayDecision(row,NOW,race);
    assert.equal(displayed.key,'PRE');
    assert.equal(displayed.label,'展示待ち');
  }
});
test('race detail uses the same ambiguity hold as the day board',async(t)=>{
  const duplicate={...race,id:'race-duplicate'};
  const out=await exercise(t,{raceRows:[race,duplicate]});
  assert.equal(out.response.status,200);
  assert.deepEqual(out.body.ambiguous_race_keys,[race.race_key]);
  assert.equal(out.body.coverage.ambiguous_race_keys,1);
  assert.equal(out.body.coverage.expected_races,1);
  assert.equal(out.body.coverage.missing_races,1);
  assert.deepEqual(out.body.races,[]);
  assert.deepEqual(out.body.forecasts,[]);
  assert.deepEqual(out.body.buy_forecasts,[]);
  assert.equal(out.body.race_date,race.race_date);
  assert.deepEqual(out.calls.find(call=>call.entity==='Race').query,{race_key:race.race_key});
});
test('race identity check consumes every cursor page, including a duplicate on page two',async(t)=>{
  const duplicateRows=Array.from({length:201},(_,index)=>({...race,id:index===0?race.id:'race-duplicate-'+index}));
  const out=await exercise(t,{raceRows:duplicateRows});
  assert.equal(out.response.status,200);
  const calls=out.calls.filter(call=>call.entity==='Race');
  assert.equal(calls.length,2);
  assert.equal(Object.hasOwn(calls[0].options,'cursor'),false);
  assert.equal(calls[1].options.cursor,'cursor-200');
  assert.deepEqual(out.body.ambiguous_race_keys,[race.race_key]);
  assert.deepEqual(out.body.forecasts,[]);
});
test('an incomplete duplicate-check read returns an error without publishing partial forecasts',async(t)=>{
  const duplicateRows=Array.from({length:201},(_,index)=>({...race,id:index===0?race.id:'race-duplicate-'+index}));
  const out=await exercise(t,{raceRows:duplicateRows,failRaceCursor:true});
  assert.equal(out.response.status,503);
  assert.equal(out.body.error,'READ_INCOMPLETE');
  assert.equal(Object.hasOwn(out.body,'forecasts'),false);
});
test('unique race details retain valid forecasts and fresh BUY status',async(t)=>{
  const unrelated={...race,id:'race-other',race_key:'2026-11-23_02_08',venue_code:'02'};
  const out=await exercise(t,{raceRows:[race,unrelated]});
  assert.equal(out.response.status,200);
  assert.deepEqual(out.body.ambiguous_race_keys,[]);
  assert.equal(out.body.races.length,1);
  assert.equal(out.body.forecasts[0].effective_status,'BUY');
  assert.equal(out.body.coverage.active_buy_count,1);
});
test('a race disappearing between ID lookup and key lookup is held',async(t)=>{
  const out=await exercise(t,{raceRows:[]});
  assert.equal(out.response.status,409);
  assert.equal(out.body.error,'RACE_IDENTITY_CHANGED');
  assert.equal(Object.hasOwn(out.body,'forecasts'),false);
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const sourceError=status=>Object.assign(new Error('private source body and credential-bearing URL'),{response:{status,data:{secret:'never publish'},headers:{authorization:'private-token'}}});

test('an initial transient Race read is recovered inside the first dashboard request',async(t)=>{
  const pending=exercise(t,{body:{mode:'day',race_date:race.race_date},raceReadErrors:[sourceError(503)],mockReadTimers:true});
  await flush();t.mock.timers.tick(200);await flush();
  const out=await pending;
  assert.equal(out.response.status,200);
  assert.equal(out.calls.filter(call=>call.entity==='Race').length,2);
  assert.equal(out.body.forecasts.length,1);
  assert.equal(out.body.forecasts[0].effective_status,'BUY');
});

test('permanent Race read errors propagate only the safe status and context without retry',async(t)=>{
  const out=await exercise(t,{raceReadErrors:[sourceError(403)]});
  assert.equal(out.response.status,503);
  assert.deepEqual(out.body.diagnostic,{context:'Race',code:'INCOMPLETE_READ:page_read_failed_or_timed_out',http_status:403});
  assert.equal(out.calls.filter(call=>call.entity==='Race').length,1);
  assert.equal(Object.hasOwn(out.body,'forecasts'),false);
  assert.doesNotMatch(JSON.stringify(out.body),/private|credential|secret|authorization|token/);
});

test('exhausted transient Race reads retain the last status and cannot publish partial forecasts',async(t)=>{
  const pending=exercise(t,{raceReadErrors:[sourceError(502),sourceError(503),sourceError(504)],mockReadTimers:true});
  await flush();t.mock.timers.tick(200);await flush();t.mock.timers.tick(500);await flush();
  const out=await pending;
  assert.equal(out.response.status,503);
  assert.deepEqual(out.body.diagnostic,{context:'Race',code:'INCOMPLETE_READ:page_read_failed_or_timed_out',http_status:504});
  assert.equal(out.calls.filter(call=>call.entity==='Race').length,3);
  assert.equal(Object.hasOwn(out.body,'forecasts'),false);
  assert.doesNotMatch(JSON.stringify(out.body),/private|credential|secret|authorization|token/);
});

test('unverified source exception messages are not accepted as public diagnostic codes',async(t)=>{
  const out=await exercise(t,{raceLookupError:new Error('INCOMPLETE_READ:private_source_details')});
  assert.equal(out.response.status,503);
  assert.deepEqual(out.body.diagnostic,{context:'RACE_OR_FORMAT',code:'READ_FAILED'});
  assert.doesNotMatch(JSON.stringify(out.body),/private_source_details/);
});

test('public day view exposes replay progress separately while private external evidence stays hidden',async(t)=>{
  const closed={...race,deadline:'2026-11-23T05:00:00Z',status:'finished',exhibition_ready:true};
  const pre={...forecast('PRE'),deadline:closed.deadline,generated_at:'2026-11-23T04:00:00Z',created_date:'2026-11-23T04:00:00.100Z'};
  const replay={...forecast('FINAL'),id:'replay-final',forecast_key:'replay-final',record_mode:'REPLAY',deadline:closed.deadline,generated_at:'2026-11-23T05:20:00Z',created_date:'2026-11-23T05:20:00.100Z',exhibition_complete:true,decision:{status:'REPLAY'},provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true},created_by:'private@example.test'};
  const verified=(source,kind)=>({id:'verification-'+source.id,verification_key:'key-'+source.id,revision:SETTLEMENT_REVISION,source_kind:kind,forecast_id:source.id,race_id:race.id,race_key:race.race_key,race_date:race.race_date,status:'SETTLED',research_hit:true,result_trifecta:'1-2-3'});
  const out=await exercise(t,{body:{mode:'day',race_date:race.race_date},raceRows:[closed],forecasts:[pre,replay],verifications:[verified(pre,'FORECAST'),verified(replay,'REPLAY'),{...verified(pre,'EXTERNAL'),id:'secret',verification_key:'secret',external_id:'private'}]});
  assert.equal(out.response.status,200);assert.equal(out.body.forecasts.length,1);assert.equal(out.body.replay_forecasts.length,1);
  assert.equal(out.body.replay_forecasts[0].effective_status,'REPLAY');assert.equal(Object.hasOwn(out.body.replay_forecasts[0],'created_by'),false);
  assert.equal(out.body.verifications.length,1);assert.equal(out.body.replay_verifications.length,1);assert.deepEqual(out.body.external,[]);
  assert.equal(out.body.race_progress[0].status,'VERIFIED');assert.equal(out.body.coverage.verified_races,1);assert.equal(out.body.coverage.pre_available_count,1);assert.equal(out.body.coverage.final_available_count,1);
  assert.equal(out.body.coverage.active_buy_count,0);assert.deepEqual(out.body.buy_forecasts,[]);
});

test('dashboard omits obsolete result ledgers until current-revision verification completes',async(t)=>{
 const f=forecast(),old={id:'old-check',verification_key:'old-key',revision:'V8_SETTLEMENT_1',source_kind:'FORECAST',forecast_id:f.id,race_id:race.id,race_key:race.race_key,race_date:race.race_date,status:'SETTLED',research_hit:true,result_trifecta:'1-2-3'};
 const out=await exercise(t,{forecasts:[f],verifications:[old]});
 assert.equal(out.response.status,200);assert.deepEqual(out.body.verifications,[]);assert.deepEqual(out.body.buy_verifications,[]);assert.deepEqual(out.body.replay_verifications,[]);
});
