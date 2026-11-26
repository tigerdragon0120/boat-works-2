import test from 'node:test';
import assert from 'node:assert/strict';
import {recentLaneSnapshotView, recentLaneTableView, recentLaneEvidenceView, recentLaneForecastMatch,
  recentLaneHistoryCells, recentLaneRequestKey, recentLaneReadySnapshotKey, recentLaneNumber, recentLaneDelta, recentLaneTime} from '../src/components/liveV8/v8RecentLaneView.js';

const race = {id: 'r1', race_key: '2026-11-26_23_01', race_date: '2026-11-26', venue_code: '23', race_number: 1};
const entries = Array.from({length: 6}, (_, index) => ({boat_number: index + 1, registration_number: String(4501 + index), player_name: `選手${index + 1}`}));
function snapshot(index = 0) {
  return {revision: 'V8_RECENT_LANE_1', source: 'BOATCAST_WAKU10', status: 'READY', race_id: race.id, race_key: race.race_key,
    boat_number: index + 1, registration_number: String(4501 + index), source_name: `選手${index + 1}`, identity_status: 'MATCHED_NAME_AND_ENTRY',
    snapshot_id: 'snapshot-a', row_hash: `row-${index + 1}`, fetched_at: '2026-11-26T00:01:00Z', available_at: '2026-11-26T00:01:01Z',
    source_url: 'https://race.boatcast.jp/hp_txt/23/fixture.txt', sample_size: 3, normal_sample_size: 2, special_count: 1, absent_count: 0,
    winning_rate: 6, avg_st: .17, avg_start_order: 2.8, first_rate: 100 / 3, top2_rate: 200 / 3, top3_rate: 200 / 3,
    history: [{finish_order: 1, finish_status: null, course: index + 1, course_inferred: false},
      {finish_order: null, finish_status: 'F', course: null, course_inferred: false},
      {finish_order: 2, finish_status: null, course: index + 1, course_inferred: true}]};
}
function forecast(stage = 'PRE') {
  return {id: `forecast-${stage}`, race_id: race.id, race_key: race.race_key, stage, boats: structuredClone(entries),
    recent_lane_evidence: {revision: 'V8_RECENT_LANE_EVIDENCE_1', status: 'READY', source: 'BOATCAST_WAKU10', boats: entries.map((entry, index) => ({
      ...entry, lane: entry.boat_number, selected_course: entry.boat_number, status: 'READY', source_basis: 'CURRENT_SNAPSHOT',
      snapshot: snapshot(index), snapshot_id: 'snapshot-a', row_hash: `row-${index + 1}`,
      scoring: {used: true, applied: true, used_features: ['finish', 'start'], base_before: 50, base_after: 52.3, delta: 2.3,
        finish_sample_size: 3, finish_selection: 'SAME_FRAME_HISTORY', omitted_reasons: []}}))}};
}

test('BOATCAST missing numbers stay missing while genuine zero survives', () => {
  const row = snapshot(); row.winning_rate = null; row.avg_st = ''; row.avg_start_order = null;
  let view = recentLaneSnapshotView(row, {race, entry: entries[0]});
  assert.equal(view.winning_rate, null); assert.equal(view.avg_st, null); assert.equal(view.avg_start_order, null);
  assert.equal(recentLaneNumber(view.avg_st), '—');
  row.winning_rate = 0; view = recentLaneSnapshotView(row, {race, entry: entries[0]});
  assert.equal(view.winning_rate, 0); assert.equal(recentLaneNumber(view.winning_rate), '0.00');
});

test('published winning points above ten remain unchanged and distinct from first-place percentages', () => {
  const row = snapshot(); row.winning_rate = 10.20; row.first_rate = 50;
  const view = recentLaneSnapshotView(row, {race, entry: entries[0]});
  assert.equal(view.winning_rate, 10.20);
  assert.equal(recentLaneNumber(view.winning_rate), '10.20');
  assert.equal(view.first_rate, 50);
  const saved = forecast();
  saved.recent_lane_evidence.boats[0].snapshot.winning_rate = 10.20;
  Object.assign(saved.recent_lane_evidence.boats[0].scoring, {base_before: 99, base_after: 100, delta: 1});
  const evidence = recentLaneEvidenceView(saved, 1).leader;
  assert.equal(evidence.winning_rate, 10.20);
  assert.equal(evidence.scoring.base_after, 100);
  row.winning_rate = 13;
  assert.equal(recentLaneSnapshotView(row, {race, entry: entries[0]}).winning_rate, 13);
  row.winning_rate = 13.01;
  assert.equal(recentLaneSnapshotView(row, {race, entry: entries[0]}).winning_rate, null);
});

