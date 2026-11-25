// Public BOATCAST original-exhibition feed used by its OriginalDisplayData view.
// One bounded GET during the existing exhibition collection; no LLM or new schedule.
// Feed URL verified from https://race.boatcast.jp/assets/js/OriginalDisplayData.js.
const SOURCE_KIND = 'OFFICIAL_ORIGINAL_EXHIBITION';
const PROVIDER = 'BOATCAST';
const TEXT_LIMIT = 16384;
const RETRY_GAP_MS = 60000;
// The hosted backend can inject fetch lexically without exposing globalThis.fetch.
// Use the same bare fetch call as the existing official/BOATCAST collectors.
const runtimeFetch = (url, options) => fetch(url, options);
function reportFetchFailure(sourceUrl, error) {
  const name = String(error?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
  const message = String(error?.message || 'fetch failed')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\b(authorization|bearer|token|api[_-]?key|password)\b\s*[:=]?\s*(?:Bearer\s+)?[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 300);
  // The URL is built from validated public race identifiers. Never log the
  // exception object/cause, stack, request headers or response body.
  console.warn('OriginalExhibition fetch failed', JSON.stringify({ source_url: sourceUrl, name, message }));
}
// Legacy RaceEntry names include e.g. 有賀達也埼玉/埼玉. Remove only a
// recognized trailing affiliation pair; never use fuzzy or prefix name matching.
const REGIONS = ['北海道','青森','岩手','宮城','秋田','山形','福島','茨城','栃木','群馬','埼玉','千葉','東京','神奈川','新潟','富山','石川','福井','山梨','長野','岐阜','静岡','愛知','三重','滋賀','京都','大阪','兵庫','奈良','和歌山','鳥取','島根','岡山','広島','山口','徳島','香川','愛媛','高知','福岡','佐賀','長崎','熊本','大分','宮崎','鹿児島','沖縄'];
const REGION_SUFFIX = new RegExp('(?:' + REGIONS.join('|') + ')/(?:' + REGIONS.join('|') + ')$');
const nameKey = value => typeof value === 'string' ? value.normalize('NFKC').replace(/[\s\u3000]+/g, '').replace(REGION_SUFFIX, '') : '';
const registration = value => String(value?.registration_number ?? value?.register_number ?? '').trim();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const boat = value => /^(?:[1-6])$/.test(String(value ?? '').trim()) ? Number(value) : null;
const measurement = (value, low, high) => {
  if (typeof value !== 'string' || !/^\d{1,2}\.\d{1,2}$/.test(value.trim())) return null;
  const number = Number(value);
  return number >= low && number <= high ? number : null;
};

function identity(race) {
  const raceDate = race?.race_date, code = String(race?.venue_code ?? '').padStart(2, '0'), number = Number(race?.race_number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate || '') || !Number.isFinite(Date.parse(raceDate + 'T00:00:00Z'))
    || new Date(raceDate + 'T00:00:00Z').toISOString().slice(0, 10) !== raceDate
    || !/^(?:0[1-9]|1[0-9]|2[0-4])$/.test(code) || !Number.isInteger(number) || number < 1 || number > 12) return null;
  const key = raceDate + '_' + code + '_' + String(number).padStart(2, '0');
  if (race.race_key && race.race_key !== key) return null;
  return { race_date: raceDate, venue_code: code, race_number: number, race_key: key };
}

export function buildOriginalExhibitionUrl(race) {
  const id = identity(race);
  return id ? 'https://race.boatcast.jp/txt/' + id.venue_code + '/bc_oriten_' + id.race_date.replaceAll('-', '')
    + '_' + id.venue_code + '_' + String(id.race_number).padStart(2, '0') + '.txt' : null;
}

function sourceMatches(url, race) {
  const id = identity(race);
  if (!id) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && ['boatrace.jp', 'www.boatrace.jp'].includes(parsed.hostname) && parsed.pathname === '/owpc/pc/race/beforeinfo'
      && parsed.searchParams.get('hd') === id.race_date.replaceAll('-', '')
      && String(parsed.searchParams.get('jcd') || '').padStart(2, '0') === id.venue_code
      && Number(parsed.searchParams.get('rno')) === id.race_number;
  } catch { return false; }
}

