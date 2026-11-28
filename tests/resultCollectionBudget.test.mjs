import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveRaceResult as resolveWithRealClient} from '../base44/shared/resultResolver.js';
import {clearBoatcastCache} from '../base44/shared/boatcastClient.js';

const source=readFileSync(new URL('../base44/shared/resultResolver.js',import.meta.url),'utf8');
const race={race_date:'2026-11-27',venue_code:'14',race_number:2};
function resolver(fetchBoatcastText){
  const executable=source.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
  return new Function('fetchBoatcastText','normalizeRs1','normalizeRs2','normalizeRaceResult',executable+'\nreturn {fetchBoatcastResult,resolveRaceResult};')(
    fetchBoatcastText,()=>({ok:true,status:'RESULT_FINAL'}),
    ()=>({ok:true,status:'RESULT_FINAL',payouts:{trifecta:{combination:'1-2-3',payout:580}}}),
    (_rs1,_rs2,metadata)=>({ok:true,result_trifecta:'1-2-3',payout:580,fetched_at:metadata.fetched_at}));
}

test('collector deadlines reach both BOATCAST reads with bounded time and no internal retry',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const calls=[],api=resolver(async options=>{calls.push(options);return {ok:true,text:'fixture'};});
  const result=await api.resolveRaceResult(race,{deadlineMs:102400,timeoutMs:6000});
  assert.equal(result.source,'BOATCAST');assert.equal(result.complete,true);assert.equal(result.reason,null);
  assert.deepEqual(calls.map(row=>row.dataType),['RS1','RS2']);
  assert.ok(calls.every(row=>row.timeoutMs===2400&&row.maxRetries===0&&row.maxCacheAgeMs===30000));
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

test('callers without a deadline keep established timeout/retry options while capping result cache age',async()=>{
  const calls=[],api=resolver(async options=>{calls.push(options);return {ok:true,text:'fixture'};});
  assert.equal((await api.resolveRaceResult(race)).source,'BOATCAST');
  assert.ok(calls.every(row=>!Object.hasOwn(row,'timeoutMs')&&!Object.hasOwn(row,'maxRetries')));
  assert.ok(calls.every(row=>row.maxCacheAgeMs===30000));
});

// The published responses below were observed for Miyajima 12R on 2026-11-28.
// Waiting/unavailable variants simulate the same endpoint before publication.
const NOW=Date.parse('2026-11-28T06:39:51Z');
const observedRace={race_date:'2026-11-28',venue_code:'17',race_number:12};
const rs1='data=\n1\n１\t1\t川原　　祐明\t1\'13"5\n２\t2\t羽野　　直也\t1\'14"7\n３\t3\t石渡　　鉄兵\t1\'15"4\n４\t4\t原田　　幸哉\t1\'16"0\n５\t5\t早川　　理稀\t1\'16"4\n６\t6\t高木　　圭大\t1\'17"8\n1\t.11\t\t逃　げ\n2\t.15\t\t\n3\t.13\t\t\n4\t.20\t\t\n6\t.26\t\t\n5\t.08\t\t\n1\t2\t3\t4\t5\t6\n晴　れ\t6m\t6cm\t向い風\n';
const rs2='data=\n1\t0\n1\t-\t2\t260\t円\t1\n1\t=\t2\t220\t円\t1\n1\t2\t3\t580\t円\t1\n1\t2\t3\t270\t円\t1\n1\t=\t2\t100\t円\t1\n1\t=\t3\t140\t円\t2\n2\t=\t3\t150\t円\t3\n';

test('the same warm client refetches unpublished HTTP200 results on the next five-minute run',async t=>{
  for(const bounded of [true,false])await t.test(bounded?'bounded collector':'caller without deadline',async child=>{
    child.mock.timers.enable({apis:['Date'],now:NOW});clearBoatcastCache();child.after(clearBoatcastCache);
    let published=false;const calls=[];
    child.mock.method(globalThis,'fetch',async url=>{
      calls.push(String(url));return new Response(published?(String(url).includes('_rs1_')?rs1:rs2):'data=\n0\n',{status:200});
    });
    const read=()=>resolveWithRealClient(observedRace,bounded?{deadlineMs:Date.now()+6000}:{});
    const waiting=await read();
    assert.equal(waiting.source,null);assert.equal(waiting.complete,false);assert.equal(waiting.rs1_status,'0');
    assert.match(waiting.reason,/rs1_normalize/);assert.equal(calls.length,2);
    published=true;child.mock.timers.setTime(NOW+29000);
    assert.equal((await read()).source,null);assert.equal(calls.length,2);
    child.mock.timers.setTime(NOW+295000);
    const ready=await read();
    assert.equal(calls.length,4);assert.equal(ready.source,'BOATCAST');assert.equal(ready.complete,true);assert.equal(ready.reason,null);
    assert.equal(ready.result.result_trifecta,'1-2-3');assert.equal(ready.result.payout,580);
    assert.equal(ready.fetched_at,new Date(NOW+295000).toISOString());
    child.mock.timers.setTime(NOW+305000);
    const reused=await read();assert.equal(calls.length,4);assert.equal(reused.complete,true);
    assert.equal(reused.fetched_at,ready.fetched_at);assert.equal(reused.result.fetched_at,ready.result.fetched_at);
  });
});

test('a cached unpublished payout cannot keep an available finish result partial forever',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});clearBoatcastCache();t.after(clearBoatcastCache);
  let published=false,calls=0;
  t.mock.method(globalThis,'fetch',async url=>{
    calls++;return new Response(String(url).includes('_rs1_')?rs1:published?rs2:'data=\n0\t0\n',{status:200});
  });
  const partial=await resolveWithRealClient(observedRace,{deadlineMs:Date.now()+6000});
  assert.equal(partial.source,'BOATCAST');assert.equal(partial.complete,false);assert.equal(partial.rs2_status,'0');
  assert.match(partial.reason,/rs2_normalize/);assert.equal(partial.result.result_trifecta,'1-2-3');assert.equal(partial.result.payout,null);
  published=true;t.mock.timers.setTime(NOW+295000);
  const ready=await resolveWithRealClient(observedRace,{deadlineMs:Date.now()+6000});
  assert.equal(ready.complete,true);assert.equal(ready.reason,null);assert.equal(ready.result.payout,580);assert.equal(calls,4);
});

