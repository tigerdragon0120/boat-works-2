import test from 'node:test';
import assert from 'node:assert/strict';
import {readForecastGenerationStatus} from '../base44/shared/forecastGenerationStatus.js';

test('admin forecast status preserves a partial outcome and pending races separately from collection', async () => {
  const pending = [{race_key:'2026-11-27_14_04',stage:'FINAL',phase:'SAVE_FORECAST',code:'HTTP_503'}];
  const row = {id:'status',name:'v8_live_generation',status:'partial',last_updated:'2026-11-27T00:36:00Z',error_count:1,
    errors:['予想保存を再試行します'],job_summary:{result_status:'PARTIAL',created:2,retry_pending_count:1,pending},created_by:'private'};
  const result = await readForecastGenerationStatus({filter:async (query,sort,limit) => {
    assert.deepEqual(query,{name:'v8_live_generation'});assert.equal(sort,'-last_updated');assert.equal(limit,2);return [row];
  }});
  assert.equal(result.read_status,'READY');assert.equal(result.status,'partial');
  assert.deepEqual(result.job_summary.pending,pending);assert.equal(result.job_summary.created,2);assert.equal(result.created_by,undefined);
});
test('missing, unreadable and ambiguous forecast outcomes never become a successful zero count', async () => {
  assert.deepEqual(await readForecastGenerationStatus({filter:async()=>[]}),{read_status:'MISSING'});
  assert.deepEqual(await readForecastGenerationStatus({filter:async()=>{throw new Error('private upstream failure')}}),{read_status:'READ_FAILED'});
  assert.deepEqual(await readForecastGenerationStatus({filter:async()=>({items:[]})}),{read_status:'READ_FAILED'});
  assert.deepEqual(await readForecastGenerationStatus({filter:async()=>[{id:'a',name:'v8_live_generation'},{id:'b',name:'v8_live_generation'}]}),{read_status:'CONFLICT'});
  assert.deepEqual(await readForecastGenerationStatus({filter:async()=>[{id:'a',name:'default'}]}),{read_status:'CONFLICT'});
});