test('live table rejects the wrong racer, race, duplicate lane and unverified identity', () => {
  for (const change of [row => row.registration_number = '9999', row => row.race_id = 'old',
    row => row.identity_status = 'UNVERIFIED']) {
    const row = snapshot(); change(row);
    const view = recentLaneTableView({rows: [row]}, entries, race);
    assert.equal(view.rows[0].available, false); assert.equal(view.rows[0].winning_rate, null);
  }
  const duplicate = recentLaneTableView({rows: [snapshot(), snapshot()]}, entries, race);
  assert.equal(duplicate.rows[0].reason, 'DUPLICATE_IDENTITY'); assert.equal(duplicate.available, 0);
});

test('partial rows retain per-boat availability and normal finishes exclude F/L', () => {
  const view = recentLaneTableView({rows: [snapshot(0), snapshot(3)]}, entries, race);
  assert.equal(view.available, 2); assert.equal(view.total, 6);
  assert.equal(view.rows[0].sample_size, 3); assert.equal(view.rows[0].normal_sample_size, 2);
  assert.equal(view.rows[1].sample_size, null); assert.equal(view.rows[1].adoption.kind, 'UNAVAILABLE');
});

test('newest-first source history becomes a left-padded display without inventing courses', () => {
  const original = snapshot(), before = structuredClone(original);
  const row = recentLaneSnapshotView(original, {race, entry: entries[0]}), cells = recentLaneHistoryCells(row);
  assert.equal(cells.length, 10); assert.deepEqual(cells.slice(0, 7), Array(7).fill(null));
  assert.equal(cells[7].finish_order, 2); assert.equal(cells[8].finish_status, 'F');
  assert.equal(cells[8].course, null); assert.equal(cells[9].finish_order, 1);
  assert.deepEqual(original, before);
});

test('V8 panel uses saved snapshot and saved delta; legacy forecast never receives live source', () => {
  const saved = forecast(), before = structuredClone(saved), view = recentLaneEvidenceView(saved, 4);
  assert.equal(view.leader.registration_number, '4504'); assert.equal(view.rows.length, 6);
  assert.equal(view.leader.applied, true); assert.equal(view.leader.scoring.delta, 2.3);
  assert.deepEqual(saved, before);
  const old = {...saved, recent_lane_evidence: undefined, live_recent_lane: snapshot()};
  assert.equal(recentLaneEvidenceView(old, 1).legacy, true);
  assert.equal(recentLaneEvidenceView(old, 1).leader, null);
});

test('same snapshot without actual scoring is saved, not marked applied', () => {
  const saved = forecast(); saved.recent_lane_evidence.boats[0].scoring = {used: false, applied: false, reason: 'NO_COURSE_HISTORY', delta: 0};
  const source = recentLaneSnapshotView(snapshot(), {race, entry: entries[0]});
  const view = recentLaneEvidenceView(saved, 1);
  assert.equal(view.leader.available, true); assert.equal(view.leader.applied, false); assert.equal(view.leader.scoring.delta, null);
  assert.equal(recentLaneForecastMatch(source, {baseline: saved}, race).kind, 'SAVED_NOT_APPLIED');
});

test('table adoption requires exact snapshot id, content hash and racer identity', () => {
  const source = recentLaneSnapshotView(snapshot(), {race, entry: entries[0]});
  const pre = forecast(), final = forecast('FINAL');
  assert.deepEqual(recentLaneForecastMatch(source, {baseline: pre, final}, race),
    {kind: 'APPLIED', label: '事前・展示後に反映', stages: ['事前', '展示後']});
  final.recent_lane_evidence.boats[0].snapshot.snapshot_id = 'new-snapshot';
  assert.equal(recentLaneForecastMatch(source, {final}, race).kind, 'DIFFERENT_SNAPSHOT');
  const changed = forecast(); changed.recent_lane_evidence.boats[0].snapshot.row_hash = 'different-content';
  assert.equal(recentLaneForecastMatch(source, {baseline: changed}, race).kind, 'DIFFERENT_SNAPSHOT');
  assert.equal(recentLaneForecastMatch(source, null, race).kind, 'ACQUIRED');
  assert.equal(recentLaneForecastMatch(source, {baseline: {...pre, record_mode: 'REPLAY'}}, race).kind, 'ACQUIRED');
});

