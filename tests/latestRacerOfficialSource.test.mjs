import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { parseRacerTermFile } from '../base44/shared/racerTermParser.js';
import {
  RACER_OFFICIAL_INDEX_URL, discoverLatestRacerSource, validateLatestRacerRecords,
} from '../base44/shared/latestRacerOfficialSource.js';

// Official index markup observed on 2026-11-22; only the newest archive is fetched.
const PREFIX = '/static_extra/pc_static/download/data/kibetsu/';
const LATEST_URL = 'https://www.boatrace.jp' + PREFIX + 'fan2604.lzh';
const INDEX = '<ul><li><span>2026年</span><span><a href="' + PREFIX + 'fan2510.lzh">前期</a></span>'
  + '<span><a href="' + PREFIX + 'fan2604.lzh">後期</a></span></li>'
  + '<li><span>2025年</span><a href="' + PREFIX + 'fan2504.lzh">後期</a></li></ul>';
const SOURCE = discoverLatestRacerSource(INDEX);

function record(registration = '1000') {
  return {
    registration_number: registration, racer_name: 'TEST RACER',
    term_year: 2026, term_half: 'SECOND', term_key: '2026_SECOND',
    term_start_date: '2025-11-01', term_end_date: '2026-04-30',
    win_rate: 5.2, fukusho_rate: 32.1, avg_st: 0.17, race_count: 100,
    course_stats: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i + 1), {
      entries: 10, first_count: 2, second_count: 1, third_count: 1,
      fourth_count: 2, fifth_count: 2, sixth_count: 2, avg_st: 0.17,
    }])),
  };
}
const records = (count = 1000) => Array.from({ length: count }, (_, i) => record(String(1000 + i)));

// Clearly synthetic fixed-width rows exercise the authoritative byte parser.
function syntheticText(count = 1000) {
  const output = new Uint8Array(count * 418);
  for (let i = 0; i < count; i++) {
    const row = new Uint8Array(416).fill(48);
    const put = (offset, text) => row.set(new TextEncoder().encode(text), offset);
    put(0, String(1000 + i).padStart(4, '0'));
    put(4, 'TEST RACER      ');
    put(39, 'B1');
    put(58, '0520');
    put(62, '0321');
    put(72, '100');
    put(79, '017');
    put(174, '20262');
    put(179, '20251101');
    put(187, '20260430');
    output.set(row, i * 418);
    output[i * 418 + 416] = 13;
    output[i * 418 + 417] = 10;
  }
  return output;
}

const archiveBytes = new Uint8Array(64);
archiveBytes.set(new TextEncoder().encode('-lh5-'), 2);

async function actualFetchWorker({
  html = INDEX, text = syntheticText(), http, crcError = false,
  members, uncompressedSize,
} = {}) {
  const calls = [];
  const state = { closed: 0, extracted: 0, decoderLoaded: 0 };
  const decoder = {
    Uint8ArrayReader: class { constructor(bytes) { this.bytes = bytes; } },
    Uint8ArrayWriter: class {},
    LhaReader: class {
      constructor(reader, options) {
        assert.deepEqual(reader.bytes, archiveBytes);
        assert.equal(options.checkCrc, 'throw');
        assert.equal(options.filenameDecoder(new TextEncoder().encode('fan2604.txt')), 'fan2604.txt');
      }
      async getEntries() {
        return members || [{
          filename: 'fan2604.txt', directory: false, encrypted: false,
          uncompressedSize: uncompressedSize ?? text.length,
          async getData() {
            state.extracted++;
            if (crcError) throw Error('LHA_CRC_MISMATCH');
            return text;
          },
        }];
      }
      async close() { state.closed++; }
    },
  };
  const fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    if (http) {
      const response = await http(url, calls);
      if (response) return response;
    }
    if (url === RACER_OFFICIAL_INDEX_URL) return new Response(html);
    if (url === LATEST_URL) return new Response(archiveBytes);
    throw Error('UNEXPECTED_REQUEST ' + url);
  };
  // Execute the actual worker; only the Deno npm loader is replaced with a controlled decoder.
  const source = await readFile(new URL('../base44/shared/latestRacerOfficialSource.js', import.meta.url), 'utf8');
  assert.match(source, /await import\('npm:@kirinsaninc\/lhats@0\.1\.0'\)/);
  const body = source
    .replace(/^import \{ parseRacerTermFile \} from '\.\/racerTermParser\.js';\n/, '')
    .replace(/^export /gm, '')
    .replace("await import('npm:@kirinsaninc/lhats@0.1.0')", 'await loadDecoder()');
  const worker = new Function('parseRacerTermFile', 'fetch', 'crypto', 'loadDecoder',
    body + '\nreturn { fetchLatestRacerDataset };'
  )(parseRacerTermFile, fetch, webcrypto, async () => { state.decoderLoaded++; return decoder; });
  return { ...worker, calls, state };
}

