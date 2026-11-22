import { parseRacerTermFile } from './racerTermParser.js';

export const RACER_OFFICIAL_INDEX_URL = 'https://www.boatrace.jp/owpc/pc/extra/data/download.html';
const INDEX_PATH = '/owpc/pc/extra/data/download.html';
const ARCHIVE_PATH = /^\/static_extra\/pc_static\/download\/data\/kibetsu\/fan\d{4}\.lzh$/;
const MAX_INDEX_BYTES = 1_000_000;
const MAX_ARCHIVE_BYTES = 4_000_000;
const MAX_TEXT_BYTES = 2_000_000;
const MIN_RECORDS = 1000;
const MAX_RECORDS = 3000;

const fail = (reason) => { throw new Error('LATEST_RACER_' + reason); };
const requireBudget = (budget) => {
  if (!Number.isFinite(budget) || Date.now() >= budget) fail('BUDGET_EXHAUSTED');
};

function officialUrl(value, baseUrl, kind) {
  let url;
  try { url = new URL(value, baseUrl); } catch { fail('INVALID_URL'); }
  if (url.protocol !== 'https:' || !['www.boatrace.jp', 'boatrace.jp'].includes(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash) fail('UNTRUSTED_URL');
  if (kind === 'index' ? url.pathname !== INDEX_PATH : !ARCHIVE_PATH.test(url.pathname)) fail('UNTRUSTED_PATH');
  return url;
}

function unescapeHtml(value) {
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    if (named[entity.toLowerCase()] != null) return named[entity.toLowerCase()];
    const numeric = entity.slice(2, -1);
    const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const plainText = (html) => unescapeHtml(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * Select only a link actually published beside its year and 前期/後期 label.
 * Neither the current date nor a fan filename is used to invent a newer URL.
 */
export function discoverLatestRacerSource(html, baseUrl = RACER_OFFICIAL_INDEX_URL) {
  const index = officialUrl(baseUrl, RACER_OFFICIAL_INDEX_URL, 'index');
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_INDEX_BYTES) fail('INVALID_INDEX');
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const candidates = [];
  for (const row of cleaned.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const years = [...new Set([...plainText(row[1]).matchAll(/\b(20\d{2})\s*年/g)].map((m) => Number(m[1])))];
    for (const anchor of row[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const label = plainText(anchor[2]);
      if (!/^(前期|後期)$/.test(label) || years.length === 0) continue;
      if (years.length !== 1) fail('AMBIGUOUS_INDEX_YEAR');
      const href = anchor[1].match(/(?:^|\s)href\s*=\s*(["'])(.*?)\1/i);
      if (!href) continue;
      const url = officialUrl(unescapeHtml(href[2]), index.href, 'archive');
      const half = label === '前期' ? 'FIRST' : 'SECOND';
      candidates.push({
        url: url.href,
        index_url: index.href,
        file_name: url.pathname.split('/').pop(),
        term_key: years[0] + '_' + half,
        term_year: years[0],
        term_half: half,
      });
    }
  }
  if (!candidates.length) fail('LATEST_LINK_NOT_FOUND');
  candidates.sort((a, b) => b.term_year - a.term_year || (b.term_half === 'SECOND' ? 2 : 1) - (a.term_half === 'SECOND' ? 2 : 1));
  const latest = candidates[0];
  if (candidates.some((x) => x.term_key === latest.term_key && x.url !== latest.url)) fail('AMBIGUOUS_LATEST_LINK');
  return latest;
}

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_PERIOD_DATE');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('INVALID_PERIOD_DATE');
  return date.getTime();
}

/**
 * The official record contains its own year, half and calculation period.
 * Page labels must match every row; no filename-based override is applied.
 */
export function validateLatestRacerRecords(records, source) {
  if (!Array.isArray(records) || records.length < MIN_RECORDS || records.length > MAX_RECORDS) fail('INVALID_RECORD_COUNT');
  const year = source?.term_year;
  const half = source?.term_half;
  if (!Number.isInteger(year) || year < 2000 || year > 2099 || !['FIRST', 'SECOND'].includes(half)
    || source.term_key !== year + '_' + half) fail('INVALID_SOURCE_TERM');
  const expectedStart = half === 'SECOND' ? (year - 1) + '-11-01' : (year - 1) + '-05-01';
  const expectedEnd = half === 'SECOND' ? year + '-04-30' : (year - 1) + '-10-31';
  const registrations = new Set();
  for (const row of records) {
    if (!row || !/^\d{4}$/.test(String(row.registration_number || ''))) fail('INVALID_REGISTRATION');
    if (registrations.has(String(row.registration_number))) fail('DUPLICATE_REGISTRATION');
    registrations.add(String(row.registration_number));
    if (row.term_year !== year || row.term_half !== half || row.term_key !== source.term_key) fail('PAGE_RECORD_TERM_MISMATCH');
    const start = dateValue(row.term_start_date);
    const end = dateValue(row.term_end_date);
    if (start >= end || row.term_start_date !== expectedStart || row.term_end_date !== expectedEnd) fail('INCOHERENT_PERIOD');
    if (typeof row.racer_name !== 'string' || !row.racer_name.trim() || row.racer_name.includes('\ufffd')) fail('INVALID_RACER_NAME');
    for (const [key, max] of [['win_rate', 20], ['fukusho_rate', 100], ['avg_st', 5]]) {
      if (!Number.isFinite(row[key]) || row[key] < 0 || row[key] > max) fail('INVALID_STAT_' + key.toUpperCase());
    }
    if (!Number.isInteger(row.race_count) || row.race_count < 0 || row.race_count > 999) fail('INVALID_RACE_COUNT');
    for (let course = 1; course <= 6; course++) {
      const stats = row.course_stats?.[String(course)];
      if (!stats || !Number.isInteger(stats.entries) || stats.entries < 0) fail('INVALID_COURSE_ENTRIES');
      let finishes = 0;
      for (const rank of ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']) {
        const count = stats[rank + '_count'];
        if (!Number.isInteger(count) || count < 0) fail('INVALID_COURSE_FINISH_COUNT');
        finishes += count;
      }
      if (finishes > stats.entries) fail('COURSE_FINISHES_EXCEED_ENTRIES');
      if (!Number.isFinite(stats.avg_st) || stats.avg_st < 0 || stats.avg_st > 5) fail('INVALID_COURSE_AVG_ST');
    }
  }
  return { record_count: records.length, term_start_date: expectedStart, term_end_date: expectedEnd };
}

async function fetchOfficialBytes(value, kind, budget, maxBytes) {
  requireBudget(budget);
  let url = officialUrl(value, RACER_OFFICIAL_INDEX_URL, kind);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(12000, budget - Date.now()));
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      requireBudget(budget);
      const response = await fetch(url.href, { signal: controller.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) fail('REDIRECT_LIMIT');
        const next = officialUrl(location, url.href, kind);
        // Host canonicalization is allowed, silently switching to an older file is not.
        if (next.pathname !== url.pathname) fail('REDIRECT_PATH_CHANGED');
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail('HTTP_' + response.status);
      }
      if (response.url) {
        const observed = officialUrl(response.url, url.href, kind);
        if (observed.pathname !== url.pathname) fail('RESPONSE_PATH_CHANGED');
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > maxBytes) {
        await response.body?.cancel();
        fail('RESPONSE_TOO_LARGE');
      }
      if (!response.body) fail('EMPTY_RESPONSE');
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          requireBudget(budget);
          const { value: chunk, done } = await reader.read();
          if (done) break;
          total += chunk.byteLength;
          if (total > maxBytes) fail('RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      requireBudget(budget);
      if (!total) fail('EMPTY_RESPONSE');
      const bytes = new Uint8Array(total);
      let position = 0;
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
      return bytes;
    }
    fail('REDIRECT_LIMIT');
  } finally { clearTimeout(timeout); }
}

function validateFixedWidthBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_TEXT_BYTES) fail('INVALID_TEXT_SIZE');
  let start = 0;
  let count = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 10) continue;
    let end = i;
    if (end > start && bytes[end - 1] === 13) end--;
    const length = end - start;
    if (length > 0) {
      if (length !== 416) fail('INVALID_FIXED_WIDTH');
      // The legacy parser maps an unreadable rank count to zero. Reject damaged
      // numeric columns first, before that permissive conversion loses the evidence.
      for (const [offset, width] of [[58, 102], [174, 24], [198, 212]]) {
        for (let column = start + offset; column < start + offset + width; column++) {
          if (bytes[column] < 48 || bytes[column] > 57) fail('INVALID_NUMERIC_COLUMN');
        }
      }
      count++;
    }
    start = i + 1;
  }
  if (count < MIN_RECORDS || count > MAX_RECORDS) fail('INVALID_RECORD_COUNT');
  return count;
}

