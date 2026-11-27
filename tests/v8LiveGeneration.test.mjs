import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {runV8LiveCapture} from '../base44/shared/v8LiveCapture.js';
import {runV8LiveGeneration} from '../base44/shared/v8LiveGeneration.js';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';
import {parseOfficialVenueProfile} from '../base44/shared/v8VenueProfileSource.js';
import {makeVenueProfileRecord} from '../base44/shared/v8VenueStore.js';
import {emptyFrameTendencies} from '../base44/shared/v8RacerTendencies.js';
import {liveResponseStatus,LIVE_STATUS_NAME} from '../base44/shared/v8LiveStatus.js';
import {buildCommittedExhibitionKey} from '../base44/shared/exhibitionInputKey.js';

const generateEntry=stripTypeScriptTypes(fs.readFileSync(new URL('../base44/functions/v8GenerateLiveForecasts/entry.ts',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'')).replace('export default async function','return async function');
const generateHandler=client=>new Function('createClientFromRequest','runV8LiveGeneration','liveResponseStatus',generateEntry)(
  ()=>({...client,auth:{me:async()=>({role:'admin'})}}),runV8LiveGeneration,liveResponseStatus);

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
const commitExhibition=(race,entries,at=SOURCE)=>{
  const key=buildCommittedExhibitionKey(race,entries);
  if(key)Object.assign(race,{exhibition_input_key:key,exhibition_committed_at:at});
  return key;
};

const projected=(value,fields,prefix='')=>{
  if(fields.includes(prefix)||value==null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(row=>projected(row,fields,prefix));
  return Object.fromEntries(Object.entries(value).filter(([key])=>fields.some(field=>{
    const path=prefix?prefix+'.'+key:key;return field===path||field.startsWith(path+'.');
  })).map(([key,item])=>[key,projected(item,fields,prefix?prefix+'.'+key:key)]));
};
function setup(t,{races=[],entries=[],forecasts=[],results=[],venues=null,committed=true,before=()=>{}}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  t.mock.method(console,'info',()=>{});
  const tables={Race:structuredClone(races),RaceEntry:structuredClone(entries),V8RaceForecast:structuredClone(forecasts),
    RaceResult:structuredClone(results),ProcessLock:[],RacerStatsSync:[],PredictionV7:[],OddsSnapshot:[],
    V7WeatherObservation:[],V7StageClaim:[],V7GenerationTrace:[],OnlineFetchLog:[],AutoUpdateStatus:[]};
  // Default complete exhibition fixtures represent the collector's committed
  // saved input, not a set of individually visible writes in progress.
  if(committed)for(const race of tables.Race)commitExhibition(race,tables.RaceEntry.filter(entry=>entry.race_id===race.id));
  if(venues!==null)tables.V8VenueProfileSnapshot=structuredClone(venues);
  const calls=[];let serial=0;
  const match=(row,query)=>Object.entries(query||{}).every(([key,value])=>value&&typeof value==='object'
    ? ('$in' in value?value.$in.includes(row[key]):false) : row[key]===value);
  const touch=(name,method,args)=>{calls.push({name,method,args,at:Date.now()});before({name,method,args,tables,t});};
  const entities=Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{
    async filter(query={},options,limit){touch(name,'filter',[query,options,limit]);const found=rows.filter(row=>match(row,query));
      if(options&&typeof options==='object'){
        const offset=options.cursor?Number(options.cursor):0,more=offset+options.limit<found.length;
        const page=found.slice(offset,offset+options.limit);
        return {items:structuredClone(options.fields?page.map(row=>projected(row,options.fields)):page),has_more:more,next_cursor:more?String(offset+options.limit):null};
      }
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
  assert.equal(v8.decision.strategy,'V8_RULE_BUY_2');
  assert.equal(v8.decision.status,'WATCH');assert.equal(v8.research_tickets.length,8);
  assert.deepEqual(v8.decision.tickets,v8.final_selection.tickets);
  assert.ok(v8.final_selection.tickets.length>=6&&v8.final_selection.tickets.length<=12);
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
  commitExhibition(state.tables.Race[0],state.tables.RaceEntry,new Date(Date.now()).toISOString());
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

test('an unknown forecast write failure stays FAILED while a budget-only pause is durably PARTIAL',async t=>{
  const race=makeRace('write-fails',12);
  const state=setup(t,{races:[race],entries:entriesFor(race),before:({name,method})=>{
    if(name==='V8RaceForecast'&&method==='create')throw new Error('simulated storage failure');
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.ok,false);assert.equal(result.error,'LIVE_CAPTURE_FAILED');
  assert.equal(result.result_status,'FAILED');assert.equal(liveResponseStatus(result),503);
  assert.equal(result.v8.errors,1);assert.equal(state.tables.V8RaceForecast.length,0);
  assert.equal(state.tables.AutoUpdateStatus[0].status,'error');
  assert.ok(state.tables.ProcessLock.every(row=>row.status==='released'));
  const paused=await runV8LiveGeneration(state.client,{timeBudgetMs:0});
  assert.equal(paused.ok,false);assert.equal(paused.partial,true);assert.equal(paused.skipped,'time_budget');
  assert.equal(paused.result_status,'PARTIAL');assert.equal(paused.status_persisted,true);assert.equal(liveResponseStatus(paused),200);
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

async function venueSnapshot(at=SOURCE){
  const html=fs.readFileSync(new URL('./fixtures/official_venue_20261126_23.html',import.meta.url),'utf8');
  const parsed=await parseOfficialVenueProfile(html,{venueCode:'23',fetchedAt:at,now:at});
  assert.equal(parsed.ok,true);
  const record=await makeVenueProfileRecord(parsed.profile,{now:at});
  assert.ok(record);
  return {...record,id:'venue-23-october',created_date:at,updated_date:at};
}
const karatsu=(id,number)=>makeRace(id,number,{venue_code:'23',race_key:`2026-11-22_23_${String(number).padStart(2,'0')}`});

test('saved venue evidence is shared across races with one bulk read and no per-race source fetch',async t=>{
  const a=karatsu('venue-a',1),b=karatsu('venue-b',2),source=await venueSnapshot();
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a),...entriesFor(b)],venues:[source]});
  let fetched=0;t.mock.method(globalThis,'fetch',async()=>{fetched++;throw new Error('No source fetch is needed');});
  const out=await runV8LiveCapture(state.client);
  assert.equal(out.created,2);assert.equal(out.venue_profiles.ready,1);assert.equal(fetched,0);
  assert.equal(state.calls.filter(call=>call.name==='V8VenueProfileSnapshot'&&call.method==='filter').length,1);
  for(const row of state.tables.V8RaceForecast){
    assert.equal(row.venue_evidence.status,'READY');
    assert.equal(row.venue_evidence.profile.snapshot_id,source.id);
    assert.equal(row.provenance.venue_snapshot_id,source.id);
    assert.equal(row.provenance.venue_read_snapshot_id,source.id);
    assert.equal(row.venue_evidence.profile.courses['1'].first_rate,59.2);
  }
  assert.deepEqual(state.tables.V8VenueProfileSnapshot,[source]);
});

test('a newly available venue source appends a richer PRE without rewriting the earlier forecast',async t=>{
  const race=karatsu('venue-arrival',3),state=setup(t,{races:[race],entries:entriesFor(race),venues:[]});
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  const initial=await runV8LiveCapture(state.client);
  assert.equal(initial.pre,1);
  const original=structuredClone(state.tables.V8RaceForecast[0]);
  assert.equal(original.venue_evidence.status,'UNAVAILABLE');
  t.mock.timers.tick(1000);
  const source=await venueSnapshot(new Date().toISOString());
  state.tables.V8VenueProfileSnapshot.push(source);
  const arrived=await runV8LiveCapture(state.client);
  assert.equal(arrived.pre,1);assert.equal(state.tables.V8RaceForecast.length,2);
  const richer=state.tables.V8RaceForecast.at(-1);
  assert.notEqual(richer.forecast_key,original.forecast_key);
  assert.equal(richer.venue_evidence.profile.snapshot_id,source.id);
  assert.notEqual(richer.venue_key,original.venue_key);
  assert.deepEqual(state.tables.V8RaceForecast[0],original);
  assert.equal((await runV8LiveCapture(state.client)).created,0);
});

test('capture scopes its lightweight full-cursor index to actionable races and hydrates only the selected PRE',async t=>{
  const active=makeRace('active-index',1,{exhibition_ready:true}),closed=makeRace('closed-index',2,{status:'finished'}),
    cutoff=makeRace('cutoff-index',3,{deadline:new Date(NOW+90000).toISOString()});
  const baseline={...buildRaceForecast({race:{...active,exhibition_ready:false},entries:entriesFor(active),stage:'PRE',now:'2026-11-22T02:30:00Z'}).record,
    id:'chosen-pre',created_date:'2026-11-22T02:30:00Z'};
  const historical=Array.from({length:200},(_,i)=>({...baseline,id:'history-'+i,forecast_key:'history-'+i,stage:'FINAL',
    generated_at:SOURCE,created_date:SOURCE,quality:'PARTIAL',boats:[{large:'HEAVY_UNUSED_HISTORY'.repeat(1000)}]}));
  const excluded=[closed,cutoff].map(r=>({...baseline,id:'excluded-'+r.id,race_id:r.id,race_key:r.race_key,forecast_key:'excluded-'+r.id}));
  const originals=structuredClone([baseline,...historical,...excluded]);
  const state=setup(t,{races:[closed,cutoff,active],entries:entriesFor(active,true),forecasts:originals});
  const result=await runV8LiveCapture(state.client);
  assert.equal(result.final,1);assert.equal(result.active_races,1);assert.equal(result.prior_index_rows,201);assert.equal(result.hydrated_baselines,1);
  const reads=state.calls.filter(call=>call.name==='V8RaceForecast'&&call.method==='filter'&&typeof call.args[1]==='object');
  const index=reads.filter(call=>call.args[1].fields),detail=reads.filter(call=>!call.args[1].fields);
  assert.equal(index.length,2);assert.equal(index[1].args[1].cursor,'200');
  assert.ok(index.every(call=>JSON.stringify(call.args[0])===JSON.stringify({race_id:{$in:[active.id]}})));
  assert.ok(index.every(call=>call.args[1].fields.includes('forecast_key')&&call.args[1].fields.includes('final_selection.ranked_tickets.score')));
  assert.ok(index.every(call=>!call.args[1].fields.some(field=>/^(boats|scenarios|racer_evidence|recent_lane_evidence|venue_evidence|input_snapshot)(\.|$)/.test(field))));
  assert.deepEqual(detail.map(call=>call.args[0]),[{forecast_key:baseline.forecast_key}]);
  assert.ok(state.calls.findIndex(call=>call.name==='Race'&&call.method==='filter')<state.calls.findIndex(call=>call.name==='V8RaceForecast'));
  assert.equal(state.tables.V8RaceForecast.at(-1).comparison.baseline_id,baseline.id);
  assert.deepEqual(state.tables.V8RaceForecast.slice(0,-1),originals);
});

test('closed-only scope does not read prediction history or optional source datasets',async t=>{
  const race=makeRace('already-closed',1,{status:'finished'}),state=setup(t,{races:[race]});
  const result=await runV8LiveCapture(state.client);
  assert.equal(result.created,0);assert.equal(result.active_races,0);
  assert.equal(state.calls.some(call=>['V8RaceForecast','RaceEntry','RacerStatsSync','V8RecentLaneSnapshot','V8VenueProfileSnapshot'].includes(call.name)),false);
});

test('a chosen baseline that changes between the index and detail read is held without creating FINAL',async t=>{
  const cases={
    id:row=>{row.id='different-id';},key:row=>{row.forecast_key='different-key';},race:row=>{row.race_id='different-race';},
    stage:row=>{row.stage='FINAL';},time:row=>{row.generated_at='2026-11-22T02:31:00Z';},
    source:row=>{row.provenance.venue_snapshot_id='different-source';},missing_boats:row=>{delete row.boats;},
  };
  for(const [name,mutate] of Object.entries(cases))await t.test(name,async child=>{
    const race=makeRace('changed-'+name,1,{exhibition_ready:true});
    const baseline={...buildRaceForecast({race:{...race,exhibition_ready:false},entries:entriesFor(race),stage:'PRE',now:'2026-11-22T02:30:00Z'}).record,
      id:'chosen-'+name,created_date:'2026-11-22T02:30:00Z'};
    const state=setup(child,{races:[race],entries:entriesFor(race,true),forecasts:[baseline],before:({name,method,args,tables})=>{
      if(name==='V8RaceForecast'&&method==='filter'&&args[0].forecast_key===baseline.forecast_key)mutate(tables.V8RaceForecast[0]);
    }});
    const result=await runV8LiveCapture(state.client);
    assert.equal(result.created,0);assert.equal(result.reasons.BASELINE_DETAIL_MISMATCH,1);
    assert.equal(state.calls.some(call=>call.name==='V8RaceForecast'&&call.method==='create'),false);
  });
});

test('a baseline key duplicated outside the active race scope holds FINAL instead of using the visible row',async t=>{
  const active=makeRace('baseline-active',1,{exhibition_ready:true}),closed=makeRace('baseline-closed',2,{status:'finished'});
  const baseline={...buildRaceForecast({race:{...active,exhibition_ready:false},entries:entriesFor(active),stage:'PRE',now:'2026-11-22T02:30:00Z'}).record,
    id:'baseline-key-original',created_date:'2026-11-22T02:30:00Z'};
  const duplicate={...structuredClone(baseline),id:'baseline-key-cross-race',race_id:closed.id,race_key:closed.race_key};
  const original=structuredClone([baseline,duplicate]);
  const state=setup(t,{races:[active,closed],entries:entriesFor(active,true),forecasts:original});
  const result=await runV8LiveCapture(state.client);
  assert.equal(result.prior_index_rows,1);assert.equal(result.created,0);assert.equal(result.reasons.BASELINE_DETAIL_MISMATCH,1);
  const details=state.calls.filter(call=>call.name==='V8RaceForecast'&&call.method==='filter'
    &&typeof call.args[1]==='object'&&!call.args[1].fields);
  assert.deepEqual(details.map(call=>call.args[0]),[{forecast_key:baseline.forecast_key}]);
  assert.deepEqual(state.tables.V8RaceForecast,original);
});

test('hydration retains the same frozen PRE venue and produces the same before-cutoff forecast',async t=>{
  const source=await venueSnapshot(),race=karatsu('frozen-baseline',1);race.exhibition_ready=true;
  const profile={...source.profile,snapshot_id:source.id,snapshot_key:source.snapshot_key,available_at:source.created_date};
  const baseline={...buildRaceForecast({race:{...race,exhibition_ready:false},entries:entriesFor(race),stage:'PRE',now:'2026-11-22T02:30:00Z',venueProfile:profile}).record,
    id:'frozen-pre',created_date:'2026-11-22T02:30:00Z'};
  baseline.provenance.venue_snapshot_id=source.id;
  const entries=entriesFor(race,true),state=setup(t,{races:[race],entries,forecasts:[baseline]});
  const result=await runV8LiveCapture(state.client),saved=state.tables.V8RaceForecast.at(-1);
  const expected=buildRaceForecast({race,entries:entries.map(entry=>({...entry,
    v8_frame_tendencies:{registration_number:entry.registration_number,...emptyFrameTendencies({asOf:new Date(NOW).toISOString(),status:'UNAVAILABLE'})}})),
    stage:'FINAL',now:new Date(NOW).toISOString(),baseline}).record;
  assert.equal(result.final,1);assert.equal(saved.comparison.baseline_id,baseline.id);
  assert.equal(saved.venue_evidence.source_basis,'BASELINE_SNAPSHOT');
  assert.deepEqual(saved.venue_evidence.profile,baseline.venue_evidence.profile);
  assert.equal(saved.forecast_key,expected.forecast_key);
  assert.deepEqual(saved.scenarios,expected.scenarios);assert.deepEqual(saved.final_selection,expected.final_selection);
  assert.deepEqual(state.tables.V8RaceForecast[0],baseline);
});

test('a transient forecast write returns durable PARTIAL HTTP 200, continues other races and retries only missing keys',async t=>{
  const a=makeRace('transient-a',1),b=makeRace('transient-b',2);let fail=true;
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a),...entriesFor(b)],before:({name,method,args})=>{
    if(fail&&name==='V8RaceForecast'&&method==='create'&&args[0].race_id===a.id)
      throw Object.assign(new Error('private provider failure'),{response:{status:503}});
  }});
  const request=()=>new Request('https://test.invalid/generate',{method:'POST',body:'{}'}),handler=generateHandler(state.client);
  const response=await handler(request()),first=await response.json();
  assert.equal(response.status,200);assert.equal(first.ok,false);assert.equal(first.result_status,'PARTIAL');
  assert.equal(first.worker_completed,true);assert.equal(first.status_persisted,true);assert.equal(first.v8.created,1);
  assert.equal(first.v8.pending_count,1);assert.equal(first.v8.retry_pending_count,1);
  const status=state.tables.AutoUpdateStatus.find(row=>row.name===LIVE_STATUS_NAME);
  assert.equal(status.status,'partial');assert.equal(status.job_summary.result_status,'PARTIAL');
  assert.equal(status.job_summary.created,1);assert.equal(status.job_summary.pending_count,1);
  assert.deepEqual(status.job_summary.pending,[{race_key:a.race_key,stage:'PRE',phase:'SAVE_FORECAST',code:'SOURCE_REQUEST_TRANSIENT',retryable:true}]);
  assert.doesNotMatch(JSON.stringify(status),/private provider/);
  const saved=structuredClone(state.tables.V8RaceForecast[0]);assert.equal(saved.race_id,b.id);
  fail=false;t.mock.timers.tick(1000);
  const recoveredResponse=await handler(request()),recovered=await recoveredResponse.json();
  assert.equal(recoveredResponse.status,200);assert.equal(recovered.ok,true);assert.equal(recovered.result_status,'COMPLETE');
  assert.equal(recovered.v8.created,1);assert.equal(recovered.v8.existing,1);assert.equal(recovered.v8.pending_count,0);
  assert.equal(state.tables.V8RaceForecast.length,2);assert.deepEqual(state.tables.V8RaceForecast.find(row=>row.race_id===b.id),saved);
  assert.equal(state.tables.AutoUpdateStatus.length,1);assert.equal(state.tables.AutoUpdateStatus[0].status,'success');
});

test('a confirmed network read failure stays pending while another race is captured',async t=>{
  const a=makeRace('read-transient-a',1,{exhibition_ready:true}),b=makeRace('read-transient-b',2,{exhibition_ready:true});
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a,true),...entriesFor(b,true)],before:({name,method,args})=>{
    if(name==='OddsSnapshot'&&method==='filter'&&args[0].race_id===a.id)throw Object.assign(new Error('Network Error'),{code:'ERR_NETWORK'});
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.result_status,'PARTIAL');assert.equal(liveResponseStatus(result),200);assert.equal(result.v8.created,1);
  assert.equal(result.v8.retry_pending_count,1);assert.equal(result.v8.pending[0].phase,'READ_QUOTES');
  assert.equal(result.v8.pending[0].code,'SOURCE_READ_TRANSIENT');assert.equal(state.tables.AutoUpdateStatus[0].status,'partial');
});

