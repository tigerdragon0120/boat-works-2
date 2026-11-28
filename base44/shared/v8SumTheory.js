// Verified public arithmetic only. Ticket construction and the V8 weighting
// remain our uncalibrated research rules, not the author's complete strategy.
export const SUM_REVISION = 'V8_SUM_1';
export const SUM_SOURCE_KIND = 'OFFICIAL_ORIGINAL_EXHIBITION';
const CUTOFF_MS = 60000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => finite(value) ? Math.round(value * 1000000) / 1000000 : null;
const range = (value, min, max) => finite(value) && value >= min && value <= max ? value : null;
const boatNumber = value => Number.isInteger(value) && value >= 1 && value <= 6;
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
};
const venue = value => /^\d{1,2}$/.test(String(value ?? '')) ? String(value).padStart(2, '0') : null;
const registration = row => String(row?.registration_number ?? row?.register_number ?? '').trim();
const sourceUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};
const RAW_FIELDS = ['status', 'source_kind', 'provider', 'source_url', 'exhibition_source_url', 'captured_at', 'exhibition_captured_at', 'venue_code', 'race_date', 'race_number', 'race_key', 'race_id'];
const ROW_FIELDS = ['boat_number', 'registration_number', 'exhibition_time', 'lap_time', 'turn_time', 'straight_time'];
const ACQUISITION_REASONS = new Set([
  'HALF_LAP_NOT_SUPPORTED', 'MEASUREMENT_UNAVAILABLE', 'LAP_TIME_NOT_PUBLISHED', 'ORIGINAL_TIMES_PARTIAL',
  'FETCH_TIMEOUT', 'FETCH_FAILED', 'FETCH_TIME_BUDGET', 'NOT_PUBLISHED',
  'RACE_IDENTITY_INVALID', 'ROSTER_MISSING', 'ROSTER_AMBIGUOUS', 'ROSTER_NAME_MISSING',
  'SCRATCHED_BOATS_INVALID', 'ACTIVE_BOATS_INVALID', 'EXHIBITION_BOATS_AMBIGUOUS',
  'EXHIBITION_RACER_MISMATCH', 'EXHIBITION_TIME_MISSING', 'EXHIBITION_SOURCE_MISMATCH',
  'SOURCE_TIME_INVALID', 'SOURCE_FORMAT_INVALID', 'SOURCE_HEADER_INVALID', 'SOURCE_LABELS_INVALID',
  'SOURCE_BOATS_INVALID', 'SOURCE_RACER_MISMATCH', 'SOURCE_TOO_LARGE',
]);
const acquisitionReasons = value => !Array.isArray(value) ? [] : [...new Set(value.filter(reason =>
  typeof reason === 'string' && (ACQUISITION_REASONS.has(reason) || /^HTTP_[1-5]\d{2}$/.test(reason))))].slice(0, 16);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value || {}, key))
  .map(key => [key, ['string', 'number', 'boolean'].includes(typeof value[key]) ? value[key] : null]));
