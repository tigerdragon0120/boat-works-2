// Frozen official course records used by the V8 pre-race comparison.
// Rates are observed frequencies, while scoring transforms remain uncalibrated.
export const RACER_PARAMETERS_REVISION = 'V8_RACER_PARAMETERS_1';
export const RACER_PROFILE_REVISION = 'V8_RACER_PROFILE_1';
export const COURSE_PRIOR_STRENGTH = 20;
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bounded = (value,min,max) => finite(value) && value >= min && value <= max ? value : null;
const whole = (value,min=0,max=1000000) => Number.isInteger(value) && value >= min && value <= max ? value : null;
const course = value => whole(Number(value),1,6);
const reg = value => String(value ?? '').trim();
const round = value => finite(value) ? Math.round(value * 1000) / 1000 : null;
const clamp = value => Math.max(0,Math.min(100,value));
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const n = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + 'Z');
  return Number.isFinite(n) ? n : null;
};
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const mean = pairs => {
  const present = pairs.filter(([value])=>finite(value));
  return present.length ? present.reduce((sum,[value,weight])=>sum+value*weight,0)/present.reduce((sum,[,weight])=>sum+weight,0) : null;
};
const RATES = ['first_rate','second_rate','third_rate','top2_rate','top3_rate'];

function cleanCourse(raw,number) {
  if (!raw || course(raw.course) !== number) return null;
  const n = whole(raw.sample_size);
  const names = ['first_count','second_count','third_count','fourth_count','fifth_count','sixth_count'];
  const counts = names.map(name=>whole(raw[name]));
  if (n === null || counts.some(value=>value===null) || counts.reduce((sum,value)=>sum+value,0)>n) return null;
  const rates = n ? [counts[0],counts[1],counts[2],counts[0]+counts[1],counts[0]+counts[1]+counts[2]].map(value=>value/n*100) : RATES.map(()=>null);
  return {course:number,sample_size:n,...Object.fromEntries(names.map((name,index)=>[name,counts[index]])),
    ...Object.fromEntries(RATES.map((name,index)=>[name,round(rates[index])])),
    avg_st:n?bounded(raw.avg_st,0,1):null,avg_st_rank:n?bounded(raw.avg_st_rank,1,6):null,
    f_count:whole(raw.f_count),l_count:whole(raw.l_count)};
}
function cleanPrior(raw) {
  if (!raw || whole(raw.sample_size,1) === null) return null;
  const out = {sample_size:raw.sample_size,...Object.fromEntries(RATES.map(key=>[key,bounded(raw[key],0,100)])),
    avg_st:bounded(raw.avg_st,0,1),avg_st_rank:bounded(raw.avg_st_rank,1,6)};
  if (out.first_rate!==null && out.top2_rate!==null && out.first_rate>out.top2_rate) return null;
  if (out.top2_rate!==null && out.top3_rate!==null && out.top2_rate>out.top3_rate) return null;
  return out;
}

/** Validate again at the engine boundary, including a reused frozen profile. */
export function validatedRacerProfile(profile,{registrationNumber,raceDate,asOf}={}) {
  const source=profile?.source,at=time(asOf),available=time(source?.available_at);
  if (profile?.revision!==RACER_PROFILE_REVISION || !/^\d{4}$/.test(reg(registrationNumber))
    || reg(profile.registration_number)!==reg(registrationNumber) || at===null || available===null || available>at
    || !date(raceDate) || !source?.dataset_key || !source?.term_key
    || !date(source.term_start_date) || !date(source.term_end_date) || source.term_start_date>source.term_end_date
    || source.term_end_date>=raceDate || Date.parse(source.term_end_date+'T23:59:59.999+09:00')>available
    || !profile.courses || typeof profile.courses!=='object') return null;
  const courses={},priors={};
  for(let number=1;number<=6;number++){
    courses[String(number)]=cleanCourse(profile.courses[String(number)],number);
    priors[String(number)]=cleanPrior(profile.course_priors?.[String(number)]);
  }
  if (!Object.values(courses).some(Boolean)) return null;
  return {revision:RACER_PROFILE_REVISION,registration_number:reg(registrationNumber),player_name:String(profile.player_name||''),
    source:Object.fromEntries(['dataset_key','term_key','source_url','source_file','term_start_date','term_end_date','available_at','checksum']
      .map(key=>[key,source[key]??null])),courses,course_priors:priors};
}

