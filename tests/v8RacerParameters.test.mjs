import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';
import {buildRacerParameters,validatedRacerProfile} from '../base44/shared/v8RacerParameters.js';
import {buildScenarioTickets,scenarioTicketView,SCENARIO_TICKET_REVISION} from '../base44/shared/v8ScenarioTickets.js';

const race={id:'r',race_key:'2026-11-26_24_05',race_date:'2026-11-26',venue_code:'24',race_number:5,
  deadline:'2026-11-26T05:00:00Z',status:'scheduled',updated_date:'2026-11-25T12:00:00Z'};
const preNow='2026-11-26T01:00:00Z',finalNow='2026-11-26T04:40:00Z';
function profile(number=1){
  return {revision:'V8_RACER_PROFILE_1',registration_number:String(4500+number),player_name:'選手'+number,
    source:{dataset_key:'period-a',term_key:'2027_FIRST',term_start_date:'2026-05-01',term_end_date:'2026-10-31',
      available_at:'2026-11-22T00:00:00Z',source_url:'https://www.boatrace.jp/official-file',source_file:'fan2610.txt',checksum:'abc'},
    courses:Object.fromEntries(Array.from({length:6},(_,index)=>[String(index+1),{course:index+1,sample_size:40,
      first_count:8,second_count:10,third_count:10,fourth_count:4,fifth_count:4,sixth_count:4,
      first_rate:20,second_rate:25,third_rate:25,top2_rate:45,top3_rate:70,avg_st:.16,avg_st_rank:3,f_count:0,l_count:0}])),
    course_priors:Object.fromEntries(Array.from({length:6},(_,index)=>[String(index+1),{sample_size:1000,
      first_rate:10,second_rate:20,third_rate:20,top2_rate:30,top3_rate:50,avg_st:.19,avg_st_rank:3.5}]))};
}
function entries(){return Array.from({length:6},(_,index)=>({id:'e'+index,race_id:'r',race_key:race.race_key,race_date:race.race_date,
  boat_number:index+1,registration_number:String(4501+index),player_name:'選手'+(index+1),
  national_win_rate:6,local_win_rate:6,national_2rate:40,motor_2rate:40,avg_st:.18,section_points:6,
  updated_date:'2026-11-25T12:00:00Z',v8_racer_profile:profile(index+1)}));}
const finalEntries=()=>entries().map((row,index)=>({...row,exhibition_course:index+1,exhibition_time:6.8,
  exhibition_st:.15,updated_date:'2026-11-26T04:35:00Z'}));
const baseline=()=>({...buildRaceForecast({race,entries:entries(),stage:'PRE',now:preNow}).record,
  id:'pre',created_date:'2026-11-26T01:00:00.100Z'});

test('course evidence retains observed rates, shrinks small samples and exposes a single finish group',()=>{
  const input=entries();
  const record=buildRaceForecast({race,entries:input,stage:'PRE',now:preNow}).record;
  const row=record.racer_evidence.boats[0];
  assert.equal(row.raw.first_rate,20);assert.equal(row.sample_size,40);
  assert.equal(row.adjusted.first_rate,16.667);assert.equal(row.adjusted.avg_st,.17);
  assert.deepEqual(record.racer_evidence.scoring.feature_keys,
    ['national_win_rate','local_win_rate','national_2rate','motor_2rate','start_parameter_score','section_points','course_finish_score']);
  assert.equal(record.racer_evidence.scoring.feature_weights.course_finish_score,.16);
  assert.equal(record.racer_evidence.scoring.feature_weights.start_parameter_score,.15);
  assert.equal(record.racer_evidence.boats[0].scoring.used_for_scoring,true);
  assert.equal(record.scenarios[0].racer_evidence.sample_size,40);
  assert.deepEqual(input,entries());
});

test('future, mismatched and unfinished official profiles are rejected at the engine boundary',()=>{
  for(const mutate of [p=>p.registration_number='9999',p=>p.source.available_at='2026-11-27T00:00:00Z',
    p=>p.source.term_end_date='2026-11-26',p=>p.source.available_at='2026-10-15T00:00:00Z',
    p=>p.revision='UNKNOWN']){
    const p=profile();mutate(p);
    assert.equal(validatedRacerProfile(p,{registrationNumber:'4501',raceDate:race.race_date,asOf:preNow}),null);
  }
  const p=profile();p.courses['1'].first_count=100;
  const out=validatedRacerProfile(p,{registrationNumber:'4501',raceDate:race.race_date,asOf:preNow});
  assert.equal(out.courses['1'],null);
});

