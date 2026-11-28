import test from 'node:test';
import assert from 'node:assert/strict';
import { createRaceListCache, dedupeRacesForDisplay, RACE_LIST_TIMEOUT_MS } from '../src/lib/raceListCache.js';

const date = '2026-11-28';
const row = (number = 1, extra = {}) => ({ id: `race-${number}`, race_date: date, venue_code: '15',
  race_number: number, race_key: `${date}_15_${String(number).padStart(2, '0')}`, status: 'scheduled', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function clock(start = 0) {
  let current = start, next = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer: (callback, wait) => { const id = ++next; timers.set(id, { at: current + wait, callback }); return id; },
    clearTimer: id => timers.delete(id),
    tick: ms => { current += ms; for (const [id, timer] of timers) if (timer.at <= current) { timers.delete(id); timer.callback(); } },
  };
}

test('parallel consumers share one read, including a forced caller and different finished filters', async () => {
  const pending = deferred(); let calls = 0;
  const list = createRaceListCache({ filterRaces: () => { calls++; return pending.promise; } });
  const all = list({ raceDate: date, includeFinished: true });
  const active = list({ raceDate: date });
  const forced = list({ raceDate: date, force: true, includeFinished: true });
  await flush(); assert.equal(calls, 1);
  pending.resolve([row(1), row(2, { status: 'finished' }), row(3, { status: 'cancelled' })]);
  assert.equal((await all).length, 3);
  assert.deepEqual(await active, [row(1)]);
  assert.equal((await forced).length, 3);
  assert.equal(calls, 1);
});

test('date-specific cache expires after twelve seconds and a real empty array is cacheable', async () => {
  const time = clock(); let calls = 0;
  const list = createRaceListCache({ ...time, filterRaces: async () => { calls++; return []; } });
  assert.deepEqual(await list({ raceDate: date }), []);
  time.tick(11999); await list({ raceDate: date }); assert.equal(calls, 1);
  time.tick(1); await list({ raceDate: date }); assert.equal(calls, 2);
  await list({ raceDate: '2026-11-29' }); assert.equal(calls, 3);
  await list({ raceDate: date }); assert.equal(calls, 3);
});

test('a forced failure rejects while retaining the last good cache without refreshing its age', async () => {
  const time = clock(); let calls = 0;
  const failure = new Error('Network Error');
  const list = createRaceListCache({ ...time, filterRaces: async () => {
    calls++; if (calls === 2) throw failure;
    return [row(1, { updated_date: calls === 1 ? '2026-11-28T01:00:00Z' : '2026-11-28T02:00:00Z' })];
  } });
  const first = await list({ raceDate: date });
  time.tick(5000);
  await assert.rejects(list({ raceDate: date, force: true }), error => error === failure);
  assert.deepEqual(await list({ raceDate: date }), first); assert.equal(calls, 2);
  time.tick(7000);
  const fresh = await list({ raceDate: date });
  assert.equal(calls, 3); assert.notDeepEqual(fresh, first);
});

test('JST midnight has independent inflight/cache entries and late yesterday results stay yesterday', async () => {
  const oldDay = '2026-11-27', oldRead = deferred();
  const time = clock(Date.parse('2026-11-27T14:59:59Z'));
  const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time.now()));
  const seen = [];
  const list = createRaceListCache({ ...time, filterRaces: async query => {
    seen.push(query.race_date);
    return query.race_date === oldDay ? oldRead.promise : [row(1)];
  } });
  const yesterday = list({ raceDate: day() });
  time.tick(1000);
  const today = await list({ raceDate: day() });
  oldRead.resolve([row(1, { race_date: oldDay, race_key: `${oldDay}_15_01` })]);
  assert.equal((await yesterday)[0].race_date, oldDay);
  assert.equal(today[0].race_date, date);
  assert.deepEqual(await list({ raceDate: day() }), today);
  assert.deepEqual(seen, [oldDay, date]);
});

test('invalid or cross-date responses reject instead of becoming an empty successful day', async () => {
  for (const response of [null, undefined, {}, { items: [], complete: false }, [null], [1],
    [row(1, { race_date: '2026-11-27' })], [row(13)], [row(1, { venue_code: '99' })]]) {
    let calls = 0;
    const list = createRaceListCache({ filterRaces: async () => { calls++; return calls === 1 ? response : [row(1)]; } });
    await assert.rejects(list({ raceDate: date }), { code: 'RACE_LIST_INVALID' });
    assert.deepEqual(await list({ raceDate: date }), [row(1)]); assert.equal(calls, 2);
  }
});

test('invalid dates fail before sending a backend query', async () => {
  let calls = 0;
  const list = createRaceListCache({ filterRaces: async () => { calls++; return []; } });
  for (const raceDate of [undefined, '2026-11-31', '2026-1-1', 'not-a-day']) {
    await assert.rejects(list({ raceDate }), { code: 'RACE_LIST_DATE' });
  }
  assert.equal(calls, 0);
});

test('a full five-hundred-row page continues with the SDK legacy skip argument before committing', async () => {
  const first = Array.from({ length: 500 }, (_, index) => row(1, { id: `duplicate-${index}` }));
  const tail = row(2, { status: 'cancelled' });
  const calls = [];
  const list = createRaceListCache({ filterRaces: async (...args) => { calls.push(args); return args[3] === 0 ? first : [tail]; } });
  const races = await list({ raceDate: date, includeFinished: true });
  assert.deepEqual(calls, [[{ race_date: date }, '-deadline', 500, 0], [{ race_date: date }, '-deadline', 500, 500]]);
  assert.equal(races.length, 2); assert.equal(races[1].status, 'cancelled');
});

