// One scheduled invocation saves V8's own immutable forecasts. Input collection
// and result recovery keep their existing schedules and shared safety gates.
import { acquireLock, releaseLock } from './concurrencyLock.js';
import { runV8LiveCapture } from './v8LiveCapture.js';
import { jstDate } from './v8Repository.js';
import {persistLiveStatus,classifyLiveFailure,confirmLiveLockHeld} from './v8LiveStatus.js';

export const LIVE_GENERATION_REVISION = 'V8_LIVE_PIPELINE_2';
const MAX_BUDGET_MS = 100000;

export async function runV8LiveGeneration(client, options = {}) {
  const started = Date.now(), today = jstDate();
  if (options.race_date && options.race_date !== today) {
    return { ok: false, error: 'INVALID_LIVE_DATE', race_date: today,
      details: 'Live generation is for today. Closed races use the separate research recovery queue.' };
  }
  const requestedBudget = Number.isFinite(options.timeBudgetMs) ? Math.max(0, options.timeBudgetMs) : MAX_BUDGET_MS;
  const deadlineMs = Math.min(started + Math.min(MAX_BUDGET_MS, requestedBudget),
    Number.isFinite(options.deadlineMs) ? options.deadlineMs : Infinity);
  const summary = { ok: true, revision: LIVE_GENERATION_REVISION, race_date: today, v8: null };
  const finish = () => ({ ...summary, started_at:new Date(started).toISOString(),completed_at: new Date().toISOString(), duration_ms: Date.now() - started });
  let phase='LOCK';
  const trace=next=>{phase=next;console.info('[V8_LIVE_PHASE]',JSON.stringify({phase,elapsed_ms:Date.now()-started,
    created:Number(summary.v8?.created||0),partial:summary.v8?.partial===true}));};
  let pipelineLock = null;
  try {
    trace('LOCK');
    if (Date.now() >= deadlineMs) return await persistLiveStatus(client,{ ...finish(),ok:false,worker_completed:true,result_status:'PARTIAL',partial:true,skipped:'time_budget',
      v8:{pending_count:0,retry_pending_count:0,reason_counts:{TIME_BUDGET:1},pending:[]} });
    pipelineLock = await acquireLock(client, 'V8_LIVE_GENERATION', 'v8GenerateLiveForecasts', 120000);
    if (!pipelineLock) {
      if(await confirmLiveLockHeld(client,'V8_LIVE_GENERATION'))return {...finish(),skipped:'locked',worker_completed:false,result_status:'SKIPPED',status_persisted:false};
      throw new Error('LOCK_ACQUISITION_NOT_CONFIRMED');
    }

    // Cover PRE, DAY_BEFORE and FINAL from persisted race inputs, even when
    // collection found no new ready_keys. No separate prediction engine is needed.
    if (Date.now() >= deadlineMs) summary.v8 = {ok:false,worker_completed:true,result_status:'PARTIAL',partial:true,skipped:'time_budget',
      pending_count:0,retry_pending_count:0,reason_counts:{TIME_BUDGET:1},pending:[]};
    else {
      trace('CAPTURE');
      summary.v8 = await runV8LiveCapture(client, {
        // Keep a small part of the existing invocation budget for durable status.
        deadlineMs:Math.max(Date.now(),deadlineMs-4000),
        race_keys: options.race_keys,
        timeBudgetMs: Math.max(0, deadlineMs - Date.now()),
      });
    }
    summary.ok = summary.v8?.ok === true;
    summary.result_status=summary.v8?.result_status||'FAILED';
    summary.worker_completed=summary.v8?.worker_completed===true;
    if(summary.v8?.fatal)summary.fatal=summary.v8.fatal;
    if(summary.result_status==='FAILED')summary.error=summary.v8?.error||'LIVE_CAPTURE_FAILED';
    trace('COMPLETE');
    return await persistLiveStatus(client,{...finish(),partial:summary.result_status==='PARTIAL'||summary.v8?.partial===true});
  } catch (error) {
    console.error('[V8_LIVE_FAILURE]',JSON.stringify({phase,elapsed_ms:Date.now()-started,
      kind:['Error','TypeError','RangeError','ReferenceError','SyntaxError','AbortError','TimeoutError'].includes(error?.name)?error.name:'UnknownError'}));
    return await persistLiveStatus(client,{...finish(),ok:false,worker_completed:true,result_status:'FAILED',error:'LIVE_PIPELINE_FAILED',
      fatal:{...classifyLiveFailure(error,phase),retryable:false}});
  } finally {
    if (pipelineLock) await releaseLock(client, pipelineLock).catch(() => {});
  }
}

