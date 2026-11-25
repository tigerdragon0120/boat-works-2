import test from 'node:test';
import assert from 'node:assert/strict';
import {runV8LiveCapture} from '../base44/shared/v8LiveCapture.js';
import {runV8LiveGeneration} from '../base44/shared/v8LiveGeneration.js';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';

const NOW=Date.parse('2026-11-22T03:00:00Z');
const SOURCE='2026-11-22T02:00:00Z';
const makeRace=(id,number,{tomorrow=false,...extra}={})=>({
  id,race_key:`2026-11-${tomorrow?'23':'22'}_01_${String(number).padStart(2,'0')}`,
  race_date:`2026-11-${tomorrow?'23':'22'}`,venue_code:'01',race_number:number,
  deadline:`2026-11-${tomorrow?'23':'22'}T04:00:00Z`,status:'scheduled',is_womens:false,series_name:'一般戦',updated_date:SOURCE,...extra,
});
const entriesFor=(race,exhibition=false)=>Array.from({length:6},(_,i)=>({
  id:`${race.id}-${i+1}`,race_id:race.id,race_key:race.race_key,race_date:race.race_date,
  boat_number:i+1,registration_number:String(4501+i),national_win_rate:i===0?8.2:5.5-i*.1,
  national_2rate:i===0?60:32-i,local_win_rate:i===0?8:5.3,motor_f2_rate:i===0?60:35,
  avg_st:i===0?.12:.17+i*.01,section_finishes:i===0?'1-2-1':'3-4-3',updated_date:SOURCE,
  ...(exhibition?{exhibition_time:i===0?6.65:6.78+i*.01,exhibition_st:.09+i*.02,exhibition_course:i+1}:{}),
}));

function setup(t,{races=[],entries=[],forecasts=[],results=[],before=()=>{}}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const tables={Race:structuredClone(races),RaceEntry:structuredClone(entries),V8RaceForecast:structuredClone(forecasts),
    RaceResult:structuredClone(results),ProcessLock:[],RacerStatsSync:[],PredictionV7:[],OddsSnapshot:[],
    V7WeatherObservation:[],V7StageClaim:[],V7GenerationTrace:[],OnlineFetchLog:[]};
  const calls=[];let serial=0;
  const match=(row,query)=>Object.entries(query||{}).every(([key,value])=>value&&typeof value==='object'
    ? ('$in' in value?value.$in.includes(row[key]):false) : row[key]===value);
  const touch=(name,method,args)=>{calls.push({name,method,args,at:Date.now()});before({name,method,args,tables,t});};
  const entities=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{
    async filter(query={},options,limit){touch(name,'filter',[query,options,limit]);const found=rows.filter(row=>match(row,query));
      if(options&&typeof options==='object')return {items:structuredClone(found),has_more:false,next_cursor:null};
      return structuredClone(found.slice(0,limit||found.length));},
    async get(id){touch(name,'get',[id]);return structuredClone(rows.find(row=>row.id===id)||null);},
    async create(doc){touch(name,'create',[doc]);const row={...structuredClone(doc),id:`${name}-${++serial}`,created_date:new Date().toISOString()};rows.push(row);return structuredClone(row);},
    async bulkCreate(docs){touch(name,'bulkCreate',[docs]);for(const doc of docs)rows.push({...structuredClone(doc),id:`${name}-${++serial}`,created_date:new Date().toISOString()});return [];},
    async update(id,doc){touch(name,'update',[id,doc]);const row=rows.find(row=>row.id===id);if(row)Object.assign(row,structuredClone(doc));return structuredClone(row);},
    async updateMany(query,update){touch(name,'updateMany',[query,update]);const found=rows.filter(row=>match(row,query));for(const row of found)Object.assign(row,structuredClone(update.$set||update));return {updated:found.length};},
    async bulkUpdate(docs){touch(name,'bulkUpdate',[docs]);for(const doc of docs){const row=rows.find(row=>row.id===doc.id);if(row)Object.assign(row,structuredClone(doc));}return [];},
    async deleteMany(query){touch(name,'deleteMany',[query]);for(let i=rows.length-1;i>=0;i--)if(match(rows[i],query))rows.splice(i,1);},
  }]));
  return {tables,calls,client:{asServiceRole:{entities}}};
}

