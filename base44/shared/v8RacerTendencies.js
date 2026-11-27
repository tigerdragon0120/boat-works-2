// Read existing immutable results only. No external requests or new schedules.
// These are observed boat-number outcomes, never inferred entry-course records.
import {readV8Rows, jstDate, dateValid} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

export const FRAME_TENDENCY_REVISION = 'V8_FRAME_TENDENCIES_1';
export const FRAME_WINDOW_DAYS = 30;
const METHODS = ['逃げ', '差し', 'まくり', 'まくり差し', '抜き', '恵まれ'];
const counts = () => Object.fromEntries(METHODS.map(method => [method, 0]));
const rank = value => Number.isInteger(value) && value >= 1 && value <= 6;
const round = value => Math.round(value * 1000) / 1000;
const readerCache = new WeakMap();
const FRAME_FIELDS=['id','race_id','race_key','race_date','venue_code','race_number','result_trifecta','winner_boat','winner_register',
  'winning_method','result_finished_at','captured_at','created_date','source.result_id','source.provenance',
  'boat_results.boat_number','boat_results.registration_number','boat_results.finish','boat_results.entry_known','boat_results.winning_method'];
const frameReadRow=row=>({
  ...Object.fromEntries(FRAME_FIELDS.filter(key=>!key.includes('.')).filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])),
  source:row.source&&typeof row.source==='object'?{result_id:row.source.result_id,provenance:row.source.provenance}:row.source,
  boat_results:Array.isArray(row.boat_results)?row.boat_results.map(boat=>boat&&typeof boat==='object'
    ?Object.fromEntries(['boat_number','registration_number','finish','entry_known','winning_method'].filter(key=>Object.hasOwn(boat,key)).map(key=>[key,boat[key]])):boat):row.boat_results,
});

export function frameWindow(asOf) {
  const at = utcMs(asOf);
  return at == null ? null : {window_start: jstDate(1 - FRAME_WINDOW_DAYS, at), window_end: jstDate(0, at)};
}

export function emptyFrameTendencies({asOf, status = 'NO_DATA', window = frameWindow(asOf)} = {}) {
  return {
    revision: FRAME_TENDENCY_REVISION, status, as_of: asOf,
    window_start: window?.window_start || null, window_end: window?.window_end || null,
    source: 'V8PatternEvidence', coverage: 'APP_COLLECTED_ONLY', sample_rule: 'SIX_FINISHERS_VERIFIED',
    evidence_count: 0, first_race_date: null, last_race_date: null, latest_source_at: null, source_ids: [],
    used_for_scoring: false,
    frames: Object.fromEntries(Array.from({length: 6}, (_, index) => [String(index + 1), {
      sample_size: 0, first_count: 0, second_count: 0, third_count: 0,
      fourth_count: 0, fifth_count: 0, sixth_count: 0,
      first_rate: null, top2_rate: null, top3_rate: null,
      known_method_wins: 0, winning_methods: counts(), method_known_races: 0,
      opponent_wins_by_method: counts(), one_boat_escape_count: 0,
    }])),
  };
}

function usableEvidence(row, asOf, window) {
  const at = utcMs(asOf), captured = utcMs(row?.captured_at), created = utcMs(row?.created_date);
  const finished = utcMs(row?.result_finished_at);
  if (at == null || !row?.id || !row.race_id || !dateValid(row.race_date)
    || row.race_date < window.window_start || row.race_date > window.window_end
    || captured == null || created == null || finished == null
    || finished > captured || captured > created || created > at
    || !row.source?.result_id || row.source.provenance !== 'RACE_RESULT_AND_RACER_HISTORY') return null;
  const expectedKey = row.race_date + '_' + String(row.venue_code).padStart(2, '0') + '_' + String(row.race_number).padStart(2, '0');
  if (row.race_key !== expectedKey || !/^\d{4}-\d{2}-\d{2}_\d{2}_\d{2}$/.test(expectedKey)
    || !/^[1-6]-[1-6]-[1-6]$/.test(row.result_trifecta || '')) return null;
  // Incomplete 4th–6th places must not selectively discard losses or turn them
  // into zeroes. The first version uses only six identified normal finishers.
  const boats = row.boat_results;
  if (!Array.isArray(boats) || boats.length !== 6
    || boats.some(boat => !rank(boat.boat_number) || !rank(boat.finish)
      || typeof boat.registration_number !== 'string' || !/^\d{4}$/.test(boat.registration_number) || boat.entry_known !== true)
    || new Set(boats.map(boat => boat.boat_number)).size !== 6
    || new Set(boats.map(boat => boat.finish)).size !== 6
    || new Set(boats.map(boat => boat.registration_number)).size !== 6) return null;
  const finishers = [...boats].sort((a, b) => a.finish - b.finish);
  if (finishers.slice(0, 3).map(boat => boat.boat_number).join('-') !== row.result_trifecta
    || row.winner_boat !== finishers[0].boat_number
    || (row.winner_register && row.winner_register !== finishers[0].registration_number)) return null;
  const method = METHODS.includes(row.winning_method) ? row.winning_method : null;
  if (method && finishers[0].winning_method && finishers[0].winning_method !== method) return null;
  return {row, boats, method};
}

