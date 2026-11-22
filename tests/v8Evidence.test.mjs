import test from 'node:test';
import assert from 'node:assert/strict';
import {buildExternalPrediction} from '../base44/shared/v8ExternalEvidence.js';
import {settleForecast, settleExternal} from '../base44/shared/v8Settlement.js';

const race = {id: 'race-1', race_key: '2026-11-23_01_01', race_date: '2026-11-23', venue_code: '01', venue_name: '桐生', race_number: 1,
  deadline: '2026-11-23T15:00:00+09:00', status: 'scheduled', exhibition_ready: false};
const entries = Array.from({length: 6}, (_, index) => ({id: 'entry-' + index, race_id: race.id, boat_number: index + 1}));
const tickets = ['1-2-3', '1-2-4', '1-2-5', '1-2-6', '1-3-2', '1-3-4', '1-3-5', '1-3-6'];
const input = {race_id: race.id, source_name: '提供元', forecaster_name: '予想者', source_type: 'TRACK_TIPSTER', stage: 'PRE',
  published_at: '2026-11-23T05:00:00Z', source_url: 'https://example.test/prediction', tickets, stake_per_ticket: 100,
  reason_tags: ['イン評価'], permission_confirmed: true};
const current = '2026-11-23T05:30:00Z';
const external = (overrides = {}, context = {}) => buildExternalPrediction({input: {...input, ...overrides}, race, entries, now: current, recordedBy: 'admin-1', ...context});
const forecast = {id: 'forecast-1', revision: 'V8_FORECAST_1', ...race, id: 'forecast-1', race_id: race.id, stage: 'FINAL',
  generated_at: '2026-11-23T05:50:00Z', created_date: '2026-11-23T05:50:00.100Z', input_as_of: '2026-11-23T05:49:00Z',
  research_tickets: tickets, decision: {status: 'BUY', tickets}, top_scenario_key: 'escape1',
  scenarios: [{key: 'escape1', leader: 1, method: 'ESCAPE'}]};
const result = {id: 'result-1', race_id: race.id, result_status: 'RESULT_FINAL', is_finished: true,
  result_trifecta: '1-2-3', payout: 2800, source: 'LOCAL', finished_at: '2026-11-23T06:02:00Z', winning_method: '逃げ'};
const provenance = {id: 'proof-1', evidence_type: 'LIVE', race_id: race.id, race_key: race.race_key, result_id: result.id,
  result_trifecta: result.result_trifecta, source: 'LOCAL', fetched_at: '2026-11-23T06:03:00Z',
  recorded_at: '2026-11-23T06:03:00.100Z', created_date: '2026-11-23T06:03:00.200Z'};
const now = '2026-11-23T06:10:00Z';
const settle = (overrides = {}) => settleForecast({forecast, result, provenance, now, ...overrides});