async function extractOfficialText(bytes, source, budget) {
  requireBudget(budget);
  if (bytes.length < 24 || !/^-lh[014567]-$/.test(new TextDecoder().decode(bytes.subarray(2, 7)))) fail('INVALID_LZH');
  // Lazy import keeps pure discovery/validation usable in Node tests.
  const { LhaReader, Uint8ArrayReader, Uint8ArrayWriter } = await import('npm:@kirinsaninc/lhats@0.1.0');
  requireBudget(budget);
  const reader = new LhaReader(new Uint8ArrayReader(bytes), {
    filenameDecoder: (name) => new TextDecoder('shift_jis', { fatal: true }).decode(name),
    checkCrc: 'throw',
  });
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory);
    const expectedName = source.file_name.replace(/\.lzh$/, '.txt');
    if (entries.length !== 1 || entries[0].filename !== expectedName || entries[0].encrypted) fail('UNEXPECTED_ARCHIVE_MEMBERS');
    const entry = entries[0];
    if (!Number.isInteger(entry.uncompressedSize) || entry.uncompressedSize < 416 * MIN_RECORDS
      || entry.uncompressedSize > MAX_TEXT_BYTES) fail('INVALID_TEXT_SIZE');
    requireBudget(budget);
    const text = await entry.getData(new Uint8ArrayWriter());
    requireBudget(budget);
    if (!(text instanceof Uint8Array) || text.length !== entry.uncompressedSize) fail('TRUNCATED_ARCHIVE_MEMBER');
    return text;
  } finally { await reader.close(); }
}

