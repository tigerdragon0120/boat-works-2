import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readV8Rows} from '../base44/shared/v8Repository.js';
import {buildCommittedExhibitionKey} from '../base44/shared/exhibitionInputKey.js';

const source=readFileSync(new URL('../base44/functions/fetchOnlineData/entry.ts',import.meta.url),'utf8');
const start=source.indexOf('async function processExhibition('),end=source.indexOf('\n}',start)+2;
const NOW=Date.parse('2026-11-27T05:40:00Z'),OLD=new Date(NOW-600000).toISOString();
function setup(t,{mode='fresh',failure=null}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const race={id:'race-1',race_key:'2026-11-27_08_10',race_date:'2026-11-27',venue_code:'08',race_number:10,
    deadline:new Date(NOW+900000).toISOString(),status:'scheduled',exhibition_ready:mode!=='fresh',original_exhibition:{status:'AVAILABLE'}};
  const entries=Array.from({length:6},(_,i)=>({id:'entry-'+(i+1),race_id:race.id,race_key:race.race_key,
    boat_number:i+1,registration_number:String(4001+i),updated_date:OLD,
    ...(mode==='fresh'?{}:{exhibition_time:6.7,exhibition_st:.1,exhibition_st_raw:.1,exhibition_course:i+1})}));
  const incoming=entries.map(({boat_number,registration_number})=>({boat_number,registration_number,
    exhibition_time:6.7,exhibition_st:.1,exhibition_course:boat_number}));
  if(mode==='old-marker'){
    race.exhibition_input_key=buildCommittedExhibitionKey(race,entries);race.exhibition_committed_at=OLD;
  }
  const prior=structuredClone(race),events=[],entryWrites=[],raceWrites=[];
  const entities={RaceEntry:{filter:async()=>{
    if(failure==='read')throw new Error('database unavailable');
    return {items:structuredClone(entries),has_more:false,next_cursor:null};
  },update:async(id,doc)=>{
    events.push('entry:'+id);entryWrites.push({id,doc:structuredClone(doc)});
    if(id==='entry-2' && failure==='entry')throw new Error('entry write failed');
    if(id==='entry-2' && failure==='entry-unconfirmed')return {};
    const row=entries.find(entry=>entry.id===id);Object.assign(row,doc);return structuredClone(row);
  }},Race:{update:async(id,doc)=>{
    events.push('race');raceWrites.push(structuredClone(doc));
    if(failure==='race')throw new Error('race write failed');
    if(failure==='race-unconfirmed')return {};
    Object.assign(race,doc);return structuredClone(race);
  }}};
  const dependencies={readV8Rows,buildCommittedExhibitionKey,num:value=>value==null?null:Number(value),
    fetchOriginalExhibition:async()=>({snapshot:{status:'AVAILABLE'}}),
    runV8LiveGeneration:async()=>{
      events.push('forecast');
      assert.equal(race.exhibition_input_key,buildCommittedExhibitionKey(race,entries));
      assert.ok(Date.parse(race.exhibition_committed_at)<=NOW);return {ok:true};
    }};
  const run=new Function(...Object.keys(dependencies),stripTypeScriptTypes(source.slice(start,end))+'\nreturn processExhibition;')(...Object.values(dependencies));
  const parsed={entries:incoming,real_exhibition_count:6,active_boat_count:6,scratched_boats:[]};
  return {race,prior,entries,incoming,parsed,events,entryWrites,raceWrites,
    run:()=>run({asServiceRole:{entities}},structuredClone(race),parsed,{url:'official-beforeinfo',captured_at:new Date(NOW).toISOString()})};
}

test('page-triggered collection commits all saved inputs before starting the forecast',async t=>{
  const state=setup(t),result=await state.run();
  assert.equal(result.exhibition_committed,true);assert.equal(result.exhibition_ready,true);
  assert.equal(state.entryWrites.length,6);assert.equal(state.raceWrites.length,1);
  assert.deepEqual(state.events.slice(-2),['race','forecast']);
  assert.equal(state.race.exhibition_committed_at,new Date(NOW).toISOString());
});

test('unchanged READY rows with a missing marker are committed without rewriting all boats',async t=>{
  const state=setup(t,{mode:'ready'}),result=await state.run();
  assert.equal(state.entryWrites.length,0);assert.equal(result.exhibition_committed,true);
  assert.deepEqual(state.events,['race','forecast']);
});

for(const failure of ['read','entry','entry-unconfirmed','race','race-unconfirmed'])test(`${failure} prevents forecast generation and leaves the last marker intact`,async t=>{
  const state=setup(t,{mode:'old-marker',failure});
  state.incoming[0].exhibition_st=.07;state.incoming[1].exhibition_st=.08;
  await assert.rejects(state.run());
  assert.equal(state.events.includes('forecast'),false);
  assert.equal(state.race.exhibition_input_key,state.prior.exhibition_input_key);
  assert.equal(state.race.exhibition_committed_at,state.prior.exhibition_committed_at);
  assert.equal(state.race.exhibition_ready,true);
});

test('an incomplete source cannot borrow old measurements to commit a new complete collection',async t=>{
  const state=setup(t,{mode:'old-marker'});
  state.incoming[0].exhibition_st=.07;delete state.incoming[1].exhibition_st;
  const result=await state.run();
  assert.equal(state.entries[0].exhibition_st,.07);assert.equal(state.entries[1].exhibition_st,.1);
  assert.equal(result.exhibition_committed,false);assert.equal(result.forecasts,null);
  assert.equal(state.race.exhibition_input_key,state.prior.exhibition_input_key);
  assert.equal(state.race.exhibition_committed_at,state.prior.exhibition_committed_at);
  assert.equal(state.race.exhibition_ready,true);
});

for(const fault of ['foreign-roster','duplicate-source','foreign-source'])test(`${fault} is rejected before any writes`,async t=>{
  const state=setup(t);
  if(fault==='foreign-roster')state.entries[0].race_id='another-race';
  if(fault==='duplicate-source')state.incoming[1].boat_number=1;
  if(fault==='foreign-source')state.incoming[0].registration_number='9999';
  await assert.rejects(state.run());assert.deepEqual(state.events,[]);
});

test('a scratched boat and observed F retain their meaning in the committed source',async t=>{
  const state=setup(t);
  state.incoming[1].exhibition_st='F.03';
  state.incoming[5]={boat_number:6,registration_number:'4006',is_absent:true};
  state.parsed.scratched_boats=[6];state.parsed.real_exhibition_count=5;state.parsed.active_boat_count=5;
  const result=await state.run(),key=JSON.parse(state.race.exhibition_input_key);
  assert.equal(result.exhibition_committed,true);assert.deepEqual(key.boats[1][3],[-.03,'F']);
  assert.deepEqual(key.boats[5],[6,'4006',null,null,null,true]);
  assert.deepEqual(state.events.slice(-2),['race','forecast']);
});
