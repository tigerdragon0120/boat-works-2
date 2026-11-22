import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLiveInputRaces, isSavedExhibitionComplete } from '../base44/shared/liveInputPriority.js';

const now = Date.parse('2026-11-22T10:00:00Z');
const race = (id, minutes, extra = {}) => ({ id, status: 'scheduled', deadline: new Date(now + minutes * 60000).toISOString(), ...extra });
const completeRows = () => Array.from({ length: 6 }, (_, i) => ({
  boat_number: i + 1, exhibition_time: 6.70 + i * 0.01,
  exhibition_st: 0.10 + i * 0.01, exhibition_course: i + 1,
}));

test('live selection prioritizes upcoming deadlines and never spends the live slot on closed races', () => {
  const rows = [race('later', 30), race('past', -5), race('next', 4),
    race('finished', 2, { status: 'finished' }), race('cancelled', 3, { status: 'cancelled' }),
    race('future-day', 120), race('pre', 10, { status: 'pre' }), race('final', 6, { status: 'final' })];
  const original = structuredClone(rows);
  assert.deepEqual(selectLiveInputRaces(rows, now).map(row => row.id), ['next', 'final', 'pre', 'later']);
  assert.deepEqual(rows, original);
});

test('90-second cutoff is exclusive and the 60-minute horizon is inclusive', () => {
  const rows = [race('boundary', 1.5), race('inside-cutoff', 1.49), race('just-safe', 1.5 + 1 / 60000),
    race('horizon', 60), race('outside-horizon', 60 + 1 / 60000)];
  assert.deepEqual(selectLiveInputRaces(rows, now).map(row => row.id), ['just-safe', 'horizon']);
  assert.deepEqual(selectLiveInputRaces(rows, now, { cutoffMs: 0, horizonMinutes: 2 }).map(row => row.id),
    ['inside-cutoff', 'boundary', 'just-safe']);
});

test('invalid deadlines are excluded and UTC database timestamps match explicit JST deadlines', () => {
  const rows = [{ id: 'missing' }, null, race('invalid', 5, { deadline: 'not a time' }),
    race('date-only', 5, { deadline: '2026-11-22' }),
    race('jst', 5, { deadline: '2026-11-22T19:05:00+09:00' }),
    race('db-utc', 5, { deadline: '2026-11-22T10:05:00.000000' })];
  assert.deepEqual(selectLiveInputRaces(rows, now).map(row => row.id), ['jst', 'db-utc']);
  assert.deepEqual(selectLiveInputRaces(rows, NaN), []);
  assert.deepEqual(selectLiveInputRaces(rows, now, { cutoffMs: -1 }), []);
  assert.deepEqual(selectLiveInputRaces(rows, now, { horizonMinutes: Infinity }), []);
});

test('unchanged complete saved data is still ready without an update counter', () => {
  const rows = completeRows(), original = structuredClone(rows);
  assert.equal(isSavedExhibitionComplete(rows), true);
  assert.equal(isSavedExhibitionComplete(rows), true);
  assert.deepEqual(rows, original);
});

test('zero, numeric flying, F text and L text are observations rather than missing ST', () => {
  for (const st of [0, -0.03, '0', '.00', '-0.03', 'F.03', 'F0.03', ' L ']) {
    const rows = completeRows(); rows[0].exhibition_st = st;
    assert.equal(isSavedExhibitionComplete(rows), true, String(st));
  }
  const rows = completeRows();
  rows[0].exhibition_st_raw = 'L'; rows[0].exhibition_st = null;
  assert.equal(isSavedExhibitionComplete(rows), true);
  rows[0].exhibition_st_raw = ''; rows[0].exhibition_st = 0;
  assert.equal(isSavedExhibitionComplete(rows), true);
});

test('missing, blank, boolean and non-finite observations cannot become ready', () => {
  for (const value of [null, undefined, '', '  ', NaN, Infinity, true, 'F', 'missing']) {
    const rows = completeRows(); rows[0].exhibition_st = value;
    assert.equal(isSavedExhibitionComplete(rows), false, String(value));
  }
  for (const value of [null, '', 0, -6.7, Infinity, false]) {
    const rows = completeRows(); rows[0].exhibition_time = value;
    assert.equal(isSavedExhibitionComplete(rows), false, String(value));
  }
});

test('a failed final boat write leaves saved evidence incomplete despite a complete source response', () => {
  const incoming = completeRows();
  const saved = incoming.map(row => ({ boat_number: row.boat_number }));
  for (const row of incoming) {
    if (row.boat_number !== 6) Object.assign(saved[row.boat_number - 1], row);
  }
  assert.equal(isSavedExhibitionComplete(incoming), true);
  assert.equal(isSavedExhibitionComplete(saved), false);
  Object.assign(saved[5], incoming[5]);
  assert.equal(isSavedExhibitionComplete(saved), true);
});

test('an unaccounted missing boat is incomplete, while explicit scratched or absent boats are excluded', () => {
  const five = completeRows().slice(0, 5);
  assert.equal(isSavedExhibitionComplete(five), false);
  assert.equal(isSavedExhibitionComplete(five, [6]), true);
  assert.equal(isSavedExhibitionComplete(five, ['6']), true);
  for (const flag of ['is_absent', 'is_scratched']) {
    assert.equal(isSavedExhibitionComplete([...five, { boat_number: 6, [flag]: true }]), true);
  }
  assert.equal(isSavedExhibitionComplete([], [1, 2, 3, 4, 5, 6]), false);
});

test('actual entry courses may reorder but must be unique valid integers for active boats', () => {
  const switched = completeRows().map((row, i) => ({ ...row, exhibition_course: [1, 2, 3, 5, 6, 4][i] }));
  assert.equal(isSavedExhibitionComplete(switched), true);
  for (const course of [null, '', 0, 7, 1.5, true, 'missing', 1]) {
    const rows = completeRows(); rows[1].exhibition_course = course;
    assert.equal(isSavedExhibitionComplete(rows), false, String(course));
  }
  assert.equal(isSavedExhibitionComplete([...completeRows(), completeRows()[0]]), false);
});

test('missing containers and invalid boat identities are handled without throwing', () => {
  assert.equal(isSavedExhibitionComplete(null), false);
  assert.equal(isSavedExhibitionComplete([]), false);
  assert.equal(isSavedExhibitionComplete(completeRows(), null), false);
  assert.equal(isSavedExhibitionComplete(completeRows(), [7]), false);
  assert.equal(isSavedExhibitionComplete([...completeRows().slice(0, 5), { boat_number: 7 }]), false);
});
