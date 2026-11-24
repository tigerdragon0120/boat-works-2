import test from 'node:test';
import assert from 'node:assert/strict';
import {runV8ResearchObservations,createV8ResearchObservationsHandler} from '../base44/shared/v8ResearchObservations.js';
import {runV7CaptureFeatures} from '../base44/shared/v7FeatureCaptureRunner.js';
import {runV8TheoryTrials} from '../base44/shared/v8TheoryTrialRunner.js';
import {buildV7FeatureObservation} from '../base44/shared/v7FeatureObservation.js';

const NOW=Date.parse('2026-11-23T05:00:00Z');
const at=offset=>new Date(NOW+offset).toISOString();
const tickets=['1-2-3','1-2-4','1-2-5','1-2-6','1-3-2','1-3-4','1-3-5','2-1-3'];

function fixture(left=6*60000){
  const race={id:'race-1',race_key:'2026-11-23_01_01',race_date:'2026-11-23',venue_code:'01',race_number:1,
    deadline:at(left),status:'scheduled',exhibition_ready:true,is_womens:false,series_day:1,race_type:'予選',updated_date:at(-60000)};
  const pred={id:'prediction-1',race_id:race.id,race_key:race.race_key,race_date:race.race_date,stage:'FINAL',
    source:'SERVER',record_hash:'sealed-final',created_date:at(-120000),generated_at:at(-120000),coverage:1,
    plans:{hit_8:{tickets,judgment:'WATCH'}},top_combination:tickets[0]};
  const rows={Race:[race],PredictionV7:[pred],RaceEntry:Array.from({length:6},(_,i)=>({
    id:'entry-'+(i+1),race_id:race.id,race_key:race.race_key,boat_number:i+1,register_number:String(4000+i),
    updated_date:at(-60000),national_win_rate:6+i*.1,national_2rate:50-i,national_3rate:65-i,
    local_2rate:45-i,local_3rate:60-i,motor_f2_rate:40+i,motor_f3_rate:60+i,boat_f2_rate:40,boat_f3_rate:60,
    exhibition_time:6.8+i*.01,exhibition_st:.1+i*.02,exhibition_course:i+1,section_finishes:'1-2-3',
  })),OddsSnapshot:[{id:'odds-1',race_id:race.id,stage:'FINAL',captured_at:at(-60000),created_date:at(-60000),
    odds_map:Object.fromEntries(tickets.map((t,i)=>[t,10+i]))}],V7FeatureSnapshot:[],V7FactorCandidate:[],
    V8TheoryTrial:[],V7BuyShadowTrial:[],ProcessLock:[]};
  const before=structuredClone({Race:rows.Race,PredictionV7:rows.PredictionV7,RaceEntry:rows.RaceEntry,OddsSnapshot:rows.OddsSnapshot});
  const calls=[];
  const entities=Object.fromEntries(Object.keys(rows).map(name=>[name,{
    async filter(query,options,limit){
      calls.push({entity:name,method:'filter'});
      const matches=rows[name].filter(row=>Object.entries(query).every(([key,value])=>row[key]===value));
      return typeof options==='object'?{items:structuredClone(matches),has_more:false,next_cursor:null}:structuredClone(matches.slice(0,limit));
    },
    async create(record){calls.push({entity:name,method:'create'});const row={...structuredClone(record),id:name+'-'+(rows[name].length+1),created_date:at(0)};rows[name].push(row);return structuredClone(row);},
    async update(id,data){const row=rows[name].find(row=>row.id===id);Object.assign(row,data);return structuredClone(row);},
    async deleteMany(query){rows[name]=rows[name].filter(row=>!Object.entries(query).every(([key,value])=>row[key]===value));},
  }]));
  return {client:{asServiceRole:{entities}},rows,before,calls};
}

const observationInput=rows=>({race:rows.Race[0],entries:rows.RaceEntry,odds:rows.OddsSnapshot,
  stage:'FINAL',observedAt:at(0),sourceMode:'V8_INPUT_ONLY'});

test('raw snapshots ignore supplied V7 predictions and keep the legacy snapshot key and builder mode',()=>{
  const {rows}=fixture(),input=observationInput(rows),before=structuredClone(input);
  const expected=buildV7FeatureObservation(input);
  assert.equal(expected.ok,true);
  for(const prediction of [rows.PredictionV7[0],{...rows.PredictionV7[0],created_date:at(1000)},
    {...rows.PredictionV7[0],plans:{hit_8:{tickets:[],judgment:'BUY'}}}]){
    assert.deepEqual(buildV7FeatureObservation({...input,pre:prediction,final:prediction}),expected);
  }
  const legacy=buildV7FeatureObservation({...input,sourceMode:'V7_PREDICTION',final:rows.PredictionV7[0]});
  assert.equal(legacy.ok,true);assert.equal(legacy.record.snapshot_key,expected.record.snapshot_key);
  assert.equal(legacy.record.prediction_id,'prediction-1');
  assert.deepEqual(legacy.record.market.selected_tickets,tickets);
  assert.equal(expected.record.provenance.prediction_used,false);
  assert.equal(expected.record.provenance.source,'BASE44_RACE_RACEENTRY_ODDSSNAPSHOT');
  assert.deepEqual(input,before);
});

