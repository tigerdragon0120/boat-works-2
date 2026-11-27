import test from 'node:test';
import assert from 'node:assert/strict';
import {persistLiveStatus,liveResponseStatus,LIVE_STATUS_NAME} from '../base44/shared/v8LiveStatus.js';

const NOW=Date.parse('2026-11-28T00:00:00Z');
const iso=offset=>new Date(NOW+offset).toISOString();
const partial=()=>({ok:false,result_status:'PARTIAL',worker_completed:true,race_date:'2026-11-28',
  started_at:iso(-1000),completed_at:iso(0),v8:{ok:false,result_status:'PARTIAL',worker_completed:true,
    created:2,attempted:3,existing:0,errors:1,pending_count:1,retry_pending_count:1,
    reason_counts:{RATE_LIMIT_BACKOFF:1},pending:[{race_key:'2026-11-28_01_01',stage:'FINAL',
      phase:'SAVE_FORECAST',code:'RATE_LIMIT_BACKOFF',retryable:true}]}});
const complete=()=>({...partial(),ok:true,result_status:'COMPLETE',v8:{ok:true,result_status:'COMPLETE',
  worker_completed:true,created:0,attempted:0,existing:0,errors:0,pending_count:0,retry_pending_count:0,pending:[]}});
const previous=()=>({id:'job-status',name:LIVE_STATUS_NAME,status:'partial',last_updated:iso(-10000),
  job_summary:{started_at:iso(-20000),result_status:'PARTIAL',pending_count:7},errors:['PENDING_SAVED_WORK']});
const limited=()=>Object.assign(new Error('private rate limit details'),{response:{status:429}});

function setup(t,{rows=[],before=()=>{}}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});t.mock.method(console,'error',()=>{});
  const records=structuredClone(rows),calls=[],sleeps=[];
  const touch=(method,args)=>{calls.push({method,args});before({method,args,records});};
  const entity={
    async filter(query){touch('filter',[query]);return {items:structuredClone(records),has_more:false,next_cursor:null};},
    async create(doc){touch('create',[doc]);const saved={...structuredClone(doc),id:'created-job'};records.push(saved);return saved;},
    async update(id,doc){touch('update',[id,doc]);const row=records.find(item=>item.id===id);if(row)Object.assign(row,structuredClone(doc));return row;},
  };
  return {records,calls,sleeps,client:{asServiceRole:{entities:{AutoUpdateStatus:entity}}},
    options:{sleep:async ms=>{sleeps.push(ms);t.mock.timers.tick(ms);}}};
}

test('a transient status write retries and preserves the worker PARTIAL instead of failing the schedule',async t=>{
  let failure=true;const state=setup(t,{before:({method})=>{if(method==='create'&&failure){failure=false;throw limited();}}});
  const result=await persistLiveStatus(state.client,partial(),state.options);
  assert.equal(result.result_status,'PARTIAL');assert.equal(result.ok,false);assert.equal(result.status_persisted,true);
  assert.equal(result.status_save_attempts,2);assert.equal(liveResponseStatus(result),200);assert.deepEqual(state.sleeps,[250]);
  assert.equal(state.records.length,1);assert.equal(state.records[0].status,'partial');
  assert.equal(state.records[0].job_summary.created,2);assert.equal(state.records[0].job_summary.retry_pending_count,1);
});

test('a lost create acknowledgement is reconciled before retry without a duplicate status identity',async t=>{
  let failure=true;const state=setup(t,{before:({method,args,records})=>{
    if(method==='create'&&failure){failure=false;records.push({...structuredClone(args[0]),id:'created-but-unacknowledged'});
      throw Object.assign(new Error('Network Error'),{code:'ERR_NETWORK'});}
  }});
  const result=await persistLiveStatus(state.client,partial(),state.options);
  assert.equal(result.status_persisted,true);assert.equal(state.records.length,1);
  assert.equal(state.calls.filter(call=>call.method==='create').length,1);
  assert.equal(state.calls.filter(call=>call.method==='update').length,1);
});

test('unconfirmed status persistence keeps its observed cause and continues the next scheduled run without claiming success',async t=>{
  const state=setup(t,{before:({method})=>{if(method==='create')throw limited();}});
  const result=await persistLiveStatus(state.client,partial(),state.options);
  assert.equal(result.ok,false);assert.equal(result.status_persisted,false);assert.equal(result.result_status,'PARTIAL');
  assert.equal(result.work_result_status,'PARTIAL');assert.equal(result.error,'LIVE_STATUS_SAVE_FAILED');
  assert.equal(result.status_failure.code,'RATE_LIMIT_BACKOFF');assert.equal(result.status_failure.http_status,429);
  assert.equal(result.status_failure.retryable,true);assert.equal(result.status_save_attempts,3);
  assert.equal(liveResponseStatus(result),200);assert.equal(result.next_retry_policy,'NEXT_SCHEDULED_RUN');assert.equal(state.records.length,0);
  assert.deepEqual(state.sleeps,[250,1000]);assert.doesNotMatch(JSON.stringify(result),/private rate/);
});