function validBaseline(baseline,race,now) {
  const generated=time(baseline?.generated_at),created=time(baseline?.created_date),deadline=time(race?.deadline);
  return !!baseline?.id && baseline.race_id===race?.id && baseline.race_key===race?.race_key
    && baseline.race_date===race?.race_date && ['DAY_BEFORE','PRE'].includes(baseline.stage)
    && baseline.record_mode!=='REPLAY' && generated!==null && created!==null && deadline!==null
    && generated<=now && created<=now && generated<deadline-60000 && created<deadline-60000
    && baseline.racer_evidence?.revision===RACER_PARAMETERS_REVISION
    && Array.isArray(baseline.racer_evidence.boats);
}
function frozenFrameTendencies(value,now,replay,registrationNumber) {
  if(replay || !value || value.source!=='V8PatternEvidence' || time(value.as_of)===null || time(value.as_of)>now
    || value.registration_number!=null&&reg(value.registration_number)!==registrationNumber
    || value.latest_source_at!=null&&(time(value.latest_source_at)===null||time(value.latest_source_at)>time(value.as_of))) return null;
  return clone(value);
}

/** Build only from sources already available when this forecast is created. */
export function buildRacerParameters({race,entries=[],stage,now,baseline=null,exhibitionComplete=false,replay=false}={}) {
  const at=time(now),useObserved=stage==='FINAL'&&exhibitionComplete===true;
  const reuseAllowed=!replay&&stage==='FINAL'&&validBaseline(baseline,race,at);
  let reused=0,current=0,datasetChanged=false;
  const rows=entries.map(entry=>{
    const number=course(entry.boat_number),registrationNumber=reg(entry.registration_number??entry.register_number);
    const expected=course(entry.expected_entry_course??entry.entry_course)??number;
    const selected=useObserved?course(entry.exhibition_course):expected;
    const currentProfile=replay?null:validatedRacerProfile(entry.v8_racer_profile,{registrationNumber,raceDate:race?.race_date,asOf:now});
    const oldRows=reuseAllowed?baseline.racer_evidence.boats.filter(row=>row.boat_number===number&&row.registration_number===registrationNumber):[];
    const previous=oldRows.length===1?validatedRacerProfile(oldRows[0].profile,{registrationNumber,raceDate:race?.race_date,asOf:baseline.generated_at}):null;
    const profile=previous||currentProfile;
    const basis=previous?'BASELINE_SNAPSHOT':currentProfile?'CURRENT_SNAPSHOT':'UNAVAILABLE';
    if(previous)reused++;else if(currentProfile)current++;
    if(previous&&currentProfile&&previous.source.dataset_key!==currentProfile.source.dataset_key)datasetChanged=true;
    const raw=profile?.courses?.[String(selected)]||null,prior=profile?.course_priors?.[String(selected)]||null;
    const n=raw?.sample_size||0,reliability=n/(n+COURSE_PRIOR_STRENGTH);
    const adjusted=n?Object.fromEntries([...RATES,'avg_st','avg_st_rank'].map(key=>[key,
      finite(raw?.[key])&&finite(prior?.[key])?round(raw[key]*reliability+prior[key]*(1-reliability)):null])):null;
    const effectiveStart=finite(adjusted?.avg_st)?adjusted.avg_st:null;
    const startScore=effectiveStart===null?null:round(mean([[clamp((.3-effectiveStart)/.3*100),.8],
      [finite(adjusted?.avg_st_rank)?clamp((6-adjusted.avg_st_rank)/5*100):null,.2]]));
    const finishScore=n&&['first_rate','top2_rate','top3_rate'].every(key=>finite(adjusted?.[key]))
      ?round(adjusted.first_rate*.5+adjusted.top2_rate*.3+adjusted.top3_rate*.2):null;
    // Role-specific scores replace a small share of the ordinary follower score.
    // They are not added again as independent first/top2/top3 features.
    const secondScore=finite(adjusted?.second_rate)?round(adjusted.second_rate):null;
    const thirdScore=finite(adjusted?.third_rate)?round(adjusted.third_rate):null;
    return {boat_number:number,registration_number:registrationNumber,status:!profile?'MISSING':n?'READY':'MISSING',
      profile_valid:!!profile,profile_basis:basis,selected_course:selected,
      selected_course_basis:useObserved?'EXHIBITION_CONFIRMED':'EXPECTED',sample_size:n,reliability:round(reliability),
      prior_strength:COURSE_PRIOR_STRENGTH,raw,adjusted,prior,profile,
      frame_tendencies:frozenFrameTendencies(entry.v8_frame_tendencies,at,replay,registrationNumber),
      scoring:{course_finish_score:finishScore,start_score:startScore,start_basis:startScore===null?'OVERALL_AVG_ST':'COURSE_AVG_ST_AND_RANK',
        effective_avg_st:effectiveStart,second_finish_score:secondScore,third_finish_score:thirdScore,used_for_scoring:false}};
  });
  const ready=rows.filter(row=>row.status==='READY').length;
  const basis=reused&&current?'MIXED':reused?'BASELINE_SNAPSHOT':current?'CURRENT_SNAPSHOT':'UNAVAILABLE';
  const changeNote=stage!=='FINAL'?null:reused===rows.length&&rows.length
    ? datasetChanged?'コース資料が更新されていますが、展示前後の比較には事前保存と同じコース資料を使用しています。':'選手のコース資料は事前保存と同じです。'
    : reused?'一部の選手は事前保存のコース資料を使用しています。その他は今回取得済みの資料で評価しています。'
      : current?'事前保存に同じ選手資料がないため、今回取得済みの資料を使用しています。資料の追加と展示の変化を区別してください。':null;
  return {revision:RACER_PARAMETERS_REVISION,as_of:now,status:ready===rows.length&&rows.length?'READY':ready?'PARTIAL':'UNAVAILABLE',
    baseline_id:reuseAllowed?baseline.id:null,profile_basis:basis,baseline_profile_reused:reused===rows.length&&rows.length>0,
    dataset_changed:datasetChanged,change_note:changeNote,course_basis:useObserved?'EXHIBITION_CONFIRMED':'EXPECTED',
    prior_strength:COURSE_PRIOR_STRENGTH,method_rates_available:false,score_type:'UNCALIBRATED_COMPARISON_RULE',boats:rows};
}

