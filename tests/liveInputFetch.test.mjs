import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchHtml} from '../base44/shared/boatraceOfficialParser.js';

test('an exhausted live collection budget performs no HTTP request', async t => {
  const request=t.mock.method(globalThis,'fetch',async()=>{throw new Error('must not fetch');});
  const result=await fetchHtml('https://example.invalid',0,{deadlineMs:Date.now()-1,timeoutMs:20});
  assert.equal(request.mock.callCount(),0);
  assert.equal(result.ok,false);
  assert.equal(result.error,'FETCH_TIME_BUDGET');
});

test('a stalled response body is still covered by the live timeout', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>({status:200,text:()=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('body aborted')),{once:true});
  })}));
  const pending=fetchHtml('https://example.invalid',0,{timeoutMs:20,deadlineMs:101000});
  await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(20);
  const result=await pending;
  assert.equal(result.ok,false);
  assert.equal(result.error,'body aborted');
});

test('retry backoff cannot outlive the absolute collection deadline', async t => {
  const request=t.mock.method(globalThis,'fetch',async()=>({status:503}));
  const result=await fetchHtml('https://example.invalid',3,{timeoutMs:100,deadlineMs:Date.now()+500});
  assert.equal(request.mock.callCount(),1);
  assert.equal(result.ok,false);
  assert.equal(result.error,'HTTP 503');
});

test('ordinary successful HTML fetch retains the existing response format', async t => {
  t.mock.method(globalThis,'fetch',async()=>({status:200,text:async()=>'<html>race data</html>'}));
  assert.deepEqual(await fetchHtml('https://example.invalid',0),{ok:true,status:200,html:'<html>race data</html>'});
});
