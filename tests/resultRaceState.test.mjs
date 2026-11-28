import test from 'node:test';
import assert from 'node:assert/strict';
import {syncFinishedRace} from '../base44/shared/resultRaceState.js';

const race=()=>({id:'miyajima-12',race_date:'2026-11-28',venue_code:'17',race_number:12,
  race_key:'2026-11-28_17_12',status:'final',updated_date:'2026-11-28T06:28:00Z',
  deadline:'2026-11-28T06:28:00Z',exhibition_input_key:'saved-exhibition'});
const result=()=>({id:'official-result-12',race_id:'miyajima-12',source:'BOATCAST',
  result_status:'RESULT_FINAL',is_finished:true,result_trifecta:'3-1-4',payout:1240});
function setup({row=race(),saved=result(),beforeWrite=null,apply=true,reply={updated:1},readError=null,writeError=null,readbackError=null}={}){
  let current=structuredClone(row),reads=0;
  const writes=[],calls=[];
  const sr={
    RaceResult:{get:async id=>{calls.push(['result.get',id]);return structuredClone(saved);}},
    Race:{
      get:async id=>{calls.push(['race.get',id]);reads++;if(readError)throw readError;if(reads>1&&readbackError)throw readbackError;return structuredClone(current);},
      updateMany:async(query,update)=>{
        calls.push(['race.updateMany']);writes.push({query:structuredClone(query),update:structuredClone(update)});
        if(writeError)throw writeError;if(beforeWrite)current=beforeWrite(current);
        if(apply&&Object.entries(query).every(([key,value])=>current[key]===value))Object.assign(current,update.$set);
        return reply;
      },
    },
  };
  return {sr,writes,calls,read:()=>current,run:(inputRace=race(),inputResult=result())=>syncFinishedRace(sr,inputRace,inputResult)};
}

test('a persisted official result repairs only Race.status with an identity/current-state CAS and readback',async()=>{
  const state=setup(),out=await state.run();
  assert.equal(out.ok,true);assert.equal(out.updated,true);assert.equal(out.race.status,'finished');
  assert.deepEqual(state.calls,[['result.get','official-result-12'],['race.get','miyajima-12'],['race.updateMany'],['race.get','miyajima-12']]);
  assert.deepEqual(state.writes,[{query:{id:'miyajima-12',race_date:'2026-11-28',venue_code:'17',race_number:12,
    race_key:'2026-11-28_17_12',status:'final',updated_date:'2026-11-28T06:28:00Z'},update:{$set:{status:'finished'}}}]);
  assert.deepEqual(state.read(),{...race(),status:'finished'});
});

test('all official sources and supported active states can be repaired; a legacy saved final flag is supported',async()=>{
  for(const source of ['BOATCAST','LOCAL','TXT'])for(const status of ['scheduled','pre','final']){
    const saved={...result(),source};const state=setup({row:{...race(),status},saved});
    assert.equal((await state.run({...race(),status},saved)).ok,true);
  }
  const legacy={...result()};delete legacy.result_status;
  const state=setup({saved:legacy});assert.equal((await state.run(race(),legacy)).ok,true);
});

test('already finished races still require persisted matching evidence and cause no write',async()=>{
  const state=setup({row:{...race(),status:'finished'}}),out=await state.run();
  assert.equal(out.ok,true);assert.equal(out.updated,false);assert.equal(state.writes.length,0);
  assert.deepEqual(state.calls,[['result.get','official-result-12'],['race.get','miyajima-12']]);
});

test('unsaved, partial, unofficial, invalid-ticket and nonpositive/nonfinite-payout inputs never write',async()=>{
  const changes=[{id:undefined},{race_id:'other'},{source:'MANUAL'},
    {result_status:'RESULT_PARTIAL',is_finished:true},{result_status:'RESULT_WAITING',is_finished:true},
    {result_status:undefined,is_finished:false},{result_trifecta:'1-1-3'},{result_trifecta:'1-2-7'},
    {payout:0},{payout:-1},{payout:Infinity},{payout:NaN},{payout:'1240'},
    {race_key:'2026-11-28_18_12'},{race_date:'2026-11-27'},{venue_code:'18'},{race_number:11}];
  for(const change of changes){
    const state=setup();await assert.rejects(state.run(race(),{...result(),...change}),/RACE_FINISH_RESULT_INVALID/);
    assert.equal(state.calls.length,0);assert.equal(state.writes.length,0);
  }
});

