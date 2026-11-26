// Immutable, pre-deadline V8 development hypotheses.
// Ordinal research scores are NOT occurrence probabilities or expected returns.
// This module is pure and portable between Node and Deno.
import {buildSumEvidence, selectedSumModel} from './v8SumTheory.js';
import {buildScenarioTickets, SCENARIO_TICKET_REVISION, SCENARIO_TICKET_BASIS} from './v8ScenarioTickets.js';
import {buildRacerParameters, parameterBoatFields, racerScenarioEvidence, roleAdjustedBoatScore} from './v8RacerParameters.js';
import {buildRecentLaneEvidence,recentLaneEvidenceKey,RECENT_LANE_PRIOR_STRENGTH} from './v8RecentLaneEvidence.js';
import {buildVenueEvidence,venueEvidenceKey,applyVenueToScenarios,buildFinalTicketSelection,decideFinalSelection,
  FINAL_SELECTION_REVISION,FINAL_BUY_POLICY_REVISION} from './v8FinalTickets.js';
export const FORECAST_REVISION = 'V8_FORECAST_7_HEAD_COVERAGE';
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
  // Observed course is applied only after the whole exhibition entry is checked.
  const course = courseRecord(entry, expected);
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
function scoreBoats(boats, stage, sumEvidence, recentEvidence) {
  const recentRows=new Map((recentEvidence?.boats||[]).map(row=>[row.boat_number,row]));
  const grouped=boats.some(boat=>boat.racer_parameters?.profile_valid===true)
    ||boats.some(boat=>recentRows.get(boat.boat_number)?.status==='READY');
  const coreFields=[
    ['national_win_rate', .21, value => value * 10],
    ['local_win_rate', .10, value => value * 10],
    ['national_2rate', .12, value => value],
    ['motor_2rate', .18, value => value],
    ['section_points', .08, value => clamp(value * 10)],
  ];
  const legacyFields=[
    ['national_win_rate', .27, value => value * 10],
    ['local_win_rate', .12, value => value * 10],
    ['national_2rate', .16, value => value],
    ['motor_2rate', .18, value => value],
    ['avg_st', .15, value => clamp((.3 - value) / .3 * 100)],
    ['section_points', .08, value => clamp(value * 10)],
    ['course_win_percent', .04, value => value],
  ];
  // Core features retain the common-input rule. Detailed groups use a disclosed
  // per-racer fallback, so one missing history cannot discard the other five.
  const common=(grouped?coreFields:legacyFields).filter(([key])=>boats.every(boat=>finite(boat[key])));
  const coreWeights=common.reduce((sum,[,weight])=>sum+weight,0);
  const groupWeights=Object.fromEntries(common.map(([key,weight])=>[key,round(weight/coreWeights*(grouped ? .69 : 1))]));
  const featureKeys=grouped
    ?['national_win_rate','local_win_rate','national_2rate','motor_2rate','start_parameter_score','section_points','course_finish_score']
      .filter(key=>Object.hasOwn(groupWeights,key)||['start_parameter_score','course_finish_score'].includes(key))
    :common.map(([key])=>key);
  if(grouped){groupWeights.start_parameter_score=.15;groupWeights.course_finish_score=.16;}
  const independentInputs=common.length+(grouped&&boats.some(boat=>finite(boat.avg_st)||finite(boat.racer_parameters?.effective_avg_st))?1:0)
    +(grouped&&boats.some(boat=>finite(boat.racer_parameters?.course_finish_score)||recentRows.get(boat.boat_number)?.scoring?.finish_sample_size>0)?1:0);
  const meaningful=independentInputs>=3&&common.some(([key])=>key==='national_win_rate'||key==='national_2rate');
  const finishValue=value=>['first_rate','top2_rate','top3_rate'].every(key=>finite(value?.[key]))
    ?value.first_rate*.5+value.top2_rate*.3+value.top3_rate*.2:null;
  const stValue=value=>finite(value)?clamp((.3-value)/.3*100):null;
  const rankValue=value=>finite(value)?clamp((6-value)/5*100):null;
  const mix=(reference,value,alpha)=>!finite(value)||alpha<=0?reference:finite(reference)?reference+alpha*(value-reference):value;
  boats=boats.map(boat=>{
    const p=boat.racer_parameters||{},r=recentRows.get(boat.boat_number),s=r?.scoring;
    const core=weightedMean(common.map(([key,weight,convert])=>[convert(boat[key]),weight]));
    if(!grouped){
      if(s){s.reason=r.reason;s.base_before=round(core);s.base_after=round(core);}
      return {...boat,base_score:round(core),racer_parameters:{...p,used_for_scoring:false,used_features:[],role_finish_used:false,
        effective_avg_st:null,start_score:null,start_basis:'OVERALL_AVG_ST'}};
    }
    const individualFinish=finishValue(p.adjusted),populationFinish=finishValue(p.prior);
    const finishReference=individualFinish??populationFinish??core;
    const finishKind=individualFinish!==null?'RACER_COURSE':populationFinish!==null?'COURSE_POPULATION':'CORE_NEUTRAL';
    const individualST=finite(p.adjusted?.avg_st)?p.adjusted.avg_st:null;
    const referenceST=individualST??(finite(boat.avg_st)?boat.avg_st:null)??(finite(p.prior?.avg_st)?p.prior.avg_st:null);
    const referenceRank=finite(p.adjusted?.avg_st_rank)?p.adjusted.avg_st_rank
      :individualST===null&&!finite(boat.avg_st)&&finite(p.prior?.avg_st_rank)?p.prior.avg_st_rank:null;
    const startKind=individualST!==null?'RACER_COURSE':finite(boat.avg_st)?'OVERALL_AVG_ST':referenceST!==null?'COURSE_POPULATION':'CORE_NEUTRAL';
    const referenceSTScore=stValue(referenceST)??core;
    const referenceRankScore=rankValue(referenceRank)??referenceSTScore;
    const startReference=weightedMean([[referenceSTScore,.8],[referenceRankScore,.2]]);
    const finishAlpha=s?.finish_sample_size>0?s.finish_sample_size/(s.finish_sample_size+RECENT_LANE_PRIOR_STRENGTH):0;
    const recentST=finite(s?.recent_avg_st)?s.recent_avg_st:null,recentRank=finite(s?.recent_avg_start_order)?s.recent_avg_start_order:null;
    const startAlpha=(recentST!==null||recentRank!==null)&&r?.raw?.sample_size>0
      ?r.raw.sample_size/(r.raw.sample_size+RECENT_LANE_PRIOR_STRENGTH):0;
    const finishAfter=mix(finishReference,s?.recent_finish_score,finishAlpha);
    const startAfter=weightedMean([[mix(referenceSTScore,stValue(recentST),startAlpha),.8],
      [mix(referenceRankScore,rankValue(recentRank),startAlpha),.2]]);
    const before=weightedMean([[core,.69],[finishReference,.16],[startReference,.15]]);
    const after=weightedMean([[core,.69],[finishAfter,.16],[startAfter,.15]]);
    const effectiveST=mix(referenceST,recentST,startAlpha);
    const individualStart=individualST!==null||finite(p.adjusted?.avg_st_rank);
    const officialUsed=meaningful&&(individualFinish!==null||individualStart);
    const roleUsed=meaningful&&p.profile_valid===true&&finite(p.second_finish_score)&&finite(p.third_finish_score);
    const used=[];
    if(meaningful&&finishAlpha>0&&finite(s?.recent_finish_score)){
      used.push('RECENT_FINISH_FREQUENCY');if(s.winning_rate_used)used.push('RECENT_FINISH_POINTS');
    }
    if(meaningful&&startAlpha>0&&recentST!==null)used.push('RECENT_AVG_ST');
    if(meaningful&&startAlpha>0&&recentRank!==null)used.push('RECENT_ST_RANK');
    if(s){
      Object.assign(s,{used:used.length>0,applied:used.length>0,used_features:used,
        reason:!meaningful?'SCORING_INPUTS_INSUFFICIENT':used.length?'APPLIED':r.reason==='READY'?'NO_USABLE_METRICS':r.reason,
        finish_reference_kind:finishKind,start_reference_kind:startKind,
        finish_before:round(finishReference),finish_after:round(finishAfter),start_before:round(startReference),start_after:round(startAfter),
        base_before:round(before),base_after:round(after),delta:used.length?round(round(after)-round(before)):null});
      if(!meaningful&&!s.omitted_reasons.includes('SCORING_INPUTS_INSUFFICIENT'))s.omitted_reasons.push('SCORING_INPUTS_INSUFFICIENT');
    }
    const startBasis=individualST!==null?(finite(referenceRank)?'COURSE_AVG_ST_AND_RANK':'COURSE_AVG_ST')
      :startKind==='COURSE_POPULATION'?'COURSE_POPULATION':startKind==='CORE_NEUTRAL'?'CORE_NEUTRAL':'OVERALL_AVG_ST';
    return {...boat,base_score:round(after),start_parameter_score:round(startAfter),course_finish_score:round(finishAfter),
      recent_lane_scoring:s?JSON.parse(JSON.stringify(s)):null,
      racer_parameters:{...p,used_for_scoring:officialUsed,role_finish_used:roleUsed,
        used_features:meaningful?[...(individualFinish!==null?['course_finish_score']:[]),...(individualStart?['start_parameter_score']:[])]:[],
        finish_reference_kind:finishKind,course_finish_score:round(finishAfter),
        effective_avg_st:individualStart||startAlpha>0||startKind==='COURSE_POPULATION'?round(effectiveST):null,
        start_score:individualStart||startAlpha>0?round(startAfter):null,
        start_basis:startBasis+(startAlpha>0?'_WITH_RECENT_LANE':'')}};
  });
  const allTimes = stage === 'FINAL' && boats.every(boat => finite(boat.exhibition_time));
  const allStarts = stage === 'FINAL' && boats.every(boat => finite(boat.exhibition_st));
  const minTime = allTimes ? Math.min(...boats.map(boat => boat.exhibition_time)) : null;
  const maxTime = allTimes ? Math.max(...boats.map(boat => boat.exhibition_time)) : null;
  const sum = stage === 'FINAL' ? selectedSumModel(sumEvidence) : null;
  return {
    feature_keys: featureKeys,
    feature_weights:groupWeights,
    parameter_weights_applied:grouped,
    racer_parameters_used:boats.some(boat=>boat.racer_parameters?.used_for_scoring===true),
    meaningful,
    boats: boats.map(boat => {
      const speedScore = !allTimes ? null : maxTime === minTime ? 50 : (maxTime - boat.exhibition_time) / (maxTime - minTime) * 100;
      const sumRow = sum?.boats.find(row => row.boat_number === boat.boat_number);
      const originalRow = sumRow || sumEvidence?.basic?.boats.find(row => row.boat_number === boat.boat_number);
      const sumScore = finite(sumRow?.relative_score) ? sumRow.relative_score : null;
      const exhibitionStartScore = !allStarts ? null : boat.exhibition_flying ? 0 : clamp((.3 - boat.exhibition_st) / .3 * 100);
      // Replace the existing speed term; adding SUM as a second speed feature
      // would count the shared exhibition measurement twice.
      const score = weightedMean([[boat.base_score, .75], [sumScore ?? speedScore, .15], [exhibitionStartScore, .10]]);
      return { ...boat,score: round(score), exhibition_speed_score: round(speedScore), exhibition_start_score: round(exhibitionStartScore),
        lap_time: originalRow?.lap_time ?? null, turn_time: originalRow?.turn_time ?? null,
        straight_time: originalRow?.straight_time ?? null, sum_total: sumRow?.total ?? null,
        sum_delta: sumRow?.delta ?? null, sum_speed_score: round(sumScore),
        speed_feature: sumScore == null ? 'EXHIBITION_TIME' : sum.key };
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
    return finite(boat.racer_parameters?.effective_avg_st)
      ? boat.racer_parameters.effective_avg_st : boat.avg_st;
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
      racer_evidence: racerScenarioEvidence(boat),
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
      score: scenario.score * .58 + roleAdjustedBoatScore(b,2) * .27 + roleAdjustedBoatScore(c,3) * .15
        + (scenario.beneficiaries.includes(b.boat_number) ? 2 : 0),
    });
  }
  return rows.sort((a, b) => b.score - a.score || a.ticket.localeCompare(b.ticket)).slice(0, 8).map(row => row.ticket);
}
function useBaseline(baseline, race, now, replay = false) {
  if (!baseline?.id || !['DAY_BEFORE', 'PRE'].includes(baseline.stage) || baseline.race_key !== race.race_key
    || baseline.race_id !== race.id || baseline.race_date !== race.race_date) return null;
  const generated = forecastTime(baseline.generated_at), created = forecastTime(baseline.created_date);
  if (generated == null || created == null || generated > now || created > now) return null;
  if (replay && baseline.record_mode === 'REPLAY') {
    return baseline.stage === 'PRE' && baseline.provenance?.reconstruction === true
      && baseline.provenance?.result_excluded === true && Array.isArray(baseline.boats)
      && baseline.boats.length === 6 ? baseline : null;
  }
  if (baseline.record_mode === 'REPLAY' || generated >= forecastTime(race.deadline) - CUTOFF_MS
    || created >= forecastTime(race.deadline) - CUTOFF_MS) return null;
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
  const baseFields=['national_win_rate','local_win_rate','national_2rate','motor_2rate','motor_3rate','motor_number','avg_st','section_points'];
  const baseChanges=boats.map(boat=>{
    const prior=baseline.boats.find(row=>row.boat_number===boat.boat_number&&row.registration_number===boat.registration_number);
    return {boat_number:boat.boat_number,fields:prior?baseFields.filter(key=>(prior[key]??null)!==(boat[key]??null)):[]};
  }).filter(row=>row.fields.length);
  if(baseChanges.length)changes.push('展示以外の基礎情報も更新されています（'+baseChanges.map(row=>row.boat_number+'号艇').join('・')+'）');
  checks.push({label:'展示以外の基礎情報',status:baseChanges.length?'CHANGED':'SUPPORTED',
    detail:baseChanges.length?'選手・モーター・節間等の更新を展示の変化と区別して記録':'事前保存と同じ基礎情報'});
  if (changedEntrants) changes.push('事前保存後に出走選手の対応が変わっています');
  const entryCheck={ label: '想定進入', status: !complete ? 'UNKNOWN' : changedCourses.length ? 'CHANGED' : 'SUPPORTED',
    detail: !complete ? '展示進入の確定待ち' : changedCourses.length ? changedCourses.map(boat => boat.boat_number + '号艇→' + boat.observed_course + 'コース').join(' / ') : '事前の想定進入と一致' };
  checks.push(entryCheck);
  if (changedCourses.length) changes.push('進入変更：' + entryCheck.detail);
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
    non_exhibition_inputs_changed:baseChanges.length>0,non_exhibition_changes:baseChanges,
  };
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
// Capture can compare immutable source identities before deciding whether an
// earlier PRE without WAKU10 needs a separately saved supplemented forecast.
export function forecastRecentLaneKey(input){
  if(Array.isArray(input?.entries))return recentLaneEvidenceKey(buildRecentLaneEvidence(input));
  return recentLaneEvidenceKey(input?.recent_lane_evidence||input);
}
export function forecastVenueKey(input){
  return input?.race?venueEvidenceKey(buildVenueEvidence(input)):venueEvidenceKey(input);
}
function buildForecast({ race, entries = [], stage, now: nowText, baseline = null, odds = null, weather = null, originalExhibition = null,venueProfile=null }, replay = false) {
  const now = forecastTime(nowText), deadline = forecastTime(race?.deadline);
  if (!STAGES.includes(stage)) return { ok: false, reason: 'INVALID_STAGE' };
  if (!race?.id || !/^\d{4}-\d{2}-\d{2}_\d{2}_\d{2}$/.test(race?.race_key || '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(race?.race_date || '') || now == null || deadline == null
    || race.status === 'cancelled' || (!replay && (now >= deadline - CUTOFF_MS || race.status === 'finished'))) return { ok: false, reason: 'INVALID_OR_CLOSED_RACE' };
  if (replay && !['PRE', 'FINAL'].includes(stage)) return { ok: false, reason: 'REPLAY_STAGE_INVALID' };
  const expectedKey = race.race_date + '_' + String(race.venue_code).padStart(2, '0') + '_' + String(race.race_number).padStart(2, '0');
  if (expectedKey !== race.race_key || dateJst(deadline) !== race.race_date) return { ok: false, reason: 'RACE_IDENTITY_MISMATCH' };
  if (sourceTime(race) == null || sourceTime(race) > now) return { ok: false, reason: 'RACE_SOURCE_TIME_INVALID' };
  if (!replay && (stage === 'DAY_BEFORE' ? dateJst(now + 86400000) !== race.race_date : dateJst(now) !== race.race_date)) {
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
  let rawBoats = sorted.map(entry => normalizeBoat(entry, race, stage));
  if (new Set(rawBoats.map(boat => boat.expected_course)).size !== 6) return { ok: false, reason: 'EXPECTED_COURSE_CONFLICT' };
  const missing = [];
  const active = rawBoats.filter(boat => boat.active);
  const participating = replay ? active : rawBoats;
  const complete = stage === 'FINAL' && participating.length >= 3
    && participating.every(boat => boat.active && boat.exhibition_time != null
      && (boat.exhibition_st != null || (replay && boat.exhibition_late))
      && boat.observed_course != null && (replay || !boat.exhibition_late))
    && new Set(participating.map(boat => boat.observed_course)).size === participating.length;
  const savedBaseline = useBaseline(baseline, race, now, replay);
  const racerEvidence = buildRacerParameters({race,entries:sorted,stage,now:nowText,baseline:savedBaseline,
    exhibitionComplete:complete,replay});
  const recentEvidence=buildRecentLaneEvidence({race,entries:sorted,stage,now:nowText,baseline:savedBaseline,
    exhibitionComplete:complete,replay});
  const venueEvidence=buildVenueEvidence({race,venueProfile,stage,now:nowText,baseline:savedBaseline,exhibitionComplete:complete,replay});
  rawBoats=rawBoats.map((boat,index)=>{
    const parameters=racerEvidence.boats[index],selected=complete?boat.observed_course:boat.expected_course;
    const legacyCourse=courseRecord(sorted[index],selected);
    const profileCourse=parameters.profile_valid?parameters.raw:null;
    const startScore=parameters.scoring.start_score??(finite(boat.avg_st)?clamp((.3-boat.avg_st)/.3*100):null);
    return {...boat,...parameterBoatFields(parameters),
      course_win_percent:parameters.profile_valid?(profileCourse?.first_rate??null):legacyCourse.win_percent,
      course_sample_size:parameters.profile_valid?(profileCourse?.sample_size??null):legacyCourse.starts,
      start_parameter_score:startScore,course_finish_score:parameters.scoring.course_finish_score};
  });
  if (stage === 'FINAL' && !complete) missing.push('EXHIBITION_INCOMPLETE_OR_CONFLICTED');
  if (active.length !== 6) missing.push(replay ? 'SCRATCHED_BOATS_EXCLUDED' : 'ACTIVE_BOATS_NOT_SIX');
  for (const key of ['national_win_rate', 'motor_2rate', 'avg_st', 'course_win_percent']) {
    if (rawBoats.some(boat => boat[key] == null)) missing.push(key.toUpperCase() + '_INCOMPLETE');
  }
  const sum = buildSumEvidence({race, boats: rawBoats, originalExhibition, stage, now: nowText, replay});
  const evaluated = scoreBoats(replay ? rawBoats.filter(boat=>boat.active) : rawBoats, stage, sum.evidence,recentEvidence);
  const allEvaluated = replay ? rawBoats.map(boat => evaluated.boats.find(row => row.boat_number === boat.boat_number)
    || { ...boat, base_score: null, score: null, exhibition_speed_score: null, exhibition_start_score: null }) : evaluated.boats;
  if (!evaluated.meaningful) missing.push('SCORING_INPUTS_INSUFFICIENT');
  const enoughBoats = replay ? active.length >= 3 : active.length === 6;
  sum.evidence.used_for_scoring = stage === 'FINAL' && sum.evidence.status === 'READY' && evaluated.meaningful && enoughBoats;
  if (stage === 'FINAL' && sum.evidence.status !== 'READY') missing.push('SUM_NOT_APPLIED');
  const scenarios = evaluated.meaningful && enoughBoats ? applyVenueToScenarios({scenarios:buildScenarios(evaluated.boats,complete),
    boats:allEvaluated,venueEvidence,stage,exhibitionComplete:complete}).map(scenario => ({
    ...scenario,
    recent_lane_evidence:(()=>{
      const row=recentEvidence.boats.find(item=>item.boat_number===scenario.leader);
      return row?.snapshot?{boat_number:row.boat_number,registration_number:row.registration_number,lane:row.lane,
        selected_course:row.selected_course,snapshot_id:row.snapshot_id,source_basis:row.source_basis,
        scoring:JSON.parse(JSON.stringify(row.scoring))}:null;
    })(),
    tickets:buildScenarioTickets({scenario,boats:allEvaluated,stage,exhibitionComplete:complete}),
    ticket_revision:SCENARIO_TICKET_REVISION, ticket_basis:SCENARIO_TICKET_BASIS,
  })) : [];
  const comparison = compare(savedBaseline, allEvaluated, scenarios, complete, stage);
  const venueChanged=!!savedBaseline&&(venueEvidence.profile?.snapshot_id??null)!==(savedBaseline.venue_evidence?.profile?.snapshot_id??null);
  comparison.venue_inputs_changed=venueChanged;
  comparison.non_exhibition_global_changes=venueChanged?['venue_profile']:[];
  if(savedBaseline){
    comparison.checkpoint_results.push({label:'場のコース別根拠',status:venueChanged?'CHANGED':venueEvidence.profile?'SUPPORTED':'UNKNOWN',
      detail:venueEvidence.change_note||'場の資料の取得待ち'});
    if(venueChanged){comparison.non_exhibition_inputs_changed=true;comparison.changes.push('展示以外の場の資料も追加・更新されています');}
  }
  const recentChanged=savedBaseline?recentEvidence.boats.filter(row=>{
    const old=savedBaseline.recent_lane_evidence?.boats?.find(item=>item.boat_number===row.boat_number&&item.registration_number===row.registration_number);
    return (row.snapshot_id??null)!==(old?.snapshot_id??null)||(row.row_hash??null)!==(old?.row_hash??null);
  }):[];
  comparison.recent_lane_inputs_changed=recentChanged.length>0;
  comparison.recent_lane_changed_boats=recentChanged.map(row=>row.boat_number);
  if(savedBaseline){
    comparison.checkpoint_results.push({label:'枠番過去10走',status:recentChanged.length?'CHANGED':recentEvidence.status==='UNAVAILABLE'?'UNKNOWN':'SUPPORTED',
      detail:recentEvidence.change_note||'枠番過去10走の取得待ち'});
    if(recentChanged.length){
      comparison.changes.push('展示以外の枠番履歴も追加・更新されています（'+recentChanged.map(row=>row.boat_number+'号艇').join('・')+'）');
      comparison.non_exhibition_inputs_changed=true;
      for(const row of recentChanged){
        const existing=comparison.non_exhibition_changes.find(item=>item.boat_number===row.boat_number);
        if(existing)existing.fields.push('recent_lane_snapshot');
        else comparison.non_exhibition_changes.push({boat_number:row.boat_number,fields:['recent_lane_snapshot']});
      }
      const check=comparison.checkpoint_results.find(item=>item.label==='展示以外の基礎情報');
      if(check){check.status='CHANGED';check.detail='選手・モーター・節間・枠番履歴の更新を展示の変化と区別して記録';}
    }
  }
  racerEvidence.scoring={feature_keys:evaluated.feature_keys,feature_weights:evaluated.feature_weights,
    parameter_weights_applied:evaluated.parameter_weights_applied,prior_strength:20};
  for(const row of racerEvidence.boats){
    const boat=allEvaluated.find(item=>item.boat_number===row.boat_number);
    for(const key of ['start_score','start_basis','effective_avg_st','course_finish_score','finish_reference_kind','used_for_scoring','role_finish_used']) {
      // Preserve explicit nulls: a displayed raw value is not necessarily the
      // reference or blended value applied by the score calculation.
      if(Object.hasOwn(boat?.racer_parameters||{},key))row.scoring[key]=boat.racer_parameters[key];
      else if(!Object.hasOwn(row.scoring,key))row.scoring[key]=null;
    }
    row.scoring.used_features=boat?.racer_parameters?.used_features||[];
  }
  racerEvidence.non_exhibition_inputs_changed=comparison.non_exhibition_inputs_changed===true;
  racerEvidence.non_exhibition_changes=comparison.non_exhibition_changes||[];
  const researchTickets = candidateTickets(evaluated.boats, scenarios);
  const finalSelection=buildFinalTicketSelection({boats:allEvaluated,scenarios,venueEvidence,stage,exhibitionComplete:complete,replay});
  const decision=decideFinalSelection({race,stage,now,baseline:savedBaseline,comparison,complete,odds,
    meaningful:evaluated.meaningful,boats:allEvaluated,selection:finalSelection,replay});
  const conditions = conditionsSnapshot(race, weather, stage, now, missing);
  const maxSourceAt = Math.max(sourceTime(race), ...sorted.map(sourceTime),
    forecastTime(decision.odds_captured_at) || 0,
    forecastTime(conditions.observed_at) || 0,
    forecastTime(sum.evidence.input_as_of) || 0,
    forecastTime(venueEvidence.profile?.available_at)||0,
    ...recentEvidence.boats.map(row=>forecastTime(row.available_at)||0),
    ...racerEvidence.boats.flatMap(row=>[forecastTime(row.profile?.source?.available_at)||0,
      forecastTime(row.frame_tendencies?.latest_source_at||row.frame_tendencies?.as_of)||0]));
  const priorIdentity = stage === 'FINAL' ? savedBaseline?.id || null : null;
  const {as_of:racerCalculatedAt,...racerHashEvidence}=racerEvidence;
  racerHashEvidence.boats=racerEvidence.boats.map(row=>{
    if(!row.frame_tendencies)return row;
    const {as_of:frameCalculatedAt,...frameEvidence}=row.frame_tendencies;
    return {...row,frame_tendencies:frameEvidence};
  });
  const contentHash = fingerprint({ boats: allEvaluated, baseline_id: priorIdentity,
    odds_id: stage === 'FINAL' ? decision.odds_snapshot_id || null : null,
    odds: decision.odds, decision, conditions, sum_evidence: sum.evidence, original_exhibition: sum.original_exhibition,
    racer_evidence:racerHashEvidence,
    venue_evidence:venueEvidence,final_selection:finalSelection,
    recent_lane_evidence:Object.fromEntries(Object.entries(recentEvidence).filter(([key])=>key!=='as_of')),
    scenario_tickets:scenarios.map(scenario => ({key:scenario.key,tickets:scenario.tickets,revision:scenario.ticket_revision})) });
  const recentKey=recentLaneEvidenceKey(recentEvidence);
  const venueKey=venueEvidenceKey(venueEvidence);
  return { ok: true, record: {
    forecast_key: FORECAST_REVISION + ':' + race.race_key + ':' + stage + ':' + (stage === 'FINAL' ? contentHash : recentKey+':'+venueKey),
    revision: FORECAST_REVISION, race_id: race.id, race_key: race.race_key, race_date: race.race_date,
    venue_code: String(race.venue_code).padStart(2, '0'), venue_name: race.venue_name || '',
    race_number: Number(race.race_number), deadline: race.deadline, stage, generated_at: new Date(now).toISOString(),
    input_as_of: new Date(maxSourceAt).toISOString(), boats: allEvaluated,
    scenarios, top_scenario_key: scenarios[0]?.key || null, research_tickets: researchTickets,
    comparison, decision, priority_score: round(scenarios[0]?.score ?? 0),
    quality: !evaluated.meaningful || (stage === 'FINAL' && !complete) || !enoughBoats ? 'PARTIAL' : 'CAPTURED',
    missing: [...new Set(missing)], conditions, exhibition_complete: complete,
    sum_evidence: sum.evidence, original_exhibition: sum.original_exhibition,
    racer_evidence:racerEvidence,
    recent_lane_evidence:recentEvidence,recent_lane_key:recentKey,
    venue_evidence:venueEvidence,venue_key:venueKey,final_selection:finalSelection,
    score_type: 'UNCALIBRATED_RESEARCH_SCORE', model_label: '展開仮説 V8',
    gender_model: race.is_womens === true ? 'WOMENS' : race.is_womens === false ? 'OPEN' : 'UNKNOWN',
    provenance: {
      source: 'Race_RaceEntry_OddsSnapshot', input_revision: FORECAST_REVISION,
      entry_ids: sorted.map(entry => entry.id), race_updated_at: race.updated_date || race.created_date,
      baseline_id: priorIdentity, prediction_id: null, decision_revision:FINAL_BUY_POLICY_REVISION,
      odds_snapshot_id: stage === 'FINAL' ? decision.odds_snapshot_id || null : null,
      source_times_checked: true, future_inputs_excluded: true,
      exhibition_used: stage === 'FINAL', odds_used: stage === 'FINAL' && decision.price_checked,
      weather_used_for_scoring: false, tide_used_for_scoring: false,
      sum_revision: sum.evidence.revision, sum_used_for_scoring: sum.evidence.used_for_scoring,
      sum_model: sum.evidence.selected_model, sum_speed_weight: sum.evidence.used_for_scoring ? .15 : 0,
      sum_replaces_exhibition_speed: sum.evidence.used_for_scoring,
      scenario_ticket_revision:SCENARIO_TICKET_REVISION,
      racer_parameters_revision:racerEvidence.revision,racer_parameters_used:evaluated.racer_parameters_used,
      recent_lane_revision:recentEvidence.revision,recent_lane_used:recentEvidence.boats.some(row=>row.scoring.used),
      venue_revision:venueEvidence.revision,venue_snapshot_id:venueEvidence.profile?.snapshot_id||null,venue_used:venueEvidence.used,
      final_selection_revision:FINAL_SELECTION_REVISION,
      taro_official_strategy_reproduced: false,
      research_only: true, content_fingerprint: contentHash,
      fingerprint_kind: 'FNV1A_CHANGE_DETECTION_NOT_SIGNATURE',
    },
  } };
}


// The prospective entry point keeps its cutoff and original source-time checks.
export const buildRaceForecast = input => buildForecast(input, false);
// Only the whitelisting replay adapter uses this entry point. It never supplies live odds.
export const buildReplayHypothesis = input => buildForecast(input, true);

