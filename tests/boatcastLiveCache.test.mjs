import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchBoatcastText,clearBoatcastCache} from '../base44/shared/boatcastClient.js';

const NOW=Date.parse('2026-11-28T02:30:00Z');
const request={venueCode:'03',raceDate:'2026-11-28',raceNumber:3,dataType:'TKZ',maxRetries:0};

test('a live collector rechecks unpublished data before a drifting five-minute run can reuse it',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});clearBoatcastCache();
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>({status:200,text:async()=>++calls===1?'data=\n0':'data=\n1\nnew observations'}));
  const first=await fetchBoatcastText({...request,maxCacheAgeMs:60000});
  t.mock.timers.setTime(NOW+30000);
  const reused=await fetchBoatcastText({...request,maxCacheAgeMs:60000});
  assert.equal(reused.metadata.cache,'HIT');assert.equal(reused.metadata.fetched_at,first.metadata.fetched_at);
  t.mock.timers.setTime(NOW+295000);
  const updated=await fetchBoatcastText({...request,maxCacheAgeMs:60000});
  assert.equal(updated.metadata.cache,'MISS');assert.equal(updated.text,'data=\n1\nnew observations');
  assert.equal(calls,2);assert.equal(updated.metadata.fetched_at,new Date(NOW+295000).toISOString());
  clearBoatcastCache();
});

test('other consumers retain the existing cache policy and a cap cannot extend it',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});clearBoatcastCache();
  let calls=0;t.mock.method(globalThis,'fetch',async()=>({status:200,text:async()=>String(++calls)}));
  await fetchBoatcastText(request);
  t.mock.timers.setTime(NOW+295000);
  assert.equal((await fetchBoatcastText(request)).metadata.cache,'HIT');
  t.mock.timers.setTime(NOW+301000);
  assert.equal((await fetchBoatcastText({...request,maxCacheAgeMs:600000})).metadata.cache,'MISS');
  assert.equal(calls,2);clearBoatcastCache();
});
