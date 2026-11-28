// A deadline is a sales cutoff, not evidence that a race was completed.
// Terminal counts come only from saved result/cancellation states.
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
export const dashboardDate = (now = Date.now()) => Number.isFinite(now) ? dayFormat.format(new Date(now)) : null;
export function dashboardTime(value) {
  const at = timestamp(value);
  return at == null ? '--:--' : timeFormat.format(new Date(at));
}
function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? text + 'Z' : text);
  return Number.isFinite(at) ? at : null;
}
const round = race => Number(race?.race_number);
const postponed = race => race.status === 'cancelled' && race.schedule_status === 'POSTPONED';
const cancelled = race => race.status === 'cancelled' && !postponed(race);
const finished = race => race.status === 'finished';

export function describeVenueRaces(input, { date = dashboardDate(), now = Date.now() } = {}) {
  const slots = new Map();
  for (const race of input || []) {
    const number = round(race);
    if (!validDate(date) || race?.race_date !== date || !Number.isInteger(number) || number < 1 || number > 12) continue;
    const previous = slots.get(number);
    if (!previous || String(race.updated_date || '') > String(previous.updated_date || '')) slots.set(number, race);
  }
  const races = [...slots.values()].sort((a, b) => round(a) - round(b));
  const counts = { finished: 0, cancelled: 0, postponed: 0, pending: 0, upcoming: 0, missing: 12 - races.length };
  const pending = [], upcoming = [];
  for (const race of races) {
    if (finished(race)) { counts.finished++; continue; }
    if (postponed(race)) { counts.postponed++; continue; }
    if (cancelled(race)) { counts.cancelled++; continue; }
    const at = timestamp(race.deadline);
    if (at != null && dashboardDate(at) === date && at > now && race.schedule_status !== 'POSTPONED') {
      upcoming.push(race); counts.upcoming++;
    } else { pending.push(race); counts.pending++; }
  }
  const nextRace = upcoming[0] || null;
  const focusRace = nextRace || pending[0] || races.find(race => race.status === 'cancelled') || races.at(-1) || null;
  const unresolved = counts.pending + counts.missing;
  const notice = [...new Set(races.filter(race => race.status === 'cancelled').map(race => String(race.schedule_reason || '').trim()).filter(Boolean))];
  const commonReason = notice.length === 1 ? notice[0] : null;
  const result = { races, counts, nextRace, focusRace, deadline: nextRace?.deadline || null, title: '', detail: '', kind: '', reason: commonReason };
  if (!races.length) return { ...result, kind: 'NO_DATA', title: '開催情報なし' };
  if (counts.postponed === 12) {
    const destinations = [...new Set(races.map(race => race.postponed_to).filter(validDate))];
    return { ...result, kind: 'POSTPONED', title: '本日順延', detail: destinations.length === 1 && races.every(race => race.postponed_to === destinations[0])
      ? `${destinations[0].slice(5).replace('-', '/')}へ順延` : '全12R順延' };
  }
  if (counts.cancelled === 12) return { ...result, kind: 'CANCELLED', title: '本日中止', detail: '全12R中止' };
  if (counts.finished === 12) return { ...result, kind: 'FINISHED', title: '終了', detail: '全12R結果確定' };
  if (counts.finished + counts.cancelled + counts.postponed === 12) {
    return { ...result, kind: counts.postponed ? 'POSTPONED' : 'CANCELLED', title: counts.finished ? (counts.postponed ? '一部順延' : '途中中止') : '中止・順延',
      detail: [counts.cancelled && `${counts.cancelled}R中止`, counts.postponed && `${counts.postponed}R順延`].filter(Boolean).join('・') };
  }
  if (nextRace) return { ...result, kind: 'UPCOMING', title: `締切前 ${round(nextRace)}R`, detail: `締切 ${dashboardTime(nextRace.deadline)}` };
  return { ...result, kind: 'PENDING', title: '状況確認中', detail: `${unresolved}Rの結果・開催状況を確認中` };
}