test('a true zero sample remains distinguishable from missing evidence and is not scored as a zero rate',()=>{
  const input=entries(),c=input[0].v8_racer_profile.courses['1'];
  for(const key of ['first_count','second_count','third_count','fourth_count','fifth_count','sixth_count'])c[key]=0;
  c.sample_size=0;
  const out=buildRaceForecast({race,entries:input,stage:'PRE',now:preNow}).record;
  const row=out.racer_evidence.boats[0];
  assert.equal(row.profile_valid,true);assert.equal(row.status,'MISSING');assert.equal(row.raw.sample_size,0);
  assert.equal(row.raw.first_rate,null);assert.equal(row.adjusted,null);
  assert.equal(out.boats[0].course_win_percent,null);
  assert.ok(!out.racer_evidence.scoring.feature_keys.includes('course_finish_score'));
  assert.equal(out.boats[0].racer_parameters.role_finish_used,false);
  const other=out.racer_evidence.boats[1];
  assert.equal(other.adjusted.avg_st,.17);
  assert.equal(other.scoring.start_basis,'OVERALL_AVG_ST');
  assert.equal(other.scoring.effective_avg_st,null);
  assert.equal(other.scoring.start_score,null);
  assert.equal(other.scoring.used_for_scoring,false);
});

test('partial or conflicting exhibition uses the same expected course in diagram and racer evidence',()=>{
  const input=finalEntries();input[0].exhibition_course=6;
  const out=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow}).record;
  assert.equal(out.exhibition_complete,false);
  assert.equal(out.racer_evidence.boats[0].selected_course,1);
  assert.equal(out.racer_evidence.boats[0].selected_course_basis,'EXPECTED');
  assert.equal(out.boats[0].racer_parameters.selected_course,1);
});

test('FINAL entry changes select another course from the same frozen pre-race profile',()=>{
  const saved=baseline();saved.racer_evidence.boats[0].profile.courses['2'].avg_st=.11;
  const input=finalEntries();input[0].exhibition_course=2;input[1].exhibition_course=1;
  for(const row of input){row.v8_racer_profile.source.dataset_key='period-b';row.v8_racer_profile.courses['2'].avg_st=.28;}
  const before=structuredClone(saved);
  const out=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow,baseline:saved}).record;
  assert.equal(out.racer_evidence.baseline_profile_reused,true);assert.equal(out.racer_evidence.dataset_changed,true);
  assert.equal(out.racer_evidence.boats[0].selected_course,2);
  assert.equal(out.racer_evidence.boats[0].selected_course_basis,'EXHIBITION_CONFIRMED');
  assert.equal(out.racer_evidence.boats[0].raw.avg_st,.11);
  assert.equal(out.racer_evidence.boats[0].profile.source.dataset_key,'period-a');
  assert.equal(out.comparison.entry_changed,true);assert.deepEqual(saved,before);
});

test('legacy baselines or another racer cannot silently supply a frozen profile',()=>{
  const old=baseline();delete old.racer_evidence;
  const out=buildRaceForecast({race,entries:finalEntries(),stage:'FINAL',now:finalNow,baseline:old}).record;
  assert.equal(out.racer_evidence.baseline_profile_reused,false);assert.equal(out.racer_evidence.profile_basis,'CURRENT_SNAPSHOT');
  assert.match(out.racer_evidence.change_note,/事前保存に同じ選手資料がない/);
  const saved=baseline();saved.racer_evidence.boats[0].registration_number='9999';
  const mixed=buildRaceForecast({race,entries:finalEntries(),stage:'FINAL',now:finalNow,baseline:saved}).record;
  assert.equal(mixed.racer_evidence.boats[0].profile_basis,'CURRENT_SNAPSHOT');
  assert.equal(mixed.racer_evidence.boats[1].profile_basis,'BASELINE_SNAPSHOT');
  assert.equal(mixed.racer_evidence.profile_basis,'MIXED');
});

test('a profile acquired after the baseline was saved cannot be relabelled as frozen baseline evidence',()=>{
  const saved=baseline();saved.racer_evidence.boats[0].profile.source.available_at='2026-11-26T02:00:00Z';
  const out=buildRaceForecast({race,entries:finalEntries(),stage:'FINAL',now:finalNow,baseline:saved}).record;
  assert.equal(out.racer_evidence.boats[0].profile_basis,'CURRENT_SNAPSHOT');
});

test('current official profiles and frame aggregates are not injected into REPLAY',()=>{
  const input=entries();input[0].v8_frame_tendencies={source:'V8PatternEvidence',as_of:preNow,frames:{'1':{sample_size:10}}};
  const out=buildRacerParameters({race,entries:input,stage:'FINAL',now:finalNow,baseline:baseline(),replay:true});
  assert.equal(out.status,'UNAVAILABLE');assert.ok(out.boats.every(row=>row.profile===null&&row.frame_tendencies===null));
});

