// Pure, prospective-only bridge from an immutable official term dataset to the
// existing V7/V8 inputs. It never writes RaceEntry or changes model coefficients.
export const LATEST_RACER_EVIDENCE_REVISION = 'OFFICIAL_TERM_EVIDENCE_1';
export const V8_RACER_PROFILE_REVISION = 'V8_RACER_PROFILE_1';

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

const rankNames = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const wholeCount = (value, max = 100000) => {
  const n = numeric(value); return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};
const rawCourse = (record, course) => {
  if (!Array.isArray(record?.course_stats)) return record?.course_stats?.[String(course)];
  const matches = record.course_stats.filter(row => courseNumber(row?.course ?? row?.course_number) === course);
  return matches.length === 1 ? matches[0] : null;
};
const rateOf = (count, n) => n > 0 && count !== null ? count * 100 / n : null;

// These are observed-course statistics, not boat-number statistics. Preserve
// missing values instead of turning an absent observation into a zero rate.
function racerCourseProfile(record, course) {
  const raw = rawCourse(record, course), n = wholeCount(raw?.entries);
  const counts = rankNames.map(rank => {
    const value = raw?.[rank + '_count'];
    return n === 0 && (value == null || value === '') ? 0 : n === null ? null : wholeCount(value, n);
  });
  const invalidCount = rankNames.some((rank, index) => {
    const value = raw?.[rank + '_count'];
    return value != null && value !== '' && counts[index] === null;
  }) || (n !== null && counts.reduce((sum, value) => sum + (value ?? 0), 0) > n);
  if (invalidCount) counts.fill(null);
  const sumCounts = (limit) => counts.slice(0, limit).every(value => value !== null)
    ? counts.slice(0, limit).reduce((sum, value) => sum + value, 0) : null;
  const l0 = n === null ? null : n === 0 && (raw?.l0_count == null || raw.l0_count === '') ? 0 : wholeCount(raw?.l0_count, n);
  const l1 = n === null ? null : n === 0 && (raw?.l1_count == null || raw.l1_count === '') ? 0 : wholeCount(raw?.l1_count, n);
  const l = l0 !== null && l1 !== null && l0 + l1 <= n ? l0 + l1 : null;
  const output = {
    course, sample_size: n,
    ...Object.fromEntries(rankNames.map((rank, index) => [rank + '_count', counts[index]])),
    first_rate: rateOf(counts[0], n), second_rate: rateOf(counts[1], n), third_rate: rateOf(counts[2], n),
    top2_rate: rateOf(sumCounts(2), n), top3_rate: rateOf(sumCounts(3), n),
    avg_st: n > 0 ? bounded(raw?.avg_st, 0, 1) : null,
    avg_st_rank: n > 0 ? bounded(raw?.avg_st_rank, 1, 6) : null,
    f_count: n === null ? null : n === 0 && (raw?.f_count == null || raw.f_count === '') ? 0 : wholeCount(raw?.f_count, n),
    l_count: l,
  };
  return output;
}

function emptyCoursePrior() {
  return {sample_size: null, first_rate: null, second_rate: null, third_rate: null,
    top2_rate: null, top3_rate: null, avg_st: null, avg_st_rank: null};
}

// Every value uses the same complete dataset. A missing metric is not silently
// averaged over a smaller, unidentified subset while showing the full sample.
function datasetCoursePriors(records, validIdentity) {
  const result = {};
  for (let course = 1; course <= 6; course++) {
    const prior = emptyCoursePrior(); result[String(course)] = prior;
    if (!validIdentity) continue;
    const rows = records.map(record => racerCourseProfile(record, course));
    if (rows.some(row => row.sample_size === null)) continue;
    prior.sample_size = rows.reduce((sum, row) => sum + row.sample_size, 0);
    const observed = rows.filter(row => row.sample_size > 0);
    if (!prior.sample_size) continue;
    for (const metric of ['first_rate', 'second_rate', 'third_rate', 'top2_rate', 'top3_rate', 'avg_st', 'avg_st_rank']) {
      if (observed.every(row => row[metric] !== null)) {
        prior[metric] = observed.reduce((sum, row) => sum + row[metric] * row.sample_size, 0) / prior.sample_size;
      }
    }
  }
  return result;
}

function courseCounts(record, course) {
  const raw = rawCourse(record, course);
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
  const enriched = Array.isArray(entries) ? entries.map(row => {
    const fresh = {...row};
    // A caller-supplied profile cannot bypass this dataset's availability and
    // identity checks, even when enrichment is unavailable on this attempt.
    delete fresh.v8_racer_profile;
    return fresh;
  }) : [];
  const provenance = {
    revision: LATEST_RACER_EVIDENCE_REVISION, race_key: race?.race_key || null, stage,
    as_of: asOf, status: 'NOT_APPLIED', reason: null, source: null,
    matched_boats: 0, applied_boats: 0, profiled_boats: 0, missing_registration_numbers: [], boats: [],
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
  const samePeriod = record => record?.term_key === meta.term_key
    && record.term_start_date === meta.term_start_date && record.term_end_date === meta.term_end_date;
  const validDatasetIdentity = duplicates.size === 0 && byRegistration.size === dataset.records.length
    && dataset.records.every(samePeriod);
  const coursePriors = datasetCoursePriors(dataset.records, validDatasetIdentity);
  for (const entry of enriched) {
    const reg = registration(entry), record = byRegistration.get(reg), boat = courseNumber(entry.boat_number);
    if (!record || duplicates.has(reg) || record.term_key !== meta.term_key
      || record.term_start_date !== meta.term_start_date || record.term_end_date !== meta.term_end_date) {
      provenance.missing_registration_numbers.push(reg); continue;
    }
    provenance.matched_boats++;
    const profileCourses = Object.fromEntries(Array.from({length: 6}, (_, index) => [String(index + 1), racerCourseProfile(record, index + 1)]));
    entry.v8_racer_profile = {
      revision: V8_RACER_PROFILE_REVISION, registration_number: reg,
      player_name: typeof record.racer_name === 'string' && record.racer_name.trim() ? record.racer_name.trim() : null,
      source: {...Object.fromEntries(['dataset_key', 'term_key', 'source_url', 'source_file', 'term_start_date', 'term_end_date', 'checksum']
        .map(key => [key, meta[key] ?? null])), available_at: provenance.source.available_at},
      courses: profileCourses, course_priors: structuredClone(coursePriors),
    };
    provenance.profiled_boats++;
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
      courses[String(course)] = {...profileCourses[String(course)], win_percent: counts.rank_counts[0] / counts.n * 100, starts: counts.n,
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