function context(race, options) {
  const id = identity(race), capturedAt = options.capturedAt || new Date().toISOString();
  return {
    ...(id || {}), status: 'UNAVAILABLE', source_kind: SOURCE_KIND, provider: PROVIDER,
    source_url: buildOriginalExhibitionUrl(race), captured_at: capturedAt,
    exhibition_source_url: options.exhibitionSourceUrl || null,
    exhibition_captured_at: options.exhibitionCapturedAt || null,
    matching: 'BOAT_AND_NAME', entries: [], reasons: [],
  };
}
function unavailable(base, reason) { return { ...base, status: 'UNAVAILABLE', entries: [], reasons: [reason] }; }
function rosterKey(expected) {
  return JSON.stringify(expected.active.map(b => [b, registration(expected.byBoat.get(b)), nameKey(expected.byBoat.get(b).player_name || expected.byBoat.get(b).racer_name), expected.exhibition.get(b).exhibition_time]));
}

function roster(race, entries, exhibitionEntries) {
  if (!Array.isArray(entries) || !Array.isArray(exhibitionEntries)) return { error: 'ROSTER_MISSING' };
  const byBoat = new Map(), exhibition = new Map(), excluded = new Set();
  for (const value of race.scratched_boats || []) { const b = boat(value); if (b == null) return { error: 'SCRATCHED_BOATS_INVALID' }; excluded.add(b); }
  for (const entry of entries) {
    const b = boat(entry?.boat_number);
    if (b == null || byBoat.has(b)) return { error: 'ROSTER_AMBIGUOUS' };
    byBoat.set(b, entry);
    if (entry.is_absent || entry.is_scratched) excluded.add(b);
  }
  for (const entry of exhibitionEntries) {
    const b = boat(entry?.boat_number);
    if (b == null || exhibition.has(b)) return { error: 'EXHIBITION_BOATS_AMBIGUOUS' };
    exhibition.set(b, entry);
    if (entry.is_absent || entry.is_scratched) excluded.add(b);
  }
  const active = [1, 2, 3, 4, 5, 6].filter(b => !excluded.has(b));
  if (active.length < 3) return { error: 'ACTIVE_BOATS_INVALID' };
  for (const b of active) {
    const entry = byBoat.get(b), observed = exhibition.get(b);
    if (!entry || !observed || !registration(entry) || registration(entry) !== registration(observed)) return { error: 'EXHIBITION_RACER_MISMATCH' };
    if (!nameKey(entry.player_name || entry.racer_name)) return { error: 'ROSTER_NAME_MISSING' };
    if (!finite(observed.exhibition_time) || observed.exhibition_time < 4 || observed.exhibition_time > 10) return { error: 'EXHIBITION_TIME_MISSING' };
  }
  return { byBoat, exhibition, excluded, active };
}