test('rate limiting is recorded as retry pending and backs off before another race request',async t=>{
  const a=makeRace('limited-a',1),b=makeRace('limited-b',2);
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a),...entriesFor(b)],before:({name,method})=>{
    if(name==='V8RaceForecast'&&method==='create')throw Object.assign(new Error('rate limited'),{response:{status:429}});
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.result_status,'PARTIAL');assert.equal(liveResponseStatus(result),200);
  assert.equal(result.v8.attempted,1);assert.equal(result.v8.retry_pending_count,2);assert.equal(result.v8.pending_count,2);
  assert.ok(result.v8.pending.every(row=>row.code==='RATE_LIMIT_BACKOFF'));
  assert.equal(state.tables.AutoUpdateStatus[0].job_summary.retry_pending_count,2);
});

test('implementation and permission failures remain FAILED rather than retryable success',async t=>{
  for(const kind of ['TypeError','Forbidden'])await t.test(kind,async child=>{
    const race=makeRace('hard-failure',1),state=setup(child,{races:[race],entries:entriesFor(race),before:({name,method})=>{
      if(name==='V8RaceForecast'&&method==='create')throw kind==='TypeError'?new TypeError('private bad implementation')
        :Object.assign(new Error('private access restriction'),{response:{status:403}});
    }});
    const result=await runV8LiveGeneration(state.client);
    assert.equal(result.result_status,'FAILED');assert.equal(result.ok,false);assert.equal(liveResponseStatus(result),503);
    assert.equal(result.v8.retry_pending_count,0);assert.equal(state.tables.AutoUpdateStatus[0].status,'error');
    assert.equal(state.tables.AutoUpdateStatus[0].job_summary.fatal.code,kind==='TypeError'?'IMPLEMENTATION_ERROR':'ACCESS_DENIED');
    assert.doesNotMatch(JSON.stringify(state.tables.AutoUpdateStatus),/private bad|private access/);
  });
});