test('the V8 scheduler fills PRE and DAY_BEFORE without any V7 entities or ready keys',async t=>{
  const today=makeRace('today',1),tomorrow=makeRace('tomorrow',1,{tomorrow:true});
  const state=setup(t,{races:[today,tomorrow],entries:[...entriesFor(today),...entriesFor(tomorrow)]});
  for(const name of ['PredictionV7','V7StageClaim','V7GenerationTrace'])delete state.client.asServiceRole.entities[name];
  const first=await runV8LiveGeneration(state.client);
  assert.equal(first.ok,true);assert.equal(Object.hasOwn(first,'v7'),false);assert.equal(first.v8.pre,1);assert.equal(first.v8.day_before,1);
  const original=structuredClone(state.tables.V8RaceForecast);
  assert.ok(original.every(row=>row.record_mode!=='REPLAY'));
  const again=await runV8LiveGeneration(state.client);
  assert.equal(again.v8.created,0);assert.deepEqual(state.tables.V8RaceForecast,original);
  assert.ok(state.tables.ProcessLock.every(row=>row.status==='released'));
});

test('V8 FINAL preserves its PRE baseline and never reads or writes V7 prediction records',async t=>{
  const race=makeRace('final',2,{deadline:'2026-11-22T03:20:00Z',exhibition_ready:true});
  const preRace={...race,exhibition_ready:false},preEntries=entriesFor(preRace);
  const baseline={...buildRaceForecast({race:preRace,entries:preEntries,stage:'PRE',now:'2026-11-22T02:30:00Z'}).record,
    id:'original-pre',created_date:'2026-11-22T02:30:00Z'};
  const state=setup(t,{races:[race],entries:entriesFor(race,true),forecasts:[baseline]});
  const old={id:'old-v7',race_id:race.id,stage:'FINAL',plans:{hit_8:{judgment:'SKIP',tickets:['6-5-4']}}};
  state.tables.PredictionV7.push(structuredClone(old));
  for(const name of ['PredictionV7','V7StageClaim','V7GenerationTrace'])delete state.client.asServiceRole.entities[name];
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.ok,true);assert.equal(result.v8.final,1);
  const v8=state.tables.V8RaceForecast.find(row=>row.stage==='FINAL');
  assert.equal(v8.provenance.prediction_id,null);
  assert.equal(v8.decision.strategy,'V8_OWN_FORECAST_1');
  assert.equal(v8.decision.status,'WATCH');assert.equal(v8.research_tickets.length,8);
  assert.deepEqual(v8.decision.tickets,v8.research_tickets);
  assert.equal(v8.comparison.baseline_id,baseline.id);
  assert.deepEqual(state.tables.V8RaceForecast.find(row=>row.id===baseline.id),baseline);
  assert.deepEqual(state.tables.PredictionV7,[old]);
  assert.equal(state.calls.some(call=>['PredictionV7','V7StageClaim','V7GenerationTrace'].includes(call.name)),false);
});

