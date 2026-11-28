import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardDate, dashboardTime, describeVenueRaces } from '../src/lib/venueDashboard.js';

const date = '2026-11-28';
const now = Date.parse(date + 'T15:21:00+09:00');
const row = (number, extra = {}) => ({ id: 'race-' + number, race_date: date, venue_code: '15', race_number: number,
  status: 'scheduled', deadline: date + 'T' + String(9 + Math.floor(number / 2)).padStart(2, '0') + ':00:00+09:00', ...extra });
const wholeDay = extra => Array.from({ length: 12 }, (_, index) => row(index + 1, typeof extra === 'function' ? extra(index + 1) : extra));
const view = rows => describeVenueRaces(rows, { date, now });

test('elapsed sales cutoffs never fabricate twelve completed results', () => {
  const result = view(wholeDay({ status: 'scheduled' }));
  assert.equal(result.counts.finished, 0);
  assert.equal(result.counts.pending, 12);
  assert.equal(result.title, '状況確認中');
  assert.equal(result.kind, 'PENDING');
  assert.equal(result.nextRace, null);
});

test('the observed all-day cancellations and postponement are distinct from finished races', () => {
  for (const venue of ['15', '24']) {
    const result = view(wholeDay({ venue_code: venue, status: 'cancelled', schedule_status: 'CANCELLED', deadline: date + 'T20:00:00+09:00' }));
    assert.equal(result.title, '本日中止');
    assert.equal(result.counts.finished, 0);
    assert.equal(result.counts.cancelled, 12);
    assert.equal(result.nextRace, null);
  }
  const result = view(wholeDay({ venue_code: '20', status: 'cancelled', schedule_status: 'POSTPONED' }));
  assert.equal(result.title, '本日順延');
  assert.equal(result.counts.finished, 0);
  assert.equal(result.counts.cancelled, 0);
  assert.equal(result.counts.postponed, 12);
  assert.equal(result.detail, '全12R順延');
  assert.equal(result.nextRace, null);
});

test('Tokuyama six confirmed races plus six cancellations displays a partial cancellation', () => {
  const result = view(wholeDay(number => ({ venue_code: '18', status: number <= 6 ? 'finished' : 'cancelled',
    schedule_status: number <= 6 ? null : 'CANCELLED' })));
  assert.equal(result.title, '途中中止');
  assert.deepEqual(result.counts, { finished: 6, cancelled: 6, postponed: 0, pending: 0, upcoming: 0, missing: 0 });
  assert.equal(result.focusRace.race_number, 7);
});

test('only twelve saved finished states produce all-race completion', () => {
  const rows = wholeDay({ status: 'finished' });
  assert.equal(view(rows).detail, '全12R結果確定');
  const partial = view(rows.slice(0, 11));
  assert.equal(partial.kind, 'PENDING');
  assert.equal(partial.counts.finished, 11);
  assert.equal(partial.counts.missing, 1);
  assert.doesNotMatch(partial.detail, /全.*確定/);
});

test('a corrected future deadline is reflected without erasing prior unconfirmed results', () => {
  const rows = wholeDay(number => ({ status: number <= 9 ? 'finished' : 'scheduled',
    deadline: date + (number < 11 ? 'T15:10:00+09:00' : number === 11 ? 'T15:38:00+09:00' : 'T16:08:00+09:00') }));
  const before = view(rows);
  assert.equal(before.title, '締切前 11R');
  assert.equal(before.counts.finished, 9);
  assert.equal(before.counts.pending, 1);
  const after = view(rows.map(race => race.race_number === 10 ? { ...race, deadline: date + 'T15:30:00+09:00' } : race));
  assert.equal(after.title, '締切前 10R');
  assert.equal(after.detail, '締切 15:30');
  assert.equal(after.counts.finished, 9);
  assert.equal(after.counts.pending, 0);
});

test('cancelled future slots cannot become the next highlighted race', () => {
  const rows = wholeDay(number => ({ status: number <= 10 ? 'finished' : number === 11 ? 'cancelled' : 'scheduled',
    deadline: date + (number === 11 ? 'T15:22:00+09:00' : 'T15:50:00+09:00') }));
  const result = view(rows);
  assert.equal(result.nextRace.race_number, 12);
  assert.equal(result.counts.finished, 10);
  assert.equal(result.counts.cancelled, 1);
});

test('JST rollover excludes yesterday and UTC-naive persisted timestamps format correctly', () => {
  assert.equal(dashboardDate(Date.parse('2026-11-27T14:59:59Z')), '2026-11-27');
  assert.equal(dashboardDate(Date.parse('2026-11-27T15:00:00Z')), date);
  assert.equal(dashboardTime('2026-11-28T06:38:00.000000'), '15:38');
  const rows = wholeDay({ race_date: '2026-11-27', status: 'finished' });
  assert.equal(view(rows).kind, 'NO_DATA');
  const wrongDeadline = view([row(1, { deadline: '2026-11-29T15:00:00+09:00' })]);
  assert.equal(wrongDeadline.counts.upcoming, 0);
  assert.equal(wrongDeadline.counts.pending, 1);
});

test('a rescheduled date is shown only when the full postponed day names the same date', () => {
  const rows = wholeDay({ status: 'cancelled', schedule_status: 'POSTPONED', postponed_to: '2026-11-29' });
  assert.equal(view(rows).detail, '11/29へ順延');
  rows[0].postponed_to = null;
  assert.equal(view(rows).detail, '全12R順延');
});