export function parameterBoatFields(row) {
  return {racer_parameters:{profile_valid:row?.profile_valid===true,selected_course:row?.selected_course??null,
    selected_course_basis:row?.selected_course_basis||'EXPECTED',sample_size:row?.sample_size||0,
    reliability:row?.reliability||0,raw:clone(row?.raw),adjusted:clone(row?.adjusted),
    ...clone(row?.scoring)},
    course_first_percent:row?.raw?.first_rate??null,course_second_percent:row?.raw?.second_rate??null,
    course_third_percent:row?.raw?.third_rate??null,course_top2_percent:row?.raw?.top2_rate??null,
    course_top3_percent:row?.raw?.top3_rate??null,course_avg_st:row?.raw?.avg_st??null,
    course_avg_st_rank:row?.raw?.avg_st_rank??null};
}

export function racerScenarioEvidence(boat) {
  const p=boat?.racer_parameters;
  if(!p?.profile_valid||!p.sample_size)return null;
  return {boat_number:boat.boat_number,registration_number:boat.registration_number,
    selected_course:p.selected_course,sample_size:p.sample_size,raw:clone(p.raw),adjusted:clone(p.adjusted),
    reliability:p.reliability,used_for_scoring:p.used_for_scoring===true,
    note:'コース実績は選手評価の根拠です。決まり手別の発生率ではありません。'};
}

export function roleAdjustedBoatScore(boat,position) {
  const base=boat?.score,value=position===2?boat?.racer_parameters?.second_finish_score:boat?.racer_parameters?.third_finish_score;
  return finite(base)&&finite(value)&&boat?.racer_parameters?.role_finish_used===true ? base*.85+value*.15 : base;
}
