// Execute the real dashboard handler and cursor reader with an in-memory provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as repository from '../base44/shared/v8Repository.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';

const handlerSource=readFileSync(new URL('../base44/functions/v8ReadDashboard/entry.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const executable=stripTypeScriptTypes(handlerSource).replace('export default async function','return async function');
const names=['jstDate','dateValid','readV8Rows','canonicalForecasts','latestForecasts','firstBuyForecasts','currentDecision','groupBy','publicRow'];
const factory=new Function('createClientFromRequest',...names,'utcMs',executable);
const clientSource=readFileSync(new URL('../src/components/liveV8/v8Client.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const displayDecision=new Function(clientSource+'\nreturn displayDecision;')();
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

async function exercise(t,{body={mode:'race',race_id:race.id},raceRows=[race],forecasts=[forecast()],failRaceCursor=false}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  t.mock.method(console,'error',()=>{});
  const calls=[];
  const rowsByEntity={Race:raceRows,V8RaceForecast:forecasts,V8ExternalPrediction:[],V8ForecastVerification:[],V8TheoryTrial:[]};
  const sr={};
  for(const [name,rows] of Object.entries(rowsByEntity)){
    sr[name]={
      get:async id=>id===race.id?structuredClone(race):null,
      async filter(query,options){
        calls.push({entity:name,query:structuredClone(query),options:structuredClone(options)});
        assert.equal(typeof options,'object');
        if(name==='Race'&&options.cursor&&failRaceCursor)throw new Error('read failed on second page');
        const selected=rows.filter(row=>matches(row,query));
        const offset=options.cursor?Number(options.cursor.slice('cursor-'.length)):0;
        const page=selected.slice(offset,offset+options.limit),more=offset+options.limit<selected.length;
        return {items:structuredClone(page),has_more:more,next_cursor:more?'cursor-'+(offset+options.limit):null};
      },
    };
  }
  const client={auth:{me:async()=>null},asServiceRole:{entities:sr}};
  const handler=factory(()=>client,...names.map(name=>repository[name]),utcMs);
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

