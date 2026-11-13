// LOCAL AUDIT CANDIDATE ONLY. Not connected to any function or workflow.
// There is deliberately no search/create ProcessLock here: it cannot guarantee uniqueness.
// The operator must serialize administrator invocations outside this database.
import { expectedStageClaims, inspectClaimRows } from './v7StageClaimRead.js';
import { timeMs } from '../liveV7Time.js';

const MAX_CREATES_PER_RUN = 20;
const WARNING = '初回作成の一意性は保証しません。管理処理は単一実行とし、重複・未準備・取得未完了は安全停止します。';
const stopReason = report => !report.read_complete ? 'CLAIM_READ_INCOMPLETE'
  : report.duplicate.length ? 'CLAIM_DUPLICATE'
  : report.invalid.length ? 'CLAIM_INVALID' : null;

export async function provisionStageClaims(sr, races, {
  nowMs = Date.now(), allowCreate = false, singleWriterConfirmed = false,
} = {}) {
  if (allowCreate && singleWriterConfirmed !== true) throw new Error('SINGLE_ADMIN_RUN_REQUIRED');
  const expected = expectedStageClaims(races, nowMs);
  const before = await inspectClaimRows(sr, expected);
  const base = { mode: allowCreate ? 'SINGLE_ADMIN_SEQUENTIAL' : 'READ_ONLY', warning: WARNING };
  if (!allowCreate || stopReason(before) || !before.missing.length) {
    return { ...before, ...base, attempted: 0, stopped_reason: stopReason(before), manual_resume_required: false };
  }

  const attempted = [];
  let stopped = null;
  // One request at a time, one create attempt per key, then a complete read of that key.
  // Neither a create response nor a single read is a distributed uniqueness guarantee.
  for (const key of [...before.missing].sort().slice(0, MAX_CREATES_PER_RUN)) {
    const wanted = expected.get(key);
    const race = races.find(row => row.race_key === wanted.race_key);
    if (timeMs(race.deadline) <= Math.max(nowMs, Date.now())) { stopped = 'DEADLINE_PASSED'; break; }
    attempted.push(key);
    try {
      await sr.V7StageClaim.create({
        ...wanted, state: 'free', owner: null, record_hash: null, claimed_at: null,
      });
    } catch {
      // An ambiguous response is never retried here. Only re-read what is observable.
    }
    const observed = await inspectClaimRows(sr, new Map([[key, wanted]]));
    stopped = stopReason(observed) || (observed.missing.length ? 'CLAIM_MISSING' : null);
    if (stopped) break;
  }

  const after = await inspectClaimRows(sr, expected);
  const confirmed = attempted.filter(key => after.readyPairs.has(key)).length;
  stopped = stopReason(after) || stopped || (after.missing.length ? 'BATCH_LIMIT' : null);
  return {
    ...after, ...base,
    // "created" means newly observed singleton slots, not proof of which caller created them.
    created: confirmed, attempted: attempted.length,
    creation_unconfirmed: attempted.length - confirmed,
    stopped_reason: stopped, all_ready: after.all_ready && !stopped,
    manual_resume_required: stopped === 'BATCH_LIMIT',
  };
}