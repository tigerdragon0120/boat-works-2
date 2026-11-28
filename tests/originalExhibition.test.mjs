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
const BOATCAST_TKZ = 'https://race.boatcast.jp/hp_txt/21/bc_j_tkz_20261124_21_07.txt';

test('a canonical BOATCAST TKZ exhibition source fetches SUM independently and preserves valid cached SUM across source switches', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(CAPTURED) });
  const options = { ...inputs(), exhibitionSourceUrl: BOATCAST_TKZ };
  let requests = 0;
  const fetcher = async (url, request) => {
    requests++;
    assert.equal(url, 'https://race.boatcast.jp/txt/21/bc_oriten_20261124_21_07.txt');
    assert.equal(request.redirect, 'manual');
    return new Response(ASHIYA, { status: 200 });
  };
  const fresh = await fetchOriginalExhibition({ ...options, fetcher });
  assert.equal(fresh.fetched, true); assert.equal(fresh.snapshot.status, 'AVAILABLE');
  assert.equal(fresh.snapshot.entries.length, 6); assert.equal(fresh.snapshot.entries[0].lap_time, 36.04);
  assert.equal(fresh.snapshot.exhibition_source_url, BOATCAST_TKZ);
  for (const previous of [fresh.snapshot, parse()]) {
    options.race.original_exhibition = previous;
    const reused = await fetchOriginalExhibition({ ...options, fetcher });
    assert.equal(reused.reused, true); assert.equal(reused.snapshot, previous);
  }
  assert.equal(requests, 1, 'a standard-source switch must not replace available matching SUM with unavailable');
});

test('BOATCAST TKZ matching rejects other races and every non-canonical URL before requesting SUM', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(CAPTURED) });
  const urls = [
    BOATCAST_TKZ.replace('20261124', '20261125'),
    BOATCAST_TKZ.replace('/hp_txt/21/', '/hp_txt/20/'),
    BOATCAST_TKZ.replace('_21_07', '_20_07'),
    BOATCAST_TKZ.replace('_07.txt', '_08.txt'),
    BOATCAST_TKZ.replace('_tkz_', '_stt_'),
    BOATCAST_TKZ.replace('https:', 'http:'),
    BOATCAST_TKZ.replace('race.boatcast.jp', 'race.boatcast.jp.evil.invalid'),
    BOATCAST_TKZ.replace('race.boatcast.jp', 'user@race.boatcast.jp'),
    BOATCAST_TKZ.replace('race.boatcast.jp', 'race.boatcast.jp:443'),
    BOATCAST_TKZ.replace('/bc_j_tkz_', '/%62c_j_tkz_'),
    BOATCAST_TKZ.replace('/hp_txt/', '/other/../hp_txt/'),
    BOATCAST_TKZ + '?race=7', BOATCAST_TKZ + '#race', ' ' + BOATCAST_TKZ,
  ];
  for (const exhibitionSourceUrl of urls) {
    const result = await fetchOriginalExhibition({ ...inputs(), exhibitionSourceUrl,
      fetcher: async () => assert.fail('an invalid exhibition source must not fetch SUM') });
    assert.equal(result.fetched, false, exhibitionSourceUrl);
    assert.deepEqual(result.snapshot.reasons, ['EXHIBITION_SOURCE_MISMATCH'], exhibitionSourceUrl);
  }
});

test('a valid TKZ URL still requires matching active racers, complete SUM rows and valid observation time', () => {
  const options = () => ({ ...inputs(), exhibitionSourceUrl: BOATCAST_TKZ });
  const different = options(); different.exhibitionEntries[2].registration_number = '5555';
  assert.deepEqual(parseOriginalExhibition(ASHIYA, different).reasons, ['EXHIBITION_RACER_MISMATCH']);
  const missing = options(); missing.exhibitionEntries.pop();
  assert.deepEqual(parseOriginalExhibition(ASHIYA, missing).reasons, ['EXHIBITION_RACER_MISMATCH']);
  assert.deepEqual(parseOriginalExhibition(ASHIYA.replace('桑原', '別人'), options()).reasons, ['SOURCE_RACER_MISMATCH']);
  const future = options(); future.exhibitionCapturedAt = '2026-11-24T02:20:01.000Z';
  assert.deepEqual(parseOriginalExhibition(ASHIYA, future).reasons, ['SOURCE_TIME_INVALID']);
  const partial = parseOriginalExhibition(ASHIYA.trimEnd().split('\n').slice(0,8).join('\n'), options());
  assert.equal(partial.status, 'PARTIAL'); assert.deepEqual(partial.reasons, ['ORIGINAL_TIMES_PARTIAL']);
});

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
  const fetcher = async (_url, options) => {
    requests++;
    assert.deepEqual(options.headers, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/plain', 'Accept-Language': 'ja,en;q=0.9',
    });
    return new Response('', { status: 403 });
  };
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


