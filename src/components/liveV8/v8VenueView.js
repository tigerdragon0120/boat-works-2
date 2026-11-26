const finite = value => typeof value === 'number' && Number.isFinite(value);
const rate = value => finite(value) && value >= 0 && value <= 100 ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '/') : null;
export const venueRateText = value => rate(value) === null ? '未取得' : `${value.toFixed(1)}%`;
export const VENUE_METHODS = ['逃げ', 'まくり', '差し', 'まくり差し', '抜き', '恵まれ'];

export function venueEvidenceView(evidence, race) {
  const profile = evidence?.profile;
  const empty = reason => ({available: false, reason, used: false, rows: [], profile: null, first_rate: null, source_url: null});
  if (!evidence) return empty('NOT_SAVED');
  if (evidence.revision !== 'V8_VENUE_EVIDENCE_1' || profile?.revision !== 'V8_VENUE_PROFILE_1'
    || profile.status !== 'READY' || profile.source !== 'BOATRACE_STADIUM' || profile.course_basis !== 'ACTUAL_ENTRY_COURSE') return empty(evidence.reason || 'UNAVAILABLE');
  if (race?.venue_code && String(profile.venue_code).padStart(2, '0') !== String(race.venue_code).padStart(2, '0')) return empty('VENUE_MISMATCH');
  const rows = Array.from({length: 6}, (_, index) => {
    const course = index + 1, saved = profile.courses?.[String(course)];
    return {course, first_rate: rate(saved?.first_rate), top2_rate: rate(saved?.top2_rate), top3_rate: rate(saved?.top3_rate),
      sample_size: Number.isInteger(saved?.sample_size) && saved.sample_size >= 0 ? saved.sample_size : null,
      methods: VENUE_METHODS.map(method => ({method, rate: rate(saved?.winning_methods?.[method])}))};
  });
  let href = null;
  try { const url = new URL(profile.source_url); if (url.protocol === 'https:' && ['boatrace.jp', 'www.boatrace.jp'].includes(url.hostname)) href = url.href; } catch {}
  const start = date(profile.period_start), end = date(profile.period_end);
  return {available: true, reason: null, profile, rows, first_rate: rows[0].first_rate, source_url: href,
    period: start && end ? `${start}〜${end}` : '対象期間未確認',
    sample_label: Number.isInteger(profile.sample_size) && profile.sample_size >= 0 ? `${profile.sample_size}走` : '公式ページに件数の掲載なし',
    used: evidence.used === true, inside_favored: evidence.inside_favored === true,
    same_profile: evidence.baseline_profile_reused === true, change_note: typeof evidence.change_note === 'string' ? evidence.change_note : null};
}