test('a global database read failure remains FAILED even when it was a transport error',async t=>{
  const race=makeRace('global-read',1),state=setup(t,{races:[race],entries:entriesFor(race),before:({name,method})=>{
    if(name==='Race'&&method==='filter')throw Object.assign(new Error('Network Error'),{code:'ERR_NETWORK'});
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.result_status,'FAILED');assert.equal(liveResponseStatus(result),503);assert.equal(result.v8.created,0);
  assert.equal(result.v8.fatal.retryable,false);assert.equal(state.tables.AutoUpdateStatus[0].status,'error');
  assert.equal(state.tables.AutoUpdateStatus[0].job_summary.fatal.phase,'READ_RACES');
});

test('a status write failure cannot return completed or PARTIAL HTTP success',async t=>{
  const race=makeRace('status-write',1),state=setup(t,{races:[race],entries:entriesFor(race),before:({name,method})=>{
    if(name==='AutoUpdateStatus'&&method==='create')throw Object.assign(new Error('private status write failure'),{response:{status:503}});
  }});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.v8.created,1);assert.equal(result.result_status,'FAILED');assert.equal(result.status_persisted,false);
  assert.equal(result.error,'LIVE_STATUS_SAVE_FAILED');assert.equal(liveResponseStatus(result),503);
  assert.equal(state.tables.AutoUpdateStatus.length,0);
});

test('an overlapping generation lock leaves the previous durable PARTIAL untouched',async t=>{
  const state=setup(t),previous={id:'previous-job',name:LIVE_STATUS_NAME,status:'partial',last_updated:SOURCE,
    job_summary:{result_status:'PARTIAL',pending_count:2,retry_pending_count:1}};
  state.tables.AutoUpdateStatus.push(structuredClone(previous));
  state.tables.ProcessLock.push({id:'active-generation',lock_key:'V8_LIVE_GENERATION',status:'active',expires_at:new Date(NOW+120000).toISOString()});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.skipped,'locked');assert.equal(result.result_status,'SKIPPED');assert.equal(result.worker_completed,false);
  assert.equal(liveResponseStatus(result),200);assert.deepEqual(state.tables.AutoUpdateStatus,[previous]);
  assert.equal(state.calls.some(call=>call.name==='AutoUpdateStatus'),false);
});

