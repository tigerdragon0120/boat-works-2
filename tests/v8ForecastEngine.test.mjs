import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRaceForecast, FORECAST_REVISION } from '../base44/shared/v8ForecastEngine.js';

const race = {
  id: 'race-1', race_key: '2026-11-22_01_08', race_date: '2026-11-22',
  venue_code: '01', venue_name: '桐生', race_number: 8,
  deadline: '2026-11-22T14:00:00+09:00', status: 'scheduled',
  updated_date: '2026-11-21T09:00:00.000Z', is_womens: false,
};
const entries = Array.from({ length: 6 }, (_, index) => ({
  id: 'entry-' + (index + 1), race_id: race.id, race_key: race.race_key,
  race_date: race.race_date, boat_number: index + 1,
  registration_number: String(4501 + index), player_name: '試験選手' + index,
  national_win_rate: index === 0 ? 8.2 : 5.5 - index * .1,
  national_2rate: index === 0 ? 60 : 32 - index,
  local_win_rate: index === 0 ? 8 : 5.3,
  avg_st: index === 0 ? .12 : .17 + index * .01,
  motor_f2_rate: index === 0 ? 60 : 35,
  section_finishes: index === 0 ? '1-2-1' : '3-4-3',
  updated_date: '2026-11-21T09:00:00.000Z',
}));
const finalEntries = () => entries.map((entry, index) => ({
  ...entry, updated_date: '2026-11-22T04:35:00.000Z',
  exhibition_course: index + 1, exhibition_st: index === 0 ? .09 : .15 + index * .01,
  exhibition_time: index === 0 ? 6.65 : 6.78 + index * .01,
}));
const preNow = '2026-11-22T04:00:00.000Z';
const finalNow = '2026-11-22T04:40:00.000Z';
const baseline = () => ({
  ...buildRaceForecast({ race, entries, stage: 'PRE', now: preNow }).record,
  id: 'forecast-pre', created_date: '2026-11-22T04:00:00.100Z',
});
const ticketSet = ['1-2-3', '1-2-4', '1-2-5', '1-2-6', '1-3-2', '1-3-4', '1-3-5', '1-3-6'];
const pricing = (id, at, amount = 20) => ({
  id, race_id: race.id, stage: 'FINAL', captured_at: at, created_date: at,
  odds_map: Object.fromEntries(ticketSet.map(ticket => [ticket, amount])),
});
const prediction = () => ({
  id: 'v7-final', race_id: race.id, race_key: race.race_key,
  stage: 'FINAL', source: 'SERVER', record_hash: 'server:' + race.race_key + ':FINAL',
  generated_at: '2026-11-22T04:35:00.000Z', created_date: '2026-11-22T04:35:00.100Z',
  plans: { hit_8: { tickets: ticketSet, judgment: 'BUY' } },
  pricing_snapshot: pricing('odds-original', '2026-11-22T04:34:30.000Z'),
});
const finalArgs = () => ({
  race, entries: finalEntries(), stage: 'FINAL', now: finalNow, baseline: baseline(),
  prediction: prediction(), odds: pricing('odds-current', '2026-11-22T04:39:00.000Z', 21),
});

