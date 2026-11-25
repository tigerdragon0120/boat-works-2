// Exercise the actual live orchestration functions with in-memory providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { selectLiveInputRaces, isSavedExhibitionComplete } from '../base44/shared/liveInputPriority.js';
import { fetchOriginalExhibition } from '../base44/shared/originalExhibition.js';

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
  player_name: '選手' + (i + 1), registration_number: String(4101 + i),
  exhibition_time: 6.7 + i * .01, exhibition_st: .1 + i * .01,
  exhibition_st_raw: .1 + i * .01, exhibition_course: i + 1,
}));

function setupAuto(t, { spendBudgets = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [], budgets = [], logs = [], errors = [], row = makeRace();
  const spend = (name, budget) => { budgets.push([name, budget]); if (spendBudgets) t.mock.timers.tick(budget); };
  const client = {
    asServiceRole: { entities: { Race: { filter: async () => [row] } } },
    functions: { invoke: async () => { calls.push('unexpected-backend-invoke'); throw new Error('AUTO must leave generation to the unified forecast workflow'); } },
  };
  const legacy = () => { calls.push('legacy'); throw new Error('Legacy prediction must not run in AUTO'); };
  const run = bindFunction('autoUpdate', {
    nowJSTTime: () => '19:20',
    fetchAndSaveExhibition: async (_client, date, budget, _logs, _errors, options) => {
      calls.push('exhibition'); assert.equal(date, TODAY); assert.equal(budget, 30000);
      assert.deepEqual(options, { liveOnly: true, deferForecasts: true });
      spend('exhibition', budget);
      return { fetched: 1, ready_keys: [row.race_key] };
    },
    fetchLiveOdds: async (_client, date, budget) => {
      calls.push('odds'); assert.equal(date, TODAY); assert.equal(budget, 18000);
      spend('odds', budget);
      return { saved: 1, ready_keys: [row.race_key] };
    },
    runV7AutoGeneration: async () => {
      calls.push('unexpected-v7'); throw new Error('AUTO must not duplicate unified V7 generation');
    },
    runV8LiveGeneration: async () => {
      calls.push('unexpected-unified-generation'); throw new Error('AUTO must not duplicate the unified workflow');
    },
    fetchAndSaveResults: async (_client, date, budget) => {
      calls.push('results'); assert.equal(date, TODAY); spend('results', budget); return { fetched: 1 };
    },
    fetchAndSaveRaceCards: async (_client, date, budget) => {
      calls.push('cards:' + date); spend('cards:' + date, budget); return { races: 0, entries: 0 };
    },
    generateMainPrePredictions: legacy, generatePrePredictions: legacy,
    fetchAndSaveOddsAndFinal: legacy, runAndSavePrediction: legacy,
  });
  return { run: () => run(client, TODAY, TOMORROW, 80000, logs, errors), calls, budgets, errors };
}

test('AUTO saves exhibition and prices before maintenance without duplicating V7, V8 or legacy generation', async t => {
  const state = setupAuto(t);
  const result = await state.run();
  assert.deepEqual(state.calls, ['exhibition', 'odds', 'results', 'cards:' + TODAY, 'cards:' + TOMORROW]);
  assert.deepEqual(state.errors, []);
  assert.ok(result.steps.includes('forecast_inputs_ready: 1R'), 'the same race from exhibition and odds is counted once');
  assert.ok(result.steps.includes('exhibition: 1R'));
  assert.ok(result.steps.includes('live_odds: 1R'));
  assert.deepEqual(state.budgets, [['exhibition', 30000], ['odds', 18000], ['results', 15000], ['cards:' + TODAY, 20000], ['cards:' + TOMORROW, 80000]]);
});

test('AUTO preserves live-input budgets and uses only remaining time for cards before stopping', async t => {
  const state = setupAuto(t, { spendBudgets: true });
  const result = await state.run();
  assert.deepEqual(state.calls, ['exhibition', 'odds', 'results', 'cards:' + TODAY]);
  assert.deepEqual(state.budgets, [['exhibition', 30000], ['odds', 18000], ['results', 15000], ['cards:' + TODAY, 17000]]);
  assert.equal(Date.now() - NOW, 80000);
  assert.ok(result.steps.includes('forecast_inputs_ready: 1R'));
  assert.equal(result.steps.some(step => step.startsWith('tomorrow_card:')), false);
  assert.deepEqual(state.errors, []);
});

function setupExhibition(t, { failedBoat = null, alreadyComplete = true, originalHttpStatus = 200 } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const row = makeRace(), incoming = completeRows();
  const stored = alreadyComplete ? completeRows() : incoming.map(e => ({ id: e.id, boat_number: e.boat_number, player_name: e.player_name, registration_number: e.registration_number }));
  const entryWrites = [], raceWrites = [], errors = [], originalRequests = [], originalInputs = [];
  const originalText = 'data=\n1\t1\n一周\n' + incoming.map((entry, i) => `${entry.boat_number}\t${entry.player_name}\t${(36 + i * .1).toFixed(2)}`).join('\n') + '\n';
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
    buildUrl: (_type, date, venue, number) => `https://boatrace.jp/owpc/pc/race/beforeinfo?rno=${number}&jcd=${venue}&hd=${date.replaceAll('-', '')}`,
    fetchHtml: async (_url, retries, options) => {
      assert.equal(retries, 0); assert.equal(options.timeoutMs, 6000);
      return { ok: true, html: 'fixture' };
    },
    parseBeforeInfo: () => ({ ok: true, data: { entries: structuredClone(incoming), real_exhibition_count: 6, active_boat_count: 6, scratched_boats: [] } }),
    fetchOriginalExhibition: async options => {
      originalInputs.push(structuredClone(options));
      return fetchOriginalExhibition({ ...options, fetcher: async url => {
        originalRequests.push(url);
        return new Response(originalHttpStatus === 200 ? originalText : '', { status: originalHttpStatus });
      } });
    },
    withRateLimitRetry: async fn => fn(), sleep: async () => {},
    runV8LiveGeneration: () => assert.fail('AUTO collection must leave V8 generation to the unified workflow'),
  });
  return { row, stored, entryWrites, raceWrites, errors, originalRequests, originalInputs,
    run: () => run({ asServiceRole: { entities } }, TODAY, 30000, [], errors, { liveOnly: true, deferForecasts: true }) };
}