test('Retry-After is respected and an excessive cooldown is not retried inside the status budget',async t=>{
  const state=setup(t,{before:({method})=>{
    if(method==='create')throw Object.assign(limited(),{response:{status:429,headers:{'retry-after':'30'}}});
  }});
  const result=await persistLiveStatus(state.client,partial(),state.options);
  assert.equal(result.status_save_attempts,1);assert.equal(result.status_failure.http_status,429);
  assert.equal(state.sleeps.length,0);assert.equal(state.calls.filter(call=>call.method==='create').length,1);
});

test('a status read rate limit retains Retry-After through the shared sanitized paging error',async t=>{
  const state=setup(t,{before:({method})=>{
    if(method==='filter')throw Object.assign(limited(),{response:{status:429,headers:{'retry-after':'30'}}});
  }});
  const result=await persistLiveStatus(state.client,partial(),state.options);
  assert.equal(result.status_save_attempts,1);assert.equal(result.status_failure.http_status,429);
  assert.equal(state.sleeps.length,0);assert.equal(state.calls.filter(call=>call.method==='filter').length,1);
  assert.equal(result.result_status,'PARTIAL');assert.equal(result.status_persisted,false);assert.equal(liveResponseStatus(result),200);
});

test('a repeated 408 from the status filter defers a completed worker and accepts the sanitized read-timeout classification',async t=>{
  const state=setup(t,{before:({method})=>{
    if(method==='filter')throw Object.assign(new Error('request timeout'),{response:{status:408}});
  }});
  const result=await persistLiveStatus(state.client,partial(),state.options);
  assert.equal(result.status_save_attempts,3);assert.equal(result.status_failure.http_status,408);
  assert.equal(result.status_failure.retryable,true);assert.equal(result.worker_completed,true);
  assert.equal(result.ok,false);assert.equal(result.result_status,'PARTIAL');assert.equal(result.status_persisted,false);
  assert.equal(result.next_retry_policy,'NEXT_SCHEDULED_RUN');assert.equal(liveResponseStatus(result),200);
  assert.equal(state.records.length,0);assert.equal(state.calls.filter(call=>call.method==='filter').length,3);
  assert.equal(liveResponseStatus({...result,status_failure:{...result.status_failure,code:'SOURCE_READ_TRANSIENT'}}),200);
});

test('permission, implementation and ambiguous identity failures are not retried or converted to HTTP success',async t=>{
  for(const kind of ['Forbidden','TypeError','Duplicate'])await t.test(kind,async child=>{
    const state=setup(child,{rows:kind==='Duplicate'?[previous(),{...previous(),id:'other'}]:[],before:({method})=>{
      if(method==='create')throw kind==='TypeError'?new TypeError('private bug')
        :Object.assign(new Error('private denied'),{response:{status:403}});
    }});
    const result=await persistLiveStatus(state.client,partial(),state.options);
    assert.equal(result.result_status,'FAILED');assert.equal(result.status_failure.retryable,false);
    assert.equal(liveResponseStatus(result),503);assert.equal(result.status_save_attempts,1);assert.equal(state.sleeps.length,0);
  });
});

test('a later zero-work page refresh preserves the useful pending scheduled status',async t=>{
  const saved=previous(),state=setup(t,{rows:[saved]});
  const result=await persistLiveStatus(state.client,complete(),state.options);
  assert.equal(result.ok,false);assert.equal(result.result_status,'SKIPPED');assert.equal(result.skipped,'no_work_preserved_status');
  assert.equal(result.status_persisted,false);assert.equal(liveResponseStatus(result),200);
  assert.deepEqual(state.records,[saved]);assert.equal(state.calls.some(call=>['create','update'].includes(call.method)),false);
});

test('a nonempty completed run can clear an old warning after checking saved work',async t=>{
  const state=setup(t,{rows:[previous()]}),work=complete();work.v8.attempted=2;work.v8.existing=2;
  const result=await persistLiveStatus(state.client,work,state.options);
  assert.equal(result.result_status,'COMPLETE');assert.equal(result.status_persisted,true);assert.equal(liveResponseStatus(result),200);
  assert.equal(state.records[0].status,'success');assert.equal(state.records[0].job_summary.existing,2);
});