test('course starts and ranks change evidence-based scoring without adding the overall-ST feature twice',()=>{
  const input=entries();input[0].v8_racer_profile.courses['1'].avg_st=.1;input[0].v8_racer_profile.courses['1'].avg_st_rank=1;
  const out=buildRaceForecast({race,entries:input,stage:'PRE',now:preNow}).record;
  assert.ok(out.boats[0].base_score>out.boats[1].base_score);
  assert.ok(!out.racer_evidence.scoring.feature_keys.includes('avg_st'));
  assert.equal(out.boats[0].racer_parameters.start_basis,'COURSE_AVG_ST_AND_RANK');
  input[5].v8_racer_profile.courses['6'].avg_st_rank=null;
  const partial=buildRaceForecast({race,entries:input,stage:'PRE',now:preNow}).record;
  assert.ok(partial.boats.every(row=>row.racer_parameters.start_basis==='COURSE_AVG_ST'));
});

test('non-exhibition card changes are recorded separately even when course profiles stay frozen',()=>{
  const input=finalEntries();input[2].motor_2rate=55;
  input[2].exhibition_course=4;input[3].exhibition_course=3;
  const out=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow,baseline:baseline()}).record;
  assert.equal(out.racer_evidence.baseline_profile_reused,true);
  assert.equal(out.comparison.non_exhibition_inputs_changed,true);
  assert.deepEqual(out.comparison.non_exhibition_changes,[{boat_number:3,fields:['motor_2rate']}]);
  assert.ok(out.comparison.changes.includes('進入変更：3号艇→4コース / 4号艇→3コース'));
  assert.match(out.comparison.checkpoint_results.find(row=>row.label==='展示以外の基礎情報').detail,/選手・モーター・節間/);
  assert.match(out.racer_evidence.change_note,/コース資料/);
});

test('saved evidence affects the forecast identity and input timestamp, but calculation time alone does not',()=>{
  const input=finalEntries();input[0].v8_racer_profile.source.available_at='2026-11-26T04:38:00Z';
  const frame={source:'V8PatternEvidence',status:'READY',as_of:'2026-11-26T04:39:00Z',source_ids:['p1'],frames:{'1':{sample_size:5}}};
  input[0].v8_frame_tendencies=frame;
  const a=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow}).record;
  assert.equal(a.input_as_of,new Date(frame.as_of).toISOString());
  input[0].v8_frame_tendencies={...frame,as_of:'2026-11-26T04:39:30Z'};
  const b=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow}).record;
  assert.equal(a.forecast_key,b.forecast_key);
  input[0].v8_racer_profile.courses['1'].f_count=1;
  const c=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow}).record;
  assert.notEqual(a.forecast_key,c.forecast_key);
  input[0].v8_frame_tendencies={...frame,as_of:'2026-11-26T05:00:00Z'};
  const d=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow}).record;
  assert.equal(d.racer_evidence.boats[0].frame_tendencies,null);
  input[0].v8_frame_tendencies={...frame,latest_source_at:'2026-11-27T00:00:00Z'};
  const future=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow}).record;
  assert.equal(future.racer_evidence.boats[0].frame_tendencies,null);
});

test('conditional tickets use second and third place evidence, with legacy saved sets still readable',()=>{
  const scenario={key:'1_ESCAPE',leader:1,method:'ESCAPE',beneficiaries:[]};
  const boats=Array.from({length:6},(_,index)=>({boat_number:index+1,score:50,active:true,expected_course:index+1,
    racer_parameters:{role_finish_used:true,second_finish_score:index===5?100:0,third_finish_score:index===4?100:0}}));
  const tickets=buildScenarioTickets({scenario,boats,stage:'PRE'});
  assert.equal(tickets[0],'1-6-5');
  const old={revision:'V8_FORECAST_3_SCENARIOS',stage:'PRE',boats,
    scenarios:[{...scenario,tickets,ticket_revision:'V8_SCENARIO_TICKETS_1',ticket_basis:'FORECAST_SNAPSHOT'}]};
  assert.equal(scenarioTicketView(old,scenario.key).status,'SAVED');
  assert.equal(scenarioTicketView(old,scenario.key).revision,'V8_SCENARIO_TICKETS_1');
  assert.equal(SCENARIO_TICKET_REVISION,'V8_SCENARIO_TICKETS_2_RACER_PARAMETERS');
  assert.equal(scenarioTicketView({...old,revision:'V8_FORECAST_4_RACER_PARAMETERS',scenarios:[scenario]},scenario.key).status,'UNAVAILABLE');
});
