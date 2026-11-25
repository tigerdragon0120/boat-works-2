import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOriginalExhibitionUrl, parseOriginalExhibition, fetchOriginalExhibition, reuseOriginalExhibition } from '../base44/shared/originalExhibition.js';

const ASHIYA = fs.readFileSync(new URL('./fixtures/original-exhibition/bc_oriten_20261124_21_07.txt', import.meta.url), 'utf8');
const AMAGASAKI = fs.readFileSync(new URL('./fixtures/original-exhibition/bc_oriten_20261117_13_07.txt', import.meta.url), 'utf8');
const CAPTURED = '2026-11-24T02:20:00.000Z';
function inputs(text = ASHIYA, date = '2026-11-24', venue = '21') {
  const rows = text.trimEnd().split('\n').slice(3).map(line => line.split('\t'));
  return {
    race: { id: 'race-a', race_key: date + '_' + venue + '_07', race_date: date, venue_code: venue, race_number: 7, scratched_boats: [] },
    entries: rows.map((row, i) => ({ boat_number: Number(row[0]), player_name: row[1], registration_number: String(4101 + i) })),
    exhibitionEntries: rows.map((row, i) => ({ boat_number: Number(row[0]), registration_number: String(4101 + i), exhibition_time: [6.73, 6.79, 6.86, 6.81, 6.86, 6.84][i] })),
    exhibitionSourceUrl: 'https://boatrace.jp/owpc/pc/race/beforeinfo?rno=7&jcd=' + venue + '&hd=' + date.replaceAll('-', ''),
    exhibitionCapturedAt: CAPTURED, capturedAt: CAPTURED,
  };
}
const parse = (text = ASHIYA, overrides = {}) => parseOriginalExhibition(text, { ...inputs(), ...overrides });

test('observed public Ashiya source preserves the boat, lap, turn and straight values', () => {
  const data = parse();
  assert.equal(data.status, 'AVAILABLE');
  assert.equal(data.source_url, 'https://race.boatcast.jp/txt/21/bc_oriten_20261124_21_07.txt');
  assert.equal(data.source_kind, 'OFFICIAL_ORIGINAL_EXHIBITION');
  assert.equal(data.matching, 'BOAT_AND_NAME');
  assert.deepEqual(data.entries.map(e => [e.boat_number, e.lap_time, e.turn_time, e.straight_time]), [
    [1,36.04,7.57,7.65],[2,37.11,8.23,7.75],[3,37.19,8.16,7.71],[4,37.4,8.22,7.76],[5,37.33,8.15,7.77],[6,37.16,8.11,7.68],
  ]);
  assert.equal(data.entries[0].exhibition_time, 6.73);
  assert.equal(data.entries[0].registration_number, '4101');
});

test('observed Amagasaki source has a lap and a turn, with no invented straight time', () => {
  const data = parseOriginalExhibition(AMAGASAKI, inputs(AMAGASAKI, '2026-11-17', '13'));
  assert.equal(data.status, 'AVAILABLE');
  assert.deepEqual(data.source_labels, ['一周', 'まわり足']);
  assert.deepEqual(data.entries.map(e => e.turn_time), [11.56,11.55,11.99,11.88,12.10,11.85]);
  assert.ok(data.entries.every(e => e.straight_time === null));
});

test('row order cannot turn a boat number into the exhibition course', () => {
  const lines = ASHIYA.trimEnd().split('\n');
  const data = parse([...lines.slice(0,3), ...lines.slice(3).reverse()].join('\n'));
  assert.equal(data.status, 'AVAILABLE');
  assert.deepEqual(data.entries.map(e => e.boat_number), [1,2,3,4,5,6]);
  assert.equal(data.entries[0].lap_time, 36.04);
});

