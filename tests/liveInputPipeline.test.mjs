// Exercise the actual live orchestration functions with in-memory providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { selectLiveInputRaces, isSavedExhibitionComplete } from '../base44/shared/liveInputPriority.js';

const source = readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-22T10:20:00Z');
const TODAY = '2026-11-22', TOMORROW = '2026-11-23';
function bindFunction(name, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, `function ${name} exists`);
  const executable = stripTypeScriptTypes(source.slice(start, end));
  return new Function(...Object.keys(dependencies), executable + `\nreturn ${name};`)(...Object.values(dependencies));
}
const makeRace = (id = 'race-1', seconds = 600, extra = {}) => ({
  id, race_key: `${TODAY}_01_${id === 'race-2' ? '11' : '10'}`, race_date: TODAY,
  venue_code: '01', race_number: id === 'race-2' ? 11 : 10, status: 'scheduled',
  deadline: new Date(NOW + seconds * 1000).toISOString(), exhibition_ready: false, ...extra,
});
const completeRows = () => Array.from({ length: 6 }, (_, i) => ({
  id: 'entry-' + (i + 1), boat_number: i + 1,
  exhibition_time: 6.7 + i * .01, exhibition_st: .1 + i * .01,
  exhibition_st_raw: .1 + i * .01, exhibition_course: i + 1,
}));

function setupAuto(t, { failV7 = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [], logs = [], errors = [], row = makeRace();
  const client = {
    asServiceRole: { entities: { Race: { filter: async () => [row] } } },
    functions: { invoke: async (name, body) => {
      calls.push('v8'); assert.equal(name, 'v8CaptureForecasts'); assert.deepEqual(body, {});
      return { data: { ok: true, final: 1 } };
    } },
  };
  const legacy = () => { calls.push('legacy'); throw new Error('Legacy prediction must not run in AUTO'); };
  const run = bindFunction('autoUpdate', {
    nowJSTTime: () => '19:20',
    fetchAndSaveExhibition: async (_client, date, budget, _logs, _errors, options) => {
      calls.push('exhibition'); assert.equal(date, TODAY); assert.equal(budget, 30000);
      assert.deepEqual(options, { liveOnly: true, deferV7: true });
      return { fetched: 1, ready_keys: [row.race_key] };
    },
    fetchLiveOdds: async (_client, date, budget) => {
      calls.push('odds'); assert.equal(date, TODAY); assert.equal(budget, 18000);
      return { saved: 1, ready_keys: [row.race_key] };
    },
    runV7AutoGeneration: async (_client, options) => {
      calls.push('v7'); assert.deepEqual(options, { race_date: TODAY, race_keys: [row.race_key] });
      if (failV7) throw new Error('V7 temporarily unavailable');
      return { saved_final: 1 };
    },
    fetchAndSaveResults: async () => { calls.push('results'); return { fetched: 1 }; },
    fetchAndSaveRaceCards: async (_client, date) => { calls.push('cards:' + date); return { races: 0, entries: 0 }; },
    generateMainPrePredictions: legacy, generatePrePredictions: legacy,
    fetchAndSaveOddsAndFinal: legacy, runAndSavePrediction: legacy,
  });
  return { run: () => run(client, TODAY, TOMORROW, 80000, logs, errors), calls, errors };
}

test('AUTO performs exhibition, prices, V7 and V8 before maintenance without legacy prediction work', async t => {
  const state = setupAuto(t);
  const result = await state.run();
  assert.deepEqual(state.calls, ['exhibition', 'odds', 'v7', 'v8', 'results', 'cards:' + TODAY, 'cards:' + TOMORROW]);
  assert.deepEqual(state.errors, []);
  assert.ok(result.steps.includes('v8_final: 1R'));
});

test('a V7 generation exception still permits V8 to capture the observed exhibition', async t => {
  const state = setupAuto(t, { failV7: true });
  await state.run();
  assert.deepEqual(state.calls.slice(0, 4), ['exhibition', 'odds', 'v7', 'v8']);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /V7 temporarily unavailable/);
});