test('raw observation excludes future evidence and rejects late, closed, incomplete or mislabeled sources',()=>{
  const {rows}=fixture(),input=observationInput(rows);
  for(const race of [{...input.race,updated_date:at(1)},{...input.race,created_date:at(1)},
    {...input.race,status:'finished'},{...input.race,status:'cancelled'},{...input.race,deadline:at(60000)},
    {...input.race,exhibition_ready:false}])assert.equal(buildV7FeatureObservation({...input,race}).ok,false);
  for(const field of ['updated_date','created_date']){
    const entries=structuredClone(input.entries);entries[0][field]=at(1);
    assert.equal(buildV7FeatureObservation({...input,entries}).ok,false);
  }
  assert.equal(buildV7FeatureObservation({...input,stage:'PRE',race:{...input.race,exhibition_ready:false}}).ok,false);
  for(const extra of [{captured_at:at(1)},{created_date:at(1)},{created_date:null},{race_id:'another-race'},{stage:'POST'}]){
    const output=buildV7FeatureObservation({...input,odds:[{...input.odds[0],...extra}]});
    assert.equal(output.ok,true);assert.deepEqual(output.record.market.observed_quotes,{});
    assert.equal(output.record.market.source_latest_id,null);
    assert.ok(output.record.missing.includes('ODDS_SNAPSHOT_NOT_YET_AVAILABLE'));
  }
});

test('V8 capture fails closed on incomplete ledgers and saturated source reads, and preserves legacy rows',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const entity of ['Race','V7FeatureSnapshot']){
    const {client,rows}=fixture();client.asServiceRole.entities[entity].filter=async()=>[];
    const response=await runV7CaptureFeatures(client,{sourceMode:'V8_INPUT_ONLY'});
    assert.equal(response.status,503);assert.equal(rows.V7FeatureSnapshot.length,0);
  }
  for(const [entity,count] of [['RaceEntry',40],['OddsSnapshot',60]]){
    const {client,rows}=fixture();client.asServiceRole.entities[entity].filter=async()=>Array(count).fill(rows[entity][0]);
    const report=await (await runV7CaptureFeatures(client,{sourceMode:'V8_INPUT_ONLY'})).json();
    assert.equal(report.created,0);assert.equal(report.skipped_source,2);
  }
  const {client,rows}=fixture();await runV7CaptureFeatures(client);
  const original=structuredClone(rows.V7FeatureSnapshot);
  const report=await runV8ResearchObservations(client);
  assert.equal(report.ok,true);assert.deepEqual(rows.V7FeatureSnapshot,original);
  assert.equal(rows.V8TheoryTrial.length,2);
});

test('one call saves raw inputs then V8 theories without V7 prediction or BUY entities and retries idempotently',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows,before,calls}=fixture();
  for(const name of ['PredictionV7','V7FactorCandidate','V7BuyShadowTrial'])delete client.asServiceRole.entities[name];
  const report=await runV8ResearchObservations(client);
  assert.equal(report.ok,true);assert.equal(report.complete,true);
  assert.equal(rows.V7FeatureSnapshot.length,2);
  assert.deepEqual(rows.V7FeatureSnapshot.map(r=>r.snapshot_stage).sort(),['FINAL','LOCK']);
  assert.deepEqual(Object.keys(report.phases),['features','theories']);
  assert.equal(report.phases.features.source_mode,'V8_INPUT_ONLY');
  assert.equal(rows.V7FactorCandidate.length,0);assert.equal(rows.V8TheoryTrial.length,2);
  for(const record of rows.V8TheoryTrial){
    assert.ok(rows.V7FeatureSnapshot.some(feature=>feature.id===(record.source_snapshot_id||record.snapshot_id)));
    assert.deepEqual(record.baseline_tickets,[]);
    assert.equal(record.provenance.source_mode,'V8_INPUT_ONLY');
    assert.ok(!record.missing.includes('BASELINE_TICKETS_INVALID'));
    assert.equal(record.models.find(model=>model.key==='V8_ALL_FACTOR').status,'READY');
    assert.equal(record.models.find(model=>model.key==='V8_ALL_FACTOR').tickets.length,8);
  }
  for(const feature of rows.V7FeatureSnapshot){
    assert.equal(feature.prediction_id,null);assert.equal(feature.current_judgment,null);
    assert.deepEqual(feature.market.selected_tickets,[]);
    assert.deepEqual(feature.market.observed_quotes,rows.OddsSnapshot[0].odds_map);
    assert.ok(feature.missing.includes('PREDICTION_NOT_USED_V8_INPUT_ONLY'));
  }
  assert.equal(rows.V7BuyShadowTrial.length,0);
  const counts=[rows.V7FeatureSnapshot.length,rows.V7FactorCandidate.length,rows.V8TheoryTrial.length,rows.V7BuyShadowTrial.length];
  const repeated=await runV8ResearchObservations(client);
  assert.equal(repeated.ok,true);
  assert.deepEqual([rows.V7FeatureSnapshot.length,rows.V7FactorCandidate.length,rows.V8TheoryTrial.length,rows.V7BuyShadowTrial.length],counts);
  assert.deepEqual({Race:rows.Race,PredictionV7:rows.PredictionV7,RaceEntry:rows.RaceEntry,OddsSnapshot:rows.OddsSnapshot},before);
  assert.ok(!calls.some(call=>['PredictionV7','V7FactorCandidate','V7BuyShadowTrial'].includes(call.entity)));
  assert.ok(rows.ProcessLock.every(row=>row.status==='released'));
});

