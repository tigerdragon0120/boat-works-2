import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedReadRequests, shouldPollRead } from '../src/lib/sharedReadRequests.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const user = { id: 'admin-a', role: 'admin' };
const day = { mode: 'day', race_date: '2026-11-24' };

test('16 simultaneous readers of the same conditions make one backend call', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true), gate = deferred();
  let calls = 0;
  const read = () => { calls++; return gate.promise; };
  const pending = Array.from({ length: 16 }, (_, i) => pool.request(scope, 'v8ReadDashboard', i % 2 ? day : { race_date: day.race_date, mode: day.mode }, read));
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve({ ok: true, generated_at: 'new' });
  const results = await Promise.all(pending);
  assert.ok(results.every(result => result.generated_at === 'new'));
});

test('different dates, races, and operations never share a request', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true);
  let calls = 0;
  const read = async parameters => ({ call: ++calls, parameters });
  const results = await Promise.all([
    pool.request(scope, 'v8ReadDashboard', day, read),
    pool.request(scope, 'v8ReadDashboard', { ...day, race_date: '2026-11-23' }, read),
    pool.request(scope, 'v8ReadDashboard', { mode: 'race', race_id: 'race-a' }, read),
    pool.request(scope, 'getAutoUpdateStatusV2', {}, read),
  ]);
  assert.equal(calls, 4);
  assert.equal(new Set(results.map(result => result.call)).size, 4);
});

test('completed reads are not cached, including a manual refresh', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true);
  let calls = 0;
  const read = async () => ++calls;
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, read), 1);
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, read), 2);
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, read, { force: true }), 3);
});

test('manual refresh after a save starts a new read and supersedes an older pending response for every reader', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true);
  const before = deferred(), after = deferred();
  let calls = 0;
  const read = () => (++calls === 1 ? before.promise : after.promise);
  const oldA = pool.request(scope, 'v8ReadDashboard', day, read);
  const oldB = pool.request(scope, 'v8ReadDashboard', day, read);
  await Promise.resolve();
  const fresh = pool.request(scope, 'v8ReadDashboard', day, read, { force: true });
  await Promise.resolve();
  assert.equal(calls, 2);
  after.resolve('after-save');
  assert.equal(await fresh, 'after-save');
  before.resolve('before-save');
  assert.deepEqual(await Promise.all([oldA, oldB]), ['after-save', 'after-save']);
});

test('a failed forced read does not fall back to an older successful result', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true), before = deferred();
  const old = pool.request(scope, 'v8ReadDashboard', day, () => before.promise);
  const oldRejected = assert.rejects(old, /latest failed/);
  await Promise.resolve();
  const fresh = pool.request(scope, 'v8ReadDashboard', day, async () => { throw new Error('latest failed'); }, { force: true });
  await assert.rejects(fresh, /latest failed/);
  before.resolve('obsolete');
  await oldRejected;
});

test('a forced refresh immediately releases old readers, without waiting for the obsolete network response', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true), slow = deferred();
  let oldFinished = false;
  const original = pool.request(scope, 'v8ReadDashboard', day, () => slow.promise);
  original.then(() => { oldFinished = true; });
  await Promise.resolve();
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, async () => 'version-2', { force: true }), 'version-2');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(oldFinished, true);
  assert.equal(await original, 'version-2');
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, async () => 'version-3', { force: true }), 'version-3');
  slow.resolve('version-1');
  assert.equal(await original, 'version-2');
});

test('failures are shared but a later attempt can recover', async () => {
  const pool = createSharedReadRequests(), scope = pool.scopeFor(user, true);
  let calls = 0;
  const fail = async () => { calls++; throw new Error('unavailable'); };
  await Promise.all([
    assert.rejects(pool.request(scope, 'v8ReadDashboard', day, fail), /unavailable/),
    assert.rejects(pool.request(scope, 'v8ReadDashboard', day, fail), /unavailable/),
  ]);
  assert.equal(calls, 1);
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, async () => 'recovered'), 'recovered');
});

test('switching users rejects a late private result and never shares it with the next user', async () => {
  const pool = createSharedReadRequests(), a = pool.scopeFor(user, true), gate = deferred();
  const old = pool.request(a, 'v8ReadDashboard', { mode: 'race', race_id: 'race-a' }, () => gate.promise);
  const oldRejected = assert.rejects(old, /利用者が変わった/);
  await Promise.resolve();
  const b = pool.scopeFor({ id: 'user-b', role: 'user' }, true);
  assert.notEqual(a, b);
  const result = await pool.request(b, 'v8ReadDashboard', { mode: 'race', race_id: 'race-a' }, async () => ({ external: [] }));
  gate.resolve({ external: ['private'] });
  await oldRejected;
  assert.deepEqual(result, { external: [] });
  await assert.rejects(pool.request(a, 'v8ReadDashboard', day, async () => 'stale'), /利用者が変わった/);
});

test('logout, a new login for the same ID, and a role change all invalidate old requests', () => {
  const pool = createSharedReadRequests(), firstUser = { ...user };
  const first = pool.scopeFor(firstUser, true);
  assert.equal(pool.scopeFor(firstUser, true), first);
  const anonymous = pool.scopeFor(null, false);
  const relogin = pool.scopeFor({ ...user }, true);
  const changedRole = pool.scopeFor({ ...user, role: 'user' }, true);
  assert.equal(new Set([first, anonymous, relogin, changedRole]).size, 4);
});

test('an expired read releases the shared slot so a new read can recover', async () => {
  const pool = createSharedReadRequests({ timeoutMs: 15 }), scope = pool.scopeFor(user, true);
  await assert.rejects(pool.request(scope, 'v8ReadDashboard', day, () => new Promise(() => {})), /時間内/);
  assert.equal(await pool.request(scope, 'v8ReadDashboard', day, async () => 'recovered'), 'recovered');
});

test('hidden initial/periodic reads and overlapping polls are blocked; overdue visible reads resume', () => {
  const base = { requestedAt: 1000000, now: 1300000, interval: 300000, hidden: false, inFlight: false };
  assert.equal(shouldPollRead(base), true);
  assert.equal(shouldPollRead({ ...base, hidden: true, requestedAt: 0 }), false);
  assert.equal(shouldPollRead({ ...base, hidden: true }), false);
  assert.equal(shouldPollRead({ ...base, inFlight: true }), false);
  assert.equal(shouldPollRead({ ...base, now: 1299999 }), false);
  assert.equal(shouldPollRead({ ...base, requestedAt: 0 }), true);
});

test('one visible idle hour has 12 status polls instead of 120; busy status can still poll at 30 seconds', () => {
  const count = interval => {
    let requestedAt = 0, calls = 0;
    for (let elapsed = 0; elapsed < 3600000; elapsed += 30000) {
      const now = 1000000 + elapsed;
      if (shouldPollRead({ hidden: false, inFlight: false, requestedAt, now, interval })) {
        calls++;
        requestedAt = now;
      }
    }
    return calls;
  };
  assert.equal(count(300000), 12);
  assert.equal(count(30000), 120);
});