test('previous-day forecast uses actual JST observation date and never backfills a previous-day label', () => {
  const prior = buildRaceForecast({ race, entries, stage: 'DAY_BEFORE', now: '2026-11-21T10:00:00Z' });
  assert.equal(prior.ok, true);
  assert.equal(prior.record.stage, 'DAY_BEFORE');
  assert.equal(prior.record.forecast_key, FORECAST_REVISION + ':' + race.race_key + ':DAY_BEFORE');
  assert.equal(buildRaceForecast({ race, entries, stage: 'DAY_BEFORE', now: preNow }).reason, 'STAGE_DATE_MISMATCH');
  assert.equal(buildRaceForecast({ race, entries, stage: 'PRE', now: '2026-11-21T10:00:00Z' }).reason, 'STAGE_DATE_MISMATCH');
});
test('DAY_BEFORE scoring and persisted inputs exclude exhibition, current weather, odds and prediction', () => {
  const args = { race, entries, stage: 'DAY_BEFORE', now: '2026-11-21T10:00:00Z' };
  const original = buildRaceForecast(args).record;
  const contaminated = buildRaceForecast({
    ...args, race: { ...race, wind_speed: 20, wave_height: 50 },
    entries: entries.map(entry => ({ ...entry, exhibition_time: 4.1, exhibition_st: -.8, exhibition_course: 7 - entry.boat_number })),
    prediction: prediction(), odds: pricing('future', finalNow, 99999),
    weather: { race_id: race.id, kind: 'RESULT_ACTUAL', wind_speed: 40, observed_at: finalNow },
  }).record;
  assert.deepEqual(contaminated.scenarios, original.scenarios);
  assert.deepEqual(contaminated.research_tickets, original.research_tickets);
  assert.equal(contaminated.boats[0].exhibition_time, null);
  assert.equal(contaminated.boats[0].observed_course, null);
  assert.equal(contaminated.decision.status, 'WATCH');
  assert.deepEqual(contaminated.decision.odds, {});
  assert.equal(contaminated.conditions.wind_speed, null);
});
test('PRE rejects partial exhibition even when exhibition_ready flag is false', () => {
  const partial = entries.map((entry, index) => index === 5 ? { ...entry, exhibition_st: .11 } : entry);
  assert.equal(buildRaceForecast({ race, entries: partial, stage: 'PRE', now: preNow }).reason, 'EXHIBITION_ALREADY_AVAILABLE');
  assert.equal(buildRaceForecast({ race: { ...race, exhibition_ready: true }, entries, stage: 'PRE', now: preNow }).reason, 'EXHIBITION_ALREADY_AVAILABLE');
});
test('source chronology and unique race/boat/racer identities are required', () => {
  const args = { race, entries, stage: 'PRE', now: preNow };
  assert.equal(buildRaceForecast({ ...args, race: { ...race, updated_date: finalNow } }).reason, 'RACE_SOURCE_TIME_INVALID');
  assert.equal(buildRaceForecast({ ...args, entries: entries.map((entry, index) => index === 0 ? { ...entry, updated_date: finalNow } : entry) }).reason, 'ENTRY_SOURCE_TIME_INVALID');
  assert.equal(buildRaceForecast({ ...args, entries: [entries[0], entries[0], ...entries.slice(2)] }).reason, 'INVALID_BOATS');
  assert.equal(buildRaceForecast({ ...args, entries: entries.map(entry => ({ ...entry, registration_number: '4500' })) }).reason, 'ENTRY_IDENTITY_INVALID');
  assert.equal(buildRaceForecast({ ...args, entries: entries.map(entry => ({ ...entry, race_id: 'other-race' })) }).reason, 'ENTRY_RACE_MISMATCH');
  assert.equal(buildRaceForecast({ ...args, race: { ...race, race_number: 9 } }).reason, 'RACE_IDENTITY_MISMATCH');
});
test('no forecasting is permitted at the safety cutoff or after closure', () => {
  assert.equal(buildRaceForecast({ ...finalArgs(), now: '2026-11-22T04:59:00Z' }).ok, false);
  assert.equal(buildRaceForecast({ ...finalArgs(), race: { ...race, status: 'finished' } }).ok, false);
});
test('missing stats stay null and cannot produce invented confidence or a BUY', () => {
  const bare = entries.map(entry => ({
    id: entry.id, race_id: entry.race_id, boat_number: entry.boat_number,
    registration_number: entry.registration_number, updated_date: entry.updated_date,
    national_win_rate: null, avg_st: '', motor_f2_rate: null,
  }));
  const result = buildRaceForecast({ race, entries: bare, stage: 'PRE', now: preNow }).record;
  assert.equal(result.boats[0].national_win_rate, null);
  assert.equal(result.boats[0].base_score, null);
  assert.equal(result.quality, 'PARTIAL');
  assert.deepEqual(result.scenarios, []);
  assert.deepEqual(result.research_tickets, []);
  assert.equal(result.decision.status, 'WAIT');
  assert.equal(JSON.stringify(result).includes('"probability"'), false);
  assert.equal(JSON.stringify(result).includes('"expectedRecovery"'), false);
});
test('exhibition F is not rewarded as a fast start', () => {
  const args = finalArgs();
  const normal = buildRaceForecast(args).record;
  const flying = buildRaceForecast({
    ...args, entries: args.entries.map((entry, index) => index === 0 ? { ...entry, exhibition_st_raw: 'F.03' } : entry),
  }).record;
  assert.equal(flying.boats[0].exhibition_flying, true);
  assert.equal(flying.boats[0].exhibition_st, -.03);
  assert.equal(flying.boats[0].exhibition_start_score, 0);
  assert.ok(flying.boats[0].score < normal.boats[0].score);
});
test('FINAL uses the immutable baseline and reports observed course changes explicitly', () => {
  const args = finalArgs(), original = JSON.stringify(args.baseline);
  const result = buildRaceForecast({
    ...args, entries: args.entries.map(entry => ({ ...entry, exhibition_course: entry.boat_number === 1 ? 2 : entry.boat_number === 2 ? 1 : entry.boat_number })),
  }).record;
  assert.equal(result.boats[0].expected_course, 1);
  assert.equal(result.boats[0].observed_course, 2);
  assert.equal(result.comparison.baseline_id, 'forecast-pre');
  assert.equal(result.comparison.entry_changed, true);
  assert.equal(result.comparison.status, 'CHANGED');
  assert.equal(JSON.stringify(args.baseline), original);
});
test('partial exhibition cannot produce BUY, and duplicate observed courses are not filled with frame numbers', () => {
  const args = finalArgs();
  const partial = buildRaceForecast({ ...args, entries: args.entries.map((entry, index) => index === 5 ? { ...entry, exhibition_course: null } : entry) }).record;
  assert.equal(partial.exhibition_complete, false);
  assert.equal(partial.boats[5].observed_course, null);
  assert.equal(partial.decision.status, 'WAIT');
  const duplicate = buildRaceForecast({ ...args, entries: args.entries.map(entry => ({ ...entry, exhibition_course: 1 })) }).record;
  assert.equal(duplicate.decision.status, 'WAIT');
});
test('research BUY requires stored prior hypothesis, existing server BUY and preserved current price conditions', () => {
  const record = buildRaceForecast(finalArgs()).record;
  assert.equal(record.decision.status, 'BUY');
  assert.equal(record.decision.research_only, true);
  assert.equal(record.decision.source_prediction_id, 'v7-final');
  assert.equal(record.decision.reference_odds_id, 'odds-original');
  assert.equal(record.decision.reference_price_basis, 'LATEST_AVAILABLE_AT_PREDICTION_TIME_NOT_PROVEN_INPUT');
  assert.equal(Object.hasOwn(record.decision, 'original_odds_id'), false);
  assert.equal(record.decision.odds_snapshot_id, 'odds-current');
  assert.equal(record.decision.price_checked, true);
  assert.equal(record.decision.valid_until, '2026-11-22T04:44:00.000Z');
  assert.equal(buildRaceForecast({ ...finalArgs(), baseline: null }).record.decision.status, 'WAIT');
  const unsigned = prediction(); unsigned.source = 'BROWSER';
  assert.equal(buildRaceForecast({ ...finalArgs(), prediction: unsigned }).record.decision.status, 'WAIT');
  const skip = prediction(); skip.plans.hit_8.judgment = 'SKIP';
  assert.equal(buildRaceForecast({ ...finalArgs(), prediction: skip }).record.decision.status, 'SKIP');
});
test('freshness, missing quotes and historical-price provenance fail closed', () => {
  const args = finalArgs();
  assert.equal(buildRaceForecast({ ...args, odds: pricing('stale', '2026-11-22T04:34:59Z') }).record.decision.status, 'WAIT');
  assert.equal(buildRaceForecast({ ...args, odds: pricing('future', '2026-11-22T04:41:00Z') }).record.decision.status, 'WAIT');
  const noPrices = prediction(); delete noPrices.pricing_snapshot;
  assert.equal(buildRaceForecast({ ...args, prediction: noPrices }).record.decision.status, 'WATCH');
  const wrongSource = prediction(); wrongSource.pricing_snapshot.race_id = 'other';
  assert.equal(buildRaceForecast({ ...args, prediction: wrongSource }).record.decision.status, 'WATCH');
  const hindsight = prediction(); hindsight.pricing_snapshot.captured_at = '2026-11-22T04:36:00Z';
  assert.equal(buildRaceForecast({ ...args, prediction: hindsight }).record.decision.status, 'WATCH');
  const laterInserted = prediction(); laterInserted.pricing_snapshot.created_date = '2026-11-22T04:36:00Z';
  assert.equal(buildRaceForecast({ ...args, prediction: laterInserted }).record.decision.status, 'WATCH');
  assert.equal(buildRaceForecast({ ...args, odds: pricing('down', '2026-11-22T04:39:00Z', 19.9) }).record.decision.status, 'WATCH');
});
test('future or wrongly labelled baselines cannot establish prospective evidence', () => {
  const args = finalArgs();
  const future = { ...args.baseline, created_date: '2026-11-22T04:45:00Z' };
  assert.equal(buildRaceForecast({ ...args, baseline: future }).record.comparison.status, 'NO_BASE');
  const fakeDayBefore = { ...args.baseline, stage: 'DAY_BEFORE' };
  assert.equal(buildRaceForecast({ ...args, baseline: fakeDayBefore }).record.comparison.status, 'NO_BASE');
  const generatedYesterdayStoredToday = {
    ...buildRaceForecast({ race, entries, stage: 'DAY_BEFORE', now: '2026-11-21T10:00:00Z' }).record,
    id: 'backdated', created_date: '2026-11-22T00:00:00Z',
  };
  assert.equal(buildRaceForecast({ ...args, baseline: generatedYesterdayStoredToday }).record.comparison.status, 'NO_BASE');
});
test('final content identity is deterministic, changes with quotes and preserves input objects', () => {
  const args = finalArgs(), before = JSON.stringify(args);
  const a = buildRaceForecast(args).record, b = buildRaceForecast({ ...args, now: '2026-11-22T04:40:10Z' }).record;
  assert.equal(a.forecast_key, b.forecast_key);
  const c = buildRaceForecast({ ...args, odds: pricing('updated', '2026-11-22T04:39:30Z', 22) }).record;
  assert.notEqual(a.forecast_key, c.forecast_key);
  assert.equal(JSON.stringify(args), before);
  assert.equal(a.research_tickets.length, 8);
  assert.equal(new Set(a.research_tickets).size, 8);
});
test('post-race weather is not accepted as pre-race evidence', () => {
  const result = buildRaceForecast({ ...finalArgs(), weather: {
    id: 'result-weather', race_id: race.id, kind: 'RESULT_ACTUAL', observed_at: finalNow, wind_speed: 12,
  } }).record;
  assert.equal(result.conditions.wind_speed, null);
  assert.equal(result.conditions.used_for_scoring, false);
  assert.ok(result.missing.includes('TIDE_NOT_CONNECTED'));
});

