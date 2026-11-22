import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {researchWindowDates,researchBootstrapDates,selectResearchDay,researchDayComplete} from '../base44/shared/v8ResearchQueue.js';
import {dateValid,buildRaceProgress} from '../base44/shared/v8Repository.js';
import {SETTLEMENT_REVISION} from '../base44/shared/v8Settlement.js';
const TODAY='2026-11-22',NOW=Date.parse('2026-11-22T11:30:00Z');
const item=(date,extra={})=>({id:'day-'+date,race_date:date,status:'PARTIAL',...extra});

test('bootstrap registers only existing race dates within seven days and never duplicates the durable queue',()=>{
 const races=[{race_date:TODAY},{race_date:'2026-11-21'},{race_date:'2026-11-21'},{race_date:'2026-11-16'},{race_date:'2026-11-15'},{race_date:'2026-11-23'},{race_date:'invalid'}];
 const existing=[item(TODAY),item('2026-11-10')],snapshot=JSON.stringify(existing);
 assert.deepEqual(researchBootstrapDates(races,existing,TODAY),['2026-11-21','2026-11-16']);
 assert.deepEqual(researchBootstrapDates([],existing,TODAY),[]);assert.equal(JSON.stringify(existing),snapshot);
 assert.equal(researchWindowDates(TODAY).length,7);assert.equal(researchWindowDates(TODAY).at(-1),'2026-11-16');
 assert.deepEqual(researchBootstrapDates(races,existing,TODAY,'2026-11-15'),['2026-11-21','2026-11-16','2026-11-15']);
 assert.throws(()=>researchWindowDates(TODAY,'2026-11-23'),/INVALID/);
});

test('today alternates with a fair historical queue and unfinished dates never expire',()=>{
 const rows=[item(TODAY),item('2026-11-21'),item('2026-11-20'),item('2026-11-01')],chosen=[];
 for(let i=0;i<8;i++){
  const selected=selectResearchDay(rows,TODAY);chosen.push(selected.race_date);
  selected.last_attempt_at=new Date(NOW+i*60000).toISOString();
 }
 assert.deepEqual(chosen,[TODAY,'2026-11-01',TODAY,'2026-11-20',TODAY,'2026-11-21',TODAY,'2026-11-01']);
 assert.equal(selectResearchDay(rows,TODAY,'2026-11-20').race_date,'2026-11-20');
});

test('completed historical work still gives today the next turn and completed today continues to be checked',()=>{
 const rows=[item(TODAY,{status:'COMPLETE',last_attempt_at:'2026-11-22T10:00:00Z'}),item('2026-11-21',{status:'COMPLETE',last_attempt_at:'2026-11-22T10:10:00Z'}),item('2026-11-20')];
 assert.equal(selectResearchDay(rows,TODAY).race_date,TODAY);
 rows[0].last_attempt_at='2026-11-22T10:20:00Z';assert.equal(selectResearchDay(rows,TODAY).race_date,'2026-11-20');
});

const source=readFileSync(new URL('../base44/functions/v8CompleteRaceResearch/entry.ts',import.meta.url),'utf8');
const start=source.indexOf('export async function runV8CompleteRaceResearch');
const runner=stripTypeScriptTypes(source.slice(start,source.indexOf('\nexport default',start))).replace('export async function','async function');
function environment(t,{races,queue=[]}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const data={Race:structuredClone(races),V8ResearchDay:structuredClone(queue),V8RaceForecast:[],V8ForecastVerification:[],RaceResult:[]},calls=[];
 const entities=Object.fromEntries(Object.entries(data).map(([name,rows])=>[name,{name,
  create:async value=>{const created={...structuredClone(value),id:name+'-'+rows.length};rows.push(created);return structuredClone(created);},
  update:async(id,value)=>{const row=rows.find(item=>item.id===id);Object.assign(row,structuredClone(value));return structuredClone(row);}
 }]));
 const matches=(row,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]):row[key]===value);
 const deps={acquireLock:async()=> 'lock',releaseLock:async()=>{},jstDate:()=>TODAY,dateValid,readV8Rows:async(entity,query)=>{calls.push({name:entity.name,query});return structuredClone(data[entity.name].filter(row=>matches(row,query)));},buildRaceProgress,selectResearchDay,researchDayComplete,researchWindowDates,researchBootstrapDates,recoverRaceResearchInputs:async()=>({next_cursor:0,failures:[]}),runV8ReplayForecasts:async()=>({created:0,errors:0,next_cursor:0}),runV8VerifyForecasts:async()=>({created:0,errors:0}),SETTLEMENT_REVISION};
 const run=new Function(...Object.keys(deps),runner+'\nreturn runV8CompleteRaceResearch;')(...Object.values(deps));
 return {data,calls,run:options=>run({asServiceRole:{entities}},options||{})};
}
const raceFor=(date,id)=>({id,race_key:date+'_01_01',race_date:date,venue_code:'01',race_number:1,deadline:date+'T05:00:00Z',status:'finished'});

test('actual coordinator bootstraps past race dates and a second call processes history without duplicating queue rows',async t=>{
 const env=environment(t,{races:[raceFor(TODAY,'today'),raceFor('2026-11-21','old')]});
 const first=await env.run();assert.equal(first.date,TODAY);assert.deepEqual(first.registered_dates,[TODAY,'2026-11-21']);
 const second=await env.run();assert.equal(second.date,'2026-11-21');assert.deepEqual(second.registered_dates,[]);
 assert.equal(env.data.V8ResearchDay.length,2);
 const bootstrapQuery=env.calls.find(row=>row.name==='Race'&&row.query.race_date?.$in);
 assert.deepEqual(bootstrapQuery.query.race_date.$in,researchWindowDates(TODAY));
});

test('actual coordinator does not create empty or future race dates',async t=>{
 const env=environment(t,{races:[raceFor('2026-11-23','future')]});
 const result=await env.run();assert.equal(result.skipped,'no_pending_dates');assert.deepEqual(env.data.V8ResearchDay,[]);
});
