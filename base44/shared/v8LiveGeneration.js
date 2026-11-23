// One scheduled invocation runs the existing V7 save gates before V8 captures
// its immutable forecasts. Inputs and result recovery have their own schedules.
import { acquireLock, releaseLock } from './concurrencyLock.js';
import { runV7AutoGeneration } from './v7AutoGeneration.js';
import { runV8LiveCapture } from './v8LiveCapture.js';
import { jstDate } from './v8Repository.js';

export const LIVE_GENERATION_REVISION = 'V8_LIVE_PIPELINE_1';
const MAX_BUDGET_MS = 100000;
const STAGE_BUDGET_MS = 45000;

export async function runV8LiveGeneration(client, options = {}) {
  const started = Date.now(), today = jstDate();
  if (options.race_date && options.race_date !== today) {
    return { ok: false, error: 'INVALID_LIVE_DATE', race_date: today,
      details: 'Live generation is for today. Closed races use the separate research recovery queue.' };
  }
  const requestedBudget = Number.isFinite(options.timeBudgetMs) ? Math.max(0, options.timeBudgetMs) : MAX_BUDGET_MS;
  const deadlineMs = Math.min(started + Math.min(MAX_BUDGET_MS, requestedBudget),
    Number.isFinite(options.deadlineMs) ? options.deadlineMs : Infinity);
  const summary = { ok: true, revision: LIVE_GENERATION_REVISION, race_date: today, v7: null, v8: null };
  const finish = () => ({ ...summary, completed_at: new Date().toISOString(), duration_ms: Date.now() - started });
  let pipelineLock = null, v7Lock = null;
  try {
    if (Date.now() >= deadlineMs) return { ...finish(), partial: true, skipped: 'time_budget' };
    pipelineLock = await acquireLock(client, 'V8_LIVE_GENERATION', 'v8GenerateLiveForecasts', 120000);
    if (!pipelineLock) return { ...finish(), skipped: 'locked' };

    // Keep the standalone V7 lock name during the migration. This prevents the
    // old schedule/manual entry and this pipeline from racing over the same day.
    // Reserve a V8 slice even when V7 cannot finish all eligible races this time.
    const v7Deadline = Math.min(Date.now() + STAGE_BUDGET_MS, deadlineMs - STAGE_BUDGET_MS);
    if (Date.now() < v7Deadline) {
      try {
        v7Lock = await acquireLock(client, `v7_generate_${today}`, 'v8GenerateLiveForecasts', 240000);
        if (!v7Lock) summary.v7 = { ok: true, skipped: 'locked' };
        else summary.v7 = { ok: true, ...await runV7AutoGeneration(client, {
          race_date: today, horizon_minutes: options.horizon_minutes, deadlineMs: v7Deadline,
        }) };
      } catch (error) {
        summary.v7 = { ok: false, error: String(error?.message || error).slice(0, 160) };
      } finally {
        if (v7Lock) await releaseLock(client, v7Lock).catch(() => {});
        v7Lock = null;
      }
    } else summary.v7 = { ok: true, partial: true, skipped: 'time_budget' };

    // Always inspect all of today's and tomorrow's races, even if V7 had no
    // FINAL targets or input collection produced no ready_keys. V8's own gates
    // keep missing/ambiguous V7 evidence from becoming a BUY.
    if (Date.now() >= deadlineMs) summary.v8 = { ok: true, partial: true, skipped: 'time_budget' };
    else summary.v8 = await runV8LiveCapture(client, {
      deadlineMs: Math.min(deadlineMs, Date.now() + STAGE_BUDGET_MS),
      timeBudgetMs: STAGE_BUDGET_MS,
    });
    const captureFailed = Number(summary.v8?.errors || 0) > 0;
    summary.ok = summary.v7?.ok !== false && summary.v8?.ok !== false && !captureFailed;
    return { ...finish(), partial: !!summary.v7?.partial || !!summary.v8?.partial || captureFailed,
      ...(captureFailed ? { error: 'LIVE_CAPTURE_PARTIAL_FAILURE' } : {}) };
  } catch (error) {
    return { ...finish(), ok: false, error: 'LIVE_PIPELINE_FAILED', details: String(error?.message || error).slice(0, 160) };
  } finally {
    if (v7Lock) await releaseLock(client, v7Lock).catch(() => {});
    if (pipelineLock) await releaseLock(client, pipelineLock).catch(() => {});
  }
}