test('discovers the current newest link from the observed page labels, independent of its position', () => {
  assert.deepEqual(SOURCE, {
    url: LATEST_URL, index_url: RACER_OFFICIAL_INDEX_URL, file_name: 'fan2604.lzh',
    term_key: '2026_SECOND', term_year: 2026, term_half: 'SECOND',
  });
  const firstOnly = '<li><span>2027年</span><a href="' + PREFIX + 'fan2610.lzh">前期</a><span>後期</span></li>';
  assert.equal(discoverLatestRacerSource(INDEX + firstOnly).term_key, '2027_FIRST');
  assert.equal(discoverLatestRacerSource(firstOnly + INDEX).file_name, 'fan2610.lzh');
});

test('a current date, disabled half, filename and hidden markup cannot invent a newer published period', () => {
  const hidden = '<!-- <li>2099年<a href="' + PREFIX + 'fan9904.lzh">後期</a></li> -->'
    + '<script><li>2098年<a href="' + PREFIX + 'fan9804.lzh">後期</a></li></script>';
  assert.equal(discoverLatestRacerSource(hidden + INDEX).term_key, '2026_SECOND');
  assert.throws(() => discoverLatestRacerSource('<a href="' + PREFIX + 'fan2604.lzh">後期</a>'), /LATEST_LINK_NOT_FOUND/);
  const mislabeled = '<li>2027年<a href="' + PREFIX + 'fan2604.lzh">前期</a></li>';
  assert.equal(discoverLatestRacerSource(mislabeled).term_key, '2027_FIRST');
  assert.throws(() => validateLatestRacerRecords(records(), discoverLatestRacerSource(mislabeled)), /PAGE_RECORD_TERM_MISMATCH/);
});

test('only HTTPS official hosts and the exact distribution path are accepted without older fallback', () => {
  for (const link of [
    'http://www.boatrace.jp' + PREFIX + 'fan2610.lzh',
    'https://www.boatrace.jp.attacker.invalid' + PREFIX + 'fan2610.lzh',
    'https://www.boatrace.jp@attacker.invalid' + PREFIX + 'fan2610.lzh',
    'https://www.boatrace.jp:444' + PREFIX + 'fan2610.lzh',
    'https://www.boatrace.jp/other/fan2610.lzh',
    'https://www.boatrace.jp' + PREFIX + 'fan2610.lzh?next=other',
  ]) {
    assert.throws(() => discoverLatestRacerSource(INDEX + '<li>2027年<a href="' + link + '">前期</a></li>'), /UNTRUSTED_/);
  }
  assert.throws(() => discoverLatestRacerSource(INDEX, 'https://attacker.invalid/download.html'), /UNTRUSTED_URL/);
  assert.equal(discoverLatestRacerSource(INDEX, RACER_OFFICIAL_INDEX_URL.replace('www.', '')).url,
    LATEST_URL.replace('www.', ''));
});

test('conflicting newest links and ambiguous year labels stop discovery', () => {
  assert.throws(() => discoverLatestRacerSource(INDEX + '<li>2026年<a href="' + PREFIX + 'fan9999.lzh">後期</a></li>'), /AMBIGUOUS_LATEST_LINK/);
  assert.throws(() => discoverLatestRacerSource('<li>2026年2027年<a href="' + PREFIX + 'fan2604.lzh">後期</a></li>'), /AMBIGUOUS_INDEX_YEAR/);
});