test('post-cutoff input never becomes a prospective feature or theory trial',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows}=fixture(50000);
  // A prior valid feature exists, but its consumers also refuse late creation.
  rows.V7FeatureSnapshot.push({id:'sealed-feature',snapshot_key:'past',race_date:'2026-11-23',race_key:'2026-11-23_01_01',
    race_id:'race-1',snapshot_stage:'FINAL',gender_model:'OPEN',observed_at:at(-120000),created_date:at(-120000),deadline:at(50000),boats:[]});
  const report=await runV8ResearchObservations(client);
  assert.equal(report.ok,true);
  assert.equal(rows.V7FeatureSnapshot.length,1);assert.equal(rows.V7FactorCandidate.length,0);
  assert.equal(rows.V8TheoryTrial.length,0);assert.equal(rows.V7BuyShadowTrial.length,0);
  assert.equal(report.phases.theories.late,1);
});

test('failed capture is reported while theories can still consume already sealed observations',async()=>{
  const seen=[];
  const runners=Object.fromEntries(['features','factors','theories','shadow'].map(name=>[name,async()=>{
    seen.push(name);
    if(name==='features')throw new Error('expected read failure');
    return Response.json({ok:true,created:0});
  }]));
  const report=await runV8ResearchObservations({}, {dryRun:true},{runners});
  assert.deepEqual(seen,['features','theories']);
  assert.equal(report.ok,false);assert.equal(report.complete,false);assert.equal(report.status,'PARTIAL');
  assert.equal(report.phases.features.error,'RESEARCH_PHASE_FAILED');
  assert.equal(report.phases.theories.ok,true);
});

test('partial read failures and row errors are never advertised as a completed batch',async()=>{
  const report=await runV8ResearchObservations({}, {dryRun:true},{runners:{
    features:async()=>Response.json({ok:false,error:'PAGED_SOURCE_INCOMPLETE'},{status:503}),
    theories:async()=>Response.json({ok:true,read_errors:1})}});
  assert.equal(report.ok,false);assert.equal(report.complete,false);
  assert.equal(report.phases.features.http_status,503);assert.equal(report.phases.theories.ok,false);
});

test('dry run writes no research records and no locks',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows}=fixture();
  const report=await runV8ResearchObservations(client,{dryRun:true});
  assert.equal(report.ok,true);assert.equal(report.phases.features.model_changes,2);
  for(const name of ['V7FeatureSnapshot','V7FactorCandidate','V8TheoryTrial','V7BuyShadowTrial','ProcessLock'])assert.equal(rows[name].length,0);
});

test('HTTP handler rejects anonymous and non-admin callers before service-role work',async()=>{
  let runs=0;
  for(const [user,status] of [[null,401],[{role:'user'},403]]){
    const handle=createV8ResearchObservationsHandler(()=>({auth:{me:async()=>user}}),async()=>{runs++;return {ok:true};});
    assert.equal((await handle(new Request('https://example.invalid',{method:'POST',body:'{}'}))).status,status);
  }
  assert.equal(runs,0);
});

test('HTTP input cannot override budget, date or cutoff and phase failure returns 503',async()=>{
  let observed;
  const handle=createV8ResearchObservationsHandler(()=>({auth:{me:async()=>({role:'admin'})}}),async(client,options)=>{
    observed=options;return {ok:false,complete:false,phases:{features:{ok:false}}};
  });
  const response=await handle(new Request('https://example.invalid',{method:'POST',body:JSON.stringify({dry_run:true,budgetMs:999999,date:'2020-01-01',cutoff:0})}));
  assert.deepEqual(observed,{dryRun:true});assert.equal(response.status,503);
});