test('unchanged complete saved exhibition repairs readiness and is forwarded even with zero entry writes', async t => {
  const state = setupExhibition(t);
  const result = await state.run();
  assert.equal(state.entryWrites.length, 0);
  assert.equal(state.raceWrites.length, 1);
  assert.equal(state.raceWrites[0].exhibition_ready, true);
  assert.equal(state.row.original_exhibition.status, 'AVAILABLE');
  assert.equal(state.row.original_exhibition.entries.length, 6);
  assert.equal(state.row.original_exhibition.entries[0].lap_time, 36);
  assert.deepEqual(state.originalRequests, ['https://race.boatcast.jp/txt/01/bc_oriten_20261122_01_10.txt']);
  assert.equal(state.originalInputs[0].exhibitionCapturedAt, new Date(NOW).toISOString());
  assert.equal(state.originalInputs[0].deadlineMs, NOW + 28500, 'normal exhibition saving retains 1.5 seconds of the collection budget');
  assert.deepEqual(result.ready_keys, [state.row.race_key]);
  assert.equal(state.row.exhibition_ready, true);
  assert.deepEqual(state.errors, []);
});

test('a failed last-boat write cannot promote partial saved exhibition to ready or V8 generation', async t => {
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


test('failed original data collection preserves normal exhibition saving and forwards the V8 ready key', async t => {
  const state = setupExhibition(t, { alreadyComplete: false, originalHttpStatus: 503 });
  const result = await state.run();
  assert.equal(state.originalRequests.length, 1, 'the optional feed is requested once without retries');
  assert.equal(state.entryWrites.length, 6);
  assert.equal(isSavedExhibitionComplete(state.stored), true);
  assert.equal(state.row.exhibition_ready, true);
  assert.equal(state.row.original_exhibition.status, 'UNAVAILABLE');
  assert.deepEqual(state.row.original_exhibition.reasons, ['HTTP_503']);
  assert.deepEqual(state.row.original_exhibition.entries, []);
  assert.deepEqual(result.ready_keys, [state.row.race_key]);
  assert.deepEqual(state.errors, []);
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
