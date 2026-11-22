import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTheoryTrial, THEORY_REVISION} from '../base44/shared/v8TheoryTrial.js';

const tickets=['1-2-3','1-2-4','1-2-5','1-2-6','1-3-2','1-3-4','1-3-5','1-3-6'];
const boats=Array.from({length:6},(_,i)=>({boat_number:i+1,national_2rate:50,national_3rate:65,
 local_2rate:45,motor_2rate:40,motor_3rate:60,boat_2rate:40,section:{last_three_points:8},
 exhibition_time:6.8,exhibition_st:0.10+i*0.02}));
const snapshot={id:'source-1',race_id:'race-1',race_key:'2026-11-23_01_01',race_date:'2026-11-23',
 venue_code:'01',race_number:1,snapshot_key:'feature-1',snapshot_stage:'FINAL',gender_model:'OPEN',
 observed_at:'2026-11-23T05:20:00Z',created_date:'2026-11-23T05:20:00.100Z',deadline:'2026-11-23T15:00:00+09:00',
 boats,market:{selected_tickets:tickets},pre_top_combination:tickets[0],final_top_combination:tickets[0]};
const now='2026-11-23T05:30:00Z';
const trial=(changes={})=>buildTheoryTrial({...snapshot,...changes},now);
const model=(record,key)=>record.models.find(x=>x.key===key);

test('new trials use a new immutable revision key',()=>{
 const out=trial();
 assert.equal(THEORY_REVISION,'V8_THEORY_2');
 assert.equal(out.record.trial_key,'V8_THEORY_2:'+snapshot.race_key+':FINAL');
});
test('PRE model outputs are identical with absent or arbitrary complete exhibition',()=>{
 const noExhibition=boats.map(({exhibition_time,exhibition_st,...b})=>b);
 const contaminated=boats.map((b,i)=>({...b,exhibition_time:6.5+i*.1,exhibition_st:i===0?-.8:.01*i,
   exhibition_course:6-i,exhibition_rank:6-i,exhibition_st_raw:'F.80'}));
 const a=trial({snapshot_stage:'PRE',boats:noExhibition});
 const b=trial({snapshot_stage:'PRE',boats:contaminated});
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 assert.deepEqual(a.record.models,b.record.models);
 assert.ok(b.record.models.every(m=>m.basis.every(field=>!field.startsWith('exhibition_'))));
 const ex=model(b.record,'EXHIBITION_RELATIVE');
 assert.equal(ex.status,'WAIT_EXHIBITION');assert.deepEqual(ex.tickets,[]);assert.equal(ex.score,null);
 assert.ok(ex.missing.includes('STAGE_PRE'));
});
test('F is never promoted by a more negative ST',()=>{
 const one=trial({boats:boats.map((b,i)=>i?b:{...b,exhibition_st:-.01})});
 const two=trial({boats:boats.map((b,i)=>i?b:{...b,exhibition_st:-.99})});
 assert.deepEqual(one.record.models,two.record.models);
 assert.equal(model(one.record,'EXHIBITION_RELATIVE').status,'READY');
 assert.notEqual(model(one.record,'EXHIBITION_RELATIVE').top[0],'1');
 assert.notEqual(model(one.record,'V8_ALL_FACTOR').top[0],'1');
 // With all other inputs equal, a legal fastest ST wins the ordering while F does not.
 assert.equal(model(trial().record,'EXHIBITION_RELATIVE').top[0],'1');
});
test('null ST remains missing, while numeric zero is a valid nonnegative start',()=>{
 const absent=trial({boats:boats.map((b,i)=>i?b:{...b,exhibition_st:null})});
 const zero=trial({boats:boats.map((b,i)=>i?b:{...b,exhibition_st:0})});
 assert.equal(model(absent.record,'EXHIBITION_RELATIVE').status,'INSUFFICIENT');
 assert.ok(!model(absent.record,'V8_ALL_FACTOR').basis.includes('exhibition_st'));
 assert.equal(model(zero.record,'EXHIBITION_RELATIVE').status,'READY');
 assert.equal(model(zero.record,'EXHIBITION_RELATIVE').top[0],'1');
});
test('invalid starts or an all-F exhibition do not create a usable start feature',()=>{
 for(const invalid of [null,undefined,NaN,Infinity,'0.10']){
  const out=trial({boats:boats.map((b,i)=>i?b:{...b,exhibition_st:invalid})});
  assert.equal(model(out.record,'EXHIBITION_RELATIVE').status,'INSUFFICIENT');
 }
 const allF=trial({boats:boats.map(b=>({...b,exhibition_st:-.01}))});
 assert.equal(model(allF.record,'EXHIBITION_RELATIVE').status,'INSUFFICIENT');
});
test('nonpositive exhibition time is invalid and is not a speed advantage',()=>{
 for(const value of [0,-1,null]){
  const out=trial({boats:boats.map((b,i)=>i?b:{...b,exhibition_time:value})});
  assert.equal(model(out.record,'EXHIBITION_RELATIVE').status,'INSUFFICIENT');
 }
});
test('uichi compatibility cannot become READY from one or four features',()=>{
 const tiny=boats.map(b=>({boat_number:b.boat_number,national_2rate:50}));
 const four=boats.map(b=>({boat_number:b.boat_number,national_2rate:50,national_3rate:65,local_2rate:45,motor_2rate:40}));
 for(const input of [tiny,four]){
  const out=trial({snapshot_stage:'PRE',boats:input});
  for(const m of out.record.models.filter(x=>x.key.startsWith('UICHI_'))){assert.equal(m.status,'INSUFFICIENT');assert.equal(m.score,null);}
 }
 const five=four.map(b=>({...b,motor_3rate:60}));
 const ready=trial({snapshot_stage:'PRE',boats:five});
 assert.ok(ready.record.models.filter(x=>x.key.startsWith('UICHI_')).every(m=>m.status==='READY'));
});
test('baseline must contain eight distinct valid tickets',()=>{
 const duplicate=trial({market:{selected_tickets:[...tickets.slice(0,7),tickets[0]]}});
 assert.deepEqual(duplicate.record.baseline_tickets,[]);
 assert.ok(duplicate.record.missing.includes('BASELINE_TICKETS_INVALID'));
 assert.deepEqual(trial().record.baseline_tickets,tickets);
});
test('one-lap absence is a model limitation, not a falsely combined missing exhibition',()=>{
 const ex=model(trial().record,'EXHIBITION_RELATIVE');
 assert.equal(ex.status,'READY');assert.deepEqual(ex.missing,[]);
 assert.ok(ex.limitations.includes('ONE_LAP_TIME_NOT_COLLECTED'));
 assert.ok(ex.note.includes('未再現'));
 assert.equal(trial().record.provenance.taro_official_formula_reproduced,false);
});
test('existing source objects are never rewritten',()=>{
 const before=JSON.stringify(snapshot);trial();trial({snapshot_stage:'PRE'});
 assert.equal(JSON.stringify(snapshot),before);
});