test('saved result readback must exist and match the supplied final result before the race is read',async()=>{
  for(const saved of [null,{...result(),id:'different'}, {...result(),race_id:'other'},
    {...result(),result_status:'RESULT_WAITING'}, {...result(),result_trifecta:'2-1-4'},
    {...result(),payout:1250}, {...result(),source:'LOCAL'}]){
    const state=setup({saved});await assert.rejects(state.run(),/RACE_FINISH_RESULT_NOT_CONFIRMED/);
    assert.equal(state.writes.length,0);assert.equal(state.calls.length,1);
  }
});

test('caller and fresh race identities must be valid and identical',async()=>{
  for(const change of [{id:''},{race_date:'2026-02-30'},{race_number:0},{venue_code:'99'},{race_key:'wrong'}]){
    const state=setup();await assert.rejects(state.run({...race(),...change}),/RACE_FINISH_IDENTITY_INVALID/);
    assert.equal(state.calls.length,0);
  }
  for(const row of [null,{...race(),id:'other'}, {...race(),race_date:'2026-11-27',race_key:'2026-11-27_17_12'},
    {...race(),venue_code:'18',race_key:'2026-11-28_18_12'}, {...race(),race_number:11,race_key:'2026-11-28_17_11'},
    {...race(),race_key:'wrong'}]){
    const state=setup({row});await assert.rejects(state.run(),/RACE_FINISH_IDENTITY_CHANGED/);
    assert.equal(state.writes.length,0);
  }
});

test('cancelled and postponed races are protected even when status incorrectly still says final or finished',async()=>{
  for(const change of [{status:'cancelled'},{schedule_status:'CANCELLED'}, {schedule_status:'POSTPONED'},
    {status:'finished',schedule_status:'POSTPONED'}]){
    const state=setup({row:{...race(),...change}});
    await assert.rejects(state.run(),/RACE_FINISH_CANCELLED_OR_POSTPONED/);assert.equal(state.writes.length,0);
    const stale=setup();await assert.rejects(stale.run({...race(),...change}),/RACE_FINISH_CANCELLED_OR_POSTPONED/);
    assert.equal(stale.writes.length,0);
  }
});

test('a concurrent cancellation, state change or identity change is never overwritten by the CAS',async()=>{
  for(const change of [{status:'cancelled',schedule_status:'CANCELLED'},
    {status:'cancelled',schedule_status:'POSTPONED'}, {status:'pre'},
    {schedule_status:'POSTPONED',updated_date:'2026-11-28T06:29:00Z'},
    {race_number:11,race_key:'2026-11-28_17_11'}]){
    const state=setup({beforeWrite:row=>({...row,...change})});
    await assert.rejects(state.run(),/RACE_FINISH_(CANCELLED_OR_POSTPONED|SAVE_NOT_CONFIRMED|IDENTITY_CHANGED)/);
    assert.deepEqual(state.read(),{...race(),...change});
  }
});

test('SDK counters are not treated as a save receipt; only a confirmed readback finishes the operation',async()=>{
  const missed=setup({apply:false,reply:{updated:1}});
  await assert.rejects(missed.run(),/RACE_FINISH_SAVE_NOT_CONFIRMED/);
  for(const reply of [undefined,{modified_count:1},{updated_count:1},{}]){
    const state=setup({reply});assert.equal((await state.run()).ok,true);
  }
  const otherCollector=setup({beforeWrite:row=>({...row,status:'finished'}),reply:{modified_count:0}});
  assert.equal((await otherCollector.run()).ok,true);
});

test('get, conditional-write and readback failures propagate unchanged so callers can retry',async()=>{
  for(const field of ['readError','writeError','readbackError']){
    const failure=new Error('SDK transport failed');const state=setup({[field]:failure});
    await assert.rejects(state.run(),error=>error===failure);
  }
  const resultFailure=new Error('result read failed'),state=setup();
  state.sr.RaceResult.get=async()=>{throw resultFailure;};
  await assert.rejects(state.run(),error=>error===resultFailure);assert.equal(state.writes.length,0);
  const unavailable=setup();delete unavailable.sr.Race.updateMany;
  await assert.rejects(unavailable.run(),/RACE_FINISH_CONDITIONAL_WRITE_UNAVAILABLE/);
});
