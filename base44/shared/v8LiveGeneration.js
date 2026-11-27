// One scheduled invocation saves V8's own immutable forecasts. Input collection
// and result recovery keep their existing schedules and shared safety gates.
import { acquireLock, releaseLock } from './concurrencyLock.js';
import { runV8LiveCapture } from './v8LiveCapture.js';
import { jstDate } from './v8Repository.js';

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
  const finish = () => ({ ...summary, completed_at: new Date().toISOString(), duration_ms: Date.now() - started });
  let phase='LOCK';
  const trace=next=>{phase=next;console.info('[V8_LIVE_PHASE]',JSON.stringify({phase,elapsed_ms:Date.now()-started,
    created:Number(summary.v8?.created||0),partial:summary.v8?.partial===true}));};
  let pipelineLock = null;
  try {
    trace('LOCK');
    if (Date.now() >= deadlineMs) return { ...finish(), partial: true, skipped: 'time_budget' };
    pipelineLock = await acquireLock(client, 'V8_LIVE_GENERATION', 'v8GenerateLiveForecasts', 120000);
    if (!pipelineLock) return { ...finish(), skipped: 'locked' };

    // Cover PRE, DAY_BEFORE and FINAL from persisted race inputs, even when
    // collection found no new ready_keys. No separate prediction engine is needed.
    if (Date.now() >= deadlineMs) summary.v8 = { ok: true, partial: true, skipped: 'time_budget' };
    else {
      trace('CAPTURE');
      summary.v8 = await runV8LiveCapture(client, {
        deadlineMs,
        race_keys: options.race_keys,
        timeBudgetMs: Math.max(0, deadlineMs - Date.now()),
      });
    }
    const captureFailed = Number(summary.v8?.errors || 0) > 0;
    summary.ok = summary.v8?.ok !== false && !captureFailed;
    trace('COMPLETE');
    return { ...finish(), partial: !!summary.v8?.partial || captureFailed,
      ...(captureFailed ? { error: 'LIVE_CAPTURE_PARTIAL_FAILURE' } : {}) };
  } catch (error) {
    console.error('[V8_LIVE_FAILURE]',JSON.stringify({phase,elapsed_ms:Date.now()-started,
      kind:['Error','TypeError','RangeError','ReferenceError','SyntaxError','AbortError','TimeoutError'].includes(error?.name)?error.name:'UnknownError'}));
    return { ...finish(), ok: false, error: 'LIVE_PIPELINE_FAILED', details: String(error?.message || error).slice(0, 160) };
  } finally {
    if (pipelineLock) await releaseLock(client, pipelineLock).catch(() => {});
  }
}

