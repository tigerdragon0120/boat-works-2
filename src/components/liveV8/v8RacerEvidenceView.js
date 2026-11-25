const finite = value => typeof value === 'number' && Number.isFinite(value);
const course = value => Number.isInteger(value) && value >= 1 && value <= 6 ? value : null;
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const measured = (value, min, max) => finite(value) && value >= min && value <= max ? value : null;

export const parameterPercent = value => measured(value, 0, 100) === null ? '—' : `${value.toFixed(1)}%`;
export const parameterTime = value => measured(value, 0, 1) === null ? '—' : value.toFixed(2);
export const parameterRank = value => measured(value, 1, 6) === null ? '—' : value.toFixed(2);
export const parameterSample = value => count(value) === null ? '未取得' : `${value}走`;
export const parameterDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '/') : null;
export const parameterPeriod = source => {
  const start = parameterDate(source?.term_start_date), end = parameterDate(source?.term_end_date);
  return start && end ? `${start}〜${end}` : '対象期間未確認';
};

// Only the forecast's own frozen evidence is read. No current master, result,
// or other forecast is supplied as a fallback for an old prediction.
export function racerEvidenceView(forecast, leader) {
  const evidence = forecast?.racer_evidence;
  if (!evidence || !Array.isArray(evidence.boats)) return {legacy: true, rows: [], leader: null, evidence: null};
  const savedBoats = Array.isArray(forecast.boats) ? forecast.boats : [];
  const rows = evidence.boats.filter((row, index, all) => course(row?.boat_number) !== null
    && all.filter(other => other?.boat_number === row.boat_number).length === 1).map(row => {
    const boat = savedBoats.find(item => item.boat_number === row.boat_number) || {};
    const selectedCourse = course(row.selected_course);
    const source = row.profile_valid === false ? null : row.profile?.source || null;
    const savedCourse = row.profile?.courses?.[String(selectedCourse)];
    const sample = row.status === 'INVALID' || row.profile_valid === false || !savedCourse ? null : count(row.sample_size);
    const raw = row.status !== 'INVALID' && row.profile_valid !== false && sample > 0
      && row.raw && typeof row.raw === 'object' ? row.raw : null;
    const profileValid = row.status !== 'INVALID' && row.profile_valid !== false && row.profile && typeof row.profile.courses === 'object';
    const courses = profileValid ? Array.from({length: 6}, (_, index) => {
      const number = index + 1, saved = row.profile.courses[String(number)];
      const value = saved && typeof saved === 'object' ? saved : {};
      return {...value, course: number, ...(count(value.sample_size) === null || value.sample_size === 0
        ? {first_rate: null, second_rate: null, third_rate: null, top2_rate: null, top3_rate: null, avg_st: null, avg_st_rank: null} : {})};
    }) : [];
    const available = row.status === 'READY' && selectedCourse !== null && sample !== null && sample > 0 && !!raw;
    return {...row, player_name: boat.player_name || '選手名未取得', active: boat.active !== false,
      selected_course: selectedCourse, sample_size: sample, raw, source, courses, available,
      small_sample: sample !== null && sample > 0 && sample < 20,
      expected_course: course(boat.expected_course), observed_course: course(boat.observed_course),
      exhibition_st: finite(boat.exhibition_st) ? boat.exhibition_st : null,
      exhibition_flying: boat.exhibition_flying === true, exhibition_late: boat.exhibition_late === true};
  }).sort((a, b) => a.boat_number - b.boat_number);
  return {legacy: false, rows, leader: rows.find(row => row.boat_number === leader) || null, evidence};
}

export function exhibitionParameterComparison(row, forecast) {
  if (!row || forecast?.stage !== 'FINAL') return null;
  const average = measured(row.raw?.avg_st, 0, 1);
  const observed = measured(row.exhibition_st, 0, 1);
  const exhibition = row.exhibition_late ? 'L' : row.exhibition_flying
    ? finite(row.exhibition_st) ? `F${Math.abs(row.exhibition_st).toFixed(2)}` : 'F'
    : observed === null ? '未取得' : observed.toFixed(2);
  const difference = average !== null && observed !== null && !row.exhibition_flying && !row.exhibition_late
    ? observed - average : null;
  const changed = row.selected_course_basis === 'EXHIBITION_CONFIRMED'
    && row.expected_course !== null && row.selected_course !== row.expected_course;
  return {average, exhibition, difference, changed,
    same_profile: row.profile_basis === 'BASELINE_SNAPSHOT',
    course_label: changed ? `想定${row.expected_course} → 展示${row.selected_course}コース`
      : row.selected_course_basis === 'EXHIBITION_CONFIRMED' ? `展示${row.selected_course}コースを参照`
      : '展示進入が揃うまでは想定コースを参照'};
}

export function selectJourneyBaseline({mode = 'AUTO', linked, pre, dayBefore}) {
  if (mode === 'DAY_BEFORE') return dayBefore || null;
  if (mode === 'PRE') return pre || null;
  return linked || pre || dayBefore || null;
}