test('an unconfirmed forecast write is reconciled on the next run without appending it again',async t=>{
  const race=makeRace('unconfirmed-write',1),state=setup(t,{races:[race],entries:entriesFor(race)});
  const entity=state.client.asServiceRole.entities.V8RaceForecast,create=entity.create;
  entity.create=async doc=>{await create(doc);return null;};
  const first=await runV8LiveGeneration(state.client);
  assert.equal(first.result_status,'PARTIAL');assert.equal(first.v8.pending[0].code,'SAVE_NOT_CONFIRMED');assert.equal(liveResponseStatus(first),200);
  assert.equal(state.tables.V8RaceForecast.length,1);const saved=structuredClone(state.tables.V8RaceForecast[0]);
  entity.create=create;t.mock.timers.tick(1000);
  const next=await runV8LiveGeneration(state.client);
  assert.equal(next.result_status,'COMPLETE');assert.equal(next.v8.created,0);assert.equal(next.v8.existing,1);
  assert.deepEqual(state.tables.V8RaceForecast,[saved]);
});

test('a failed lock write without an active lease is FAILED rather than a successful overlap',async t=>{
  const state=setup(t,{before:({name,method})=>{if(name==='ProcessLock'&&method==='create')throw new Error('private lock write failure');}});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.result_status,'FAILED');assert.equal(liveResponseStatus(result),503);
  assert.equal(result.skipped,undefined);assert.equal(state.tables.AutoUpdateStatus[0].status,'error');
  assert.equal(state.tables.AutoUpdateStatus[0].job_summary.fatal.phase,'LOCK');
});

