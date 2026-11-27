import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../base44/shared/resultResolver.js',import.meta.url),'utf8');
const race={race_date:'2026-11-27',venue_code:'14',race_number:2};
function resolver(fetchBoatcastText){
  const executable=source.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
  return new Function('fetchBoatcastText','normalizeRs1','normalizeRs2','normalizeRaceResult',executable+'\nreturn {fetchBoatcastResult,resolveRaceResult};')(
    fetchBoatcastText,()=>({ok:true}),()=>({ok:true}),()=>({ok:true,result_trifecta:'1-2-3'}));
}

test('collector deadlines reach both BOATCAST reads with bounded time and no internal retry',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const calls=[],api=resolver(async options=>{calls.push(options);return {ok:true,text:'fixture'};});
  const result=await api.resolveRaceResult(race,{deadlineMs:102400,timeoutMs:6000});
  assert.equal(result.source,'BOATCAST');assert.deepEqual(calls.map(row=>row.dataType),['RS1','RS2']);
  assert.ok(calls.every(row=>row.timeoutMs===2400&&row.maxRetries===0));
  calls.length=0;
  const expired=await api.resolveRaceResult(race,{deadlineMs:100000});
  assert.equal(expired.source,null);assert.equal(expired.reason,'FETCH_TIME_BUDGET');assert.equal(calls.length,0);
});

test('an older shared in-flight read cannot keep the collector waiting beyond its deadline',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  let complete;
  const previous=new Promise(resolve=>{complete=resolve;}),api=resolver(()=>previous);
  const pending=api.resolveRaceResult(race,{deadlineMs:100020});
  t.mock.timers.tick(20);
  const result=await pending;
  assert.equal(result.source,null);assert.match(result.reason,/FETCH_TIME_BUDGET/);
  complete({ok:true,text:'late shared response'});
  await Promise.resolve();
});

test('callers without a deadline keep the established BOATCAST request options',async()=>{
  const calls=[],api=resolver(async options=>{calls.push(options);return {ok:true,text:'fixture'};});
  assert.equal((await api.resolveRaceResult(race)).source,'BOATCAST');
  assert.ok(calls.every(row=>!Object.hasOwn(row,'timeoutMs')&&!Object.hasOwn(row,'maxRetries')));
});