/** Parse labels, explicit boat numbers and racer names; never infer a row's boat from its position. */
export function parseOriginalExhibition(text, { race, entries, exhibitionEntries, exhibitionSourceUrl, exhibitionCapturedAt, capturedAt } = {}) {
  const options = { exhibitionSourceUrl, exhibitionCapturedAt, capturedAt }, base = context(race, options);
  if (!identity(race)) return unavailable(base, 'RACE_IDENTITY_INVALID');
  if (!sourceMatches(exhibitionSourceUrl, race)) return unavailable(base, 'EXHIBITION_SOURCE_MISMATCH');
  if (isoTime(base.captured_at) == null || isoTime(exhibitionCapturedAt) == null || isoTime(exhibitionCapturedAt) > isoTime(base.captured_at)) return unavailable(base, 'SOURCE_TIME_INVALID');
  const expected = roster(race, entries, exhibitionEntries);
  if (expected.error) return unavailable(base, expected.error);
  base.roster_key = rosterKey(expected);
  if (typeof text !== 'string' || text.length > TEXT_LIMIT) return unavailable(base, 'SOURCE_FORMAT_INVALID');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  if (lines[0].trim() !== 'data=') return unavailable(base, 'SOURCE_FORMAT_INVALID');
  const header = (lines[1] || '').split('\t');
  const sourceStatus = header[0]?.trim(), columns = Number(header[1]);
  if (sourceStatus === '2') return { ...unavailable(base, 'MEASUREMENT_UNAVAILABLE'), source_status: sourceStatus };
  if (sourceStatus === '0') return { ...unavailable(base, 'NOT_PUBLISHED'), source_status: sourceStatus };
  if (sourceStatus !== '1' || !Number.isInteger(columns) || columns < 1 || columns > 4) return unavailable(base, 'SOURCE_HEADER_INVALID');
  const labels = (lines[2] || '').split('\t').map(nameKey);
  if (labels.length !== columns || new Set(labels).size !== columns) return unavailable(base, 'SOURCE_LABELS_INVALID');
  const fields = labels.map(label => /^(?:一周|1周|一周タイム|1周タイム)$/.test(label) ? 'lap_time'
    : /^(?:まわり足|周り足|回り足)(?:タイム)?$/.test(label) ? 'turn_time'
    : /^(?:直線|直線タイム)$/.test(label) ? 'straight_time' : null);
  const sourceRows = lines.slice(3).filter(line => line.trim()).map(line => line.split('\t'));
  const seen = new Set(), rows = [];
  for (const row of sourceRows) {
    const b = boat(row[0]);
    if (b == null || seen.has(b) || row.length !== columns + 2) return unavailable(base, 'SOURCE_BOATS_INVALID');
    seen.add(b);
    if (expected.excluded.has(b)) continue;
    const stored = expected.byBoat.get(b), observed = expected.exhibition.get(b);
    if (!stored || !observed || nameKey(row[1]) !== nameKey(stored.player_name || stored.racer_name)) return unavailable(base, 'SOURCE_RACER_MISMATCH');
    const output = {
      boat_number: b, registration_number: registration(stored), player_name: String(row[1]).trim(),
      exhibition_time: observed.exhibition_time, lap_time: null, turn_time: null, straight_time: null,
    };
    fields.forEach((field, index) => { if (field) output[field] = measurement(row[index + 2], field === 'lap_time' ? 20 : 2, field === 'lap_time' ? 80 : 20); });
    rows.push(output);
  }
  rows.sort((a, b) => a.boat_number - b.boat_number);
  const complete = expected.active.every(b => rows.some(row => row.boat_number === b && row.lap_time != null));
  const reasons = [];
  if (!fields.includes('lap_time')) reasons.push(labels.some(label => /半周/.test(label)) ? 'HALF_LAP_NOT_SUPPORTED' : 'LAP_TIME_NOT_PUBLISHED');
  else if (!complete) reasons.push('ORIGINAL_TIMES_PARTIAL');
  return { ...base, status: complete ? 'AVAILABLE' : rows.length ? 'PARTIAL' : 'UNAVAILABLE',
    source_status: sourceStatus, source_labels: labels, active_boat_count: expected.active.length,
    entries: rows, reasons };
}

function matchingCached(previous, race, expected) {
  const id = identity(race);
  if (!previous || !id || previous.source_kind !== SOURCE_KIND || previous.source_url !== buildOriginalExhibitionUrl(race)
    || previous.race_date !== id.race_date || previous.venue_code !== id.venue_code || previous.race_number !== id.race_number
    || !sourceMatches(previous.exhibition_source_url, race) || expected.error || !Array.isArray(previous.entries)) return false;
  if (previous.roster_key !== rosterKey(expected)) return false;
  if (previous.status === 'UNAVAILABLE') return true;
  const rows = new Map(previous.entries.map(row => [row.boat_number, row]));
  if (rows.size !== previous.entries.length) return false;
  return expected.active.every(b => {
    const row = rows.get(b), saved = expected.byBoat.get(b), observed = expected.exhibition.get(b);
    return row && registration(row) === registration(saved) && nameKey(row.player_name) === nameKey(saved.player_name || saved.racer_name)
      && row.exhibition_time === observed.exhibition_time;
  });
}