test('ambiguous actionable race identities remain visible as an incomplete job',async t=>{
  const race=makeRace('ambiguous-a',1),state=setup(t,{races:[race,{...race,id:'ambiguous-b'}]});
  const result=await runV8LiveGeneration(state.client);
  assert.equal(result.result_status,'PARTIAL');assert.equal(result.ok,false);assert.equal(liveResponseStatus(result),200);
  assert.equal(result.v8.pending_count,1);assert.equal(result.v8.retry_pending_count,0);
  assert.equal(result.v8.pending[0].code,'DUPLICATE_RACE_KEY');assert.equal(state.tables.V8RaceForecast.length,0);
});

test('mixed exhibition writes are held per race until the committed six-boat input matches',async t=>{
  const a=makeRace('mixed-exhibition',1,{exhibition_ready:true}),b=makeRace('other-pre',2);
  let finishCollection=true;
  const state=setup(t,{races:[a,b],entries:[...entriesFor(a,true),...entriesFor(b)],before:({name,method,args,tables})=>{
    if(finishCollection&&name==='Race'&&method==='get'&&args[0]===a.id){
      finishCollection=false;
      const rows=tables.RaceEntry.filter(row=>row.race_id===a.id),fresh=tables.Race.find(row=>row.id===a.id);
      rows[1].exhibition_st=.07;rows[1].updated_date=new Date().toISOString();
      commitExhibition(fresh,rows,new Date().toISOString());
    }
  }});
  // The bulk read sees the first correction but not the second. By the fresh
  // Race read, the collector has committed both, so the mixed snapshot differs.
  state.tables.RaceEntry[0].exhibition_st=.05;
  state.tables.RaceEntry[0].updated_date=new Date(NOW-1000).toISOString();
  const first=await runV8LiveGeneration(state.client);
  assert.equal(first.result_status,'PARTIAL');assert.equal(liveResponseStatus(first),200);
  assert.equal(first.v8.created,1);assert.equal(first.v8.final,0);assert.equal(first.v8.retry_pending_count,1);
  assert.deepEqual(first.v8.pending,[{race_key:a.race_key,stage:'FINAL',phase:'CHECK_EXHIBITION_COMMIT',code:'EXHIBITION_COMMIT_MISMATCH',retryable:true}]);
  assert.equal(state.tables.V8RaceForecast[0].race_id,b.id);
  const preserved=structuredClone(state.tables.V8RaceForecast[0]);
  t.mock.timers.tick(1000);
  const recovered=await runV8LiveGeneration(state.client),saved=state.tables.V8RaceForecast.find(row=>row.race_id===a.id);
  assert.equal(recovered.result_status,'COMPLETE');assert.equal(recovered.v8.final,1);assert.equal(saved.exhibition_complete,true);
  assert.equal(saved.boats[0].exhibition_st,.05);assert.equal(saved.boats[1].exhibition_st,.07);
  const committedRace=state.tables.Race.find(row=>row.id===a.id);
  assert.equal(saved.provenance.exhibition_input_key,committedRace.exhibition_input_key);
  assert.equal(saved.provenance.exhibition_committed_at,committedRace.exhibition_committed_at);
  assert.ok(Date.parse(saved.input_as_of)>=Date.parse(committedRace.exhibition_committed_at));
  assert.deepEqual(state.tables.V8RaceForecast.find(row=>row.race_id===b.id),preserved);
});

