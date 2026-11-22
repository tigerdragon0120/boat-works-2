// Manual, private external-prediction evidence. This module never fetches a provider.
export const EXTERNAL_REVISION = 'V8_EXTERNAL_1';
export const CUTOFF_MS = 60000;

export function evidenceTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim().replace(/(\.\d{3})\d+/, '$1');
  const text = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
export const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
export function validTicket(ticket) {
  return typeof ticket === 'string' && /^[1-6]-[1-6]-[1-6]$/.test(ticket) && new Set(ticket.split('-')).size === 3;
}
export function validateTickets(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 120 &&
    value.every(validTicket) && new Set(value).size === value.length;
}
const textField = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const hasExhibitionValue = (entry) => ['exhibition_time', 'exhibition_st', 'exhibition_st_raw', 'exhibition_course', 'exhibition_rank']
  .some((key) => entry?.[key] !== null && entry?.[key] !== undefined && entry?.[key] !== '');

async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('');
}

// Validation is intentionally independent of the request handler and database.
// published_at is the administrator's transcription, not a publisher-verified timestamp.
export async function buildExternalPrediction({input, race, entries = [], now, recordedBy = ''}) {
  const nowMs = evidenceTime(now), deadlineMs = evidenceTime(race?.deadline);
  const publishedMs = evidenceTime(input?.published_at);
  const fail = (reason) => ({ok: false, reason});
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_INPUT');
  if (!race?.id || input.race_id !== race.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(race.race_date)) ||
      typeof race.race_key !== 'string' || !race.race_key || deadlineMs === null || nowMs === null) return fail('INVALID_RACE');
  if (jstDay(deadlineMs) !== race.race_date) return fail('RACE_DATE_DEADLINE_MISMATCH');
  if (input.permission_confirmed !== true) return fail('PRIVATE_RESEARCH_PERMISSION_REQUIRED');
  if (!textField(input.source_name, 80) || !textField(input.forecaster_name, 80)) return fail('SOURCE_NAME_REQUIRED');
  if (!['TRACK_TIPSTER', 'OFFICIAL_REPORTER', 'OTHER'].includes(input.source_type)) return fail('INVALID_SOURCE_TYPE');
  if (!['DAY_BEFORE', 'PRE', 'FINAL'].includes(input.stage)) return fail('INVALID_STAGE');
  if (publishedMs === null || publishedMs > nowMs || publishedMs >= deadlineMs) return fail('INVALID_PUBLICATION_TIME');
  if (!validateTickets(input.tickets)) return fail('INVALID_OR_DUPLICATE_TICKETS');
  const stake = input.stake_per_ticket ?? 100;
  const fee = input.information_fee ?? 0;
  if (!Number.isInteger(stake) || stake < 100 || stake % 100 !== 0 || stake > 100000 || stake * input.tickets.length > 100000)
    return fail('INVALID_STAKE');
  if (!Number.isInteger(fee) || fee < 0 || fee > 100000) return fail('INVALID_INFORMATION_FEE');
  let sourceUrl;
  try {
    if (typeof input.source_url !== 'string' || input.source_url.length > 2000) return fail('INVALID_SOURCE_URL');
    sourceUrl = new URL(input.source_url);
    if (!['https:', 'http:'].includes(sourceUrl.protocol) || !sourceUrl.hostname || sourceUrl.username || sourceUrl.password)
      return fail('INVALID_SOURCE_URL');
  } catch { return fail('INVALID_SOURCE_URL'); }
  const tags = input.reason_tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => !textField(tag, 80))) return fail('INVALID_REASON_TAGS');

  const reasons = [];
  if (nowMs >= deadlineMs - CUTOFF_MS) reasons.push('RECORDED_AFTER_PROSPECTIVE_CUTOFF');
  if (['finished', 'cancelled'].includes(race.status)) reasons.push('RACE_ALREADY_CLOSED');
  const day = jstDay(nowMs);
  const previousDay = new Date(Date.parse(race.race_date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  if (input.stage === 'DAY_BEFORE') {
    if (day !== previousDay || jstDay(publishedMs) >= race.race_date) reasons.push('NOT_RECORDED_ON_PREVIOUS_DAY');
  } else {
    if (day !== race.race_date) reasons.push('NOT_RECORDED_ON_RACE_DAY');
  }
  if (input.stage === 'PRE') {
    const boats = entries.map((e) => Number(e.boat_number));
    if (entries.length !== 6 || new Set(boats).size !== 6 || boats.some((n) => !Number.isInteger(n) || n < 1 || n > 6) ||
        entries.some((e) => e.race_id !== race.id)) reasons.push('PRE_EXHIBITION_INPUTS_UNVERIFIED');
    if (race.exhibition_ready === true || entries.some(hasExhibitionValue)) reasons.push('EXHIBITION_ALREADY_OBSERVED');
  }
  const eligible = reasons.length === 0;
  const canonical = {
    race_key: race.race_key, source_name: input.source_name.trim(), forecaster_name: input.forecaster_name.trim(),
    source_type: input.source_type, stage: input.stage, published_at: new Date(publishedMs).toISOString(),
    tickets: [...input.tickets].sort(), stake_per_ticket: stake, information_fee: fee, source_url: sourceUrl.href,
  };
  const hash = await digest(canonical);
  return {ok: true, record: {
    record_key: EXTERNAL_REVISION + ':' + hash, revision: EXTERNAL_REVISION,
    race_id: race.id, race_key: race.race_key, race_date: race.race_date,
    venue_code: String(race.venue_code ?? ''), venue_name: race.venue_name || '', race_number: Number(race.race_number),
    deadline: race.deadline, ...canonical, recorded_at: new Date(nowMs).toISOString(),
    source_uri: sourceUrl.href, reason_tags: [...new Set(tags.map((tag) => tag.trim()))],
    evidence_type: eligible ? 'MANUAL_BEFORE_DEADLINE' : 'HISTORICAL', verification_eligible: eligible,
    ineligibility_reasons: reasons, use_scope: 'PRIVATE_RESEARCH', permission_confirmed: true,
    publisher_verified: false, recorded_by_id: String(recordedBy),
    provenance: {
      method: 'ADMIN_MANUAL_TRANSCRIPTION', publisher_timestamp: 'ADMIN_DECLARED_UNVERIFIED',
      permission_basis: 'ADMIN_CONFIRMED_PRIVATE_RESEARCH', automatic_provider_access: false,
      server_observed_at: new Date(nowMs).toISOString(), content_sha256: hash,
    },
  }};
}