function setupExhibition(t, { failedBoat = null, alreadyComplete = true } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const row = makeRace(), incoming = completeRows();
  const stored = alreadyComplete ? completeRows() : incoming.map(e => ({ id: e.id, boat_number: e.boat_number }));
  const entryWrites = [], raceWrites = [], errors = [];
  const entities = {
    Race: {
      filter: async () => [structuredClone(row)],
      update: async (_id, patch) => { raceWrites.push(structuredClone(patch)); Object.assign(row, patch); return structuredClone(row); },
    },
    RaceEntry: {
      filter: async () => structuredClone(stored),
      update: async (id, patch) => {
        entryWrites.push(id);
        if (id === 'entry-' + failedBoat) throw new Error('entry save failed');
        const entry = stored.find(e => e.id === id); Object.assign(entry, patch); return structuredClone(entry);
      },
    },
  };
  const run = bindFunction('fetchAndSaveExhibition', {
    uniqueRacesByKey: rows => rows, uniqueEntriesByBoat: rows => rows,
    selectLiveInputRaces, isSavedExhibitionComplete, VENUE_MAP: { '01': '桐生' },
    buildUrl: () => 'https://fixture.invalid/beforeinfo',
    fetchHtml: async (_url, retries, options) => {
      assert.equal(retries, 0); assert.equal(options.timeoutMs, 6000);
      return { ok: true, html: 'fixture' };
    },
    parseBeforeInfo: () => ({ ok: true, data: { entries: structuredClone(incoming), real_exhibition_count: 6, active_boat_count: 6, scratched_boats: [] } }),
    withRateLimitRetry: async fn => fn(), sleep: async () => {},
    runV7AutoGeneration: () => assert.fail('V7 must be deferred until pricing'),
  });
  return { row, stored, entryWrites, raceWrites, errors,
    run: () => run({ asServiceRole: { entities } }, TODAY, 30000, [], errors, { liveOnly: true, deferV7: true }) };
}

test('unchanged complete saved exhibition repairs readiness and is forwarded even with zero entry writes', async t => {
  const state = setupExhibition(t);
  const result = await state.run();
  assert.equal(state.entryWrites.length, 0);
  assert.deepEqual(state.raceWrites, [{ exhibition_ready: true }]);
  assert.deepEqual(result.ready_keys, [state.row.race_key]);
  assert.equal(state.row.exhibition_ready, true);
  assert.deepEqual(state.errors, []);
});

test('a failed last-boat write cannot promote partial saved exhibition to ready or V7 generation', async t => {
  const state = setupExhibition(t, { failedBoat: 6, alreadyComplete: false });
  const result = await state.run();
  assert.equal(state.entryWrites.length, 6);
  assert.equal(state.row.exhibition_ready, false);
  assert.equal(state.raceWrites.some(patch => patch.exhibition_ready === true), false);
  assert.deepEqual(result.ready_keys, []);
  assert.equal(isSavedExhibitionComplete(state.stored), false);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /entry save failed/);
});

test('an elapsed cutoff skips the earliest race without starving the later live odds candidate', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const rows = [makeRace('race-1', 90.5, { exhibition_ready: true }), makeRace('race-2', 300, { exhibition_ready: true })];
  const fetched = [], saved = [];
  const oddsMap = {};
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) {
    if (new Set([a, b, c]).size === 3) oddsMap[`${a}-${b}-${c}`] = 12;
  }
  const run = bindFunction('fetchLiveOdds', {
    uniqueRacesByKey: list => list,
    selectLiveInputRaces: (...args) => { const selected = selectLiveInputRaces(...args); t.mock.timers.tick(1000); return selected; },
    buildUrl: (_type, _date, _venue, number) => String(number),
    fetchHtml: async url => { fetched.push(url); return { ok: true, html: 'odds' }; },
    parseOdds3t: () => oddsMap,
  });
  const client = { asServiceRole: { entities: {
    Race: { filter: async () => rows },
    OddsSnapshot: { filter: async () => [], create: async doc => { saved.push(doc); return { id: 'quote-' + saved.length, ...doc }; } },
  } } };
  const errors = [], result = await run(client, TODAY, 18000, [], errors);
  assert.deepEqual(fetched, ['11']);
  assert.equal(result.saved, 1);
  assert.deepEqual(result.ready_keys, [rows[1].race_key]);
  assert.ok(saved.every(doc => doc.race_id === 'race-2'));
  assert.deepEqual(errors, []);
});
