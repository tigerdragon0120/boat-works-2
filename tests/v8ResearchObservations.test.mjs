import test from 'node:test';
import assert from 'node:assert/strict';
import {runV8ResearchObservations,createV8ResearchObservationsHandler} from '../base44/shared/v8ResearchObservations.js';
import {runV7BuyShadowTrial} from '../base44/shared/v7BuyShadowRunner.js';

const NOW=Date.parse('2026-11-23T05:00:00Z');
const at=offset=>new Date(NOW+offset).toISOString();
const tickets=['1-2-3','1-2-4','1-2-5','1-2-6','1-3-2','1-3-4','1-3-5','2-1-3'];

function fixture(left=6*60000){
  const race={id:'race-1',race_key:'2026-11-23_01_01',race_date:'2026-11-23',venue_code:'01',race_number:1,
    deadline:at(left),status:'scheduled',exhibition_ready:true,is_womens:false,series_day:1,race_type:'予選'};
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
  const entities=Object.fromEntries(Object.keys(rows).map(name=>[name,{
    async filter(query,options,limit){
      const matches=rows[name].filter(row=>Object.entries(query).every(([key,value])=>row[key]===value));
      return typeof options==='object'?{items:structuredClone(matches),has_more:false,next_cursor:null}:structuredClone(matches.slice(0,limit));
    },
    async create(record){const row={...structuredClone(record),id:name+'-'+(rows[name].length+1),created_date:at(0)};rows[name].push(row);return structuredClone(row);},
    async update(id,data){const row=rows[name].find(row=>row.id===id);Object.assign(row,data);return structuredClone(row);},
    async deleteMany(query){rows[name]=rows[name].filter(row=>!Object.entries(query).every(([key,value])=>row[key]===value));},
  }]));
  return {client:{asServiceRole:{entities}},rows,before};
}

test('one call seals features before all consumers, keeps prediction inputs unchanged, and retries idempotently',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows,before}=fixture();
  const report=await runV8ResearchObservations(client);
  assert.equal(report.ok,true);assert.equal(report.complete,true);
  assert.equal(rows.V7FeatureSnapshot.length,2);
  assert.deepEqual(rows.V7FeatureSnapshot.map(r=>r.snapshot_stage).sort(),['FINAL','LOCK']);
  assert.equal(rows.V7FactorCandidate.length,2);assert.equal(rows.V8TheoryTrial.length,2);
  for(const record of [...rows.V7FactorCandidate,...rows.V8TheoryTrial]){
    assert.ok(rows.V7FeatureSnapshot.some(feature=>feature.id===(record.source_snapshot_id||record.snapshot_id)));
  }
  assert.equal(rows.V7BuyShadowTrial.length,1);assert.equal(rows.V7BuyShadowTrial[0].decision,'BUY');
  const counts=[rows.V7FeatureSnapshot.length,rows.V7FactorCandidate.length,rows.V8TheoryTrial.length,rows.V7BuyShadowTrial.length];
  const repeated=await runV8ResearchObservations(client);
  assert.equal(repeated.ok,true);
  assert.deepEqual([rows.V7FeatureSnapshot.length,rows.V7FactorCandidate.length,rows.V8TheoryTrial.length,rows.V7BuyShadowTrial.length],counts);
  assert.deepEqual({Race:rows.Race,PredictionV7:rows.PredictionV7,RaceEntry:rows.RaceEntry,OddsSnapshot:rows.OddsSnapshot},before);
  assert.ok(rows.ProcessLock.every(row=>row.status==='released'));
});