test('a complete FINAL needs an available commit marker even when the exhibition ready flag is false',async t=>{
  for(const kind of ['missing','future'])await t.test(kind,async child=>{
    const race=makeRace('uncommitted-'+kind,1,{exhibition_ready:false}),entries=entriesFor(race,true);
    const state=setup(child,{races:[race],entries,committed:false});
    if(kind==='future')commitExhibition(state.tables.Race[0],state.tables.RaceEntry,new Date(NOW+1000).toISOString());
    const result=await runV8LiveGeneration(state.client);
    assert.equal(result.result_status,'PARTIAL');assert.equal(result.v8.final,0);assert.equal(result.v8.retry_pending_count,1);
    assert.equal(result.v8.pending[0].code,kind==='missing'?'EXHIBITION_COMMIT_MISSING':'EXHIBITION_COMMIT_TIME_INVALID');
    assert.equal(state.tables.V8RaceForecast.length,0);assert.equal(liveResponseStatus(result),200);
  });
});

test('an incomplete FINAL remains saveable without a commit marker',async t=>{
  const race=makeRace('incomplete-uncommitted',1,{exhibition_ready:true}),entries=entriesFor(race,true);
  entries[5].exhibition_time=null;
  const state=setup(t,{races:[race],entries,committed:false}),result=await runV8LiveGeneration(state.client);
  assert.equal(result.result_status,'PARTIAL');assert.equal(result.v8.final,1);assert.equal(liveResponseStatus(result),200);
  const saved=state.tables.V8RaceForecast[0];assert.equal(saved.exhibition_complete,false);
  assert.equal(saved.provenance.exhibition_input_key,undefined);assert.notEqual(saved.decision.status,'BUY');
  assert.equal(result.v8.pending[0].code,'EXHIBITION_INCOMPLETE_OR_CONFLICTED');
});