export function buildRacerFrameTendencies({rows = [], asOf, status = 'READY'} = {}) {
  const window = frameWindow(asOf), profiles = new Map();
  const summary = {status, read_count: Array.isArray(rows)?rows.length:0, accepted_races: 0, rejected_races: 0, duplicate_races: 0,
    as_of: asOf, ...window, source: 'V8PatternEvidence'};
  if (!window || status !== 'READY' || !Array.isArray(rows)) return {profiles, summary};
  const byRace = new Map();
  for (const row of rows) {
    // A future duplicate must not change a forecast's earlier observable sample.
    if ([row?.captured_at,row?.created_date,row?.result_finished_at].some(value => utcMs(value)>utcMs(asOf))) continue;
    const group = byRace.get(row?.race_key) || [];
    group.push(row); byRace.set(row?.race_key, group);
  }
  for (const group of byRace.values()) {
    // Duplicate race evidence is not selected by its eventual preferred outcome.
    if (group.length !== 1) {summary.duplicate_races++; continue;}
    const evidence = usableEvidence(group[0], asOf, window);
    if (!evidence) {summary.rejected_races++; continue;}
    summary.accepted_races++;
    const {row, boats, method} = evidence;
    for (const boat of boats) {
      let profile = profiles.get(boat.registration_number);
      if (!profile) {
        profile = {...emptyFrameTendencies({asOf, status: 'READY', window}), registration_number: boat.registration_number};
        profiles.set(boat.registration_number, profile);
      }
      profile.evidence_count++;
      profile.source_ids.push(row.id);
      if (!profile.latest_source_at || utcMs(row.created_date)>utcMs(profile.latest_source_at)) profile.latest_source_at=new Date(utcMs(row.created_date)).toISOString();
      profile.first_race_date = !profile.first_race_date || row.race_date < profile.first_race_date ? row.race_date : profile.first_race_date;
      profile.last_race_date = !profile.last_race_date || row.race_date > profile.last_race_date ? row.race_date : profile.last_race_date;
      const frame = profile.frames[String(boat.boat_number)];
      frame.sample_size++;
      frame[['first_count', 'second_count', 'third_count', 'fourth_count', 'fifth_count', 'sixth_count'][boat.finish - 1]]++;
      if (method) {
        frame.method_known_races++;
        if (boat.finish === 1) {frame.known_method_wins++; frame.winning_methods[method]++;}
        else frame.opponent_wins_by_method[method]++;
        if (row.winner_boat === 1 && method === '逃げ') frame.one_boat_escape_count++;
      }
    }
  }
  for (const profile of profiles.values()) {
    profile.source_ids.sort();
    for (const frame of Object.values(profile.frames)) {
      if (!frame.sample_size) continue;
      frame.first_rate = round(frame.first_count / frame.sample_size * 100);
      frame.top2_rate = round((frame.first_count + frame.second_count) / frame.sample_size * 100);
      frame.top3_rate = round((frame.first_count + frame.second_count + frame.third_count) / frame.sample_size * 100);
    }
  }
  return {profiles, summary};
}

export async function loadRacerFrameTendencies(sr, {asOf = new Date().toISOString(), budget = Date.now() + 10000} = {}) {
  const window = frameWindow(asOf), entity = sr?.V8PatternEvidence;
  const unavailable = status => buildRacerFrameTendencies({asOf, rows: [], status});
  if (!window || !entity?.filter) return unavailable('UNAVAILABLE');
  const key = window.window_start + ':' + window.window_end;
  const cached = readerCache.get(entity);
  let rows;
  if (cached?.key === key && cached.until > Date.now() && cached.read_at <= utcMs(asOf)) rows = cached.rows;
  else {
    try {
      // 30 days across all 24 venues has at most 8,640 standard races. Pagination
      // must complete; a truncated ledger is never presented as a full sample.
      rows = await readV8Rows(entity, {race_date: {$gte: window.window_start, $lte: window.window_end}},
        {budget, maxPages: 60, sort: '-race_date',fields:FRAME_FIELDS}).then(rows=>rows.map(frameReadRow));
      readerCache.set(entity, {key, rows, read_at: utcMs(asOf), until: Date.now() + 15 * 60000});
    } catch {
      return unavailable('READ_FAILED');
    }
  }
  return buildRacerFrameTendencies({rows, asOf});
}