// This is only an input whitelist. Call buildSumEvidence for trust/identity checks.
export function sanitizeOriginalExhibition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return { ...pick(raw, RAW_FIELDS), reasons: acquisitionReasons(raw.reasons ?? raw.acquisition_reasons),
    entries: Array.isArray(raw.entries) ? raw.entries.map(row => pick(row, ROW_FIELDS)) : null };
}
// Ignore repeated fetch timestamps while detecting data corrections or added times.
export function sumObservationKey(raw) {
  const value = sanitizeOriginalExhibition(raw);
  if (!value || !['AVAILABLE', 'PARTIAL'].includes(value.status) || value.source_kind !== SUM_SOURCE_KIND
    || !Array.isArray(value.entries) || !value.entries.some(row => finite(row.lap_time))) return null;
  const { captured_at, exhibition_captured_at, reasons, ...content } = value;
  content.entries = [...content.entries].sort((a, b) => a.boat_number - b.boat_number);
  let hash = 2166136261;
  const text = JSON.stringify(content);
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function matchingSourceUrls(raw, race, url) {
  const code = venue(race.venue_code), day = race.race_date.replaceAll('-', ''), round = String(Number(race.race_number)).padStart(2, '0');
  const original = new URL(url);
  if (original.hostname !== 'race.boatcast.jp' || original.pathname !== '/txt/' + code + '/bc_oriten_' + day + '_' + code + '_' + round + '.txt') return false;
  // Accept only the canonical same-race TKZ URL emitted by the verified fallback.
  // Compare raw text so URL normalization cannot admit aliases or extra metadata.
  if (raw.exhibition_source_url === 'https://race.boatcast.jp/hp_txt/' + code + '/bc_j_tkz_' + day + '_' + code + '_' + round + '.txt') return true;
  const exhibition = sourceUrl(raw.exhibition_source_url);
  if (!exhibition) return false;
  const reference = new URL(exhibition);
  return ['boatrace.jp', 'www.boatrace.jp'].includes(reference.hostname) && reference.pathname === '/owpc/pc/race/beforeinfo'
    && reference.searchParams.get('hd') === day && venue(reference.searchParams.get('jcd')) === code
    && Number(reference.searchParams.get('rno')) === Number(race.race_number);
}
const emptyModel = (key, status, missing = []) => ({
  key, label: key === 'SUM_BASIC' ? '基本SUM' : '尼崎・3項SUM', status,
  formula: key === 'SUM_BASIC' ? '展示＋1周' : '展示＋1周＋周り足',
  fields: key === 'SUM_BASIC' ? ['exhibition_time', 'lap_time'] : ['exhibition_time', 'lap_time', 'turn_time'],
  mean: null, boats: [], missing,
  interpretation: 'POSITIVE_IS_FASTER_THAN_RACE_MEAN',
  published_rule_scope: 'ARITHMETIC_ONLY_NOT_COMPLETE_AUTHOR_STRATEGY',
});

function calculate(key, rows) {
  const template = emptyModel(key, 'INSUFFICIENT');
  const missing = rows.filter(row => template.fields.some(field => row[field] == null))
    .map(row => 'BOAT_' + row.boat_number + '_SUM_INPUT_MISSING');
  const totals = rows.map(row => ({ ...row, total: template.fields.every(field => row[field] != null)
    ? template.fields.reduce((total, field) => total + row[field], 0) : null }));
  // A subset mean would silently change the comparison group. Never calculate it.
  if (missing.length) return { ...template, missing, boats: totals.map(row => ({ ...row, total: round(row.total), delta: null, relative_score: null })) };
  const mean = totals.reduce((total, row) => total + row.total, 0) / totals.length;
  const min = Math.min(...totals.map(row => row.total)), max = Math.max(...totals.map(row => row.total));
  return {
    ...template, status: 'READY', mean: round(mean), missing: [],
    boats: totals.map(row => ({ ...row, total: round(row.total), delta: round(mean - row.total),
      relative_score: round(max === min ? 50 : (max - row.total) / (max - min) * 100) })),
    has_difference: max !== min,
  };
}

/** Validate race/boat/source chronology before exposing any original times. */
export function buildSumEvidence({ race, boats = [], originalExhibition = null, stage, now, replay = false }) {
  const base = {
    revision: SUM_REVISION, status: 'INSUFFICIENT', source_url: null, captured_at: null,
    exhibition_source_url: null, exhibition_captured_at: null, input_as_of: null,
    source_kind: null, provider: null, active_count: 0, mean_basis: 'SIX_BOATS',
    basic: emptyModel('SUM_BASIC', 'INSUFFICIENT'),
    venue_specific: emptyModel('SUM_AMAGASAKI', venue(race?.venue_code) === '13' ? 'INSUFFICIENT' : 'UNSUPPORTED_VENUE'),
    selected_model: null, used_for_scoring: false, missing: [], acquisition_reasons: [],
    author_strategy_reproduced: false, ticket_rule: 'OWN_RESEARCH_RANKING',
    note: '公開資料で確認できた合算を計算。評価への配分と買い目生成は独自の研究ルールです。',
  };
  if (!['FINAL', 'LOCK'].includes(stage)) return { evidence: {
    ...base, status: 'WAIT_EXHIBITION', basic: emptyModel('SUM_BASIC', 'WAIT_EXHIBITION', ['STAGE_PRE']),
    venue_specific: emptyModel('SUM_AMAGASAKI', 'WAIT_EXHIBITION', ['STAGE_PRE']), missing: ['STAGE_PRE'],
  }, original_exhibition: null };
  const raw = sanitizeOriginalExhibition(originalExhibition);
  base.acquisition_reasons = raw?.reasons || [];
  const active = boats.filter(boat => boat.active !== false && !boat.is_absent && !boat.is_scratched
    && !(race?.scratched_boats || []).map(Number).includes(Number(boat.boat_number)));
  base.active_count = active.length;
  base.mean_basis = active.length === 6 ? 'SIX_BOATS' : 'ACTIVE_STARTERS_EXTENSION';
  if (active.length !== 6) base.note += ' 欠場艇を除く出走艇平均は独自拡張です。';
  const fail = (reason, status = 'INVALID') => ({ evidence: {
    ...base, status, missing: [reason], basic: emptyModel('SUM_BASIC', status, [reason]),
    venue_specific: emptyModel('SUM_AMAGASAKI', venue(race?.venue_code) === '13' ? status : 'UNSUPPORTED_VENUE', venue(race?.venue_code) === '13' ? [reason] : []),
  }, original_exhibition: null });
  if (!originalExhibition || originalExhibition.status === 'UNAVAILABLE') return fail('ORIGINAL_EXHIBITION_MISSING', 'INSUFFICIENT');
  if (active.length < 3 || active.length > 6 || active.some(boat => !boatNumber(boat.boat_number))
    || new Set(active.map(boat => boat.boat_number)).size !== active.length) return fail('ACTIVE_BOATS_INVALID');
  if (!raw) return fail('ORIGINAL_SOURCE_UNVERIFIED');
  const url = sourceUrl(raw.source_url);
  if (!['AVAILABLE', 'PARTIAL'].includes(raw.status) || raw.source_kind !== SUM_SOURCE_KIND || !url) return fail('ORIGINAL_SOURCE_UNVERIFIED');
  const raceNumber = Number(race?.race_number);
  if (!race || !/^\d{4}-\d{2}-\d{2}$/.test(race.race_date || '') || !Number.isInteger(raceNumber) || raceNumber < 1 || raceNumber > 12
    || Number(venue(race.venue_code)) < 1 || Number(venue(race.venue_code)) > 24
    || raw.race_date !== race.race_date || venue(raw.venue_code) !== venue(race.venue_code)
    || !Number.isInteger(raw.race_number) || raw.race_number !== raceNumber
    || (raw.race_key != null && raw.race_key !== race.race_key)
    || (raw.race_id != null && raw.race_id !== (race.race_id || race.id))) return fail('ORIGINAL_RACE_MISMATCH');
  if (!matchingSourceUrls(raw, race, url)) return fail('ORIGINAL_SOURCE_URL_MISMATCH');
  const captured = time(raw.captured_at), exhibitionCaptured = time(raw.exhibition_captured_at), asOf = time(now), deadline = time(race.deadline);
  if (captured == null || exhibitionCaptured == null || asOf == null || deadline == null || Math.max(captured, exhibitionCaptured) > asOf
    || (!replay && Math.max(captured, exhibitionCaptured) >= deadline - CUTOFF_MS)) return fail('ORIGINAL_SOURCE_TIME_INVALID');
  // A race-day page reused with a new date must not make yesterday's times current.
  const capturedDate = new Date(captured + 9 * 3600000).toISOString().slice(0, 10);
  const exhibitionDate = new Date(exhibitionCaptured + 9 * 3600000).toISOString().slice(0, 10);
  if (capturedDate < race.race_date || exhibitionDate < race.race_date
    || (!replay && (capturedDate !== race.race_date || exhibitionDate !== race.race_date))) return fail('ORIGINAL_SOURCE_DATE_INVALID');
  if (!Array.isArray(raw.entries) || raw.entries.length > 6
    || raw.entries.some(row => !row || !boatNumber(row.boat_number))
    || new Set(raw.entries.map(row => row.boat_number)).size !== raw.entries.length) return fail('ORIGINAL_BOATS_INVALID');
  const sourceRows = new Map(raw.entries.map(row => [row.boat_number, row]));
  if (active.some(boat => {
    const row = sourceRows.get(boat.boat_number);
    return row && (!/^\d{4}$/.test(registration(row)) || registration(row) !== registration(boat));
  })) return fail('ORIGINAL_RACER_MISMATCH');
  const rows = active.map(boat => {
    const row = sourceRows.get(boat.boat_number) || {};
    return {
      boat_number: boat.boat_number, registration_number: registration(boat) || null,
      exhibition_time: range(row.exhibition_time, 4, 10), lap_time: range(row.lap_time, 20, 80),
      turn_time: range(row.turn_time, 2, 20), straight_time: range(row.straight_time, 2, 20),
    };
  });
  // An independently collected original page can lag the normal exhibition feed.
  // Refuse inconsistent common measurements instead of silently mixing snapshots.
  if (rows.some(row => {
    const existing = active.find(boat => boat.boat_number === row.boat_number)?.exhibition_time;
    return finite(existing) && row.exhibition_time != null && Math.abs(existing - row.exhibition_time) > .005;
  })) return fail('EXHIBITION_TIME_SOURCE_CONFLICT');
  const basic = calculate('SUM_BASIC', rows);
  const venueSpecific = venue(race.venue_code) === '13' ? calculate('SUM_AMAGASAKI', rows)
    : emptyModel('SUM_AMAGASAKI', 'UNSUPPORTED_VENUE');
  const selected = venueSpecific.status === 'READY' ? venueSpecific : basic.status === 'READY' ? basic : null;
  const saved = {
    status: raw.status, source_kind: SUM_SOURCE_KIND, source_url: url,
    exhibition_source_url: sourceUrl(raw.exhibition_source_url),
    provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 80) : null,
    captured_at: new Date(captured).toISOString(), venue_code: venue(raw.venue_code),
    exhibition_captured_at: new Date(exhibitionCaptured).toISOString(),
    reasons: raw.reasons,
    race_date: raw.race_date, race_number: raw.race_number, entries: rows.map(row => ({ ...row })),
  };
  return {
    evidence: {
      ...base, status: selected ? 'READY' : 'INSUFFICIENT', source_url: saved.source_url,
      captured_at: saved.captured_at, source_kind: saved.source_kind, provider: saved.provider,
      exhibition_source_url: saved.exhibition_source_url, exhibition_captured_at: saved.exhibition_captured_at,
      input_as_of: new Date(Math.max(captured, exhibitionCaptured)).toISOString(),
      basic, venue_specific: venueSpecific, selected_model: selected?.key || null,
      missing: [...new Set([...basic.missing, ...(venue(race.venue_code) === '13' ? venueSpecific.missing : [])])],
      source_period: replay ? 'REPLAY_OBSERVATION' : 'PRE_DEADLINE_OBSERVATION',
    }, original_exhibition: saved,
  };
}

export function selectedSumModel(evidence) {
  if (evidence?.selected_model === 'SUM_AMAGASAKI' && evidence.venue_specific?.status === 'READY') return evidence.venue_specific;
  return evidence?.selected_model === 'SUM_BASIC' && evidence.basic?.status === 'READY' ? evidence.basic : null;
}