/**
 * budget is an absolute epoch-millisecond deadline, like readV8Rows.
 * Fetches one current index and only its latest published archive. No DB writes.
 */
export async function fetchLatestRacerDataset({ budget = Date.now() + 25000, previousChecksum } = {}) {
  requireBudget(budget);
  const indexBytes = await fetchOfficialBytes(RACER_OFFICIAL_INDEX_URL, 'index', budget, MAX_INDEX_BYTES);
  const source = discoverLatestRacerSource(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes));
  const archiveBytes = await fetchOfficialBytes(source.url, 'archive', budget, MAX_ARCHIVE_BYTES);
  const digest = await crypto.subtle.digest('SHA-256', archiveBytes);
  const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  const text = await extractOfficialText(archiveBytes, source, budget);
  const lineCount = validateFixedWidthBytes(text);
  const parsed = parseRacerTermFile(text.buffer.slice(text.byteOffset, text.byteOffset + text.byteLength), source.file_name.replace(/\.lzh$/, '.txt'));
  if (!parsed.ok || parsed.errors?.length || parsed.warnings?.length || parsed.data?.records?.length !== lineCount) fail('PARSE_FAILED');
  const records = parsed.data.records;
  const metadata = validateLatestRacerRecords(records, source);
  requireBudget(budget);
  return {
    source, checksum, fetched_at: new Date().toISOString(), records, ...metadata,
    unchanged: typeof previousChecksum === 'string' && previousChecksum === checksum,
  };
}