test('the hosted backend can supply lexical fetch without globalThis.fetch', async () => {
  const source = fs.readFileSync(new URL('../base44/shared/originalExhibition.js', import.meta.url), 'utf8');
  let requests = 0;
  const injectedFetch = async url => {
    assert.equal(url, 'https://race.boatcast.jp/txt/21/bc_oriten_20261124_21_07.txt');
    requests++;
    return new Response(ASHIYA, { status: 200 });
  };
  const inHostedRuntime = new Function('fetch', 'globalThis', source.replace(/^export /gm, '') + '\nreturn fetchOriginalExhibition;')(injectedFetch, Object.freeze({}));
  const result = await inHostedRuntime(inputs());
  assert.equal(requests, 1);
  assert.equal(result.snapshot.status, 'AVAILABLE');
});

test('fetch failures log the public source and a sanitized message without exception causes', async t => {
  const logged = [];
  t.mock.method(console, 'warn', (...args) => { logged.push(args); });
  const cause = new Error('private-cause-value');
  const error = new TypeError('runtime rejected request; Authorization: Bearer secret-value token=private-value https://private.example/a?key=x', { cause });
  const result = await fetchOriginalExhibition({ ...inputs(), fetcher: async () => { throw error; } });
  assert.ok(result.snapshot.reasons.includes('FETCH_FAILED'));
  assert.equal(logged.length, 1);
  const diagnostics = JSON.parse(logged[0][1]);
  assert.equal(diagnostics.name, 'TypeError');
  assert.equal(diagnostics.source_url, 'https://race.boatcast.jp/txt/21/bc_oriten_20261124_21_07.txt');
  assert.match(diagnostics.message, /runtime rejected request/);
  assert.equal(JSON.stringify(logged).includes('secret-value'), false);
  assert.equal(JSON.stringify(logged).includes('private-value'), false);
  assert.equal(JSON.stringify(logged).includes('private.example'), false);
  assert.equal(JSON.stringify(logged).includes('private-cause-value'), false);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['message', 'name', 'source_url']);
});


test('legacy names with exact branch and origin suffixes match while preserving registration checks', () => {
  const options = inputs();
  const affiliations = ['福岡/熊本', '広島/広島', '東京/千葉', '愛知/愛知', '埼玉/埼玉', '山口/山口'];
  options.entries.forEach((entry, i) => { entry.player_name = entry.player_name.replace(/[\s　]+/g, '') + affiliations[i]; });
  const data = parseOriginalExhibition(ASHIYA, options);
  assert.equal(data.status, 'AVAILABLE');
  assert.equal(data.entries[0].registration_number, options.entries[0].registration_number);
  const withSpaces = inputs();
  withSpaces.entries[0].player_name += ' 福岡 / 熊本';
  assert.equal(parseOriginalExhibition(ASHIYA, withSpaces).status, 'AVAILABLE');
  options.exhibitionEntries[0].registration_number = '5555';
  assert.ok(parseOriginalExhibition(ASHIYA, options).reasons.includes('EXHIBITION_RACER_MISMATCH'));
});

test('unknown affiliations and another racer cannot pass as a fuzzy match', () => {
  for (const name of ['桑原啓未知/未知', '桑原別人福岡/熊本', '桑原啓福岡/熊本後記']) {
    const options = inputs(); options.entries[0].player_name = name;
    assert.ok(parseOriginalExhibition(ASHIYA, options).reasons.includes('SOURCE_RACER_MISMATCH'));
  }
});


test('edge-compatible manual redirects reject 302 without following or using the body', async () => {
  let requests = 0, bodyRead = false;
  const result = await fetchOriginalExhibition({ ...inputs(), fetcher: async (_url, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    return { status: 302, ok: false, text: async () => { bodyRead = true; return ASHIYA; } };
  } });
  assert.equal(requests, 1);
  assert.equal(bodyRead, false);
  assert.equal(result.snapshot.status, 'UNAVAILABLE');
  assert.deepEqual(result.snapshot.entries, []);
  assert.deepEqual(result.snapshot.reasons, ['HTTP_302']);
});
