// Views only read the acquired snapshot or the evidence saved with a forecast.
// Missing values never become zero, and live data never replaces saved evidence.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bounded = (value, min, max) => finite(value) && value >= min && value <= max ? value : null;
const count = value => Number.isInteger(value) && value >= 0 && value <= 10 ? value : null;
const boatNumber = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 6 ? Number(value) : null;
const registration = row => String(row?.registration_number ?? row?.register_number ?? '').trim();
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const entryName = entry => entry?.player_name || entry?.racer_name || '選手名未取得';

export const recentLaneNumber = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
export const recentLaneDelta = value => {
  if (!finite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(1)}点`;
};
export function recentLaneTime(value) {
  const saved = timestamp(value);
  if (!saved) return '取得時刻未確認';
  return new Intl.DateTimeFormat('ja-JP', {timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(saved));
}

export function recentLaneReason(reason) {
  const key = String(reason || '');
  if (/IDENTITY|NAME_MISMATCH|ENTRANT|REGISTRATION|RACE_MISMATCH|BOAT_MISMATCH|DUPLICATE/.test(key)) return '選手・枠番・対象レースの一致を確認できていません。';
  if (/AFTER|FUTURE|AS_OF|TOO_LATE|CUTOFF|CLOSED/.test(key)) return 'この予想の保存時点に使える取得記録がありません。';
  if (/REPLAY/.test(key)) return '当時取得した枠番過去10走の記録がないため、後から補って評価していません。';
  if (/COURSE|ENTRY_CHANGED/.test(key)) return '今回の進入コースに対応する履歴・指標が不足しています。';
  if (/SAMPLE|HISTORY_EMPTY|NO_HISTORY|NO_STARTS/.test(key)) return '評価に使える同枠の出走履歴が不足しています。';
  if (/METRIC|REFERENCE|FEATURE|SCORING|BASE_SCORE/.test(key)) return '比較に必要な指標が揃わず、補正を適用していません。';
  if (/INVALID|MALFORMED|PARSE|UNKNOWN_FINISH/.test(key)) return '取得した枠番過去10走を確認できず、補正を適用していません。';
  if (/NOT_SAVED|LEGACY/.test(key)) return '当時の枠番過去10走と補正量は保存されていません。';
  return '枠番過去10走を取得できていません。';
}

export function recentLaneRequestKey(race, entries = []) {
  return JSON.stringify([race?.id || null, race?.race_key || null, race?.race_date || null,
    String(race?.venue_code || '').padStart(2, '0'), Number(race?.race_number) || null,
    entries.map(entry => [boatNumber(entry.boat_number), registration(entry)]).sort((a, b) => a[0] - b[0])]);
}

// Only newly available saved source identities cause an additional table read.
// Forecast timestamps, polling results and temporary missing responses do not.
export function recentLaneReadySnapshotKey(forecasts, race) {
  const ids = new Set();
  for (const forecast of [forecasts?.baseline, forecasts?.final]) {
    if (!forecast || forecast.record_mode === 'REPLAY' || forecast.race_id !== race?.id
      || (race?.race_key && forecast.race_key !== race.race_key)) continue;
    for (const row of recentLaneEvidenceView(forecast).rows) {
      if (row.available && row.evidence_consistent && row.snapshot_id) ids.add(row.snapshot_id);
    }
  }
  return ids.size ? JSON.stringify([...ids].sort()) : '';
}

export function recentLaneSnapshotView(snapshot, {race, entry} = {}) {
  const boat = boatNumber(entry?.boat_number ?? snapshot?.boat_number), reg = registration(entry || snapshot);
  const fail = reason => ({available: false, reason, boat_number: boat, registration_number: reg,
    player_name: entryName(entry), history: [], sample_size: null, normal_sample_size: null,
    special_count: null, absent_count: null, winning_rate: null, avg_st: null, avg_start_order: null});
  if (!snapshot) return fail('SNAPSHOT_UNAVAILABLE');
  if (snapshot.revision !== 'V8_RECENT_LANE_1' || snapshot.source !== 'BOATCAST_WAKU10' || snapshot.status !== 'READY') return fail(snapshot.reason || 'SNAPSHOT_INVALID');
  if (snapshot.identity_status !== 'MATCHED_NAME_AND_ENTRY' || boat === null || !/^\d{4}$/.test(reg)
    || snapshot.boat_number !== boat || registration(snapshot) !== reg) return fail('IDENTITY_MISMATCH');
  if (race && ((race.id && snapshot.race_id !== race.id) || (race.race_key && snapshot.race_key !== race.race_key))) return fail('RACE_MISMATCH');
  if (typeof snapshot.snapshot_id !== 'string' || !snapshot.snapshot_id || typeof snapshot.row_hash !== 'string' || !snapshot.row_hash
    || !timestamp(snapshot.fetched_at) || !timestamp(snapshot.available_at)) return fail('SNAPSHOT_INVALID');
  const sample = count(snapshot.sample_size), normal = count(snapshot.normal_sample_size);
  if (sample === null || normal === null || normal > sample || !Array.isArray(snapshot.history) || snapshot.history.length > 10) return fail('SAMPLE_INVALID');
  const history = snapshot.history.map(row => ({
    finish_order: boatNumber(row?.finish_order),
    finish_status: typeof row?.finish_status === 'string' && row.finish_status.trim() ? row.finish_status.trim().slice(0, 12) : null,
    course: boatNumber(row?.course), course_inferred: row?.course_inferred === true,
    code: typeof row?.code === 'string' ? row.code : null,
  }));
  return {available: true, reason: null, boat_number: boat, lane: boat, registration_number: reg,
    player_name: entry ? entryName(entry) : snapshot.source_name || '選手名未取得',
    snapshot_id: snapshot.snapshot_id, row_hash: snapshot.row_hash, fetched_at: snapshot.fetched_at,
    available_at: snapshot.available_at, source_url: snapshot.source_url, source_name: snapshot.source_name,
    sample_size: sample, normal_sample_size: normal, special_count: count(snapshot.special_count), absent_count: count(snapshot.absent_count),
    winning_rate: sample > 0 ? bounded(snapshot.winning_rate, 0, 13) : null,
    avg_st: sample > 0 ? bounded(snapshot.avg_st, 0, 1) : null,
    avg_start_order: sample > 0 ? bounded(snapshot.avg_start_order, 1, 6) : null,
    first_rate: sample > 0 ? bounded(snapshot.first_rate, 0, 100) : null,
    top2_rate: sample > 0 ? bounded(snapshot.top2_rate, 0, 100) : null,
    top3_rate: sample > 0 ? bounded(snapshot.top3_rate, 0, 100) : null,
    history, snapshot};
}

export function recentLaneHistoryCells(row) {
  const history = Array.isArray(row?.history) ? row.history.slice(0, 10).reverse() : [];
  return [...Array(Math.max(0, 10 - history.length)).fill(null), ...history];
}

export function recentLaneEvidenceView(forecast, leader) {
  const evidence = forecast?.recent_lane_evidence;
  if (evidence?.revision !== 'V8_RECENT_LANE_EVIDENCE_1' || !Array.isArray(evidence.boats)) return {legacy: true, rows: [], leader: null, evidence: null};
  const boats = Array.isArray(forecast.boats) ? forecast.boats : [];
  const rows = boats.map(entry => {
    const matches = evidence.boats.filter(row => row.boat_number === entry.boat_number && registration(row) === registration(entry));
    const saved = matches.length === 1 ? matches[0] : null;
    const source = recentLaneSnapshotView(saved?.snapshot, {race: {id: forecast.race_id, race_key: forecast.race_key}, entry});
    const scoring = saved?.scoring || {};
    const consistent = source.available && saved?.snapshot_id === source.snapshot_id && saved?.row_hash === source.row_hash;
    const applied = consistent && saved?.status === 'READY' && scoring.applied === true && scoring.used === true;
    const reason = matches.length > 1 ? 'DUPLICATE_IDENTITY' : source.available
      ? !consistent ? 'SNAPSHOT_INVALID' : scoring.reason || saved?.reason || 'NO_USABLE_METRICS'
      : source.reason !== 'SNAPSHOT_UNAVAILABLE' ? source.reason : saved?.reason || scoring.reason || source.reason;
    return {...source, active: entry.active !== false, applied, reason, evidence_consistent: consistent,
      source_basis: saved?.source_basis || 'UNAVAILABLE', selected_course: boatNumber(saved?.selected_course),
      selected_course_basis: saved?.selected_course_basis, scoring: {...scoring,
        delta: applied ? bounded(scoring.delta, -100, 100) : null,
        base_before: bounded(scoring.base_before, 0, 100), base_after: bounded(scoring.base_after, 0, 100),
        used_features: Array.isArray(scoring.used_features) ? scoring.used_features.filter(value => typeof value === 'string') : [],
        omitted_reasons: Array.isArray(scoring.omitted_reasons) ? scoring.omitted_reasons.filter(value => typeof value === 'string') : []},
      status_label: applied ? '反映済み' : source.available ? '補正なし' : '未取得',
    };
  }).sort((a, b) => a.boat_number - b.boat_number);
  return {legacy: false, evidence, rows, leader: rows.find(row => row.boat_number === leader) || null};
}

export function recentLaneForecastMatch(source, forecasts, race) {
  if (!source?.available) return {kind: 'UNAVAILABLE', label: '未取得', stages: []};
  const candidates = [forecasts?.baseline, forecasts?.final].filter(forecast => forecast && forecast.record_mode !== 'REPLAY' && forecast.race_id === race?.id && (!race?.race_key || forecast.race_key === race.race_key));
  const matches = candidates.map(forecast => ({forecast, row: recentLaneEvidenceView(forecast, source.boat_number).leader}))
    .filter(({row}) => row?.evidence_consistent === true && row.registration_number === source.registration_number && row.snapshot_id === source.snapshot_id && row.row_hash === source.row_hash);
  const applied = matches.filter(({row}) => row.applied);
  if (applied.length) {
    const stages = [...new Set(applied.map(({forecast}) => forecast.stage === 'FINAL' ? '展示後' : '事前'))];
    return {kind: 'APPLIED', label: `${stages.join('・')}に反映`, stages};
  }
  if (matches.length) return {kind: 'SAVED_NOT_APPLIED', label: 'V8に保存・補正なし', stages: []};
  if (candidates.length) return {kind: 'DIFFERENT_SNAPSHOT', label: 'V8の採用時点と異なります', stages: []};
  return {kind: 'ACQUIRED', label: '取得済み', stages: []};
}

export function recentLaneTableView(data, entries, race, forecasts) {
  const candidates = data?.ok === false ? [] : Array.isArray(data?.rows) ? data.rows : [];
  const rows = entries.map(entry => {
    const matches = candidates.filter(row => row?.boat_number === Number(entry.boat_number));
    const source = recentLaneSnapshotView(matches.length === 1 ? matches[0] : null, {race, entry});
    if (!source.available) source.reason = matches.length > 1 ? 'DUPLICATE_IDENTITY' : source.reason === 'SNAPSHOT_UNAVAILABLE' ? data?.reason || 'SNAPSHOT_UNAVAILABLE' : source.reason;
    return {...source, adoption: recentLaneForecastMatch(source, forecasts, race)};
  });
  return {rows, available: rows.filter(row => row.available).length, total: entries.length};
}