/** Whether the existing collection may skip another GET; data corrections invalidate the cache. */
export function reuseOriginalExhibition(previous, { race, entries, exhibitionEntries, nowMs = Date.now() } = {}) {
  const expected = roster(race || {}, entries, exhibitionEntries), captured = isoTime(previous?.captured_at);
  if (captured == null || captured > nowMs || new Date(captured + 9 * 3600000).toISOString().slice(0, 10) < race?.race_date || !matchingCached(previous, race, expected)) return null;
  if (previous.status === 'AVAILABLE' && expected.active.every(b => {
    const row = previous.entries.find(item => item.boat_number === b);
    return finite(row.lap_time) && row.lap_time >= 20 && row.lap_time <= 80
      && (String(race.venue_code).padStart(2, '0') !== '13'
        || (finite(row.turn_time) && row.turn_time >= 2 && row.turn_time <= 20));
  })) return previous;
  // A half-lap or an explicitly unmeasurable race cannot become a full lap by retries.
  if (previous.reasons?.some(reason => ['HALF_LAP_NOT_SUPPORTED', 'MEASUREMENT_UNAVAILABLE'].includes(reason))) return previous;
  // Amagasaki's basic SUM can be AVAILABLE while its turn time is still pending.
  // Keep the basic calculation, then retry for the documented three-part SUM.
  if (nowMs - captured < RETRY_GAP_MS && ['AVAILABLE', 'PARTIAL', 'UNAVAILABLE'].includes(previous.status)) return previous;
  return null;
}

export async function fetchOriginalExhibition({ race, entries, exhibitionEntries, exhibitionSourceUrl,
  exhibitionCapturedAt, deadlineMs = Infinity, timeoutMs = 2500, fetcher = runtimeFetch } = {}) {
  const nowMs = Date.now(), base = context(race, { exhibitionSourceUrl, exhibitionCapturedAt, capturedAt: new Date(nowMs).toISOString() });
  if (!identity(race)) return { snapshot: unavailable(base, 'RACE_IDENTITY_INVALID'), fetched: false };
  if (!sourceMatches(exhibitionSourceUrl, race)) return { snapshot: unavailable(base, 'EXHIBITION_SOURCE_MISMATCH'), fetched: false };
  const expected = roster(race, entries, exhibitionEntries);
  if (expected.error) return { snapshot: unavailable(base, expected.error), fetched: false };
  base.roster_key = rosterKey(expected);
  if (isoTime(exhibitionCapturedAt) == null || isoTime(exhibitionCapturedAt) > nowMs) return { snapshot: unavailable(base, 'SOURCE_TIME_INVALID'), fetched: false };
  const cached = reuseOriginalExhibition(race.original_exhibition, { race, entries, exhibitionEntries, nowMs });
  if (cached) return { snapshot: cached, fetched: false, reused: true };
  const remaining = deadlineMs - nowMs;
  if (!(remaining > 150)) return { snapshot: unavailable(base, 'FETCH_TIME_BUDGET'), fetched: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(100, timeoutMs), remaining));
  try {
    const response = await fetcher(base.source_url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/plain', 'Accept-Language': 'ja,en;q=0.9' } });
    const capturedAt = new Date().toISOString();
    if (!response.ok || response.status !== 200) return { snapshot: { ...unavailable({ ...base, captured_at: capturedAt }, 'HTTP_' + response.status), http_status: response.status }, fetched: true };
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > TEXT_LIMIT) return { snapshot: unavailable({ ...base, captured_at: capturedAt }, 'SOURCE_TOO_LARGE'), fetched: true };
    const text = await response.text();
    const snapshot = parseOriginalExhibition(text, { race, entries, exhibitionEntries, exhibitionSourceUrl, exhibitionCapturedAt, capturedAt: new Date().toISOString() });
    return { snapshot, fetched: true };
  } catch (error) {
    reportFetchFailure(base.source_url, error);
    const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return { snapshot: unavailable({ ...base, captured_at: new Date().toISOString() }, timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED'), fetched: true };
  } finally { clearTimeout(timer); }
}