const formats={
  utc:value=>value,
  jst:value=>new Date(Date.parse(value)+9*3600000).toISOString().replace('Z','+09:00'),
  naiveUtcMicroseconds:value=>value.replace(/Z$/,'000'),
};
function formatObservedInputs(rows,format){
  for(const row of [...rows.Race,...rows.RaceEntry,...rows.OddsSnapshot]){
    for(const field of ['deadline','updated_date','created_date','captured_at'])if(row[field])row[field]=format(row[field]);
  }
}

test('raw V8 capture treats Z, production +09:00 and naive UTC microseconds as the same instant',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const outputs=[];
  for(const format of Object.values(formats)){
    const {client,rows}=fixture();formatObservedInputs(rows,format);
    const report=await runV8ResearchObservations(client);
    assert.equal(report.ok,true);assert.equal(rows.V8TheoryTrial.length,2);
    outputs.push(rows.V8TheoryTrial.map(trial=>({models:trial.models,baseline:trial.baseline_tickets,
      source_mode:trial.provenance.source_mode,stage:trial.stage})));
  }
  assert.deepEqual(outputs[0],outputs[1]);assert.deepEqual(outputs[0],outputs[2]);
});

test('V8 input-only stage windows depend on exhibition readiness and deadline, never a prediction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const [minutes,ready,expected] of [[121,false,[]],[46,true,[]],[30,false,['PRE']],
    [14,false,[]],[30,true,['FINAL']],[6,true,['FINAL','LOCK']],[4,true,['LOCK']],[2,true,[]],[-1,true,[]]]){
    const {client,rows}=fixture(minutes*60000);
    rows.Race[0].exhibition_ready=ready;
    delete client.asServiceRole.entities.PredictionV7;
    if(!ready)for(const entry of rows.RaceEntry){
      delete entry.exhibition_time;delete entry.exhibition_st;delete entry.exhibition_course;
    }
    const response=await runV7CaptureFeatures(client,{sourceMode:'V8_INPUT_ONLY'});
    assert.equal(response.status,200);
    assert.deepEqual(rows.V7FeatureSnapshot.map(row=>row.snapshot_stage).sort(),expected);
  }
});

test('actual theory runner recovers a transient 429 without changing or duplicating records',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows}=fixture();
  await runV7CaptureFeatures(client,{sourceMode:'V8_INPUT_ONLY'});
  const entity=client.asServiceRole.entities.V8TheoryTrial,original=entity.filter;
  let attempts=0;
  entity.filter=async(...args)=>{
    if(++attempts===1)throw Object.assign(new Error('temporary upstream rejection'),{response:{status:429}});
    return original(...args);
  };
  const response=await runV8TheoryTrials(client,{deadlineMs:NOW+5000});
  assert.equal(response.status,200);assert.equal(attempts,2);
  assert.equal(rows.V8TheoryTrial.length,2);
  await runV8TheoryTrials(client,{deadlineMs:NOW+5000});
  assert.equal(rows.V8TheoryTrial.length,2);
});

test('actual theory runner rejects permanent errors and malformed pages without retry or write',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const kind of ['forbidden','array']){
    const {client,rows}=fixture();await runV7CaptureFeatures(client,{sourceMode:'V8_INPUT_ONLY'});
    let attempts=0;
    client.asServiceRole.entities.V8TheoryTrial.filter=async()=>{
      attempts++;
      if(kind==='forbidden')throw Object.assign(new Error('private response body'),{response:{status:403}});
      return [];
    };
    const response=await runV8TheoryTrials(client,{deadlineMs:NOW+5000}),body=await response.json();
    assert.equal(response.status,503);assert.equal(attempts,1);assert.equal(rows.V8TheoryTrial.length,0);
    assert.equal(body.error,'PAGED_SOURCE_INCOMPLETE');
    assert.equal(body.diagnostic.existing.error,kind==='array'?'page_format_invalid':'page_read_failed_or_timed_out');
    assert.equal(body.diagnostic.existing.http_status,kind==='forbidden'?403:null);
    assert.equal(JSON.stringify(body).includes('private'),false);
  }
});

test('research retry cannot extend its cooperative deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows}=fixture();await runV7CaptureFeatures(client,{sourceMode:'V8_INPUT_ONLY'});
  let attempts=0;
  client.asServiceRole.entities.V8TheoryTrial.filter=async()=>{
    attempts++;throw Object.assign(new Error('retry later'),{response:{status:429,headers:{'retry-after':'1'}}});
  };
  const response=await runV8TheoryTrials(client,{deadlineMs:NOW+100}),body=await response.json();
  assert.equal(response.status,503);assert.equal(attempts,1);assert.equal(rows.V8TheoryTrial.length,0);
  assert.equal(body.diagnostic.existing.error,'retry_budget_exhausted');
});