test('record validation requires a complete unique cohort and returns the observed consistent period', () => {
  assert.deepEqual(validateLatestRacerRecords(records(), SOURCE), {
    record_count: 1000, term_start_date: '2025-11-01', term_end_date: '2026-04-30',
  });
  for (const count of [0, 999, 3001]) assert.throws(() => validateLatestRacerRecords(records(count), SOURCE), /INVALID_RECORD_COUNT/);
  const duplicate = records(); duplicate[999].registration_number = duplicate[0].registration_number;
  assert.throws(() => validateLatestRacerRecords(duplicate, SOURCE), /DUPLICATE_REGISTRATION/);
  const invalid = records(); invalid[500].registration_number = '1e03';
  assert.throws(() => validateLatestRacerRecords(invalid, SOURCE), /INVALID_REGISTRATION/);
});

test('one mixed term, malformed date, wrong calculation period or unusable statistic rejects the entire cohort', () => {
  for (const [patch, reason] of [
    [{ term_key: '2026_FIRST' }, /PAGE_RECORD_TERM_MISMATCH/],
    [{ term_year: 2025 }, /PAGE_RECORD_TERM_MISMATCH/],
    [{ term_end_date: '2026-02-30' }, /INVALID_PERIOD_DATE/],
    [{ term_start_date: '2025-05-01', term_end_date: '2025-10-31' }, /INCOHERENT_PERIOD/],
    [{ win_rate: null }, /INVALID_STAT_WIN_RATE/],
    [{ fukusho_rate: 101 }, /INVALID_STAT_FUKUSHO_RATE/],
    [{ avg_st: NaN }, /INVALID_STAT_AVG_ST/],
    [{ race_count: -1 }, /INVALID_RACE_COUNT/],
    [{ racer_name: '\ufffd' }, /INVALID_RACER_NAME/],
  ]) {
    const cohort = records(); Object.assign(cohort[999], patch);
    assert.throws(() => validateLatestRacerRecords(cohort, SOURCE), reason);
  }
});

test('the fetch worker requests only the index and latest archive, uses byte parsing and returns an SHA-256 content hash', async () => {
  const env = await actualFetchWorker();
  const before = Date.now();
  const result = await env.fetchLatestRacerDataset({ budget: Date.now() + 5000 });
  assert.deepEqual(env.calls, [RACER_OFFICIAL_INDEX_URL, LATEST_URL]);
  assert.deepEqual(result.source, SOURCE);
  assert.equal(result.record_count, 1000);
  assert.equal(result.records.length, 1000);
  assert.equal(result.records[0].win_rate, 5.2);
  assert.equal(result.records[0].avg_st, 0.17);
  assert.equal(result.term_start_date, '2025-11-01');
  assert.equal(result.term_end_date, '2026-04-30');
  assert.match(result.checksum, /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(result.fetched_at) >= before && Date.parse(result.fetched_at) <= Date.now());
  assert.equal(result.unchanged, false);
  const second = await env.fetchLatestRacerDataset({ budget: Date.now() + 5000, previousChecksum: result.checksum });
  assert.equal(second.unchanged, true);
  assert.equal(second.records.length, 1000);
  assert.equal(second.checksum, result.checksum);
  assert.equal(env.state.closed, 2);
});

test('every course needs integer entries and rank counts, consistent totals, and a usable ST', () => {
  for (const [patch, reason] of [
    [null, /INVALID_COURSE_ENTRIES/],
    [{ entries: -1 }, /INVALID_COURSE_ENTRIES/],
    [{ entries: 1.5 }, /INVALID_COURSE_ENTRIES/],
    [{ first_count: -1 }, /INVALID_COURSE_FINISH_COUNT/],
    [{ sixth_count: null }, /INVALID_COURSE_FINISH_COUNT/],
    [{ third_count: 1.5 }, /INVALID_COURSE_FINISH_COUNT/],
    [{ first_count: 3 }, /COURSE_FINISHES_EXCEED_ENTRIES/],
    [{ avg_st: null }, /INVALID_COURSE_AVG_ST/],
    [{ avg_st: -0.01 }, /INVALID_COURSE_AVG_ST/],
    [{ avg_st: 5.01 }, /INVALID_COURSE_AVG_ST/],
  ]) {
    const cohort = records();
    if (patch === null) delete cohort[999].course_stats['6'];
    else Object.assign(cohort[999].course_stats['6'], patch);
    assert.throws(() => validateLatestRacerRecords(cohort, SOURCE), reason);
  }
});

