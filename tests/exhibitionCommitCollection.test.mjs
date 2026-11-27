import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readV8Rows} from '../base44/shared/v8Repository.js';
import {selectLiveInputRaces,isSavedExhibitionComplete} from '../base44/shared/liveInputPriority.js';
import {buildCommittedExhibitionKey} from '../base44/shared/exhibitionInputKey.js';

const source=readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts',import.meta.url),'utf8');
const start=source.indexOf('async function fetchAndSaveExhibition('),end=source.indexOf('\n}',start)+2;
const NOW=Date.parse('2026-11-27T00:00:00Z'),OLD=new Date(NOW-3600000).toISOString();
function setup(t,{failedBoat=null,sourceMissing=false,minutesToDeadline=10}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const race={id:'race-1',race_key:'2026-11-27_14_02',race_date:'2026-11-27',venue_code:'14',race_number:2,
    status:'scheduled',deadline:new Date(NOW+minutesToDeadline*60000).toISOString(),exhibition_ready:true,original_exhibition:{status:'AVAILABLE'}};
  const entries=Array.from({length:6},(_,i)=>({id:'entry-'+(i+1),race_id:race.id,race_key:race.race_key,boat_number:i+1,
    registration_number:String(4001+i),player_name:'選手'+i,exhibition_time:6.7,exhibition_st:.1,exhibition_st_raw:.1,
    exhibition_course:i+1,updated_date:OLD}));
  race.exhibition_input_key=buildCommittedExhibitionKey(race,entries);
  race.exhibition_committed_at=OLD;
  const prior={key:race.exhibition_input_key,at:race.exhibition_committed_at};
  const incoming=entries.map(({boat_number,player_name,exhibition_time,exhibition_course})=>({
    boat_number,player_name,exhibition_time,exhibition_course,exhibition_st:boat_number===1?.08:boat_number===2?.09:.1,
  }));
  if(sourceMissing)delete incoming[1].exhibition_st;
  const entryWrites=[],raceWrites=[],errors=[];
  const entities={Race:{filter:async()=>[structuredClone(race)],update:async(id,doc)=>{
    raceWrites.push(structuredClone(doc));Object.assign(race,doc);return {id,...doc};
  }},RaceEntry:{filter:async()=>({items:structuredClone(entries),has_more:false,next_cursor:null}),update:async(id,doc)=>{
    entryWrites.push(id);if(id==='entry-'+failedBoat)throw new Error('write failed');
    const row=entries.find(entry=>entry.id===id);Object.assign(row,doc,{updated_date:new Date().toISOString()});return structuredClone(row);
  }}};
  const dependencies={readV8Rows,selectLiveInputRaces,isSavedExhibitionComplete,buildCommittedExhibitionKey,
    uniqueRacesByKey:rows=>rows,VENUE_MAP:{'14':'鳴門'},buildUrl:()=> 'official-beforeinfo',
    fetchHtml:async()=>({ok:true,html:'source'}),parseBeforeInfo:()=>({ok:true,data:{entries:incoming,scratched_boats:[],active_boat_count:6,real_exhibition_count:6}}),
    fetchOriginalExhibition:async({race})=>({snapshot:race.original_exhibition}),
    withRateLimitRetry:async fn=>fn(),sleep:async()=>{},runV8LiveGeneration:()=>assert.fail('deferred collection')};
  const run=new Function(...Object.keys(dependencies),stripTypeScriptTypes(source.slice(start,end))+'\nreturn fetchAndSaveExhibition;')(...Object.values(dependencies));
  return {race,entries,prior,incoming,entryWrites,raceWrites,errors,
    run:()=>run({asServiceRole:{entities}},race.race_date,30000,[],errors,{liveOnly:true,deferForecasts:true})};
}

test('a complete source commits the saved six-boat key in one Race write while unchanged entry timestamps remain old',async t=>{
  const state=setup(t),result=await state.run();
  assert.deepEqual(state.entryWrites,['entry-1','entry-2']);assert.equal(state.raceWrites.length,1);
  assert.equal(state.raceWrites[0].exhibition_input_key,buildCommittedExhibitionKey(state.race,state.entries));
  assert.equal(state.raceWrites[0].exhibition_committed_at,new Date(NOW).toISOString());
  assert.notEqual(state.race.exhibition_input_key,state.prior.key);
  assert.equal(state.entries[5].updated_date,OLD);assert.deepEqual(result.ready_keys,[state.race.race_key]);
});

test('one failed entry correction preserves the old commit marker even though all six saved boats still have exhibition values',async t=>{
  const state=setup(t,{failedBoat:2}),result=await state.run();
  assert.equal(state.entries[0].exhibition_st,.08);assert.equal(state.entries[1].exhibition_st,.1);
  assert.equal(isSavedExhibitionComplete(state.entries),true);
  assert.equal(state.race.exhibition_input_key,state.prior.key);assert.equal(state.race.exhibition_committed_at,state.prior.at);
  assert.equal(state.raceWrites.some(row=>'exhibition_input_key'in row||'exhibition_committed_at'in row),false);
  assert.deepEqual(result.ready_keys,[]);assert.equal(state.errors.length,1);
});

test('a missing source ST cannot be filled from stored data to publish a new complete-source marker',async t=>{
  const state=setup(t,{sourceMissing:true}),result=await state.run();
  assert.equal(state.entries[0].exhibition_st,.08);assert.equal(state.entries[1].exhibition_st,.1);
  assert.equal(isSavedExhibitionComplete(state.entries),true);
  assert.equal(state.race.exhibition_input_key,state.prior.key);assert.equal(state.race.exhibition_committed_at,state.prior.at);
  assert.equal(state.raceWrites.some(row=>'exhibition_input_key'in row||'exhibition_committed_at'in row),false);
  assert.deepEqual(result.ready_keys,[]);
});

test('READY inputs with no commit are collected and committed before the final refresh window',async t=>{
  const state=setup(t,{minutesToDeadline:30});
  delete state.race.exhibition_input_key;
  delete state.race.exhibition_committed_at;
  for(const entry of state.incoming)entry.exhibition_st=.1;
  const result=await state.run();
  assert.deepEqual(state.entryWrites,[]);
  assert.equal(state.race.exhibition_input_key,buildCommittedExhibitionKey(state.race,state.entries));
  assert.equal(state.race.exhibition_committed_at,new Date(NOW).toISOString());
  assert.deepEqual(result.ready_keys,[state.race.race_key]);
});

test('a future-dated commit is repaired before the final refresh window',async t=>{
  const state=setup(t,{minutesToDeadline:30});
  state.race.exhibition_committed_at=new Date(NOW+60000).toISOString();
  const result=await state.run();
  assert.equal(state.race.exhibition_committed_at,new Date(NOW).toISOString());
  assert.deepEqual(result.ready_keys,[state.race.race_key]);
});

test('READY inputs with an established commit retain the regular refresh schedule',async t=>{
  const state=setup(t,{minutesToDeadline:30}),result=await state.run();
  assert.deepEqual(state.entryWrites,[]);assert.deepEqual(state.raceWrites,[]);
  assert.equal(state.race.exhibition_input_key,state.prior.key);
  assert.deepEqual(result.ready_keys,[]);
});