test('payout fetch failures, missing payouts and conflicting combinations are explicit partial reads',async t=>{
  const variants=[
    {name:'unavailable',status:404,body:'',reason:'rs2_not_available'},
    {name:'no trifecta payout',status:200,body:'data=\n1\t0\n1\t-\t2\t260\t円\t1\n',reason:'result_payout_missing'},
    {name:'mismatching combination',status:200,body:rs2.replace('1\t2\t3\t580','1\t2\t4\t580'),reason:'result_payout_conflict'},
  ];
  for(const variant of variants)await t.test(variant.name,async child=>{
    child.mock.timers.enable({apis:['Date'],now:NOW});clearBoatcastCache();child.after(clearBoatcastCache);
    child.mock.method(globalThis,'fetch',async url=>String(url).includes('_rs1_')
      ?new Response(rs1,{status:200}):new Response(variant.body,{status:variant.status}));
    const result=await resolveWithRealClient(observedRace,{deadlineMs:Date.now()+6000});
    assert.equal(result.source,'BOATCAST');assert.equal(result.complete,false);assert.equal(result.reason,variant.reason);
    assert.equal(result.result.result_trifecta,'1-2-3');
  });
});

test('combined evidence retains the oldest real input acquisition time instead of the current call time',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const older=new Date(NOW-12000).toISOString(),newer=new Date(NOW-2000).toISOString();
  const api=resolver(async options=>({ok:true,text:'fixture',metadata:{fetched_at:options.dataType==='RS1'?older:newer}}));
  const result=await api.resolveRaceResult(observedRace);
  assert.equal(result.complete,true);assert.equal(result.fetched_at,older);assert.equal(result.result.fetched_at,older);
});