test('an exhausted budget performs no request and a latest-file HTTP failure never requests an old file', async () => {
  const expired = await actualFetchWorker();
  await assert.rejects(expired.fetchLatestRacerDataset({ budget: Date.now() - 1 }), /BUDGET_EXHAUSTED/);
  assert.deepEqual(expired.calls, []);
  const unavailable = await actualFetchWorker({ http: async (url) => url === LATEST_URL ? new Response('', { status: 404 }) : null });
  await assert.rejects(unavailable.fetchLatestRacerDataset(), /HTTP_404/);
  assert.deepEqual(unavailable.calls, [RACER_OFFICIAL_INDEX_URL, LATEST_URL]);
  assert.equal(unavailable.state.decoderLoaded, 0);
});

test('redirects cannot escape official hosts or silently switch the archive to an older file', async () => {
  const escape = await actualFetchWorker({ http: async () => new Response(null, {
    status: 302, headers: { location: 'https://attacker.invalid/collect' },
  }) });
  await assert.rejects(escape.fetchLatestRacerDataset(), /UNTRUSTED_URL/);
  assert.deepEqual(escape.calls, [RACER_OFFICIAL_INDEX_URL]);
  const older = await actualFetchWorker({ http: async (url) => url === LATEST_URL ? new Response(null, {
    status: 302, headers: { location: PREFIX + 'fan2510.lzh' },
  }) : null });
  await assert.rejects(older.fetchLatestRacerDataset(), /REDIRECT_PATH_CHANGED/);
  assert.deepEqual(older.calls, [RACER_OFFICIAL_INDEX_URL, LATEST_URL]);
});

test('oversized HTTP/archive payloads are rejected before extraction', async () => {
  const httpSize = await actualFetchWorker({ http: async (url) => url === LATEST_URL ? new Response(archiveBytes, {
    headers: { 'content-length': '5000000' },
  }) : null });
  await assert.rejects(httpSize.fetchLatestRacerDataset(), /RESPONSE_TOO_LARGE/);
  assert.equal(httpSize.state.decoderLoaded, 0);
  const unpacked = await actualFetchWorker({ uncompressedSize: 2_000_001 });
  await assert.rejects(unpacked.fetchLatestRacerDataset(), /INVALID_TEXT_SIZE/);
  assert.equal(unpacked.state.extracted, 0);
  assert.equal(unpacked.state.closed, 1);
});

test('archive CRC failure and unexpected members cannot produce a successful dataset', async () => {
  const corrupt = await actualFetchWorker({ crcError: true });
  await assert.rejects(corrupt.fetchLatestRacerDataset(), /LHA_CRC_MISMATCH/);
  assert.equal(corrupt.state.closed, 1);
  for (const filename of ['fan2510.txt', '../fan2604.txt', 'subdir/fan2604.txt']) {
    const member = await actualFetchWorker({ members: [{ filename, directory: false, uncompressedSize: 418000 }] });
    await assert.rejects(member.fetchLatestRacerDataset(), /UNEXPECTED_ARCHIVE_MEMBERS/);
    assert.equal(member.state.closed, 1);
  }
});

test('a short row is not silently discarded by the permissive legacy parser', async () => {
  const text = syntheticText();
  text[416 * 2] = 10;
  const env = await actualFetchWorker({ text });
  await assert.rejects(env.fetchLatestRacerDataset(), /INVALID_FIXED_WIDTH/);
  assert.equal(env.state.closed, 1);
});

test('a corrupt course count cannot be converted to a fabricated zero by the legacy parser', async () => {
  const text = syntheticText();
  text[198] = 88; // "X00" in course 1 first_count.
  const env = await actualFetchWorker({ text });
  await assert.rejects(env.fetchLatestRacerDataset(), /INVALID_NUMERIC_COLUMN/);
});
