// Immutable, pre-deadline V8 development hypotheses.
// Ordinal research scores are NOT occurrence probabilities or expected returns.
// This module is pure and portable between Node and Deno.
export const FORECAST_REVISION = 'V8_FORECAST_1';
export const FINAL_ODDS_MAX_AGE_MS = 5 * 60 * 1000;
const CUTOFF_MS = 60000;
const STAGES = ['DAY_BEFORE', 'PRE', 'FINAL'];
const METHODS = { ESCAPE: '逃げ', SASHI: '差し', MAKURI: 'まくり', MAKURISASHI: 'まくり差し' };
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const round = value => value == null ? null : Math.round(value * 1000) / 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => {
  if (finite(value)) return value;
  if (typeof value !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const bounded = (value, min, max) => {
  const n = number(value);
  return n != null && n >= min && n <= max ? n : null;
};
const first = (...values) => values.find(value => value !== null && value !== undefined && value !== '') ?? null;
export const forecastTime = value => {
  const text = typeof value === 'string' ? value.trim().replace(/(\.\d{3})\d+/, '$1') : '';
  if (!text || !/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : text + 'Z');
  return Number.isFinite(ms) ? ms : null;
};
const dateJst = ms => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const sourceTime = row => forecastTime(row?.updated_date || row?.created_date);
const validCourse = value => {
  const n = number(value);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
};
export const validForecastTicket = value => typeof value === 'string'
  && /^[1-6]-[1-6]-[1-6]$/.test(value) && new Set(value.split('-')).size === 3;
const validTickets = (tickets, expected) => Array.isArray(tickets)
  && tickets.length === expected && new Set(tickets).size === expected && tickets.every(validForecastTicket);
const registration = entry => {
  const value = first(entry.registration_number, entry.register_number);
  return value == null ? '' : String(value).trim();
};
function exhibitionStart(entry) {
  const raw = first(entry.exhibition_st_raw, entry.exhibition_st);
  if (typeof raw === 'string' && /^F(?:0)?\.\d+$/i.test(raw.trim())) {
    return { value: -Number(raw.trim().slice(1)), flying: true, late: false };
  }
  if (typeof raw === 'string' && /^L/i.test(raw.trim())) return { value: null, flying: false, late: true };
  const value = bounded(raw, -1, 1);
  return { value, flying: value != null && value < 0, late: false };
}
const hasExhibition = entry => bounded(entry.exhibition_time, 4, 10) != null
  || exhibitionStart(entry).value != null || validCourse(entry.exhibition_course) != null
  || exhibitionStart(entry).late;
function sectionPoints(entry) {
  // An available official/declared point rate is distinguished from our finish-form proxy.
  const official = bounded(first(entry.section_points, entry.series_point_rate, entry.qualifying_point_rate), 0, 12);
  if (official != null) return { value: official, basis: 'SOURCE_POINT_RATE' };
  if (typeof entry.section_finishes !== 'string' || !/^[1-6](?:[-, /]+[1-6])*$/.test(entry.section_finishes.trim())) {
    return { value: null, basis: 'MISSING' };
  }
  const values = entry.section_finishes.trim().split(/[-, /]+/).slice(-3).map(Number);
  const points = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2, 6: 1 };
  return { value: round(values.reduce((total, value) => total + points[value], 0) / values.length), basis: 'LAST_THREE_FINISH_PROXY' };
}
function courseRecord(entry, course) {
  // Only explicitly identified course records with a percent field are consumed.
  // Generic win_rate values may be a winning-point rating, so they are not guessed.
  const raw = Array.isArray(entry.course_stats)
    ? entry.course_stats.find(item => validCourse(item?.course ?? item?.course_number) === course)
    : entry.course_stats?.[String(course)];
  return {
    win_percent: bounded(first(raw?.win_percent, raw?.first_place_rate), 0, 100),
    starts: bounded(first(raw?.starts, raw?.sample_size), 1, 100000),
  };
}
function normalizeBoat(entry, race, stage) {
  const boat = validCourse(entry.boat_number);
  const expected = validCourse(first(entry.expected_entry_course, entry.entry_course)) ?? boat;
  const exhibition = stage === 'FINAL' ? exhibitionStart(entry) : { value: null, flying: false, late: false };
  const observed = stage === 'FINAL' ? validCourse(entry.exhibition_course) : null;
  const form = sectionPoints(entry);
  const course = courseRecord(entry, stage === 'FINAL' && observed ? observed : expected);
  const absent = !!entry.is_absent || !!entry.is_scratched || (race.scratched_boats || []).map(Number).includes(boat);
  return {
    boat_number: boat,
    registration_number: registration(entry),
    player_name: String(first(entry.player_name, entry.racer_name) || ''),
    player_class: first(entry.player_class, entry.grade_class),
    active: !absent,
    expected_course: expected,
    expected_course_basis: validCourse(first(entry.expected_entry_course, entry.entry_course)) ? 'SOURCE_EXPECTATION' : 'FRAME_ORDER_ASSUMPTION',
    observed_course: observed,
    national_win_rate: bounded(entry.national_win_rate, 0, 10),
    local_win_rate: bounded(entry.local_win_rate, 0, 10),
    national_2rate: bounded(first(entry.national_2rate, entry.national_f2_rate), 0, 100),
    local_2rate: bounded(first(entry.local_2rate, entry.local_f2_rate), 0, 100),
    motor_2rate: bounded(first(entry.motor_2rate, entry.motor_f2_rate), 0, 100),
    motor_3rate: bounded(first(entry.motor_3rate, entry.motor_f3_rate), 0, 100),
    motor_number: first(entry.motor_number),
    avg_st: bounded(first(entry.avg_st, entry.average_st), 0, 1),
    section_points: form.value,
    section_points_basis: form.basis,
    course_win_percent: course.win_percent,
    course_sample_size: course.starts,
    exhibition_time: stage === 'FINAL' ? bounded(entry.exhibition_time, 4, 10) : null,
    exhibition_st: exhibition.value,
    exhibition_flying: exhibition.flying,
    exhibition_late: exhibition.late,
    entry_id: entry.id,
    source_updated_at: entry.updated_date || entry.created_date,
  };
}
const weightedMean = pairs => {
  const present = pairs.filter(([value]) => finite(value));
  if (!present.length) return null;
  return present.reduce((sum, [value, weight]) => sum + value * weight, 0)
    / present.reduce((sum, [, weight]) => sum + weight, 0);
};
function scoreBoats(boats, stage) {
  const fields = [
    ['national_win_rate', .27, value => value * 10],
    ['local_win_rate', .12, value => value * 10],
    ['national_2rate', .16, value => value],
    ['motor_2rate', .18, value => value],
    ['avg_st', .15, value => clamp((.3 - value) / .3 * 100)],
    ['section_points', .08, value => clamp(value * 10)],
    ['course_win_percent', .04, value => value],
  ];
  // A missing feature is excluded for every boat so scores remain comparable.
  const used = fields.filter(([key]) => boats.every(boat => finite(boat[key])));
  const base = boats.map(boat => weightedMean(used.map(([key, weight, convert]) => [convert(boat[key]), weight])));
  const allTimes = stage === 'FINAL' && boats.every(boat => finite(boat.exhibition_time));
  const allStarts = stage === 'FINAL' && boats.every(boat => finite(boat.exhibition_st));
  const minTime = allTimes ? Math.min(...boats.map(boat => boat.exhibition_time)) : null;
  const maxTime = allTimes ? Math.max(...boats.map(boat => boat.exhibition_time)) : null;
  return {
    feature_keys: used.map(([key]) => key),
    meaningful: used.length >= 3 && used.some(([key]) => key === 'national_win_rate' || key === 'national_2rate'),
    boats: boats.map((boat, index) => {
      const speedScore = !allTimes ? null : maxTime === minTime ? 50 : (maxTime - boat.exhibition_time) / (maxTime - minTime) * 100;
      const exhibitionStartScore = !allStarts ? null : boat.exhibition_flying ? 0 : clamp((.3 - boat.exhibition_st) / .3 * 100);
      const score = weightedMean([[base[index], .75], [speedScore, .15], [exhibitionStartScore, .10]]);
      return { ...boat, base_score: round(base[index]), score: round(score), exhibition_speed_score: round(speedScore), exhibition_start_score: round(exhibitionStartScore) };
    }),
  };
}
function buildScenarios(boats, complete) {
  const ordered = [...boats].sort((a, b) => {
    const courseA = complete ? a.observed_course : a.expected_course;
    const courseB = complete ? b.observed_course : b.expected_course;
    return courseA - courseB;
  });
  const inside = ordered[0];
  const startOf = boat => {
    if (complete && finite(boat.exhibition_st)) return boat.exhibition_flying ? null : boat.exhibition_st;
    return boat.avg_st;
  };
  const startEdge = (boat, target) => {
    const mine = startOf(boat), theirs = startOf(target);
    return mine == null || theirs == null ? 0 : clamp((theirs - mine) * 120, -12, 12);
  };
  const followers = (leader, method) => {
    const leadIndex = ordered.findIndex(boat => boat.boat_number === leader.boat_number);
    const preferred = method === 'MAKURI' ? ordered.slice(leadIndex + 1)
      : method === 'MAKURISASHI' ? [inside, ...ordered.slice(leadIndex + 1)] : [];
    return [...new Set([...preferred, ...[...ordered].sort((a, b) => b.score - a.score)]
      .map(boat => boat.boat_number).filter(boat => boat !== leader.boat_number))].slice(0, 3);
  };
  const out = [];
  const push = (boat, method, score, explanation) => {
    out.push({
      key: boat.boat_number + '_' + method, label: boat.boat_number + '号艇 ' + METHODS[method],
      leader: boat.boat_number, method, score: round(clamp(score)),
      score_type: 'UNCALIBRATED_SCENARIO_SCORE',
      reason: explanation,
      checkpoints: [
        '想定進入を展示進入と照合する',
        boat.boat_number + '号艇の展示タイムと周辺艇との差を確認する',
        boat.boat_number + '号艇の展示ST・F/Lを確認し、本番STとは区別する',
      ],
      beneficiaries: followers(boat, method),
    });
  };
  const nearest = ordered[1];
  push(inside, 'ESCAPE', inside.score + 10 - Math.max(0, startEdge(nearest, inside)) * .7,
    inside.boat_number + '号艇が内側から先行する仮説。選手・モーター・節間評価と内側のスタート差を参考にする');
  ordered.slice(1).forEach((boat, index) => {
    const course = index + 2;
    const weakness = (100 - inside.score) * .08;
    const edge = startEdge(boat, ordered[index]);
    if (course === 2 || course === 3) {
      push(boat, 'SASHI', boat.score + weakness - 7 - (course - 2) * 3,
        boat.boat_number + '号艇が先行艇の内を狙う仮説。先行艇が残る組み合わせも比較する');
    }
    push(boat, 'MAKURI', boat.score + weakness + edge - 7 - (course - 2) * 4,
      boat.boat_number + '号艇が外から攻める仮説。内側とのスタート差と伸びの裏付けを確認する');
    if (course >= 3) {
      push(boat, 'MAKURISASHI', boat.score + weakness + Math.max(0, edge) * .4 - 5 - (course - 2) * 3,
        boat.boat_number + '号艇が攻めの間隙を狙う仮説。内艇の残りと外側の追走を比較する');
    }
  });
  return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
function candidateTickets(boats, scenarios) {
  if (!scenarios.length) return [];
  const leader = new Map();
  for (const scenario of scenarios) if (!leader.has(scenario.leader)) leader.set(scenario.leader, scenario);
  const rows = [];
  for (const a of boats) for (const b of boats) for (const c of boats) {
    if (a.boat_number === b.boat_number || a.boat_number === c.boat_number || b.boat_number === c.boat_number) continue;
    const scenario = leader.get(a.boat_number);
    if (!scenario) continue;
    rows.push({
      ticket: [a.boat_number, b.boat_number, c.boat_number].join('-'),
      score: scenario.score * .58 + b.score * .27 + c.score * .15
        + (scenario.beneficiaries.includes(b.boat_number) ? 2 : 0),
    });
  }
  return rows.sort((a, b) => b.score - a.score || a.ticket.localeCompare(b.ticket)).slice(0, 8).map(row => row.ticket);
}
function useBaseline(baseline, race, now) {
  if (!baseline?.id || !['DAY_BEFORE', 'PRE'].includes(baseline.stage) || baseline.race_key !== race.race_key
    || baseline.race_id !== race.id || baseline.race_date !== race.race_date) return null;
  const generated = forecastTime(baseline.generated_at), created = forecastTime(baseline.created_date);
  if (generated == null || created == null || generated > now || created > now
    || generated >= forecastTime(race.deadline) - CUTOFF_MS || created >= forecastTime(race.deadline) - CUTOFF_MS) return null;
  // Baselines have to have been genuinely observed in their declared period.
  if (baseline.stage === 'DAY_BEFORE' && (dateJst(generated + 86400000) !== race.race_date || dateJst(created + 86400000) !== race.race_date)) return null;
  if (baseline.stage === 'PRE' && (dateJst(generated) !== race.race_date || dateJst(created) !== race.race_date)) return null;
  if (!Array.isArray(baseline.boats) || baseline.boats.length !== 6) return null;
  return baseline;
}
function compare(baseline, boats, scenarios, complete, stage) {
  if (!baseline) return { status: 'NO_BASE', changes: [stage === 'FINAL' ? '締切前に保存された事前仮説がありません' : '最初の事前仮説として保存'], baseline_id: null, baseline_stage: null, checkpoint_results: [] };
  const oldTop = (baseline.scenarios || []).find(row => row.key === baseline.top_scenario_key) || baseline.scenarios?.[0];
  const top = scenarios[0], changes = [], checks = [];
  const changedCourses = boats.filter(boat => {
    const prior = baseline.boats.find(row => row.boat_number === boat.boat_number);
    return boat.observed_course != null && prior?.expected_course !== boat.observed_course;
  });
  const changedEntrants = boats.some(boat => {
    const prior = baseline.boats.find(row => row.boat_number === boat.boat_number);
    return !prior || prior.registration_number !== boat.registration_number;
  });
  if (changedEntrants) changes.push('事前保存後に出走選手の対応が変わっています');
  checks.push({ label: '想定進入', status: !complete ? 'UNKNOWN' : changedCourses.length ? 'CHANGED' : 'SUPPORTED',
    detail: !complete ? '展示進入の確定待ち' : changedCourses.length ? changedCourses.map(boat => boat.boat_number + '号艇→' + boat.observed_course + 'コース').join(' / ') : '事前の想定進入と一致' });
  if (changedCourses.length) changes.push('進入変更：' + checks[0].detail);
  if (oldTop && top) {
    changes.push(oldTop.key === top.key ? '本線の展開仮説を維持' : '本線を「' + oldTop.label + '」から「' + top.label + '」へ変更');
    checks.push({ label: '本線展開', status: oldTop.key === top.key ? 'SUPPORTED' : 'CHANGED', detail: changes[changes.length - 1] });
  }
  const focus = boats.find(boat => boat.boat_number === oldTop?.leader);
  if (focus) {
    checks.push({ label: '事前本線艇の展示ST', status: focus.exhibition_st == null ? 'UNKNOWN' : focus.exhibition_flying ? 'CAUTION' : 'OBSERVED',
      detail: focus.exhibition_st == null ? '未取得' : focus.exhibition_flying ? '展示F。速いSTとして加点しません' : focus.exhibition_st.toFixed(2) + '秒。本番の再現を保証しません' });
    checks.push({ label: '事前本線艇の展示タイム', status: focus.exhibition_time == null ? 'UNKNOWN' : 'OBSERVED',
      detail: focus.exhibition_time == null ? '未取得' : focus.exhibition_time.toFixed(2) + '秒' });
  }
  return {
    status: !complete || !oldTop || !top || changedEntrants ? 'PARTIAL' : oldTop.key === top.key && !changedCourses.length ? 'SUPPORTED' : 'CHANGED',
    changes, baseline_id: baseline.id, baseline_stage: baseline.stage,
    original_scenario_key: oldTop?.key || null, updated_scenario_key: top?.key || null,
    entrant_changed: changedEntrants, entry_changed: changedCourses.length > 0, checkpoint_results: checks,
  };
}
function decide({ race, stage, now, baseline, comparison, complete, prediction, odds, scenarios, meaningful }) {
  const out = {
    status: 'WAIT', reasons: [], tickets: [], odds: {}, source_prediction_id: null,
    source_judgment: null, price_checked: false, valid_until: null, score_type: 'V7_RESEARCH_GATE',
    research_only: true, strategy: 'V7_SAVED_BUY_WITH_TWO_STAGE_EVIDENCE',
  };
  if (stage !== 'FINAL') { out.status = meaningful ? 'WATCH' : 'WAIT'; out.reasons.push('事前仮説を保存。展示・オッズ確認前のためBUYは判定しません'); return out; }
  if (!complete || !meaningful) { out.reasons.push(!complete ? '6艇の展示進入・ST・タイムが揃っていません' : '比較できる事前評価項目が不足しています'); return out; }
  if (!baseline || comparison.entrant_changed) { out.reasons.push(!baseline ? '保存済みの事前仮説がないため統合BUYを保留' : '出走選手が変わり事前仮説との対応を再確認する必要があります'); return out; }
  const deadline = forecastTime(race.deadline), at = forecastTime(prediction?.generated_at), stored = forecastTime(prediction?.created_date);
  const serverRecord = prediction?.source === 'SERVER' && typeof prediction?.record_hash === 'string' && prediction.record_hash.startsWith('server:');
  if (!prediction?.id || prediction.race_id !== race.id || prediction.race_key !== race.race_key
    || prediction.stage !== 'FINAL' || !serverRecord || at == null || stored == null
    || at > now || stored > now || at >= deadline - CUTOFF_MS || stored >= deadline - CUTOFF_MS) {
    out.reasons.push('締切前に保存されたサーバーV7最終予想を待っています'); return out;
  }
  const plan = prediction.plans?.hit_8;
  out.source_prediction_id = prediction.id;
  out.source_judgment = typeof plan?.judgment === 'string' ? plan.judgment : null;
  if (!validTickets(plan?.tickets, 8)) { out.reasons.push('V7の8点買い目を検証できません'); return out; }
  out.tickets = [...plan.tickets];
  if (plan.judgment !== 'BUY') { out.status = plan.judgment === 'SKIP' ? 'SKIP' : 'WATCH'; out.reasons.push('保存済みV7の研究判定は' + (plan.judgment || '未確定')); return out; }
  const quoteAt = forecastTime(odds?.captured_at), quoteStored = forecastTime(odds?.created_date);
  if (!odds?.id || odds.race_id !== race.id || quoteAt == null || quoteAt > now
    || quoteStored == null || quoteStored > now || quoteStored >= deadline - CUTOFF_MS
    || quoteAt >= deadline - CUTOFF_MS || now - quoteAt >= FINAL_ODDS_MAX_AGE_MS) {
    out.reasons.push('5分以内に取得した締切前オッズを待っています'); return out;
  }
  const quotes = Object.fromEntries(plan.tickets.map(ticket => [ticket, bounded(odds.odds_map?.[ticket], 1, 1000000)]));
  if (Object.values(quotes).some(value => value == null)) { out.reasons.push('8点すべてのオッズが揃っていません'); return out; }
  out.odds = quotes;
  out.odds_snapshot_id = odds.id;
  out.odds_captured_at = odds.captured_at;
  out.valid_until = new Date(Math.min(deadline - CUTOFF_MS, quoteAt + FINAL_ODDS_MAX_AGE_MS)).toISOString();
  const originalSnapshot = prediction.pricing_snapshot;
  const originalAt = forecastTime(originalSnapshot?.captured_at);
  const originalStored = forecastTime(originalSnapshot?.created_date);
  const original = originalSnapshot?.odds_map || null;
  if (!originalSnapshot?.id || originalSnapshot.race_id !== race.id || originalAt == null
    || originalStored == null || originalStored > at || originalStored >= deadline - CUTOFF_MS
    || originalAt > at || originalAt >= deadline - CUTOFF_MS || !original
    || plan.tickets.some(ticket => bounded(original[ticket], 1, 1000000) == null)) {
    out.status = 'WATCH'; out.reasons.push('V7生成前に取得・保存された参照オッズが不足しているため、独立の価格条件を保留'); return out;
  }
  // The nearest previously stored snapshot is a reference price, not proven V7 input.
  out.reference_odds_id = originalSnapshot.id;
  out.reference_odds_captured_at = originalSnapshot.captured_at;
  out.reference_price_basis = 'LATEST_AVAILABLE_AT_PREDICTION_TIME_NOT_PROVEN_INPUT';
  out.price_checked = true;
  out.price_rule = 'EACH_SELECTED_ODDS_AT_LEAST_PRE_PREDICTION_REFERENCE';
  const declined = plan.tickets.filter(ticket => quotes[ticket] < original[ticket]);
  if (declined.length) { out.status = 'WATCH'; out.reasons.push(declined.length + '点でV7生成前の参照オッズを下回るため、独立の価格条件を保留'); return out; }
  const leaders = new Set(plan.tickets.map(ticket => Number(ticket[0])));
  if (!scenarios[0] || !leaders.has(scenarios[0].leader)) {
    out.status = 'WATCH'; out.reasons.push('展開仮説の本線とV7買い目の1着候補が一致しないため保留'); return out;
  }
  out.status = 'BUY';
  out.reasons.push('事前仮説との比較と6艇の展示確認が完了', '保存済みV7研究BUYと展開本線の1着候補が一致', '8点すべての現在オッズがV7生成前の参照オッズ以上。参照値とV7が使った入力との一致は未確認');
  return out;
}
function conditionsSnapshot(race, weather, stage, now, missing) {
  // This revision records conditions, but no unvalidated wind/tide coefficient is applied.
  if (stage !== 'FINAL') {
    missing.push('WEATHER_FORECAST_NOT_CONNECTED', 'TIDE_FORECAST_NOT_CONNECTED');
    return { kind: 'FORECAST', weather: null, wind_direction: null, wind_speed: null, wave_height: null, tide: null, used_for_scoring: false };
  }
  const at = forecastTime(weather?.observed_at);
  const usable = weather?.race_id === race.id && (weather?.kind || weather?.observation_kind) === 'PRE_REFERENCE' && at != null && at <= now && now - at <= 60 * 60 * 1000;
  if (!usable) missing.push('PRE_RACE_WEATHER_MISSING');
  missing.push('TIDE_NOT_CONNECTED');
  return {
    kind: 'PRE_RACE_OBSERVATION', source_id: usable ? weather.id || null : null,
    observed_at: usable ? weather.observed_at : null,
    weather: usable ? weather.weather || null : null,
    wind_direction: usable ? weather.wind_dir || null : null,
    wind_speed: usable ? bounded(weather.wind_speed, 0, 100) : null,
    wave_height: usable ? bounded(weather.wave_height, 0, 1000) : null,
    tide: null, used_for_scoring: false,
  };
}
function fingerprint(value) {
  // Stable change detection only, not a cryptographic audit signature.
  let hash = 2166136261;
  const text = JSON.stringify(value);
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function buildRaceForecast({ race, entries = [], stage, now: nowText, baseline = null, prediction = null, odds = null, weather = null }) {
  const now = forecastTime(nowText), deadline = forecastTime(race?.deadline);
  if (!STAGES.includes(stage)) return { ok: false, reason: 'INVALID_STAGE' };
  if (!race?.id || !/^\d{4}-\d{2}-\d{2}_\d{2}_\d{2}$/.test(race?.race_key || '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(race?.race_date || '') || now == null || deadline == null
    || now >= deadline - CUTOFF_MS || ['finished', 'cancelled'].includes(race.status)) return { ok: false, reason: 'INVALID_OR_CLOSED_RACE' };
  const expectedKey = race.race_date + '_' + String(race.venue_code).padStart(2, '0') + '_' + String(race.race_number).padStart(2, '0');
  if (expectedKey !== race.race_key || dateJst(deadline) !== race.race_date) return { ok: false, reason: 'RACE_IDENTITY_MISMATCH' };
  if (sourceTime(race) == null || sourceTime(race) > now) return { ok: false, reason: 'RACE_SOURCE_TIME_INVALID' };
  if (stage === 'DAY_BEFORE' ? dateJst(now + 86400000) !== race.race_date : dateJst(now) !== race.race_date) {
    return { ok: false, reason: 'STAGE_DATE_MISMATCH' };
  }
  if (!Array.isArray(entries) || entries.length !== 6
    || new Set(entries.map(entry => validCourse(entry.boat_number))).size !== 6
    || entries.some(entry => !entry.id || validCourse(entry.boat_number) == null)) return { ok: false, reason: 'INVALID_BOATS' };
  const sorted = [...entries].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
  if (sorted.some(entry => entry.race_id !== race.id || (entry.race_key && entry.race_key !== race.race_key)
    || (entry.race_date && entry.race_date !== race.race_date))) return { ok: false, reason: 'ENTRY_RACE_MISMATCH' };
  if (sorted.some(entry => !/^\d{4}$/.test(registration(entry))) || new Set(sorted.map(registration)).size !== 6) {
    return { ok: false, reason: 'ENTRY_IDENTITY_INVALID' };
  }
  if (sorted.some(entry => sourceTime(entry) == null || sourceTime(entry) > now)) return { ok: false, reason: 'ENTRY_SOURCE_TIME_INVALID' };
  if (stage === 'PRE' && (race.exhibition_ready === true || sorted.some(hasExhibition))) return { ok: false, reason: 'EXHIBITION_ALREADY_AVAILABLE' };
  const rawBoats = sorted.map(entry => normalizeBoat(entry, race, stage));
  if (new Set(rawBoats.map(boat => boat.expected_course)).size !== 6) return { ok: false, reason: 'EXPECTED_COURSE_CONFLICT' };
  const missing = [];
  const complete = stage === 'FINAL' && rawBoats.every(boat => boat.active && boat.exhibition_time != null
    && boat.exhibition_st != null && boat.observed_course != null && !boat.exhibition_late)
    && new Set(rawBoats.map(boat => boat.observed_course)).size === 6;
  if (stage === 'FINAL' && !complete) missing.push('EXHIBITION_INCOMPLETE_OR_CONFLICTED');
  const active = rawBoats.filter(boat => boat.active);
  if (active.length !== 6) missing.push('ACTIVE_BOATS_NOT_SIX');
  for (const key of ['national_win_rate', 'motor_2rate', 'avg_st', 'course_win_percent']) {
    if (rawBoats.some(boat => boat[key] == null)) missing.push(key.toUpperCase() + '_INCOMPLETE');
  }
  const evaluated = scoreBoats(rawBoats, stage);
  if (!evaluated.meaningful) missing.push('SCORING_INPUTS_INSUFFICIENT');
  const scenarios = evaluated.meaningful && active.length === 6 ? buildScenarios(evaluated.boats, complete) : [];
  const savedBaseline = useBaseline(baseline, race, now);
  const comparison = compare(savedBaseline, evaluated.boats, scenarios, complete, stage);
  const decision = decide({ race, stage, now, baseline: savedBaseline, comparison, complete, prediction, odds, scenarios, meaningful: evaluated.meaningful });
  const conditions = conditionsSnapshot(race, weather, stage, now, missing);
  const maxSourceAt = Math.max(sourceTime(race), ...sorted.map(sourceTime),
    forecastTime(decision.odds_captured_at) || 0,
    forecastTime(conditions.observed_at) || 0,
    decision.source_prediction_id ? forecastTime(prediction.generated_at) || 0 : 0);
  const priorIdentity = stage === 'FINAL' ? savedBaseline?.id || null : null;
  const contentHash = fingerprint({ boats: evaluated.boats, baseline_id: priorIdentity,
    prediction_id: stage === 'FINAL' ? prediction?.id || null : null, odds_id: stage === 'FINAL' ? odds?.id || null : null,
    odds: decision.odds, decision, conditions });
  return { ok: true, record: {
    forecast_key: FORECAST_REVISION + ':' + race.race_key + ':' + stage + (stage === 'FINAL' ? ':' + contentHash : ''),
    revision: FORECAST_REVISION, race_id: race.id, race_key: race.race_key, race_date: race.race_date,
    venue_code: String(race.venue_code).padStart(2, '0'), venue_name: race.venue_name || '',
    race_number: Number(race.race_number), deadline: race.deadline, stage, generated_at: new Date(now).toISOString(),
    input_as_of: new Date(maxSourceAt).toISOString(), boats: evaluated.boats,
    scenarios, top_scenario_key: scenarios[0]?.key || null, research_tickets: candidateTickets(evaluated.boats, scenarios),
    comparison, decision, priority_score: round(scenarios[0]?.score ?? 0),
    quality: !evaluated.meaningful || (stage === 'FINAL' && !complete) || active.length !== 6 ? 'PARTIAL' : 'CAPTURED',
    missing: [...new Set(missing)], conditions, exhibition_complete: complete,
    score_type: 'UNCALIBRATED_RESEARCH_SCORE', model_label: '展開仮説 V8',
    gender_model: race.is_womens === true ? 'WOMENS' : race.is_womens === false ? 'OPEN' : 'UNKNOWN',
    provenance: {
      source: 'Race_RaceEntry_PredictionV7_OddsSnapshot', input_revision: FORECAST_REVISION,
      entry_ids: sorted.map(entry => entry.id), race_updated_at: race.updated_date || race.created_date,
      baseline_id: priorIdentity, prediction_id: decision.source_prediction_id,
      odds_snapshot_id: stage === 'FINAL' ? decision.odds_snapshot_id || null : null,
      source_times_checked: true, future_inputs_excluded: true,
      exhibition_used: stage === 'FINAL', odds_used: stage === 'FINAL' && decision.price_checked,
      weather_used_for_scoring: false, tide_used_for_scoring: false,
      original_v7_unchanged: true, research_only: true, content_fingerprint: contentHash,
      fingerprint_kind: 'FNV1A_CHANGE_DETECTION_NOT_SIGNATURE',
    },
  } };
}

