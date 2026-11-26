// Execute the real dashboard handler and cursor reader with an in-memory provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as repository from '../base44/shared/v8Repository.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';
import {SETTLEMENT_REVISION} from '../base44/shared/v8Settlement.js';
import {selectDisplayOddsSnapshot} from '../base44/shared/v8DisplayOdds.js';
import {isReplay} from '../src/components/liveV8/v8StudyView.js';

const handlerSource=readFileSync(new URL('../base44/functions/v8ReadDashboard/entry.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const executable=stripTypeScriptTypes(handlerSource).replace('export default async function','return async function');
const names=['jstDate','dateValid','readV8Rows','canonicalForecasts','canonicalReplayForecasts','latestForecasts','firstBuyForecasts','currentDecision','groupBy','publicRow','buildRaceProgress','isCompleteFinalForecast'];
const factory=new Function('createClientFromRequest',...names,'utcMs','SETTLEMENT_REVISION','selectDisplayOddsSnapshot',executable);
const clientSource=readFileSync(new URL('../src/components/liveV8/v8Client.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const displayDecision=new Function('isReplay',clientSource+'\nreturn displayDecision;')(isReplay);
const NOW=Date.parse('2026-11-23T05:30:00.000Z');
const race={id:'race-001',race_key:'2026-11-23_01_08',race_date:'2026-11-23',venue_code:'01',venue_name:'桐生',race_number:8,deadline:'2026-11-23T06:00:00Z',status:'scheduled'};
const forecast=(stage='FINAL')=>({
  id:'forecast-'+stage,forecast_key:'V8_FORECAST_1:'+race.race_key+':'+stage+':one',
  race_id:race.id,race_key:race.race_key,race_date:race.race_date,stage,deadline:race.deadline,exhibition_complete:stage==='FINAL',research_tickets:['1-2-3'],
  generated_at:stage==='DAY_BEFORE'?'2026-11-22T10:00:00Z':'2026-11-23T05:20:00Z',
  created_date:stage==='DAY_BEFORE'?'2026-11-22T10:00:00Z':'2026-11-23T05:20:00Z',
  decision:{status:stage==='FINAL'?'BUY':'WATCH',odds_captured_at:'2026-11-23T05:29:00Z',valid_until:'2026-11-23T05:34:00Z'},
});
const matches=(record,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'&&'$in' in value?value.$in.includes(record[key]):record[key]===value);
function providerProjection(row,fields){
  const allowed=new Set(Array.isArray(fields)?fields:fields.split(','));
  const visit=(value,prefix)=>{
    if(allowed.has(prefix)||value==null||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(item=>visit(item,prefix));
    return Object.fromEntries(Object.entries(value).filter(([key])=>{
      const path=prefix?prefix+'.'+key:key;
      return [...allowed].some(field=>field===path||field.startsWith(path+'.'));
    }).map(([key,value])=>[key,visit(value,prefix?prefix+'.'+key:key)]));
  };
  return visit(row,'');
}

async function exercise(t,{body={mode:'race',race_id:race.id},raceRows=[race],forecasts=[forecast()],verifications=[],external=[],odds=[],oddsReadError=null,failRaceCursor=false,failEntityCursor=null,raceReadErrors=[],raceLookupError=null,mockReadTimers=false,admin=false,repositoryOverrides={},projectFields=false}={}){
  t.mock.timers.enable({apis:mockReadTimers?['Date','setTimeout']:['Date'],now:NOW});
  t.mock.method(console,'error',()=>{});
  t.mock.method(console,'info',()=>{});
  const calls=[];
  const rowsByEntity={Race:raceRows,V8RaceForecast:forecasts,V8ExternalPrediction:external,V8ForecastVerification:verifications,V8TheoryTrial:[],OddsSnapshot:odds};
  const sr={};
  for(const [name,rows] of Object.entries(rowsByEntity)){
    sr[name]={
      get:async id=>{if(raceLookupError)throw raceLookupError;return id===race.id?structuredClone(race):null;},
      async filter(query,options){
        calls.push({entity:name,query:structuredClone(query),options:structuredClone(options)});
        assert.equal(typeof options,'object');
        if(name==='OddsSnapshot'&&oddsReadError)throw oddsReadError;
        if(name==='Race'&&raceReadErrors.length)throw raceReadErrors.shift();
        if(name==='Race'&&options.cursor&&failRaceCursor)throw new Error('read failed on second page');
        if(name===failEntityCursor&&options.cursor)throw new Error('incomplete projected ledger');
        const selected=rows.filter(row=>matches(row,query));
        const offset=options.cursor?Number(options.cursor.slice('cursor-'.length)):0;
        const page=selected.slice(offset,offset+options.limit),more=offset+options.limit<selected.length;
        return {items:structuredClone(projectFields&&options.fields?page.map(row=>providerProjection(row,options.fields)):page),has_more:more,next_cursor:more?'cursor-'+(offset+options.limit):null};
      },
    };
  }
  const client={auth:{me:async()=>admin?{role:'admin'}:null},asServiceRole:{entities:sr}};
  const handler=factory(()=>client,...names.map(name=>repositoryOverrides[name]||repository[name]),utcMs,SETTLEMENT_REVISION,selectDisplayOddsSnapshot);
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
  assert.equal(out.calls.some(call=>call.entity==='OddsSnapshot'),false);
});

const oddsSnapshot=(extra={})=>({id:'odds-old',race_id:race.id,stage:'FINAL',captured_at:'2026-11-23T05:25:00Z',created_date:'2026-11-23T05:25:00.100Z',odds_map:{'1-2-3':10,'1-3-2':20},...extra});

test('race API adds a single latest eligible odds snapshot without changing saved V8 records',async t=>{
  const saved=forecast('PRE'),before=structuredClone(saved);
  const latest=oddsSnapshot({id:'odds-current',captured_at:'2026-11-23T05:29:00Z',created_date:'2026-11-23T05:29:00.100Z',
    odds_map:{'1-2-3':'12.5','1-3-2':0,'1-1-2':15,'1-2-4':false},created_by:'private@example.test',secret:'private-token'});
  const out=await exercise(t,{forecasts:[saved],odds:[oddsSnapshot(),latest,
    oddsSnapshot({id:'future',captured_at:'2026-11-23T05:31:00Z',created_date:'2026-11-23T05:31:00.100Z'}),
    oddsSnapshot({id:'wrong-race',race_id:'race-other'}),oddsSnapshot({id:'unconfirmed',created_date:null})]});
  assert.equal(out.response.status,200);
  assert.equal(out.body.display_odds.status,'AVAILABLE');
  assert.equal(out.body.display_odds.snapshot.id,latest.id);
  assert.deepEqual(out.body.display_odds.snapshot.odds_map,{'1-2-3':12.5});
  assert.equal(out.calls.filter(call=>call.entity==='OddsSnapshot').length,1);
  assert.deepEqual(saved,before);
  assert.equal(out.body.forecasts[0].decision.odds,undefined);
  assert.doesNotMatch(JSON.stringify(out.body.display_odds),/private|secret|token/);
});

test('an odds read failure leaves saved forecasts visible and exposes no provider error details',async t=>{
  const out=await exercise(t,{oddsReadError:sourceError(403)});
  assert.equal(out.response.status,200);
  assert.equal(out.body.ok,true);assert.equal(out.body.forecasts.length,1);
  assert.deepEqual(out.body.display_odds,{status:'UNAVAILABLE',snapshot:null});
  assert.equal(out.calls.filter(call=>call.entity==='OddsSnapshot').length,1);
  assert.doesNotMatch(JSON.stringify(out.body),/private|credential|secret|authorization|token/);
});

test('day overview does not issue any new odds reads or include display-only odds',async t=>{
  const out=await exercise(t,{body:{mode:'day',race_date:race.race_date},odds:[oddsSnapshot()]});
  assert.equal(out.response.status,200);
  assert.equal(out.calls.some(call=>call.entity==='OddsSnapshot'),false);
  assert.equal(Object.hasOwn(out.body,'display_odds'),false);
  assert.ok(out.calls.every(call=>!Object.hasOwn(call.options,'fields')));
});

test('closed-race odds selection keeps the last pre-deadline snapshot and never merges missing prices',()=>{
  const latest=oddsSnapshot({id:'latest-partial',captured_at:'2026-11-23T05:55:00Z',created_date:'2026-11-23T05:55:00.100Z',odds_map:{'1-2-3':12}});
  const rows=[oddsSnapshot(),latest,oddsSnapshot({id:'after-close',captured_at:'2026-11-23T06:01:00Z',created_date:'2026-11-23T06:01:00.100Z'}),
    oddsSnapshot({id:'stored-after-close',captured_at:'2026-11-23T05:59:00Z',created_date:'2026-11-23T06:01:00Z'})];
  const before=structuredClone(rows);
  const selected=selectDisplayOddsSnapshot(rows,race,Date.parse('2026-11-23T06:15:00Z'));
  assert.equal(selected.id,latest.id);assert.deepEqual(selected.odds_map,{'1-2-3':12});
  assert.deepEqual(rows,before);
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
  assert.deepEqual(out.body.diagnostic,{context:'Race',code:'INCOMPLETE_READ:page_read_failed_or_timed_out',http_status:403,
    kind:'Error',phase:'READ_RACES',mode:'race',elapsed_ms:0,read_rows:{},read_ms:{Race:0},selected_rows:{}});
  assert.equal(out.calls.filter(call=>call.entity==='Race').length,1);
  assert.equal(Object.hasOwn(out.body,'forecasts'),false);
  assert.doesNotMatch(JSON.stringify(out.body),/private|credential|secret|authorization|token/);
});

test('exhausted transient Race reads retain the last status and cannot publish partial forecasts',async(t)=>{
  const pending=exercise(t,{raceReadErrors:[sourceError(502),sourceError(503),sourceError(504)],mockReadTimers:true});
  await flush();t.mock.timers.tick(200);await flush();t.mock.timers.tick(500);await flush();
  const out=await pending;
  assert.equal(out.response.status,503);
  assert.deepEqual(out.body.diagnostic,{context:'Race',code:'INCOMPLETE_READ:page_read_failed_or_timed_out',http_status:504,
    kind:'Error',phase:'READ_RACES',mode:'race',elapsed_ms:700,read_rows:{},read_ms:{Race:700},selected_rows:{}});
  assert.equal(out.calls.filter(call=>call.entity==='Race').length,3);
  assert.equal(Object.hasOwn(out.body,'forecasts'),false);
  assert.doesNotMatch(JSON.stringify(out.body),/private|credential|secret|authorization|token/);
});

test('unverified source exception messages are not accepted as public diagnostic codes',async(t)=>{
  const out=await exercise(t,{raceLookupError:new Error('INCOMPLETE_READ:private_source_details')});
  assert.equal(out.response.status,503);
  assert.deepEqual(out.body.diagnostic,{context:'RACE_OR_FORMAT',code:'READ_FAILED',
    kind:'Error',phase:'READ_RACES',mode:'race',elapsed_ms:0,read_rows:{},read_ms:{},selected_rows:{}});
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

test('dashboard selects a complete FINAL before latest so newer partial history cannot hide it',async(t)=>{
 const complete=forecast(),partial={...complete,id:'partial-final',forecast_key:'partial-final',generated_at:'2026-11-23T05:25:00Z',created_date:'2026-11-23T05:25:00Z',exhibition_complete:false};
 const out=await exercise(t,{forecasts:[complete,partial]});
 assert.equal(out.response.status,200);assert.deepEqual(out.body.forecasts.map(row=>row.id),[complete.id]);
 assert.deepEqual(out.body.buy_forecasts.map(row=>row.id),[complete.id]);assert.equal(out.body.coverage.final_count,1);
});

const finalTickets=['1-2-3','1-2-4','1-3-2','1-3-4','1-4-2','1-4-3'];
const savedSelection=(status='WATCH')=>({
 revision:'V8_FINAL_SELECTION_1',policy_revision:'V8_RULE_BUY_2',status,stage:'FINAL',probability_calibrated:false,
 tickets:[...finalTickets],ticket_count:6,ranked_tickets:finalTickets.map((ticket,index)=>({ticket,rank:index+1,score:70-index,components:{first:80}})),
 role_evidence:[{private_detail:'not needed by verification'}],
});
const verificationFor=source=>({
 id:'verified-'+source.id,revision:SETTLEMENT_REVISION,verification_key:'key-'+source.id,
 source_kind:source.record_mode==='REPLAY'?'REPLAY':'FORECAST',forecast_id:source.id,
 race_id:source.race_id,race_key:source.race_key,race_date:source.race_date,stage:source.stage,status:'SETTLED',
 research_tickets:source.research_tickets,research_hit:false,research_stake:800,research_return:0,result_trifecta:'6-5-4',
 final_selection_result:{revision:'V8_FINAL_SELECTION_VERIFICATION_1',source_revision:'V8_FINAL_SELECTION_1',source_forecast_id:source.id,
  status:'SETTLED',tickets:[...finalTickets],ticket_count:6,unit_stake:100,hit:false,hit_rank:null,stake:600,return:0,
  decision_status:source.decision.status,buy_selected:source.decision.status==='BUY'},
});

test('verification projection preserves first BUY, linked PRE, separate replay and saved ticket identity',async t=>{
 const pre={...forecast('PRE'),id:'pre-linked',forecast_key:'pre-linked',generated_at:'2026-11-23T01:00:00Z',created_date:'2026-11-23T01:00:00Z'};
 const preLatest={...forecast('PRE'),id:'pre-latest',forecast_key:'pre-latest'};
 const firstBuy={...forecast(),id:'buy-first',forecast_key:'buy-first',generated_at:'2026-11-23T05:10:00Z',created_date:'2026-11-23T05:10:00Z',
  final_selection:savedSelection('BUY'),decision:{...forecast().decision,tickets:[...finalTickets]}};
 const latest={...forecast(),id:'watch-latest',forecast_key:'watch-latest',comparison:{baseline_id:pre.id,large_detail:'private'},
  final_selection:savedSelection(),decision:{...forecast().decision,status:'WATCH',tickets:[...finalTickets]}};
 const closed={...race,id:'closed-race',race_key:'2026-11-23_02_08',deadline:'2026-11-23T05:00:00Z',status:'finished'};
 const replay={...forecast(),id:'replay-final',forecast_key:'replay-final',race_id:closed.id,race_key:closed.race_key,deadline:closed.deadline,
  record_mode:'REPLAY',generated_at:'2026-11-23T05:10:00Z',created_date:'2026-11-23T05:10:01Z',input_as_of:'2026-11-23T05:05:00Z',
  decision:{status:'REPLAY'},provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true},final_selection:savedSelection('REPLAY')};
 const invalidReplay={...replay,id:'invalid-replay',forecast_key:'invalid-replay',provenance:{...replay.provenance,reconstruction:false}};
 const rows=[pre,preLatest,firstBuy,latest,replay,invalidReplay],before=structuredClone(rows);
 const out=await exercise(t,{body:{mode:'verification',days:7},admin:true,projectFields:true,raceRows:[race,closed],forecasts:rows,
  verifications:[pre,firstBuy,latest,replay].map(verificationFor)});
 assert.equal(out.response.status,200);assert.deepEqual(rows,before);
 assert.deepEqual(new Set(out.body.forecasts.map(row=>row.id)),new Set([pre.id,preLatest.id,latest.id]));
 assert.deepEqual(out.body.buy_forecasts.map(row=>row.id),[firstBuy.id]);
 assert.deepEqual(out.body.replay_forecasts.map(row=>row.id),[replay.id]);
 assert.deepEqual(out.body.buy_verifications.map(row=>row.forecast_id),[firstBuy.id]);
 assert.deepEqual(out.body.replay_verifications.map(row=>row.forecast_id),[replay.id]);
 assert.equal(out.body.race_progress.find(row=>row.race_id===race.id).pre.forecast_id,pre.id);
 assert.deepEqual(out.body.buy_forecasts[0].decision.tickets,finalTickets);
 assert.deepEqual(out.body.forecasts.find(row=>row.id===latest.id).final_selection.ranked_tickets,
  latest.final_selection.ranked_tickets.map(({rank,ticket,score})=>({rank,ticket,score})));
 assert.deepEqual(out.body.buy_verifications[0].final_selection_result,verificationFor(firstBuy).final_selection_result);
 assert.equal(out.body.policies.buy_evaluation,'FIRST_PUBLISHED_BUY_PER_RACE');
 assert.ok(out.calls.every(call=>Array.isArray(call.options.fields)&&call.options.fields.includes('id')));
 assert.doesNotMatch(JSON.stringify(out.body),/private_detail|large_detail|components/);
});

test('growing verification overview finishes every cursor and omits oversized source and scenario details',async t=>{
 const heavy='HEAVY_DETAIL_NOT_FOR_OVERVIEW'.repeat(1000);
 const races=Array.from({length:201},(_,index)=>({...race,id:'race-'+index,race_key:'logical-race-'+index}));
 const rows=races.map((r,index)=>({...forecast(),id:'forecast-'+index,forecast_key:'forecast-'+index,race_id:r.id,race_key:r.race_key,
  decision:{status:'WATCH'},final_selection:savedSelection(),boats:[{details:heavy}],scenarios:[{details:heavy}],
  racer_evidence:{details:heavy},recent_lane_evidence:{details:heavy},venue_evidence:{details:heavy}}));
 const verifications=rows.map(row=>({...verificationFor(row),scenario_results:[{details:heavy}],provenance:{details:heavy}}));
 // This provider deliberately ignores projection, exercising the second whitelist at the response boundary.
 const out=await exercise(t,{body:{mode:'verification',days:7},admin:true,raceRows:races,forecasts:rows,verifications});
 assert.equal(out.response.status,200);assert.equal(out.body.forecasts.length,201);assert.equal(out.body.verifications.length,201);
 for(const entity of ['Race','V8RaceForecast','V8ForecastVerification']){
  const calls=out.calls.filter(call=>call.entity===entity);assert.equal(calls.length,2);assert.equal(calls[1].options.cursor,'cursor-200');
  assert.ok(calls.every(call=>Array.isArray(call.options.fields)));
 }
 const json=JSON.stringify(out.body);
 assert.doesNotMatch(json,/HEAVY_DETAIL_NOT_FOR_OVERVIEW|racer_evidence|scenario_results|role_evidence/);
 assert.ok(Buffer.byteLength(json)<1000000);
 assert.ok(out.body.forecasts.every(row=>row.final_selection.ticket_count===6));
});

test('an incomplete projected forecast cursor withholds the whole overview',async t=>{
 const rows=Array.from({length:201},(_,index)=>({...forecast(),id:'forecast-'+index,forecast_key:'key-'+index}));
 const out=await exercise(t,{body:{mode:'verification',days:7},admin:true,projectFields:true,forecasts:rows,failEntityCursor:'V8RaceForecast'});
 assert.equal(out.response.status,503);assert.equal(out.body.error,'READ_INCOMPLETE');
 assert.equal(out.body.diagnostic.context,'V8RaceForecast');assert.equal(out.body.diagnostic.phase,'READ_RECORDS');
 assert.equal(Object.hasOwn(out.body,'forecasts'),false);
});

test('post-read failures expose safe kind, phase and counts without exception text',async t=>{
 const out=await exercise(t,{body:{mode:'verification',days:7},admin:true,projectFields:true,
  repositoryOverrides:{buildRaceProgress:()=>{throw new TypeError('private credential-bearing record and secret URL');}}});
 assert.equal(out.response.status,503);assert.equal(out.body.diagnostic.context,'RACE_OR_FORMAT');
 assert.equal(out.body.diagnostic.kind,'TypeError');assert.equal(out.body.diagnostic.phase,'BUILD_PROGRESS');
 assert.equal(out.body.diagnostic.mode,'verification');assert.equal(out.body.diagnostic.read_rows.V8RaceForecast,1);
 assert.equal(out.body.diagnostic.selected_rows.forecasts,1);assert.ok(out.body.diagnostic.elapsed_ms>=0);
 assert.equal(Object.hasOwn(out.body,'forecasts'),false);assert.doesNotMatch(JSON.stringify(out.body),/private|credential|secret|URL/);
});
