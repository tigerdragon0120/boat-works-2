// Offline unit tests: no Base44 client is constructed and no live function is invoked.
import { provisionStageClaims } from './v7StageClaimProvision.js';

const NOW = Date.parse('2099-01-01T00:00:00Z');
const race = { id: 'fixture-race', race_key: '2099-01-01_01_01', status: 'scheduled', deadline: '2099-01-01T01:00:00Z' };
const claim = (stage = 'PRE', id = stage) => ({ id, claim_key: `${race.race_key}::${stage}`, race_key: race.race_key, stage, state: 'free' });
const page = items => ({ items: structuredClone(items), has_more: false, next_cursor: null });
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
const options = { nowMs: NOW, allowCreate: true, singleWriterConfirmed: true };

function fixture(initial = [], behavior = {}) {
  const state = { rows: structuredClone(initial), creates: 0, reads: 0, active: 0, peak: 0 };
  const entity = {
    async filter(query) {
      state.reads++;
      if (behavior.read) return behavior.read(state, query);
      return page(state.rows.filter(row => query.claim_key.$in.includes(row.claim_key)));
    },
    async create(doc) {
      const sequence = ++state.creates;
      state.active++; state.peak = Math.max(state.peak, state.active);
      await Promise.resolve();
      try {
        if (behavior.create) return await behavior.create(state, doc);
        const row = { ...doc, id: `fixture-${sequence}` };
        state.rows.push(row);
        return row;
      } finally { state.active--; }
    },
  };
  const sr = new Proxy({ V7StageClaim: new Proxy(entity, {
    get(target, key) { if (!(key in target)) throw new Error(`Forbidden operation ${String(key)}`); return target[key]; },
  }) }, { get(target, key) { if (!(key in target)) throw new Error(`Forbidden entity ${String(key)}`); return target[key]; } });
  return { sr, state };
}

Deno.test('administrator preparation defaults to read-only', async () => {
  const { sr, state } = fixture();
  const report = await provisionStageClaims(sr, [race], { nowMs: NOW });
  assert(state.creates === 0 && report.mode === 'READ_ONLY' && !report.all_ready);
});

Deno.test('creation requires explicit external single-writer acknowledgement before any work', async () => {
  const { sr, state } = fixture();
  let rejected = false;
  try { await provisionStageClaims(sr, [race], { nowMs: NOW, allowCreate: true }); }
  catch (error) { rejected = error.message === 'SINGLE_ADMIN_RUN_REQUIRED'; }
  assert(rejected && state.creates === 0 && state.reads === 0);
});

Deno.test('sequential preparation confirms each row, never mutates existing records, and rerun creates none', async () => {
  const old = claim('PRE');
  const { sr, state } = fixture([old]);
  const report = await provisionStageClaims(sr, [race], options);
  assert(report.all_ready && report.created === 1 && state.creates === 1 && state.peak === 1);
  assert(report.uniqueness_guaranteed === false && JSON.stringify(state.rows[0]) === JSON.stringify(old));
  const again = await provisionStageClaims(sr, [race], options);
  assert(again.all_ready && again.created === 0 && state.creates === 1);
});

Deno.test('an existing duplicate stops all new preparation without deletion or representative choice', async () => {
  const { sr, state } = fixture([claim('PRE', 'one'), claim('PRE', 'two')]);
  const report = await provisionStageClaims(sr, [race], options);
  assert(report.stopped_reason === 'CLAIM_DUPLICATE' && !report.all_ready && state.creates === 0 && state.rows.length === 2);
});

Deno.test('create success with invisible persisted rows is unconfirmed and is never retried', async () => {
  const { sr, state } = fixture([], { read: async () => page([]) });
  const report = await provisionStageClaims(sr, [race], options);
  assert(state.creates === 1 && report.creation_unconfirmed === 1 && report.stopped_reason === 'CLAIM_MISSING' && !report.all_ready);
});

Deno.test('lost create response with a visible singleton is observed without repeating the create', async () => {
  const { sr, state } = fixture([], { create: async (state, doc) => {
    state.rows.push({ ...doc, id: `committed-${state.creates}` });
    throw new Error('response lost after commit');
  } });
  const report = await provisionStageClaims(sr, [race], options);
  assert(report.all_ready && state.creates === 2 && report.creation_unconfirmed === 0);
  assert(report.uniqueness_guaranteed === false);
});

Deno.test('a duplicate after create stops the remaining keys and is never cleaned up', async () => {
  const { sr, state } = fixture([], { create: async (state, doc) => {
    state.rows.push({ ...doc, id: 'concurrent-one' }, { ...doc, id: 'concurrent-two' });
    return state.rows[0];
  } });
  const report = await provisionStageClaims(sr, [race], options);
  assert(state.creates === 1 && state.rows.length === 2 && report.stopped_reason === 'CLAIM_DUPLICATE' && !report.all_ready);
});

Deno.test('read failure after an attempted create stops without automatic replay', async () => {
  const { sr, state } = fixture([], { read: async state => {
    if (state.creates) throw new Error('read unavailable');
    return page([]);
  } });
  const report = await provisionStageClaims(sr, [race], options);
  assert(state.creates === 1 && !report.read_complete && report.creation_unconfirmed === 1);
  assert(report.stopped_reason === 'CLAIM_READ_INCOMPLETE' && !report.all_ready);
});

Deno.test('bounded manual batches run sequentially and require an explicit next invocation', async () => {
  const races = Array.from({ length: 11 }, (_, i) => ({ ...race, race_key: `2099-01-01_01_${String(i + 1).padStart(2, '0')}` }));
  const { sr, state } = fixture();
  const report = await provisionStageClaims(sr, races, options);
  assert(state.creates === 20 && state.peak === 1 && report.manual_resume_required && !report.all_ready);
  const next = await provisionStageClaims(sr, races, options);
  assert(state.creates === 22 && state.peak === 1 && next.all_ready);
});

Deno.test('two administrators can still race: expose duplicates, do not claim uniqueness', async () => {
  let initialReads = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const { sr, state } = fixture([], { read: async (state, query) => {
    const snapshot = state.rows.filter(row => query.claim_key.$in.includes(row.claim_key));
    if (initialReads < 2) {
      initialReads++;
      if (initialReads === 2) release();
      await bothStarted;
    }
    return page(snapshot);
  } });
  const results = await Promise.all([
    provisionStageClaims(sr, [race], options), provisionStageClaims(sr, [race], options),
  ]);
  assert(state.rows.length === 2, 'The fixture must reproduce initial creation racing');
  assert(results.every(report => !report.all_ready && report.duplicate.length === 1 && report.uniqueness_guaranteed === false));
});