test('an exact full page requires a following empty page to prove completion', async () => {
  const calls = [];
  const list = createRaceListCache({ pageSize: 2, filterRaces: async (...args) => { calls.push(args[3]); return args[3] ? [] : [row(1), row(2)]; } });
  assert.equal((await list({ raceDate: date })).length, 2);
  assert.deepEqual(calls, [0, 2]);
});

test('a later page failure does not commit the prefix or replace a previous successful cache', async () => {
  const time = clock(); let mode = 'initial'; const calls = [];
  const failure = new Error('second page failed');
  const list = createRaceListCache({ ...time, pageSize: 2, filterRaces: async (_query, _sort, _limit, skip) => {
    calls.push(skip);
    if (mode === 'initial') return [row(1)];
    if (!skip) return [row(1), row(2)];
    if (mode === 'failed') throw failure;
    return [row(3)];
  } });
  const first = await list({ raceDate: date }); mode = 'failed';
  await assert.rejects(list({ raceDate: date, force: true }), error => error === failure);
  assert.deepEqual(await list({ raceDate: date }), first);
  mode = 'fixed';
  assert.equal((await list({ raceDate: date, force: true })).length, 3);
  assert.deepEqual(calls, [0, 0, 2, 0, 2]);
});

test('an ignored skip or page cap is an incomplete read, never a truncated success', async () => {
  const repeated = createRaceListCache({ pageSize: 2, filterRaces: async () => [row(1), row(2)] });
  await assert.rejects(repeated({ raceDate: date }), { code: 'RACE_LIST_INCOMPLETE' });
  const capped = createRaceListCache({ pageSize: 2, maxPages: 2, filterRaces: async (_query, _sort, _limit, skip) => [row(skip + 1), row(skip + 2)] });
  await assert.rejects(capped({ raceDate: date }), { code: 'RACE_LIST_INCOMPLETE' });
});

test('terminal rows outrank prediction completeness and confirmed results outrank cancellations', () => {
  const populated = row(1, { id: 'prediction', has_final: true, exhibition_ready: true, has_pre: true, updated_date: '2026-11-28T09:00:00Z' });
  const cancelled = row(1, { id: 'cancelled', status: 'cancelled', updated_date: '2026-11-28T08:00:00Z' });
  const finished = row(1, { id: 'finished', status: 'finished', updated_date: '2026-11-28T07:00:00Z' });
  for (const races of [[populated, cancelled], [cancelled, populated]]) assert.deepEqual(dedupeRacesForDisplay(races), [cancelled]);
  for (const races of [[populated, finished, cancelled], [cancelled, finished, populated]]) assert.deepEqual(dedupeRacesForDisplay(races), [finished]);
});

test('the freshest same-state row carries deadline corrections and postponement changes', () => {
  for (const status of ['scheduled', 'cancelled', 'finished']) {
    const old = row(1, { id: 'old', status, has_final: true, updated_date: '2026-11-28T15:00:00+09:00' });
    const fresh = row(1, { id: 'fresh', status, updated_date: '2026-11-28T06:01:00.000000', deadline: '2026-11-28T16:00:00+09:00', schedule_status: 'POSTPONED' });
    assert.deepEqual(dedupeRacesForDisplay([fresh, old]), [fresh]);
  }
  const first = row(1, { venue_code: '3', race_key: `${date}_3_1` });
  const second = row(1, { venue_code: '03', race_key: `${date}_03_01`, status: 'cancelled' });
  assert.deepEqual(dedupeRacesForDisplay([first, second]), [second]);
});

test('twenty-second timeout releases inflight; a late completion cannot overwrite the successful retry', async () => {
  assert.equal(RACE_LIST_TIMEOUT_MS, 20000);
  const time = clock(), late = deferred(); let calls = 0;
  const list = createRaceListCache({ ...time, filterRaces: async () => { calls++; return calls === 1 ? late.promise : [row(2)]; } });
  const pending = list({ raceDate: date }), other = list({ raceDate: date });
  const rejected = assert.rejects(pending, { code: 'RACE_LIST_TIMEOUT' });
  const otherRejected = assert.rejects(other, { code: 'RACE_LIST_TIMEOUT' });
  await flush(); time.tick(20000); await Promise.all([rejected, otherRejected]);
  assert.deepEqual(await list({ raceDate: date }), [row(2)]);
  late.resolve([row(1)]); await flush();
  assert.deepEqual(await list({ raceDate: date }), [row(2)]); assert.equal(calls, 2);
});

test('timed-out paging stops after its late page instead of starting more backend reads', async () => {
  const time = clock(), late = deferred(); let calls = 0;
  const list = createRaceListCache({ ...time, pageSize: 2, filterRaces: async () => { calls++; return late.promise; } });
  const rejected = assert.rejects(list({ raceDate: date }), { code: 'RACE_LIST_TIMEOUT' });
  await flush(); time.tick(20000); await rejected;
  late.resolve([row(1), row(2)]); await flush();
  assert.equal(calls, 1);
});

test('a queued rate-limit retry cannot send another request after the shared timeout', async () => {
  const time = clock(), delay = deferred(); let calls = 0;
  const list = createRaceListCache({ ...time, filterRaces: async () => { calls++; throw new Error('429'); },
    retry: async operation => { try { return await operation(); } catch { await delay.promise; return operation(); } } });
  const rejected = assert.rejects(list({ raceDate: date }), { code: 'RACE_LIST_TIMEOUT' });
  await flush(); time.tick(20000); await rejected;
  delay.resolve(); await flush();
  assert.equal(calls, 1);
});