test('request identity changes across races and formatting never inflates a zero delta', () => {
  assert.notEqual(recentLaneRequestKey(race, entries), recentLaneRequestKey({...race, id: 'r2', race_number: 2}, entries));
  assert.equal(recentLaneRequestKey(race, entries), recentLaneRequestKey(race, [...entries].reverse()));
  assert.equal(recentLaneDelta(0), '0.0点'); assert.equal(recentLaneDelta(2.3), '+2.3点'); assert.equal(recentLaneDelta(-2.3), '−2.3点');
  assert.equal(recentLaneTime(null), '取得時刻未確認');
  const saved = forecast(); saved.recent_lane_evidence.boats[0].scoring.delta = 0;
  assert.equal(recentLaneEvidenceView(saved, 1).leader.applied, true);
});

test('FINAL frozen baseline matches the old cache only; a fresh READY cache is not automatically applied', () => {
  const pre = forecast(), final = forecast('FINAL');
  final.recent_lane_evidence.source_basis = 'BASELINE_SNAPSHOT';
  final.recent_lane_evidence.boats[0].source_basis = 'BASELINE_SNAPSHOT';
  const old = recentLaneSnapshotView(snapshot(), {race, entry: entries[0]});
  assert.equal(recentLaneForecastMatch(old, {baseline: pre, final}, race).label, '事前・展示後に反映');
  const updated = snapshot(); updated.snapshot_id = 'snapshot-b'; updated.row_hash = 'row-new'; updated.avg_st = .12;
  const current = recentLaneSnapshotView(updated, {race, entry: entries[0]});
  assert.equal(recentLaneForecastMatch(current, {baseline: pre, final}, race).kind, 'DIFFERENT_SNAPSHOT');
  assert.equal(recentLaneEvidenceView(final, 1).leader.avg_st, .17);
});

test('source availability is distinct from a scoring omission and contradictory snapshot references fail closed', () => {
  const saved = forecast();
  saved.recent_lane_evidence.boats[0].reason = 'READY';
  Object.assign(saved.recent_lane_evidence.boats[0].scoring, {applied: false, used: false, reason: 'NO_USABLE_METRICS'});
  assert.equal(recentLaneEvidenceView(saved, 1).leader.reason, 'NO_USABLE_METRICS');
  const contradictory = forecast(); contradictory.recent_lane_evidence.boats[0].snapshot_id = 'another-snapshot';
  const view = recentLaneEvidenceView(contradictory, 1);
  assert.equal(view.leader.applied, false); assert.equal(view.leader.reason, 'SNAPSHOT_INVALID');
});

test('table refresh identity follows READY snapshot ids, not forecast timestamps or array order', () => {
  const pre = forecast(), final = forecast('FINAL');
  const key = recentLaneReadySnapshotKey({baseline: pre, final}, race);
  assert.equal(key, '["snapshot-a"]');
  final.generated_at = '2026-11-26T01:00:00Z'; final.id = 'another-forecast';
  final.recent_lane_evidence.boats.reverse();
  assert.equal(recentLaneReadySnapshotKey({baseline: pre, final}, race), key);
  for (const row of final.recent_lane_evidence.boats) {
    row.snapshot_id = 'snapshot-b'; row.snapshot.snapshot_id = 'snapshot-b';
  }
  assert.equal(recentLaneReadySnapshotKey({baseline: pre, final}, race), '["snapshot-a","snapshot-b"]');
  assert.equal(recentLaneReadySnapshotKey(null, race), '');
  assert.equal(recentLaneReadySnapshotKey({final}, {...race, id: 'another-race'}), '');
  assert.equal(recentLaneReadySnapshotKey({final: {...final, record_mode: 'REPLAY'}}, race), '');
});
