// Pure, prospective-only bridge from an immutable official term dataset to the
// existing V7/V8 inputs. It never writes RaceEntry or changes model coefficients.
export const LATEST_RACER_EVIDENCE_REVISION = 'OFFICIAL_TERM_EVIDENCE_1';

const numeric = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};
const bounded = (value, min, max) => { const n = numeric(value); return n !== null && n >= min && n <= max ? n : null; };
const courseNumber = value => { const n = numeric(value); return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null; };
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const n = Date.parse(value); return Number.isFinite(n) ? n : null;
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const registration = row => String(row?.registration_number ?? row?.register_number ?? '').trim();
const firstValid = (row, keys, min, max) => {
  for (const field of keys) { const value = bounded(row?.[field], min, max); if (value !== null) return {field, value}; }
  return null;
};

function courseCounts(record, course) {
  const raw = Array.isArray(record.course_stats)
    ? record.course_stats.find(row => courseNumber(row?.course ?? row?.course_number) === course)
    : record.course_stats?.[String(course)];
  const n = numeric(raw?.entries), counts = ['first_count', 'second_count', 'third_count'].map(key => numeric(raw?.[key]));
  if (!Number.isInteger(n) || n < 1 || n > 100000 || counts.some(value => !Number.isInteger(value) || value < 0)
    || counts.reduce((sum, value) => sum + value, 0) > n) return null;
  return {number: course, n, rank_counts: counts};
}
const existingCourseMap = entry => Array.isArray(entry.course_stats)
  ? Object.fromEntries(entry.course_stats.filter(row => courseNumber(row?.course ?? row?.course_number) !== null)
    .map(row => [String(courseNumber(row.course ?? row.course_number)), {...row}]))
  : {...(entry.course_stats && typeof entry.course_stats === 'object' ? entry.course_stats : {})};