test('post-cutoff input never becomes a prospective feature or BUY',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const {client,rows}=fixture(50000);
  // A prior valid feature exists, but its consumers also refuse late creation.
  rows.V7FeatureSnapshot.push({id:'sealed-feature',snapshot_key:'past',race_date:'2026-11-23',race_key:'2026-11-23_01_01',
    race_id:'race-1',snapshot_stage:'FINAL',gender_model:'OPEN',observed_at:at(-120000),created_date:at(-120000),deadline:at(50000),boats:[]});
  const report=await runV8ResearchObservations(client);
  assert.equal(report.ok,true);
  assert.equal(rows.V7FeatureSnapshot.length,1);assert.equal(rows.V7FactorCandidate.length,0);
  assert.equal(rows.V8TheoryTrial.length,0);assert.equal(rows.V7BuyShadowTrial.length,0);
  assert.equal(report.phases.factors.rejected_late,1);assert.equal(report.phases.theories.late,1);
});

test('one failing phase is reported while independent phases still run',async()=>{
  const seen=[];
  const runners=Object.fromEntries(['features','factors','theories','shadow'].map(name=>[name,async()=>{
    seen.push(name);
    if(name==='factors')throw new Error('expected read failure');
    return Response.json({ok:true,created:0});
  }]));
  const report=await runV8ResearchObservations({}, {dryRun:true},{runners});
  assert.equal(seen[0],'features');assert.equal(seen.length,4);
  assert.equal(report.ok,false);assert.equal(report.complete,false);assert.equal(report.status,'PARTIAL');
  assert.equal(report.phases.factors.error,'RESEARCH_PHASE_FAILED');
  assert.equal(report.phases.theories.ok,true);assert.equal(report.phases.shadow.ok,true);
});

test('partial read failures and row errors are never advertised as a completed batch',async()=>{
  const good=async()=>Response.json({ok:true});
  const report=await runV8ResearchObservations({}, {dryRun:true},{runners:{features:good,
    factors:async()=>Response.json({ok:false,error:'PAGED_SOURCE_INCOMPLETE'},{status:503}),
    theories:good,shadow:async()=>Response.json({ok:true,read_errors:1})}});
  assert.equal(report.ok,false);assert.equal(report.complete,false);
  assert.equal(report.phases.factors.http_status,503);assert.equal(report.phases.shadow.ok,false);
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
function formatShadowInputs(rows,format){
  rows.Race[0].deadline=format(rows.Race[0].deadline);
  for(const field of ['created_date','generated_at'])rows.PredictionV7[0][field]=format(rows.PredictionV7[0][field]);
  for(const field of ['captured_at','created_date'])rows.OddsSnapshot[0][field]=format(rows.OddsSnapshot[0][field]);
}

test('shadow treats Z, production +09:00 and naive UTC microseconds as the same instant',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const outputs=[];
  for(const format of Object.values(formats)){
    const {client,rows}=fixture();formatShadowInputs(rows,format);
    const response=await runV7BuyShadowTrial(client);
    assert.equal(response.status,200);assert.equal(rows.V7BuyShadowTrial.length,1);
    const trial=rows.V7BuyShadowTrial[0];
    assert.equal(trial.decision,'BUY');
    outputs.push({deadline:trial.deadline,cutoff:trial.cutoff_at,decided:trial.decided_at,
      predictionTime:trial.prediction_generated_at,tickets:trial.tickets,odds:trial.sealed_odds});
  }
  assert.deepEqual(outputs[0],outputs[1]);assert.deepEqual(outputs[0],outputs[2]);
});

test('all supported timestamp formats enforce the original shadow window and cutoff',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const format of Object.values(formats)){
    for(const left of [-1000,50000,89000,8*60000+1]){
      const {client,rows}=fixture(left);formatShadowInputs(rows,format);
      await runV7BuyShadowTrial(client);
      assert.equal(rows.V7BuyShadowTrial.length,0);
    }
    const {client,rows}=fixture(120000);formatShadowInputs(rows,format);
    rows.PredictionV7[0].created_date=format(at(1000));
    await runV7BuyShadowTrial(client);
    assert.equal(rows.V7BuyShadowTrial.length,1);
    assert.equal(rows.V7BuyShadowTrial[0].decision,'UNDETERMINED');
    assert.equal(rows.V7BuyShadowTrial[0].reason,'PREDICTION_TIME_INVALID');
  }
});
