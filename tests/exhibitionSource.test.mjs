import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchExhibitionSource} from '../base44/shared/exhibitionSource.js';

const NOW=Date.parse('2026-11-28T02:30:00Z');
const race={id:'r',race_key:'2026-11-28_03_02',race_date:'2026-11-28',venue_code:'03',race_number:2};
const rows=Array.from({length:6},(_,i)=>({boat_number:i+1,exhibition_time:6.7,exhibition_st:.1,exhibition_course:i+1}));
const primary={entries:rows,active_boat_count:6,real_exhibition_count:6,scratched_boats:[]};
const backup={ok:true,data:{...primary,entries:rows.map(x=>({...x,exhibition_time:6.8,exhibition_st:x.boat_number===1?-.04:.2}))},
  source:{provider:'BOATCAST',url:'official-tkz',urls:['official-tkz','official-stt'],captured_at:new Date(NOW-1000).toISOString()}};
function setup(options={}){
  const calls=[],config={race,entries:structuredClone(rows),deadlineMs:NOW+8000,now:()=>NOW,
    fetchOfficial:async(...args)=>{calls.push({type:'primary',args});return {ok:true,status:200,html:'source'};},
    parseOfficial:()=>({ok:true,data:structuredClone(primary)}),
    fetchBackup:async args=>{calls.push({type:'backup',args});return structuredClone(backup);},...options};
  return {calls,config,run:()=>fetchExhibitionSource(config)};
}

test('complete primary observations preserve the existing single-source path',async()=>{
  const state=setup(),result=await state.run();
  assert.equal(result.ok,true);assert.equal(result.complete,true);assert.equal(result.source.provider,'BOATRACE');
  assert.deepEqual(result.data,primary);assert.equal(result.primary_http_status,200);
  assert.deepEqual(state.calls.map(x=>x.type),['primary']);
  assert.equal(state.calls[0].args[1],0,'no retry on an access failure');
  assert.equal(state.calls[0].args[2].deadlineMs,NOW+8000);
});

test('primary 403 selects the complete alternate source, preserving F and its original timestamp',async()=>{
  const state=setup({fetchOfficial:async()=>({ok:false,status:403})}),result=await state.run();
  assert.equal(result.ok,true);assert.equal(result.complete,true);assert.equal(result.primary_http_status,403);
  assert.deepEqual(result.data,backup.data);assert.equal(result.data.entries[0].exhibition_st,-.04);
  assert.deepEqual(result.source,backup.source);
  assert.equal(state.calls[0].args.race,race);assert.equal(state.calls[0].args.deadlineMs,NOW+8000);
});

test('a denied primary is skipped on subsequent races in the same collection batch',async()=>{
  const state=setup({skipPrimary:true}),result=await state.run();
  assert.equal(result.source.provider,'BOATCAST');assert.equal(result.primary_http_status,null);
  assert.deepEqual(state.calls.map(x=>x.type),['backup']);
});

test('a partial primary is replaced by a complete alternate as a whole',async()=>{
  const partial=structuredClone(primary);delete partial.entries[2].exhibition_st;
  const state=setup({parseOfficial:()=>({ok:true,data:partial})}),result=await state.run();
  assert.equal(result.complete,true);assert.equal(result.source.provider,'BOATCAST');
  assert.deepEqual(result.data,backup.data);
  assert.ok(result.data.entries.every(x=>x.exhibition_time===6.8));
});

test('two incomplete sources never reuse old local values to claim completeness',async()=>{
  const partial=structuredClone(primary);delete partial.entries[2].exhibition_st;
  const state=setup({parseOfficial:()=>({ok:true,data:partial}),fetchBackup:async()=>({ok:false,reason:'SOURCE_START_LIST_INCOMPLETE'})});
  const result=await state.run();
  assert.equal(result.ok,true);assert.equal(result.complete,false);assert.equal(result.source.provider,'BOATRACE');
  assert.equal(result.data.entries[2].exhibition_st,undefined);assert.equal(result.backup_reason,'SOURCE_START_LIST_INCOMPLETE');
  assert.equal(state.config.entries[2].exhibition_st,.1,'existing complete rows were available but not borrowed');
});

test('both source failures return an explicit missing-data result without entries',async()=>{
  const result=await setup({fetchOfficial:async()=>({ok:false,status:403}),
    fetchBackup:async()=>({ok:false,reason:'SOURCE_HTTP_503',http_status:503})}).run();
  assert.deepEqual(result,{ok:false,reason:'SOURCE_HTTP_503',http_status:503,primary_http_status:403});
  assert.equal(result.data,undefined);
});

test('expired collection budget cannot start another network request',async()=>{
  const state=setup({deadlineMs:NOW}),result=await state.run();
  assert.equal(result.ok,false);assert.equal(result.reason,'SOURCE_TIME_BUDGET');assert.deepEqual(state.calls,[]);
});

test('programming faults are not disguised as acquisition gaps',async()=>{
  await assert.rejects(setup({parseOfficial:()=>{throw new TypeError('bad parser');}}).run(),TypeError);
  await assert.rejects(setup({skipPrimary:true,fetchBackup:async()=>{throw new ReferenceError('missing parser');}}).run(),ReferenceError);
});
