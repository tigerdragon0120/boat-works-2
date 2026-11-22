import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildReplayForecast,REPLAY_REVISION} from '../base44/shared/v8ReplayForecast.js';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';
import {selectV7RaceEntries} from '../base44/shared/v7RaceEntrySelector.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';
import {jstDate,dateValid,groupBy,chronological,canonicalForecasts,canonicalReplayForecasts} from '../base44/shared/v8Repository.js';
const src=readFileSync(new URL('../base44/shared/v8ReplayCapture.js',import.meta.url),'utf8');
const runnerStart=src.indexOf('export async function runV8ReplayForecasts');
assert.ok(runnerStart>=0,'shared replay runner exists');
const body=src.slice(runnerStart).replace('export async function','async function');
const NOW=Date.parse('2026-11-22T11:00:00Z'),PRE='2026-11-22T03:00:00Z';
const race=(id,n)=>({id,race_key:`2026-11-22_01_${String(n).padStart(2,'0')}`,race_date:'2026-11-22',venue_code:'01',race_number:n,deadline:'2026-11-22T05:00:00Z',status:'finished',updated_date:PRE});
const entriesFor=r=>Array.from({length:6},(_,i)=>({id:r.id+'-'+i,race_id:r.id,race_key:r.race_key,boat_number:i+1,registration_number:String(4501+i),national_win_rate:i===0?8:5,national_2rate:i===0?70:25,local_win_rate:6,motor_f2_rate:50-i,avg_st:.12+i*.02,exhibition_time:6.6+i*.04,exhibition_st:.1+i*.02,exhibition_course:i+1,updated_date:PRE}));
function livePre(r,entries){return {...buildRaceForecast({race:{...r,status:'scheduled'},entries:entries.map(e=>{const copy={...e};for(const key of ['exhibition_time','exhibition_st','exhibition_course'])delete copy[key];return copy;}),stage:'PRE',now:PRE}).record,id:'live-'+r.id,created_date:PRE};}
function setup(t,{races,entries,forecasts=[]}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const table={Race:structuredClone(races),RaceEntry:structuredClone(entries),V8RaceForecast:structuredClone(forecasts)},reads=[];
 const entities=new Proxy(Object.fromEntries(Object.entries(table).map(([name,rows])=>[name,{name,rows,create:async record=>{const saved={...structuredClone(record),id:'saved-'+(table.V8RaceForecast.length+1),created_date:new Date().toISOString()};rows.push(saved);return structuredClone(saved);}}])),{get(target,key){assert.notEqual(key,'RaceResult','result must never be read during reconstruction');return target[key];}});
 const readV8Rows=async(entity,query)=>{reads.push(entity.name);return structuredClone(entity.rows.filter(row=>!query.race_date||query.race_date.$in.includes(row.race_date)).filter(row=>!query.race_id||query.race_id.$in.includes(row.race_id)));};
 const dependencies={acquireLock:async()=> 'lock',releaseLock:async()=>{},selectV7RaceEntries,utcMs,buildReplayForecast,REPLAY_REVISION,jstDate,dateValid,readV8Rows,groupBy,chronological,canonicalForecasts,canonicalReplayForecasts};
 const run=new Function(...Object.keys(dependencies),body+'\nreturn runV8ReplayForecasts;')(...Object.values(dependencies));
 return {table,reads,run:options=>run({asServiceRole:{entities}},{date:'2026-11-22',...options})};
}
test('worker fills only missing stages, preserves live baseline, and is idempotent',async t=>{
 const a=race('a',1),b=race('b',2),ae=entriesFor(a),be=entriesFor(b),existing=livePre(a,ae);
 const state=setup(t,{races:[a,b],entries:[...ae,...be],forecasts:[existing]});
 const result=await state.run();assert.equal(result.created,3);assert.equal(result.pre,1);assert.equal(result.final,2);
 const after=state.table.V8RaceForecast.find(row=>row.race_id==='a'&&row.record_mode==='REPLAY');
 assert.equal(after.stage,'FINAL');assert.equal(after.comparison.baseline_id,existing.id);
 assert.deepEqual(state.table.V8RaceForecast.find(row=>row.id===existing.id),existing);
 const again=await state.run();assert.equal(again.created,0);assert.equal(state.table.V8RaceForecast.length,4);
 assert.deepEqual([...new Set(state.reads)].sort(),['Race','RaceEntry','V8RaceForecast']);
});
test('a missing exhibition row is retried later without replacing the saved PRE',async t=>{
 const r=race('a',1),entries=entriesFor(r);entries[5].exhibition_st=null;
 const state=setup(t,{races:[r],entries});const first=await state.run();
 assert.equal(first.created,1);assert.equal(first.final,0);assert.equal(first.reasons.EXHIBITION_INCOMPLETE,1);
 const pre=structuredClone(state.table.V8RaceForecast[0]);state.table.RaceEntry[5].exhibition_st=.2;
 const second=await state.run();assert.equal(second.created,1);assert.equal(second.final,1);
 assert.deepEqual(state.table.V8RaceForecast[0],pre);assert.equal(state.table.V8RaceForecast[1].comparison.baseline_id,pre.id);
});
test('cancelled and future races cannot become retrospective predictions',async t=>{
 const closed=race('closed',1),cancelled={...race('cancelled',2),status:'cancelled'},future={...race('future',3),status:'scheduled',deadline:'2026-11-22T14:00:00Z'};
 const state=setup(t,{races:[closed,cancelled,future],entries:[closed,cancelled,future].flatMap(entriesFor)});
 const result=await state.run();assert.equal(result.races,1);assert.equal(result.created,2);
 assert.ok(state.table.V8RaceForecast.every(row=>row.race_id==='closed'&&row.record_mode==='REPLAY'));
});

test('the persisted cursor moves past incomplete early races so the backlog cannot starve',async t=>{
 const races=Array.from({length:4},(_,i)=>race('r'+i,i+1)),entries=races.flatMap(entriesFor);
 for(const row of entries)if(['r0','r1'].includes(row.race_id))row.national_win_rate=null;
 for(const row of entries)if(['r0','r1'].includes(row.race_id))row.national_2rate=null;
 const state=setup(t,{races,entries});
 const first=await state.run({max_races:2,cursor:0});assert.equal(first.created,0);assert.equal(first.next_cursor,2);
 const second=await state.run({max_races:2,cursor:first.next_cursor});assert.equal(second.created,4);
 assert.deepEqual([...new Set(state.table.V8RaceForecast.map(row=>row.race_id))].sort(),['r2','r3']);
});