export function enrichLatestRacerEntries({race, entries = [], stage, asOf, dataset, recordMode = 'LIVE'}) {
  // Return fresh entry objects even when no dataset can be used. Nested objects
  // are replaced before enrichment; callers' archived inputs remain untouched.
  const enriched = Array.isArray(entries) ? entries.map(row => ({...row})) : [];
  const provenance = {
    revision: LATEST_RACER_EVIDENCE_REVISION, race_key: race?.race_key || null, stage,
    as_of: asOf, status: 'NOT_APPLIED', reason: null, source: null,
    matched_boats: 0, applied_boats: 0, missing_registration_numbers: [], boats: [],
  };
  const skip = reason => ({entries: enriched, provenance: {...provenance, reason}});
  const at = timestamp(asOf), deadline = timestamp(race?.deadline);
  if (recordMode !== 'LIVE' || !['DAY_BEFORE', 'PRE', 'FINAL'].includes(stage)
    || ['finished', 'cancelled'].includes(race?.status) || at === null || deadline === null || at >= deadline) return skip('NOT_OPEN_LIVE_FORECAST');
  if (!validDate(race?.race_date)) return skip('RACE_DATE_INVALID');
  if (!dataset) return skip('DATASET_UNAVAILABLE');
  const meta = dataset.metadata;
  if (!meta?.dataset_key || !meta?.term_key || !Array.isArray(dataset.records)
    || !Number.isInteger(meta.record_count) || meta.record_count < 1 || dataset.records.length !== meta.record_count
    || !validDate(meta.term_start_date) || !validDate(meta.term_end_date) || meta.term_start_date > meta.term_end_date) return skip('DATASET_METADATA_INVALID');
  const firstSeen = timestamp(meta.first_seen_at), activated = timestamp(meta.activated_at);
  if (firstSeen === null || activated === null) return skip('DATASET_AVAILABILITY_UNPROVEN');
  const available = Math.max(firstSeen, activated);
  if (available > at) return skip('DATASET_NOT_AVAILABLE_AS_OF');
  // A term label may name next year. Its actual observation period, not that
  // label, determines eligibility. A same-day unfinished period is excluded.
  const periodEnd = Date.parse(meta.term_end_date + 'T23:59:59.999+09:00');
  if (meta.term_end_date > race.race_date || periodEnd > at || periodEnd > available) return skip('TERM_PERIOD_NOT_COMPLETE_AS_OF');
  provenance.source = Object.fromEntries(['dataset_key', 'term_key', 'source_url', 'source_file', 'checksum', 'record_count',
    'first_seen_at', 'activated_at', 'term_start_date', 'term_end_date'].map(key => [key, meta[key] ?? null]));
  provenance.source.available_at = new Date(available).toISOString();
  const byRegistration = new Map(), duplicates = new Set();
  for (const record of dataset.records) {
    const reg = registration(record);
    if (!/^\d{4}$/.test(reg)) continue;
    if (byRegistration.has(reg)) duplicates.add(reg);
    byRegistration.set(reg, record);
  }
  for (const entry of enriched) {
    const reg = registration(entry), record = byRegistration.get(reg), boat = courseNumber(entry.boat_number);
    if (!record || duplicates.has(reg) || record.term_key !== meta.term_key
      || record.term_start_date !== meta.term_start_date || record.term_end_date !== meta.term_end_date) {
      provenance.missing_registration_numbers.push(reg); continue;
    }
    provenance.matched_boats++;
    const sourceRef = 'official-term:' + meta.dataset_key + ':' + reg;
    const perBoat = {boat_number: boat, registration_number: reg, term_key: record.term_key, fields: {}, courses: {}};
    let applied = false;
    const hasRaces = Number.isInteger(numeric(record.race_count)) && numeric(record.race_count) > 0;
    for (const [target, aliases, termField, min, max] of [
      ['national_win_rate', ['national_win_rate'], 'win_rate', 0, 10],
      ['national_2rate', ['national_2rate', 'national_f2_rate'], 'fukusho_rate', 0, 100],
      ['avg_st', ['avg_st', 'average_st'], 'avg_st', 0, 1],
    ]) {
      const daily = firstValid(entry, aliases, min, max), termValue = hasRaces ? bounded(record[termField], min, max) : null;
      const value = daily ? daily.value : termValue;
      perBoat.fields[target] = {value, source: daily ? 'RACE_ENTRY' : termValue !== null ? 'OFFICIAL_TERM_FALLBACK' : 'MISSING', source_field: daily?.field || (termValue !== null ? termField : null)};
      if (value !== null) entry[target] = value;
      if (!daily && termValue !== null) applied = true;
    }
    const courses = existingCourseMap(entry), selectedV7 = stage === 'FINAL' ? courseNumber(entry.exhibition_course) : boat;
    const selectedV8 = stage === 'FINAL' ? courseNumber(entry.exhibition_course)
      : courseNumber(entry.expected_entry_course ?? entry.entry_course) ?? boat;
    for (let course = 1; course <= 6; course++) {
      const counts = courseCounts(record, course); if (!counts) continue;
      // Dataset activation is monotonic, and an explicitly newer existing
      // course observation must also survive a stale caller's snapshot.
      const old = courses[String(course)];
      if (validDate(old?.term_end_date) && old.term_end_date > meta.term_end_date) continue;
      const evidence = {...counts, source_ref: sourceRef, acquired_at: provenance.source.available_at,
        term_key: meta.term_key, term_end_date: meta.term_end_date};
      courses[String(course)] = {win_percent: counts.rank_counts[0] / counts.n * 100, starts: counts.n,
        term_key: meta.term_key, term_end_date: meta.term_end_date, source_ref: sourceRef, acquired_at: provenance.source.available_at};
      if (course === selectedV8) { perBoat.courses.v8 = {...evidence, win_percent: courses[String(course)].win_percent}; applied = true; }
      if (course !== selectedV7) continue;
      const oldEvidence = entry.v7_evidence, oldAt = timestamp(oldEvidence?.acquired_at);
      const validOld = oldAt !== null && oldAt <= at && oldEvidence.race_key === race.race_key
        && typeof oldEvidence.source_ref === 'string' && !!oldEvidence.source_ref.trim();
      if (validOld && validDate(oldEvidence.course?.term_end_date) && oldEvidence.course.term_end_date > meta.term_end_date) continue;
      // Only already-valid lane/section evidence can be merged. Re-stamping a
      // future or other-race object would incorrectly make it usable by V7.
      entry.v7_evidence = {
        ...(validOld ? structuredClone(oldEvidence) : {}), race_key: race.race_key,
        acquired_at: new Date(Math.max(available, validOld ? oldAt : 0)).toISOString(),
        source_ref: validOld && oldEvidence.source_ref !== sourceRef ? oldEvidence.source_ref + '|' + sourceRef : sourceRef,
        course: evidence,
      };
      perBoat.courses.v7 = evidence; applied = true;
    }
    if (Object.keys(courses).length) entry.course_stats = courses;
    if (applied) provenance.applied_boats++;
    provenance.boats.push(perBoat);
  }
  provenance.status = provenance.applied_boats > 0 ? 'APPLIED' : 'NOT_APPLIED';
  provenance.reason = provenance.applied_boats > 0 ? null : 'NO_ELIGIBLE_RACER_EVIDENCE';
  return {entries: enriched, provenance};
}