test('V8 uses the remaining pipeline budget instead of reserving time for another engine',async t=>{
  const race=makeRace('pre',4);let delayed=false;
  const state=setup(t,{races:[race],entries:entriesFor(race),before:({name,method,t})=>{
    if(!delayed&&name==='ProcessLock'&&method==='create'){delayed=true;t.mock.timers.tick(46000);}
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.ok,true);assert.equal(result.v8.pre,1);
  assert.equal(state.tables.V7StageClaim.length,0);
});

test('a legacy V7 lock cannot block V8 capture',async t=>{
  const race=makeRace('pre',5),state=setup(t,{races:[race],entries:entriesFor(race)});
  const legacy={id:'held-v7',lock_key:'v7_generate_2026-11-22',status:'active',expires_at:new Date(NOW+120000).toISOString()};
  state.tables.ProcessLock.push(structuredClone(legacy));
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.ok,true);assert.equal(result.v8.pre,1);
  assert.deepEqual(state.tables.ProcessLock.find(row=>row.id==='held-v7'),legacy);
});

test('the three-minute throttle never delays completed or corrected exhibition inputs',async t=>{
  const race=makeRace('exhibition-refresh',3,{deadline:'2026-11-22T03:20:00Z',exhibition_ready:true});
  const entries=entriesFor(race,true),partialEntries=structuredClone(entries);
  partialEntries[5].exhibition_time=null;
  const previousAt=new Date(NOW-60000).toISOString();
  const partial={...buildRaceForecast({race,entries:partialEntries,stage:'FINAL',now:previousAt}).record,
    id:'saved-partial',created_date:previousAt};
  assert.equal(partial.exhibition_complete,false);
  const state=setup(t,{races:[race],entries,forecasts:[partial]});
  const completed=await runV8LiveCapture(state.client);
  assert.equal(completed.final,1);
  assert.equal(state.tables.V8RaceForecast.at(-1).exhibition_complete,true);
  const unchanged=await runV8LiveCapture(state.client);
  assert.equal(unchanged.created,0);assert.equal(unchanged.existing,1);

  t.mock.timers.tick(30000);
  state.tables.RaceEntry[0].exhibition_time=6.59;
  state.tables.RaceEntry[0].updated_date=new Date(Date.now()).toISOString();
  const corrected=await runV8LiveCapture(state.client);
  assert.equal(corrected.final,1);
  assert.equal(state.tables.V8RaceForecast.at(-1).boats[0].exhibition_time,6.59);
  assert.deepEqual(state.tables.V8RaceForecast[0],partial);

  state.tables.RaceEntry[0].updated_date=new Date(Date.now()+1000).toISOString();
  const future=await runV8LiveCapture(state.client);
  assert.equal(future.created,0);assert.equal(future.reasons.ENTRY_SOURCE_TIME_INVALID,1);
  assert.equal(state.tables.V8RaceForecast.length,3);
});

test('V8 live capture excludes closed, cutoff and confirmed-result races',async t=>{
  const finished=makeRace('finished',6,{status:'finished'}),cutoff=makeRace('cutoff',7,{deadline:new Date(NOW+90000).toISOString()}),
    resulted=makeRace('resulted',8),active=makeRace('active',9);
  const state=setup(t,{races:[finished,cutoff,resulted,active],entries:[finished,cutoff,resulted,active].flatMap(r=>entriesFor(r)),
    results:[{id:'confirmed',race_id:resulted.id,result_status:'RESULT_FINAL'}]});
  const result=await runV8LiveCapture(state.client);
  assert.equal(result.created,1);assert.equal(result.reasons.RESULT_ALREADY_AVAILABLE,1);
  assert.equal(state.tables.V8RaceForecast[0].race_id,'active');
});

test('V8 capture stops after an in-flight write settles and resumes missing keys without overwriting',async t=>{
  const a=makeRace('a',10),b=makeRace('b',11);let delayed=false;
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a),...entriesFor(b)],before:({name,method,t})=>{
    if(!delayed&&name==='V8RaceForecast'&&method==='create'){delayed=true;t.mock.timers.tick(45001);}
  }});
  const first=await runV8LiveCapture(state.client,{deadlineMs:NOW+45000});
  assert.equal(first.created,1);assert.equal(first.partial,true);
  const saved=structuredClone(state.tables.V8RaceForecast[0]);
  const second=await runV8LiveCapture(state.client,{deadlineMs:Date.now()+45000});
  assert.equal(second.created,1);assert.deepEqual(state.tables.V8RaceForecast[0],saved);
});