test('a different racer or a duplicate boat is rejected as a complete source', () => {
  const renamed = parse(ASHIYA.replace('桑原', '別人'));
  assert.equal(renamed.status, 'UNAVAILABLE');
  assert.deepEqual(renamed.entries, []);
  assert.ok(renamed.reasons.includes('SOURCE_RACER_MISMATCH'));
  const duplicated = parse(ASHIYA + ASHIYA.trimEnd().split('\n')[3] + '\n');
  assert.equal(duplicated.status, 'UNAVAILABLE');
  assert.ok(duplicated.reasons.includes('SOURCE_BOATS_INVALID'));
});

test('missing and impossible times stay null, and incomplete means cannot be marked available', () => {
  for (const value of ['-', '0.00', '999.00', 'abc']) {
    const data = parse(ASHIYA.replace('36.04', value));
    assert.equal(data.status, 'PARTIAL');
    assert.equal(data.entries[0].lap_time, null);
  }
  const data = parse(ASHIYA.trimEnd().split('\n').slice(0,8).join('\n'));
  assert.equal(data.status, 'PARTIAL');
  assert.equal(data.entries.length, 5);
});

test('a half lap is never passed to the one-lap SUM formula', () => {
  const data = parse(ASHIYA.replace('一　周', '半周ラップ'));
  assert.equal(data.status, 'PARTIAL');
  assert.ok(data.entries.every(e => e.lap_time === null));
  assert.ok(data.reasons.includes('HALF_LAP_NOT_SUPPORTED'));
});

test('officially scratched boats are excluded, without inferring a scratch from a blank time', () => {
  const options = inputs();
  options.exhibitionEntries[5].is_scratched = true;
  options.exhibitionEntries[5].exhibition_time = null;
  options.race.scratched_boats = [6];
  const data = parseOriginalExhibition(ASHIYA.replace('37.16', '-'), options);
  assert.equal(data.status, 'AVAILABLE');
  assert.equal(data.active_boat_count, 5);
  assert.deepEqual(data.entries.map(e => e.boat_number), [1,2,3,4,5]);
});

test('wrong race URLs and mismatched official registration numbers cannot be joined', () => {
  const wrongUrl = parse(ASHIYA, { exhibitionSourceUrl: inputs().exhibitionSourceUrl.replace('rno=7','rno=8') });
  assert.equal(wrongUrl.status, 'UNAVAILABLE');
  assert.ok(wrongUrl.reasons.includes('EXHIBITION_SOURCE_MISMATCH'));
  const options = inputs(); options.exhibitionEntries[2].registration_number = '5555';
  assert.ok(parseOriginalExhibition(ASHIYA, options).reasons.includes('EXHIBITION_RACER_MISMATCH'));
  assert.equal(buildOriginalExhibitionUrl({ ...options.race, race_date: '2026-02-30', race_key: '' }), null);
});

test('not-yet-published, unmeasurable and non-feed responses have explicit states', () => {
  assert.ok(parse('data=\n0\t3\n').reasons.includes('NOT_PUBLISHED'));
  assert.ok(parse('data=\n2\t3\n').reasons.includes('MEASUREMENT_UNAVAILABLE'));
  assert.ok(parse('<html>error</html>').reasons.includes('SOURCE_FORMAT_INVALID'));
});

test('complete stored data is reused, but updated official exhibition data invalidates it', async () => {
  const options = inputs(), previous = parse();
  options.race.original_exhibition = previous;
  let requests = 0;
  const fetcher = async () => { requests++; return new Response(ASHIYA, { status: 200 }); };
  const cached = await fetchOriginalExhibition({ ...options, fetcher });
  assert.equal(cached.reused, true); assert.equal(requests, 0);
  options.exhibitionEntries[0].exhibition_time = 6.74;
  const changed = await fetchOriginalExhibition({ ...options, fetcher });
  assert.equal(changed.fetched, true); assert.equal(requests, 1);
  assert.equal(changed.snapshot.entries[0].exhibition_time, 6.74);
  assert.equal(previous.entries[0].exhibition_time, 6.73);
});