test('a failed worker stays failed even if its status persistence also encounters a transient error',async t=>{
  const state=setup(t,{before:({method})=>{if(method==='create')throw limited();}}),work=partial();
  work.result_status='FAILED';work.v8.result_status='FAILED';
  work.fatal={phase:'READ_RACES',code:'SOURCE_READ_TRANSIENT',kind:'Error',http_status:503,retryable:false};
  const result=await persistLiveStatus(state.client,work,state.options);
  assert.equal(result.result_status,'FAILED');assert.equal(result.work_result_status,'FAILED');
  assert.equal(liveResponseStatus(result),503);assert.equal(result.fatal.phase,'READ_RACES');
});

test('only an actually completed COMPLETE/PARTIAL worker can defer an observed temporary status failure',async t=>{
  const failures={
    rate_limit:()=>limited(),
    request_timeout:()=>Object.assign(new Error('timeout'),{response:{status:408}}),
    provider_unavailable:()=>Object.assign(new Error('unavailable'),{response:{status:503}}),
    transport:()=>Object.assign(new Error('Network Error'),{code:'ECONNRESET'}),
  };
  for(const outcome of ['COMPLETE','PARTIAL','FAILED'])for(const workerCompleted of [true,false])for(const [kind,error] of Object.entries(failures)){
    await t.test(`${outcome}, worker completed ${workerCompleted}, ${kind}`,async child=>{
      const state=setup(child,{before:({method})=>{if(method==='create')throw error();}}),work=partial();
      work.result_status=outcome;work.v8.result_status=outcome;work.worker_completed=workerCompleted;
      // Even a nested old completion flag must not override the outer worker's
      // explicit unfinished state when deciding to keep the schedule alive.
      work.v8.worker_completed=true;
      const eligible=workerCompleted&&outcome!=='FAILED',result=await persistLiveStatus(state.client,work,state.options);
      assert.equal(result.ok,false);assert.equal(result.status_persisted,false);assert.equal(result.work_result_status,outcome);
      assert.equal(result.result_status,eligible?'PARTIAL':'FAILED');assert.equal(liveResponseStatus(result),eligible?200:503);
      if(eligible)assert.equal(result.next_retry_policy,'NEXT_SCHEDULED_RUN');
    });
  }
});

test('an unconfirmed acknowledgement or malformed successful read is not a retryable status outage',async t=>{
  for(const kind of ['missing_ack','malformed_page','unknown_error'])await t.test(kind,async child=>{
    const state=setup(child),entity=state.client.asServiceRole.entities.AutoUpdateStatus;
    if(kind==='missing_ack')entity.create=async()=>null;
    if(kind==='malformed_page')entity.filter=async()=>[];
    if(kind==='unknown_error')entity.create=async()=>{throw new Error('unknown failure');};
    const result=await persistLiveStatus(state.client,partial(),state.options);
    assert.equal(result.result_status,'FAILED');assert.equal(result.status_failure.retryable,false);
    assert.equal(liveResponseStatus(result),503);assert.equal(state.sleeps.length,0);
  });
});

test('the HTTP helper rejects forged, incomplete, or permanent status fallback flags',()=>{
  const base={...partial(),result_status:'PARTIAL',status_persisted:false,work_result_status:'PARTIAL',
    error:'LIVE_STATUS_SAVE_FAILED',next_retry_policy:'NEXT_SCHEDULED_RUN',fatal:null,
    status_failure:{phase:'SAVE_JOB_STATUS',code:'RATE_LIMIT_BACKOFF',kind:'Error',http_status:429,retryable:true}};
  assert.equal(liveResponseStatus(base),200);
  const invalid=[{worker_completed:false},{work_result_status:'FAILED'},{result_status:'FAILED'},
    {next_retry_policy:null},{fatal:{phase:'BUILD_FORECAST',code:'IMPLEMENTATION_ERROR'}},
    {status_failure:{...base.status_failure,phase:'SAVE_FORECAST'}},
    {status_failure:{...base.status_failure,http_status:403}},
    {status_failure:{...base.status_failure,kind:'TypeError'}},
    {status_failure:{...base.status_failure,code:'UNEXPECTED_FAILURE'}},
    {status_failure:{...base.status_failure,retryable:false}}];
  for(const override of invalid)assert.equal(liveResponseStatus({...base,...override}),503,JSON.stringify(override));
});