test('manual evidence records server time and private/unverified scope', async () => {
  const out = await external();
  assert.equal(out.ok, true);
  assert.equal(out.record.evidence_type, 'MANUAL_BEFORE_DEADLINE');
  assert.equal(out.record.verification_eligible, true);
  assert.equal(out.record.recorded_at, new Date(current).toISOString());
  assert.equal(out.record.publisher_verified, false);
  assert.equal(out.record.use_scope, 'PRIVATE_RESEARCH');
});
test('DAY_BEFORE is eligible only when actually recorded on previous JST day', async () => {
  const item = {stage: 'DAY_BEFORE', published_at: '2026-11-22T09:00:00Z'};
  assert.equal((await external(item, {now: '2026-11-22T10:00:00Z'})).record.verification_eligible, true);
  const late = await external(item);
  assert.equal(late.record.evidence_type, 'HISTORICAL');
  assert.ok(late.record.ineligibility_reasons.includes('NOT_RECORDED_ON_PREVIOUS_DAY'));
});
test('at cutoff and after race are historical, never backdated', async () => {
  for (const when of ['2026-11-23T05:59:00Z', '2026-11-23T06:10:00Z']) {
    const out = await external({}, {now: when});
    assert.equal(out.record.verification_eligible, false);
    assert.equal(out.record.recorded_at, new Date(when).toISOString());
  }
});
test('PRE with even one F exhibition ST is explicitly ineligible', async () => {
  const mixed = entries.map((e, i) => i === 3 ? {...e, exhibition_st: -0.05} : e);
  const out = await external({}, {entries: mixed});
  assert.equal(out.record.verification_eligible, false);
  assert.ok(out.record.ineligibility_reasons.includes('EXHIBITION_ALREADY_OBSERVED'));
});
test('PRE requires six identities and readable pre-exhibition entries', async () => {
  assert.equal((await external({}, {entries: []})).record.verification_eligible, false);
  assert.equal((await external({}, {entries: [...entries.slice(0, 5), entries[0]]})).record.verification_eligible, false);
});
test('future/after-deadline publication, duplicate tickets and invalid permission rejected', async () => {
  assert.equal((await external({published_at: '2026-11-23T05:31:00Z'})).reason, 'INVALID_PUBLICATION_TIME');
  assert.equal((await external({published_at: '2026-11-23T06:01:00Z'}, {now})).reason, 'INVALID_PUBLICATION_TIME');
  assert.equal((await external({tickets: ['1-2-3', '1-2-3']})).reason, 'INVALID_OR_DUPLICATE_TICKETS');
  assert.equal((await external({tickets: ['1-1-2']})).reason, 'INVALID_OR_DUPLICATE_TICKETS');
  assert.equal((await external({permission_confirmed: false})).reason, 'PRIVATE_RESEARCH_PERMISSION_REQUIRED');
});
test('URLs cannot execute script or contain credentials', async () => {
  for (const source_url of ['javascript:alert(1)', 'https://user:secret@example.test/', 'not-a-url'])
    assert.equal((await external({source_url})).reason, 'INVALID_SOURCE_URL');
});
test('stake and fee must be explicit valid yen amounts', async () => {
  for (const stake_per_ticket of [0, 101, -100, 100000, '100'])
    assert.equal((await external({stake_per_ticket})).reason, 'INVALID_STAKE');
  assert.equal((await external({information_fee: -1})).reason, 'INVALID_INFORMATION_FEE');
});
test('reordered tickets create the same idempotency key', async () => {
  const first = await external();
  const second = await external({tickets: [...tickets].reverse(), source_name: ' 提供元 '});
  assert.equal(first.record.record_key, second.record.record_key);
});
test('settlement charges all eight tickets and uses 100-yen unit payout', () => {
  const out = settle();
  assert.equal(out.ok, true);
  assert.equal(out.record.research_stake, 800);
  assert.equal(out.record.research_return, 2800);
  assert.equal(out.record.buy_stake, 800);
  assert.equal(out.record.buy_return, 2800);
  assert.equal(out.record.net_return, 2000);
  assert.equal(out.record.winning_method_hit, true);
});
test('miss charges the same stake with zero return', () => {
  const altered = {...result, result_trifecta: '6-5-4'};
  const out = settle({result: altered, provenance: {...provenance, result_trifecta: altered.result_trifecta}});
  assert.equal(out.record.research_stake, 800);
  assert.equal(out.record.research_return, 0);
  assert.equal(out.record.net_return, -800);
  assert.equal(out.record.scenario_leader_hit, false);
});
test('a non-BUY decision is verified but does not create BUY investment', () => {
  const out = settle({forecast: {...forecast, decision: {status: 'WATCH', tickets}}});
  assert.equal(out.record.buy_selected, false);
  assert.equal(out.record.buy_stake, 0);
  assert.equal(out.record.buy_return, 0);
});
test('late persistence cannot count as a prospective forecast', () => {
  assert.equal(settle({forecast: {...forecast, created_date: '2026-11-23T05:59:00Z'}}).reason, 'SOURCE_NOT_SAVED_BEFORE_CUTOFF');
  assert.equal(settle({forecast: {...forecast, input_as_of: '2026-11-23T05:51:00Z'}}).reason, 'INPUT_AFTER_GENERATION');
});
test('missing, backfill or mismatched result proof never settles', () => {
  assert.equal(settle({provenance: null}).reason, 'LIVE_RESULT_PROVENANCE_REQUIRED');
  assert.equal(settle({provenance: {...provenance, evidence_type: 'BACKFILL'}}).reason, 'LIVE_RESULT_PROVENANCE_REQUIRED');
  assert.equal(settle({provenance: {...provenance, result_id: 'wrong-result'}}).reason, 'RESULT_PROVENANCE_MISMATCH');
  assert.equal(settle({provenance: {...provenance, race_key: 'different-race'}}).reason, 'RESULT_PROVENANCE_MISMATCH');
});
test('future or pre-race result fetch timestamps are rejected', () => {
  assert.equal(settle({provenance: {...provenance, fetched_at: '2026-11-23T06:11:00Z'}}).reason, 'RESULT_TIME_ORDER_INVALID');
  assert.equal(settle({provenance: {...provenance, fetched_at: '2026-11-23T05:59:00Z'}}).reason, 'RESULT_TIME_ORDER_INVALID');
});
test('finished_at may be a processing stamp after fetch without rejecting genuine LIVE evidence', () => {
  const fetched = '2026-11-23T06:03:35.922Z';
  const out = settle({
    result: {...result, finished_at: '2026-11-23T06:03:35.991Z'},
    provenance: {...provenance, fetched_at: fetched, recorded_at: '2026-11-23T06:03:36.243Z', created_date: '2026-11-23T06:03:36.381Z'},
  });
  assert.equal(out.ok, true);
  assert.equal(out.record.provenance.result_fetched_at, fetched);
  assert.equal(settle({result: {...result, finished_at: '2026-11-23T05:59:59Z'}}).reason, 'RESULT_TIME_ORDER_INVALID');
});
test('result sources must match the supported official acquisition sources', () => {
  for (const source of ['BOATCAST', 'LOCAL', 'TXT'])
    assert.equal(settle({result: {...result, source}, provenance: {...provenance, source}}).ok, true);
  assert.equal(settle({result: {...result, source: 'UNKNOWN'}, provenance: {...provenance, source: 'UNKNOWN'}}).reason, 'RESULT_SOURCE_UNSUPPORTED');
});
test('conflicting final payouts or combos hold verification', () => {
  assert.equal(settle({result: [result, {...result, id: 'result-2', payout: 2810}]}).reason, 'CONFLICTING_FINAL_RESULTS');
  assert.equal(settle({result: [result, {...result, id: 'result-2', result_trifecta: '1-3-2'}]}).reason, 'CONFLICTING_FINAL_RESULTS');
});
test('identical final rows select the exact attested result, not the array order', () => {
  const unprovenCopy = {...result, id: 'result-copy'};
  const out = settle({result: [unprovenCopy, result]});
  assert.equal(out.ok, true);
  assert.equal(out.record.result_id, result.id);
  assert.equal(settle({result: {...result, result_status: 'FINAL'}}).ok, true);
  assert.equal(settle({result: {...result, result_status: 'RESULT_WAITING'}}).reason, 'RESULT_NOT_FINAL');
});
test('refund or cancelled races do not become losses or wins', () => {
  assert.equal(settle({result: {...result, refund_boats: [6]}}).reason, 'REFUND_OR_CANCELLATION_REQUIRES_REVIEW');
  assert.equal(settle({result: {...result, boats: [{boat_number: 6, rank: 'F'}]}}).reason, 'REFUND_OR_CANCELLATION_REQUIRES_REVIEW');
  assert.equal(settle({result: {...result, result_status: 'CANCELLED'}}).reason, 'REFUND_OR_CANCELLATION_REQUIRES_REVIEW');
  for (const boat of [{boat_number: 6, f_flag: 'F'}, {boat_number: 6, f_flag: true}, {boat_number: 6, finish_order: 'L'}, {boat_number: 6, result_status: '欠場'}])
    assert.equal(settle({result: {...result, boats: [boat]}}).reason, 'REFUND_OR_CANCELLATION_REQUIRES_REVIEW');
});
test('winner alone does not establish a winning method', () => {
  const out = settle({result: {...result, winning_method: null}});
  assert.equal(out.record.scenario_leader_hit, true);
  assert.equal(out.record.winning_method_hit, null);
  assert.equal(settle({result: {...result, winning_method: '差し'}}).record.winning_method_hit, false);
});
test('external stake amounts scale payouts and fees are separate', async () => {
  const out = await external({stage: 'FINAL', tickets: tickets.slice(0, 4), stake_per_ticket: 200, information_fee: 150});
  const stored = {...out.record, id: 'external-1', created_date: '2026-11-23T05:30:00.100Z'};
  const settled = settleExternal({external: stored, result, provenance, now});
  assert.equal(settled.ok, true);
  assert.equal(settled.record.research_stake, 800);
  assert.equal(settled.record.research_return, 5600);
  assert.equal(settled.record.information_fee, 150);
  assert.equal(settled.record.net_return, 4650);
  assert.equal(settled.record.buy_selected, false);
});
test('external historical rows are excluded even when claimed publication is earlier', async () => {
  const out = await external({stage: 'FINAL'});
  const stored = {...out.record, id: 'external-1', created_date: '2026-11-23T05:30:00.100Z', evidence_type: 'HISTORICAL', verification_eligible: false};
  assert.equal(settleExternal({external: stored, result, provenance, now}).reason, 'HISTORICAL_EXTERNAL_EXCLUDED');
});
test('DAY_BEFORE created on race day is rejected even if generated the previous day', () => {
  const changed = {...forecast, stage: 'DAY_BEFORE', generated_at: '2026-11-22T10:00:00Z', input_as_of: '2026-11-22T09:59:00Z'};
  assert.equal(settle({forecast: changed}).reason, 'DAY_BEFORE_NOT_SAVED_PREVIOUS_DAY');
});
test('partial results and invalid recorded tickets do not produce settlement', () => {
  assert.equal(settle({result: {...result, result_status: 'RESULT_PARTIAL'}}).reason, 'RESULT_NOT_FINAL');
  assert.equal(settle({forecast: {...forecast, research_tickets: ['1-2-3', '1-2-3']}}).reason, 'INVALID_RESEARCH_TICKETS');
});
test('settlement leaves source and result records immutable', () => {
  const before = JSON.stringify({forecast, result, provenance});
  settle();
  assert.equal(JSON.stringify({forecast, result, provenance}), before);
});
