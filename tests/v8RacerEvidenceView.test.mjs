import test from 'node:test';
import assert from 'node:assert/strict';
import {racerEvidenceView, exhibitionParameterComparison, selectJourneyBaseline,
  parameterPercent, parameterTime, parameterRank, parameterPeriod} from '../src/components/liveV8/v8RacerEvidenceView.js';

const raw = {first_rate: 20, second_rate: 30, third_rate: 10, top2_rate: 50, top3_rate: 60, avg_st: 0.16, avg_st_rank: 2.8};
const forecast = () => ({id: 'f1', race_key: '2026-11-26_24_01', stage: 'PRE',
  boats: [1, 2, 3, 4, 5, 6].map(boat_number => ({boat_number, player_name: `選手${boat_number}`, active: true,
    expected_course: boat_number, observed_course: null, exhibition_st: null})),
  racer_evidence: {revision: 'V8_RACER_PARAMETERS_1', status: 'READY', boats: [1, 2, 3, 4, 5, 6].map(boat_number => ({
    boat_number, registration_number: String(4000 + boat_number), status: 'READY', profile_valid: true,
    profile_basis: 'CURRENT_SNAPSHOT', selected_course: boat_number, selected_course_basis: 'EXPECTED',
    sample_size: 10, raw: {...raw}, adjusted: {...raw, first_rate: 25}, profile: {
      source: {term_start_date: '2026-05-01', term_end_date: '2026-10-31'},
      courses: Object.fromEntries([1, 2, 3, 4, 5, 6].map(course => [String(course), {course, sample_size: 10,
        first_count: 2, second_count: 3, third_count: 1, ...raw}]))},
    frame_tendencies: {status: 'NO_DATA', coverage: 'APP_COLLECTED_ONLY', frames: {}},
  }))}});

test('selected leader has its own frozen course data and all six racers remain available for comparison', () => {
  const saved = forecast(), before = JSON.stringify(saved);
  const view = racerEvidenceView(saved, 3);
  assert.equal(view.legacy, false); assert.equal(view.rows.length, 6);
  assert.equal(view.leader.player_name, '選手3'); assert.equal(view.leader.registration_number, '4003');
  assert.equal(view.leader.selected_course, 3); assert.equal(view.leader.small_sample, true);
  assert.equal(view.leader.courses.length, 6); assert.equal(view.leader.raw.first_rate, 20);
  assert.equal(view.leader.frame_tendencies.coverage, 'APP_COLLECTED_ONLY');
  assert.equal(JSON.stringify(saved), before);
});

test('old forecasts are explicitly missing detail and never use course stats outside the saved evidence', () => {
  const saved = forecast(); delete saved.racer_evidence;
  saved.boats[0].course_win_percent = 99;
  const view = racerEvidenceView(saved, 1);
  assert.equal(view.legacy, true); assert.deepEqual(view.rows, []); assert.equal(view.leader, null);
});

test('zero samples and invalid profiles do not appear as zero-second or zero-percent evidence', () => {
  const saved = forecast();
  const first = saved.racer_evidence.boats[0]; first.sample_size = 0;
  first.profile.courses['1'] = {...first.profile.courses['1'], sample_size: 0, first_rate: 0, avg_st: 0, avg_st_rank: 0};
  const zero = racerEvidenceView(saved, 1).leader;
  assert.equal(zero.available, false); assert.equal(zero.raw, null); assert.equal(zero.courses[0].avg_st, null);
  assert.equal(zero.courses[0].first_rate, null);
  const third = saved.racer_evidence.boats[2]; third.status = 'INVALID'; third.profile_valid = false;
  const invalid = racerEvidenceView(saved, 3).leader;
  assert.equal(invalid.raw, null); assert.equal(invalid.source, null); assert.deepEqual(invalid.courses, []); assert.equal(invalid.sample_size, null);
  Object.assign(saved.racer_evidence.boats[3], {status: 'MISSING', profile_valid: false, profile: null, sample_size: 0, raw: null});
  assert.equal(racerEvidenceView(saved, 4).leader.sample_size, null);
});

test('FINAL compares confirmed course changes and exhibition ST while identifying a reused baseline profile', () => {
  const saved = forecast(); saved.stage = 'FINAL';
  Object.assign(saved.boats[2], {observed_course: 4, exhibition_st: 0.11});
  Object.assign(saved.racer_evidence.boats[2], {selected_course: 4, selected_course_basis: 'EXHIBITION_CONFIRMED', profile_basis: 'BASELINE_SNAPSHOT'});
  const row = racerEvidenceView(saved, 3).leader, comparison = exhibitionParameterComparison(row, saved);
  assert.equal(comparison.course_label, '想定3 → 展示4コース'); assert.equal(comparison.changed, true);
  assert.equal(comparison.same_profile, true); assert.equal(comparison.exhibition, '0.11');
  assert.ok(Math.abs(comparison.difference + 0.05) < 0.000001);
  assert.equal(exhibitionParameterComparison(row, {...saved, stage: 'PRE'}), null);
});

test('exhibition F and L are not presented as improvements over normal start performance', () => {
  const saved = forecast(); saved.stage = 'FINAL';
  Object.assign(saved.boats[1], {exhibition_st: -0.02, exhibition_flying: true});
  let row = racerEvidenceView(saved, 2).leader, comparison = exhibitionParameterComparison(row, saved);
  assert.equal(comparison.exhibition, 'F0.02'); assert.equal(comparison.difference, null);
  Object.assign(saved.boats[1], {exhibition_st: 1, exhibition_flying: false, exhibition_late: true});
  row = racerEvidenceView(saved, 2).leader; comparison = exhibitionParameterComparison(row, saved);
  assert.equal(comparison.exhibition, 'L'); assert.equal(comparison.difference, null);
});

test('AUTO shows the final-linked record or the newer PRE, while an explicit day-before choice is honored', () => {
  const dayBefore = {id: 'old', stage: 'DAY_BEFORE'}, pre = {id: 'new', stage: 'PRE'}, linked = {id: 'linked'};
  assert.equal(selectJourneyBaseline({pre, dayBefore}), pre);
  assert.equal(selectJourneyBaseline({linked, pre, dayBefore}), linked);
  assert.equal(selectJourneyBaseline({mode: 'DAY_BEFORE', linked, pre, dayBefore}), dayBefore);
  assert.equal(selectJourneyBaseline({mode: 'PRE', linked, pre, dayBefore}), pre);
  assert.equal(selectJourneyBaseline({dayBefore}), dayBefore);
  assert.equal(selectJourneyBaseline({}), null);
});

test('parameter display keeps percentages, seconds, ranks and missing values distinct', () => {
  assert.equal(parameterPercent(0), '0.0%'); assert.equal(parameterPercent(null), '—');
  assert.equal(parameterPercent(101), '—'); assert.equal(parameterTime(0.13), '0.13');
  assert.equal(parameterRank(2.4), '2.40'); assert.equal(parameterRank(0), '—');
  assert.equal(parameterPeriod({term_start_date: '2026-05-01', term_end_date: '2026-10-31'}), '2026/05/01〜2026/10/31');
});