test('403 is recorded without retry and a repeated failed request is held for 60 seconds', async () => {
  const options = inputs(); let requests = 0;
  const fetcher = async () => { requests++; return new Response('', { status: 403 }); };
  const failed = await fetchOriginalExhibition({ ...options, fetcher });
  assert.equal(failed.snapshot.status, 'UNAVAILABLE');
  assert.ok(failed.snapshot.reasons.includes('HTTP_403'));
  options.race.original_exhibition = failed.snapshot;
  const held = await fetchOriginalExhibition({ ...options, fetcher });
  assert.equal(held.reused, true); assert.equal(requests, 1);
});

test('an exhausted time budget never requests or blocks normal exhibition collection', async () => {
  let requested = false;
  const result = await fetchOriginalExhibition({ ...inputs(), deadlineMs: Date.now() - 1, fetcher: async () => { requested = true; throw Error('must not fetch'); } });
  assert.equal(requested, false);
  assert.ok(result.snapshot.reasons.includes('FETCH_TIME_BUDGET'));
});

test('timeouts abort a single request and return unavailable rather than a synthetic number', async () => {
  let requests = 0;
  const result = await fetchOriginalExhibition({ ...inputs(), timeoutMs: 100,
    fetcher: (_, { signal }) => new Promise((resolve, reject) => {
      requests++; signal.addEventListener('abort', () => { const err = new Error('aborted'); err.name = 'AbortError'; reject(err); });
    }) });
  assert.equal(requests, 1);
  assert.ok(result.snapshot.reasons.includes('FETCH_TIMEOUT'));
  assert.deepEqual(result.snapshot.entries, []);
});

test('cached inputs cannot be borrowed from another race or from the future', () => {
  const options = inputs(), previous = parse();
  assert.equal(reuseOriginalExhibition({ ...previous, race_number: 8 }, options), null);
  assert.equal(reuseOriginalExhibition(previous, { ...options, nowMs: Date.parse(CAPTURED) - 1 }), null);
});


test('Amagasaki keeps basic SUM available while retrying a late turn time after 60 seconds', async () => {
  const options = inputs(AMAGASAKI, '2026-11-17', '13');
  const sourceTime = new Date(Date.now() - 61000).toISOString();
  options.exhibitionCapturedAt = sourceTime; options.capturedAt = sourceTime;
  const pending = parseOriginalExhibition(AMAGASAKI.replace('11.56', '-'), options);
  assert.equal(pending.status, 'AVAILABLE');
  assert.equal(pending.entries[0].turn_time, null);
  assert.equal(reuseOriginalExhibition(pending, { ...options, nowMs: Date.parse(sourceTime) + 30000 }), pending);
  assert.equal(reuseOriginalExhibition(pending, { ...options, nowMs: Date.parse(sourceTime) + 61000 }), null);
  options.race.original_exhibition = pending;
  let requests = 0;
  const result = await fetchOriginalExhibition({ ...options, fetcher: async () => { requests++; return new Response(AMAGASAKI, { status: 200 }); } });
  assert.equal(requests, 1); assert.equal(result.snapshot.status, 'AVAILABLE');
  assert.equal(result.snapshot.entries[0].turn_time, 11.56);
  assert.equal(reuseOriginalExhibition(result.snapshot, { ...options, nowMs: Date.parse(result.snapshot.captured_at) + 120000 }), result.snapshot);
});

test('an unused missing straight measurement does not cause repeat GETs', () => {
  const options = inputs(), sourceTime = '2026-11-24T02:20:00.000Z';
  const data = parseOriginalExhibition(ASHIYA.replace('7.65', '-'), options);
  assert.equal(data.status, 'AVAILABLE'); assert.equal(data.entries[0].straight_time, null);
  assert.equal(reuseOriginalExhibition(data, { ...options, nowMs: Date.parse(sourceTime) + 120000 }), data);
});
