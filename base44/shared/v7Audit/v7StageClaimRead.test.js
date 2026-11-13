// Offline unit tests: in-memory entity doubles only, no SDK, secrets or network.
import { inspectStageClaims } from './v7StageClaimRead.js';
import { saveV7Predictions } from '../v7PredictionStore.js';

const NOW = Date.parse('2099-01-01T00:00:00Z');
const race = { id: 'fixture-race', race_key: '2099-01-01_01_01', status: 'scheduled', deadline: '2099-01-01T01:00:00Z' };
const claim = (stage = 'PRE', id = stage) => ({ id, claim_key: `${race.race_key}::${stage}`, race_key: race.race_key, stage, state: 'free' });
const page = items => ({ items, has_more: false, next_cursor: null });
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
const reader = filter => new Proxy({ V7StageClaim: new Proxy({ filter }, {
  get(target, key) { if (!(key in target)) throw new Error(`Forbidden claim operation: ${String(key)}`); return target[key]; },
}) }, { get(target, key) { if (!(key in target)) throw new Error(`Forbidden entity: ${String(key)}`); return target[key]; } });

Deno.test('generation inspection never creates, updates, deletes or acquires a lock', async () => {
  const report = await inspectStageClaims(reader(async () => page([])), [race], { nowMs: NOW, allowCreate: true });
  assert(report.ready === 0 && report.missing.length === 2 && !report.all_ready);
  assert(report.created === 0 && report.creation_unconfirmed === 0 && report.uniqueness_guaranteed === false);
});

Deno.test('exactly one matching existing row per stage is observed as prepared', async () => {
  const report = await inspectStageClaims(reader(async () => page([claim('PRE'), claim('FINAL')])), [race], { nowMs: NOW });
  assert(report.ready === 2 && report.all_ready && report.read_complete);
  assert(report.uniqueness_guaranteed === false, 'Observation must not become a uniqueness guarantee');
});

Deno.test('a duplicate on a later page stops that stage without selecting a representative', async () => {
  const report = await inspectStageClaims(reader(async (_query, options) => options.cursor
    ? page([claim('PRE', 'second')])
    : { items: [claim('PRE', 'first'), claim('FINAL')], has_more: true, next_cursor: 'page-2' }), [race], { nowMs: NOW });
  assert(report.duplicate.includes(`${race.race_key}::PRE`));
  assert(!report.readyPairs.has(`${race.race_key}::PRE`) && report.ready === 1 && !report.all_ready);
});

Deno.test('an incomplete page cannot be interpreted as singleton or absence', async () => {
  const report = await inspectStageClaims(reader(async () => ({ items: [claim()], has_more: true })), [race], { nowMs: NOW });
  assert(!report.read_complete && report.ready === 0 && report.readyPairs.size === 0);
  assert(report.missing.length === 0 && !report.all_ready);
});

Deno.test('a read failure is fail-closed without any write fallback', async () => {
  const report = await inspectStageClaims(reader(async () => { throw new Error('fixture read failure'); }), [race], { nowMs: NOW });
  assert(!report.read_complete && !report.all_ready && !report.readyPairs.size);
});

Deno.test('a one-row claim with the wrong race or state is not prepared', async () => {
  for (const bad of [{ ...claim(), race_key: 'different-race' }, { ...claim(), stage: 'FINAL' }, { ...claim(), state: 'invalid' }]) {
    const report = await inspectStageClaims(reader(async () => page([bad, claim('FINAL')])), [race], { nowMs: NOW });
    assert(report.invalid.includes(`${race.race_key}::PRE`) && !report.all_ready);
  }
});

Deno.test('out-of-scope rows are an incomplete read, not usable claims', async () => {
  const report = await inspectStageClaims(reader(async () => page([{ ...claim(), claim_key: 'other-key' }])), [race], { nowMs: NOW });
  assert(!report.read_complete && !report.readyPairs.size);
});

Deno.test('closed, expired or timezone-unknown races never require or create slots', async () => {
  let reads = 0;
  const sr = reader(async () => { reads++; return page([]); });
  const report = await inspectStageClaims(sr, [
    { ...race, status: 'finished' }, { ...race, status: 'cancelled' },
    { ...race, deadline: '2098-12-31T23:59:00Z' }, { ...race, deadline: '2099-01-01T01:00:00' },
  ], { nowMs: NOW });
  assert(report.expected === 0 && reads === 0 && report.created === 0);
});

Deno.test('repeated race rows do not multiply expected stage keys', async () => {
  const report = await inspectStageClaims(reader(async () => page([claim('PRE'), claim('FINAL')])), [race, race], { nowMs: NOW });
  assert(report.expected === 2 && report.ready === 2);
});

for (const [name, filter] of [
  ['missing', async () => page([])],
  ['duplicate', async () => page([claim('PRE', 'one'), claim('PRE', 'two')])],
  ['read unavailable', async () => { throw new Error('unavailable'); }],
]) {
  Deno.test(`existing save path makes no writes when claim is ${name}`, async () => {
    const client = { asServiceRole: { entities: reader(filter) } };
    const result = await saveV7Predictions(client, [{
      race_key: race.race_key, stage: 'PRE', record_hash: 'offline-fixture', model: 'OPEN',
      plans: { hit_4: { tickets: ['1-2-3'], probability: 0.2, judgment: 'WATCH' } },
    }]);
    assert(result.saved === 0 && result.reasons.claim_unconfirmed === 1 && result.handled_hashes.length === 0);
  });
}