test('past dates are rejected by the live pipeline without touching the database',async t=>{
  const state=setup(t);const result=await runV8LiveGeneration(state.client,{race_date:'2026-11-21'});
  assert.equal(result.ok,false);assert.equal(result.error,'INVALID_LIVE_DATE');assert.equal(state.calls.length,0);
});

test('a manual refresh saves only the requested V8 race and rejects an empty scope',async t=>{
  const a=makeRace('selected',10),b=makeRace('other',11);
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a),...entriesFor(b)]});
  const result=await runV8LiveGeneration(state.client,{race_keys:[a.race_key]});
  assert.equal(result.ok,true);assert.equal(result.v8.created,1);
  assert.deepEqual(state.tables.V8RaceForecast.map(r=>r.race_id),[a.id]);
  const rejected=await runV8LiveCapture(state.client,{race_keys:[]});
  assert.equal(rejected.ok,false);assert.equal(rejected.error,'INVALID_RACE_KEYS');
  assert.equal(state.tables.V8RaceForecast.length,1);
});

test('a failed V8 forecast write makes the pipeline fail while a budget-only pause remains successful',async t=>{
  const race=makeRace('write-fails',12);
  const state=setup(t,{races:[race],entries:entriesFor(race),before:({name,method})=>{
    if(name==='V8RaceForecast'&&method==='create')throw new Error('simulated storage failure');
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.ok,false);assert.equal(result.error,'LIVE_CAPTURE_PARTIAL_FAILURE');
  assert.equal(result.partial,true);assert.equal(result.v8.errors,1);assert.equal(state.tables.V8RaceForecast.length,0);
  assert.ok(state.tables.ProcessLock.every(row=>row.status==='released'));
  const paused=await runV8LiveGeneration(state.client,{timeBudgetMs:0});
  assert.equal(paused.ok,true);assert.equal(paused.partial,true);assert.equal(paused.skipped,'time_budget');
});

test('later original timings reach saved V8 forecasts immediately without rewriting the earlier FINAL',async t=>{
  const race=makeRace('sum-arrival',1,{deadline:'2026-11-22T03:20:00Z',exhibition_ready:true});
  const entries=entriesFor(race,true),state=setup(t,{races:[race],entries});
  const first=await runV8LiveCapture(state.client);
  assert.equal(first.final,1);
  const previous=structuredClone(state.tables.V8RaceForecast[0]);
  assert.equal(previous.sum_evidence.used_for_scoring,false);
  t.mock.timers.tick(1000);
  const current=state.tables.Race[0],at=new Date(Date.now()).toISOString();
  current.updated_date=at;
  current.original_exhibition={status:'AVAILABLE',source_kind:'OFFICIAL_ORIGINAL_EXHIBITION',provider:'BOATCAST',
    race_date:race.race_date,venue_code:'01',race_number:1,captured_at:at,exhibition_captured_at:at,
    source_url:'https://race.boatcast.jp/txt/01/bc_oriten_20261122_01_01.txt',
    exhibition_source_url:'https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261122&jcd=01&rno=1',
    entries:entries.map((entry,i)=>({boat_number:i+1,registration_number:entry.registration_number,
      exhibition_time:entry.exhibition_time,lap_time:38-i*.4,turn_time:8-i*.1,straight_time:7.5-i*.05}))};
  const next=await runV8LiveCapture(state.client);
  assert.equal(next.final,1);
  const saved=state.tables.V8RaceForecast.at(-1);
  assert.equal(saved.sum_evidence.used_for_scoring,true);
  assert.equal(saved.sum_evidence.selected_model,'SUM_BASIC');
  assert.equal(saved.original_exhibition.source_url,current.original_exhibition.source_url);
  assert.deepEqual(state.tables.V8RaceForecast[0],previous);
  assert.notEqual(saved.forecast_key,previous.forecast_key);
  assert.equal((await runV8LiveCapture(state.client)).created,0);
});
