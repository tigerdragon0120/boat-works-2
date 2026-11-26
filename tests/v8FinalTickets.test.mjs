import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildVenueEvidence,applyVenueToScenarios,buildFinalTicketSelection,decideFinalSelection,validFinalTickets} from '../base44/shared/v8FinalTickets.js';
import {buildRaceForecast,forecastVenueKey,FORECAST_REVISION} from '../base44/shared/v8ForecastEngine.js';
import {parseOfficialVenueProfile,venueProfileSnapshotKey} from '../base44/shared/v8VenueProfileSource.js';

const race={id:'race-final',race_key:'2026-11-26_23_05',race_date:'2026-11-26',venue_code:'23',venue_name:'唐津',race_number:5,
  deadline:'2026-11-26T05:00:00Z',status:'scheduled',updated_date:'2026-11-25T12:00:00Z'};
const preNow='2026-11-26T01:00:00Z',finalNow='2026-11-26T04:40:00Z';
const html=await readFile(new URL('./fixtures/official_venue_20261126_23.html',import.meta.url),'utf8');
const parsed=await parseOfficialVenueProfile(html,{venueCode:'23',fetchedAt:'2026-11-26T00:20:00Z'});
assert.equal(parsed.ok,true);
const profile=()=>({...structuredClone(parsed.profile),snapshot_id:'venue-saved',snapshot_key:venueProfileSnapshotKey('23','2026-10-31'),available_at:'2026-11-26T00:21:00Z'});
const entries=()=>[8.8,5,8.5,4,3,2].map((value,index)=>({id:'e'+(index+1),race_id:race.id,race_key:race.race_key,race_date:race.race_date,
  boat_number:index+1,registration_number:String(4501+index),player_name:'選手'+(index+1),
  national_win_rate:value,local_win_rate:value,national_2rate:[65,25,60,15,10,5][index],
  motor_2rate:[70,25,65,20,15,10][index],avg_st:[.14,.18,.15,.20,.22,.24][index],section_points:[8,4,8,3,2,1][index],
  updated_date:'2026-11-25T12:00:00Z'}));
const finalEntries=()=>entries().map((row,index)=>({...row,updated_date:'2026-11-26T04:35:00Z',
  exhibition_course:index+1,exhibition_st:[.13,.19,.15,.21,.23,.25][index],exhibition_time:[6.7,6.81,6.72,6.84,6.86,6.9][index]}));
const pre=(overrides={})=>buildRaceForecast({race,entries:entries(),stage:'PRE',now:preNow,venueProfile:profile(),...overrides}).record;
const baseline=()=>({...pre(),id:'pre-saved',created_date:'2026-11-26T01:00:00.100Z'});
const quotes=(value=30)=>({id:'odds',race_id:race.id,captured_at:'2026-11-26T04:39:00Z',created_date:'2026-11-26T04:39:00.100Z',
  odds_map:Object.fromEntries([1,2,3,4,5,6].flatMap(a=>[1,2,3,4,5,6].flatMap(b=>[1,2,3,4,5,6]
    .filter(c=>new Set([a,b,c]).size===3).map(c=>[[a,b,c].join('-'),value]))))});
const final=(overrides={})=>buildRaceForecast({race,entries:finalEntries(),stage:'FINAL',now:finalNow,
  venueProfile:profile(),baseline:baseline(),odds:quotes(),...overrides}).record;
function modelFixture(scores=[70,40,80,30,20,10]){
  const boats=scores.map((score,index)=>({boat_number:index+1,registration_number:String(4501+index),score,base_score:score,
    active:true,expected_course:index+1,observed_course:index+1,exhibition_st:index===0?.12:.18,exhibition_time:index===0?6.7:6.8}));
  const scenarios=boats.map(boat=>({key:boat.boat_number+'_'+(boat.boat_number===1?'ESCAPE':'MAKURI'),leader:boat.boat_number,
    method:boat.boat_number===1?'ESCAPE':'MAKURI',score:boat.boat_number===1?80:boat.boat_number===3?78:55,
    beneficiaries:[3,2,4].filter(number=>number!==boat.boat_number)}));
  return {boats,scenarios};
}
function ranked(input=modelFixture(),stage='FINAL'){
  const venueEvidence=buildVenueEvidence({race,venueProfile:profile(),stage,now:stage==='FINAL'?finalNow:preNow,exhibitionComplete:stage==='FINAL'});
  const scenarios=applyVenueToScenarios({...input,venueEvidence,stage,exhibitionComplete:stage==='FINAL'});
  return {boats:input.boats,scenarios,venueEvidence,
    selection:buildFinalTicketSelection({boats:input.boats,scenarios,venueEvidence,stage,exhibitionComplete:stage==='FINAL'})};
}
function modelBaseline(input,legacy=false){
  const prior=ranked(input,'PRE');
  const saved={...baseline(),boats:structuredClone(input.boats),scenarios:structuredClone(prior.scenarios),
    venue_evidence:structuredClone(prior.venueEvidence),final_selection:structuredClone(prior.selection),top_scenario_key:prior.scenarios[0].key};
  if(legacy){
    const tickets=['1-3-2','1-3-4','1-3-5','1-3-6','1-2-3','1-4-3'];
    saved.revision='V8_FORECAST_6_FINAL_SELECTION';
    saved.final_selection={revision:'V8_FINAL_SELECTION_1',policy_revision:'V8_RULE_BUY_1',stage:'PRE',status:'WATCH',
      tickets,ticket_count:tickets.length,head_boats:[1],ranked_tickets:tickets.map((ticket,index)=>({ticket,rank:index+1,score:70-index}))};
  }
  return saved;
}
function judged(input,saved=modelBaseline(input)){
  const result=ranked(input);
  const decision=decideFinalSelection({race,stage:'FINAL',now:finalNow,baseline:saved,comparison:{entrant_changed:false},
    complete:true,odds:quotes(),meaningful:true,...result});
  return {...result,decision};
}
const preCheck=result=>result.selection.gate_checks.find(row=>row.key==='PRE_COMPARISON');
function threeHeadFixture(){
  const input=modelFixture([70,65,80,78,60,55]);input.scenarios[3].score=77;return input;
}

test('official venue evidence is saved in PRE with role comparisons and provisional 6-12 point selection',()=>{
  const source=profile(),before=structuredClone(source),record=pre({venueProfile:source});
  assert.equal(FORECAST_REVISION,'V8_FORECAST_7_HEAD_COVERAGE');assert.deepEqual(source,before);
  assert.equal(record.venue_evidence.status,'READY');assert.equal(record.venue_evidence.source_basis,'CURRENT_SNAPSHOT');
  assert.equal(record.venue_evidence.profile.sample_size,null);assert.equal(record.venue_evidence.profile.published_at,null);
  assert.equal(record.venue_evidence.inside_favored,true);assert.equal(record.venue_evidence.inside_first_rate,59.2);
  assert.equal(record.decision.status,'WATCH');assert.equal(record.final_selection.status,'WATCH');
  assert.ok(validFinalTickets(record.final_selection.tickets));assert.equal(record.final_selection.candidate_count,120);
  assert.equal(record.final_selection.role_evidence.length,6);
  assert.equal(record.research_tickets.length,8);assert.ok(record.scenarios.every(row=>row.tickets.length===8));
  assert.ok(record.final_selection.ranked_tickets.every((row,index)=>row.rank===index+1&&row.ticket===record.final_selection.tickets[index]));
  assert.equal(record.final_selection.probability_calibrated,false);
  assert.equal(record.final_selection.policy_revision,'V8_RULE_BUY_2');assert.equal(record.final_selection.rank_label,'選抜内の評価順');
  assert.ok(record.final_selection.ranked_tickets.every(row=>row.probability===undefined&&row.expected_value===undefined));
});

test('scenario venue prior combines first-place frequency and method composition once, preserving the original score',()=>{
  const record=pre(),escape=record.scenarios.find(row=>row.key==='1_ESCAPE'),makuri=record.scenarios.find(row=>row.key==='3_MAKURI');
  assert.equal(escape.venue_evidence.first_rate,59.2);assert.equal(escape.venue_evidence.method_rate,95.4);
  assert.ok(Math.abs(escape.venue_prior_score-59.2*.954)<.001);
  assert.ok(Math.abs(escape.score-(escape.score_without_venue*.85+escape.venue_prior_score*.15))<.001);
  assert.equal(makuri.venue_evidence.first_rate,12.7);assert.equal(makuri.venue_evidence.method_rate,40.2);
  assert.equal(makuri.venue_evidence.method_basis,'AMONG_COURSE_WINNERS');
  assert.ok(Math.abs(makuri.venue_prior_score-12.7*.402)<.001);
  assert.ok(Math.abs(escape.venue_adjustment-(escape.score-escape.score_without_venue))<.001);
  const firstRole=record.final_selection.role_evidence.find(row=>row.boat_number===1);
  assert.ok(Math.abs(firstRole.first_score-(escape.score_without_venue*.85+59.2*.15))<.001);
  assert.equal(firstRole.scenario_score,escape.score);assert.equal(firstRole.head_prior_basis,'COURSE_FIRST_RATE');
});

test('a clearly stronger inside head remains alone and a distant outside head still contributes as a follower',()=>{
  const selection=pre().final_selection,outside=selection.role_evidence.find(row=>row.boat_number===3);
  assert.equal(outside.role,'FOLLOWER_FOCUS');assert.equal(outside.win_eligible,false);assert.equal(outside.reverse_support.length,0);
  assert.ok(outside.head_score_gap>12);assert.equal(outside.head_selected,false);
  assert.equal(selection.candidate_count,120);assert.equal(selection.eligible_candidate_count,20);
  assert.equal(selection.ticket_count,6);assert.deepEqual(selection.head_boats,[1]);
  assert.ok(selection.tickets.every(ticket=>ticket.startsWith('1-')));
  assert.ok(selection.tickets.some(ticket=>ticket.startsWith('1-3-')));
  assert.ok(selection.tickets.some(ticket=>ticket.endsWith('-3')));
  assert.ok(!selection.tickets.some(ticket=>ticket.startsWith('3-1-')));
});

test('exhibition support explains outside heads without deleting candidates, and exhibition F never counts as a fast start',()=>{
  const fixture=modelFixture();fixture.boats[2].exhibition_st=.06;fixture.boats[2].exhibition_time=6.6;
  fixture.scenarios[2].score=99;fixture.scenarios[0].score=55;
  const supported=ranked(fixture),outside=supported.selection.role_evidence.find(row=>row.boat_number===3);
  assert.equal(outside.win_eligible,true);
  assert.deepEqual(outside.reverse_support.map(row=>row.key),['EXHIBITION_START_EDGE','EXHIBITION_SPEED_EDGE']);
  assert.equal(supported.selection.eligible_candidate_count,20);assert.equal(supported.selection.head_allocations[0].boat_number,3);
  assert.ok(supported.selection.tickets.some(ticket=>ticket.startsWith('3-')));
  fixture.boats[2].exhibition_st=-.06;fixture.boats[2].exhibition_flying=true;
  const result=judged(fixture),flying=result.selection.role_evidence.find(row=>row.boat_number===3);
  assert.equal(flying.win_eligible,true);assert.ok(!flying.reverse_support.some(row=>row.key==='EXHIBITION_START_EDGE'));
  assert.notEqual(result.decision.status,'BUY');
  assert.equal(result.selection.gate_checks.find(row=>row.key==='EXHIBITION_CAUTION').passed,false);
});

test('venue role selection follows the observed entry course rather than the boat number',()=>{
  const fixture=modelFixture();fixture.boats[0].observed_course=3;fixture.boats[2].observed_course=1;
  fixture.scenarios[0]={...fixture.scenarios[0],key:'1_MAKURI',method:'MAKURI'};
  fixture.scenarios[2]={...fixture.scenarios[2],key:'3_ESCAPE',method:'ESCAPE'};
  const {selection,scenarios}=ranked(fixture);
  assert.equal(selection.role_evidence.find(row=>row.boat_number===3).role,'INSIDE_AXIS');
  assert.equal(selection.role_evidence.find(row=>row.boat_number===3).venue_first_rate,59.2);
  assert.equal(selection.role_evidence.find(row=>row.boat_number===1).venue_first_rate,12.7);
  assert.equal(scenarios.find(row=>row.key==='3_ESCAPE').venue_evidence.course,1);
});

test('final point counts expand only within 6-12 and a broad tied pool remains on hold',()=>{
  const tight=pre().final_selection,broad=ranked(modelFixture([70,70,70,70,70,70]));
  assert.equal(tight.ticket_count,6);assert.equal(broad.selection.ticket_count,12);
  assert.ok(broad.selection.nearby_candidate_count>12);
  const decision=decideFinalSelection({race,stage:'FINAL',now:finalNow,baseline:baseline(),comparison:{entrant_changed:false},
    complete:true,odds:quotes(),meaningful:true,...broad});
  assert.equal(decision.status,'WATCH');assert.equal(broad.selection.gate_checks.find(row=>row.key==='CONCENTRATION').passed,false);
  assert.equal(broad.selection.policy.max_tickets,12);assert.equal(broad.selection.policy.score_window,4);
});

test('BUY is generated only after PRE, exhibition, venue, concentration and valid whole-set prices all pass',()=>{
  const record=final();
  assert.equal(record.decision.status,'BUY',JSON.stringify(record.final_selection.gate_checks.filter(row=>!row.passed)));
  assert.equal(record.final_selection.status,'BUY');assert.ok(record.final_selection.gate_checks.every(row=>row.passed));
  assert.ok(record.decision.tickets.length>=6&&record.decision.tickets.length<=12);
  assert.deepEqual(record.decision.tickets,record.final_selection.tickets);assert.equal(record.research_tickets.length,8);
  assert.ok(record.decision.composite_odds>1);assert.equal(record.decision.price_checked,true);
  assert.equal(record.decision.valid_until,'2026-11-26T04:44:00.000Z');
  assert.equal(record.decision.expected_value_used,false);assert.equal(record.decision.probability_calibrated,false);
  assert.equal(record.final_selection.policy.max_head_boats,3);assert.equal(record.final_selection.policy.min_tickets_per_head,2);
  assert.equal(record.final_selection.policy.head_score_window,12);assert.equal(record.final_selection.policy.head_prior_basis,'COURSE_FIRST_RATE');
});

test('a strong outside PRE head can be selected without impossible exhibition-support requirements',()=>{
  const values=[4,2,9.5,1.5,1,.5];
  const priorEntries=entries().map((row,index)=>({...row,national_win_rate:values[index],local_win_rate:values[index],
    national_2rate:values[index]*8,motor_2rate:values[index]*8,avg_st:.16,section_points:values[index]}));
  const saved={...pre({entries:priorEntries}),id:'outside-top-pre',created_date:'2026-11-26T01:00:00.100Z'};
  assert.equal(saved.top_scenario_key,'3_MAKURISASHI');assert.deepEqual(saved.final_selection.head_boats,[3]);
  assert.equal(saved.final_selection.head_allocations[0].kind,'MAIN');
  assert.equal(saved.final_selection.head_allocations[0].boat_number,3);
  assert.equal(saved.final_selection.role_evidence.find(row=>row.boat_number===3).reverse_support.length,0);
  assert.ok(saved.final_selection.tickets.every(ticket=>ticket.startsWith('3-')));
  assert.equal(saved.decision.status,'WATCH');
});

test('PRE candidate head metadata must match saved tickets, while legacy PRE may use its top scenario',()=>{
  for(const change of [row=>row.final_selection.head_boats=[3],row=>row.final_selection.head_boats=[1,1],
    row=>row.final_selection.tickets=Array(6).fill('1-2-3'),row=>delete row.final_selection]){
    const saved=baseline();change(saved);
    const record=final({baseline:saved}),check=record.final_selection.gate_checks.find(row=>row.key==='PRE_COMPARISON');
    assert.equal(check.passed,false);assert.equal(check.baseline_basis,'INVALID_FINAL_SELECTION');
    assert.notEqual(record.decision.status,'BUY');
  }
  const legacy=baseline();legacy.revision='V8_FORECAST_5_RECENT_LANE';delete legacy.final_selection;
  const record=final({baseline:legacy}),check=record.final_selection.gate_checks.find(row=>row.key==='PRE_COMPARISON');
  assert.equal(check.passed,true);assert.equal(check.baseline_basis,'LEGACY_TOP_SCENARIO');
  assert.equal(record.decision.status,'BUY');
});

test('close 3 and 4 heads retain two tickets each, ranked on all 120 original scores, and three heads can pass BUY',()=>{
  const input=threeHeadFixture(),before=structuredClone(input),result=judged(input),plan=result.selection;
  assert.deepEqual(input,before);assert.equal(plan.candidate_count,120);assert.equal(plan.ticket_count,12);
  assert.equal(plan.qualified_head_count,3);assert.equal(plan.covered_head_count,3);assert.equal(plan.coverage_complete,true);
  assert.deepEqual(plan.head_allocations.map(row=>[row.boat_number,row.kind,row.ticket_count]),[[1,'MAIN',8],[3,'COUNTER',2],[4,'COUNTER',2]]);
  assert.ok(plan.ranked_tickets.filter(row=>row.selection_basis==='HEAD_COVERAGE').every(row=>[3,4].includes(row.covered_head)));
  assert.equal(plan.ranked_tickets.filter(row=>row.selection_basis==='HEAD_COVERAGE').length,4);
  const roles=new Map(plan.role_evidence.map(row=>[row.boat_number,row])),all=[];
  for(const a of [1,2,3,4,5,6])for(const b of [1,2,3,4,5,6])for(const c of [1,2,3,4,5,6]){
    if(new Set([a,b,c]).size!==3)continue;
    const scenario=result.scenarios.find(row=>row.key===roles.get(a).scenario_key);
    const score=roles.get(a).first_score*.58+roles.get(b).second_score*.27+roles.get(c).third_score*.15
      +(scenario.beneficiaries.includes(b)?2:0);
    all.push({ticket:[a,b,c].join('-'),score:Math.round(score*1000)/1000});
  }
  all.sort((a,b)=>b.score-a.score||a.ticket.localeCompare(b.ticket));
  assert.equal(new Set(all.map(row=>row.ticket)).size,120);
  plan.ranked_tickets.forEach((row,index)=>{
    const expectedIndex=all.findIndex(value=>value.ticket===row.ticket);
    assert.equal(row.global_rank,expectedIndex+1);assert.equal(row.score,all[expectedIndex].score);
    assert.equal(row.rank,index+1);assert.equal(row.covered_head,Number(row.ticket[0]));
    if(index)assert.ok(plan.ranked_tickets[index-1].global_rank<row.global_rank);
    assert.equal(row.probability,undefined);assert.equal(row.expected_value,undefined);
  });
  assert.equal(plan.gate_checks.find(row=>row.key==='AXIS').passed,true);
  assert.equal(result.decision.status,'BUY',JSON.stringify(plan.gate_checks.filter(row=>!row.passed)));
});

test('new head scores choose the best raw scenario even when the diagram method prior ranks another method first',()=>{
  const input=modelFixture();input.scenarios.push({key:'3_SASHI',leader:3,method:'SASHI',score:78.3,beneficiaries:[1,2]});
  const result=ranked(input),row=result.selection.role_evidence.find(value=>value.boat_number===3);
  assert.equal(result.scenarios.filter(value=>value.leader===3)[0].key,'3_MAKURI');
  assert.equal(row.scenario_key,'3_SASHI');assert.equal(row.head_base_score,78.3);
  assert.ok(Math.abs(row.first_score-(78.3*.85+12.7*.15))<.001);
  assert.equal(row.scenario_score,result.scenarios.find(value=>value.key==='3_SASHI').score);
  const reordered=ranked({boats:[...input.boats].reverse(),scenarios:[...input.scenarios].reverse()});
  assert.deepEqual(reordered.selection,result.selection);
  const tied=modelFixture([50,50,50,50,50,50]);tied.scenarios.forEach(value=>{value.score=60;});
  const options={venueEvidence:{status:'UNAVAILABLE',profile:null,inside_favored:false},stage:'PRE'};
  const first=buildFinalTicketSelection({...tied,...options});
  const reversed=buildFinalTicketSelection({boats:[...tied.boats].reverse(),scenarios:[...tied.scenarios].reverse(),...options});
  assert.deepEqual(reversed,first);assert.equal(first.qualified_head_count,6);
});

test('more than three close heads remain on hold even when the displayed maximum of three are covered',()=>{
  const input=modelFixture([70,70,70,70,70,70]);input.scenarios.forEach(row=>{row.score=80;});
  const result=judged(input),plan=result.selection;
  assert.equal(plan.qualified_head_count,6);assert.equal(plan.head_allocations.length,3);
  assert.equal(plan.covered_head_count,3);assert.equal(plan.coverage_complete,false);
  assert.ok(plan.head_allocations.every(row=>row.ticket_count>=2));
  assert.equal(plan.selection_code,'TOO_MANY_HEADS');assert.equal(plan.gate_checks.find(row=>row.key==='AXIS').passed,false);
  assert.equal(result.decision.status,'WATCH');
});

test('a valid policy-1 PRE supplements heads from its frozen scenarios without rewriting its saved inside-only plan',()=>{
  const input=modelFixture(),saved=modelBaseline(input,true),original=structuredClone(saved),result=judged(input,saved),check=preCheck(result);
  assert.deepEqual(saved,original);assert.equal(check.passed,true);
  assert.equal(check.baseline_basis,'SAVED_PRE_SCENARIOS_LEGACY_POLICY');assert.equal(check.baseline_venue_basis,'FROZEN_PRE_VENUE');
  assert.deepEqual(check.baseline_saved_head_boats,[1]);assert.deepEqual(check.baseline_comparison_head_boats,[1,3]);
  assert.equal(result.selection.role_evidence.find(row=>row.boat_number===3).reverse_support.length,0);
  assert.equal(result.decision.status,'BUY');
  for(const change of [row=>row.final_selection.head_boats=[3],row=>delete row.final_selection,
    row=>row.final_selection.ticket_count=7,row=>row.final_selection.ranked_tickets[0].ticket='3-1-2']){
    const invalid=structuredClone(saved);change(invalid);const checked=judged(input,invalid);
    assert.equal(preCheck(checked).passed,false);assert.equal(preCheck(checked).baseline_basis,'INVALID_FINAL_SELECTION');
    assert.notEqual(checked.decision.status,'BUY');
  }
});

test('legacy PRE supplementation never imports a later or cross-venue profile or current FINAL source',()=>{
  const input=modelFixture(),saved=modelBaseline(input,true);
  for(const change of [row=>delete row.venue_evidence.profile,
    row=>row.venue_evidence.profile.available_at='2026-11-26T04:00:00Z',row=>row.venue_evidence.profile.venue_code='24']){
    const value=structuredClone(saved);change(value);const before=structuredClone(value),check=preCheck(judged(input,value));
    assert.equal(check.baseline_basis,'SAVED_PRE_SCENARIOS_LEGACY_POLICY');
    assert.ok(['SAVED_PRE_SCENARIOS_ONLY','SAVED_PRE_SCENARIOS_INVALID_VENUE_EXCLUDED'].includes(check.baseline_venue_basis));
    assert.equal(check.baseline_scenario_heads.find(row=>row.boat_number===1).first_score,80);
    assert.equal(check.baseline_scenario_heads.find(row=>row.boat_number===3).first_score,78);
    assert.deepEqual(value,before);
  }
});

test('a new close head needs one actual exhibition support, and historical advantage alone cannot substitute',()=>{
  const prior=modelFixture();prior.scenarios[2].score=50;const saved=modelBaseline(prior);
  assert.deepEqual(saved.final_selection.head_boats,[1]);
  const unsupported=judged(modelFixture(),saved);assert.equal(preCheck(unsupported).passed,false);
  const observed=modelFixture();observed.boats[2].exhibition_st=.06;
  const supported=judged(observed,saved),check=preCheck(supported);
  assert.equal(check.passed,true);assert.deepEqual(check.new_head_evidence[0].support.map(row=>row.key),['EXHIBITION_START_EDGE']);
  assert.equal(supported.decision.status,'BUY');
  const history=modelFixture();history.boats[0].racer_parameters={sample_size:20,adjusted:{first_rate:20}};
  history.boats[2].racer_parameters={sample_size:20,adjusted:{first_rate:40}};
  assert.equal(preCheck(judged(history,saved)).passed,false);
});

test('a confirmed inward course change can explain a new inside head, while outward movement or identity mismatch cannot',()=>{
  const prior=modelFixture();prior.scenarios[2].score=50;const saved=modelBaseline(prior);
  const inward=modelFixture();inward.boats[0].observed_course=3;inward.boats[2].observed_course=1;
  Object.assign(inward.scenarios[0],{key:'1_MAKURI',method:'MAKURI'});Object.assign(inward.scenarios[2],{key:'3_ESCAPE',method:'ESCAPE'});
  const positive=judged(inward,saved),check=preCheck(positive),support=check.new_head_evidence.find(row=>row.boat_number===3).support;
  assert.equal(check.passed,true);assert.equal(positive.selection.role_evidence.find(row=>row.boat_number===3).reverse_support.length,0);
  assert.deepEqual(support.map(row=>[row.key,row.course_before,row.course_after]),[['EXHIBITION_COURSE_CHANGE',3,1]]);
  const outward=modelFixture();outward.boats[2].observed_course=4;outward.boats[3].observed_course=3;
  const negative=preCheck(judged(outward,saved));assert.equal(negative.passed,false);
  assert.ok(negative.new_head_evidence.every(row=>!row.support.some(item=>item.key==='EXHIBITION_COURSE_CHANGE')));
  const mismatch=structuredClone(saved);mismatch.boats[2].registration_number='9999';
  assert.equal(preCheck(judged(inward,mismatch)).passed,false);
});

test('a missing baseline, missing venue, changed entrant or exhibition F/L cannot become BUY',()=>{
  const noVenueBase=baseline();delete noVenueBase.venue_evidence;
  const changed=finalEntries();changed[1].registration_number='9999';
  const flying=finalEntries();flying[2].exhibition_st=-.03;
  const late=finalEntries();late[2].exhibition_st='L';
  for(const overrides of [{baseline:null},{baseline:noVenueBase,venueProfile:null},{entries:changed},{entries:flying},{entries:late}]){
    const record=final(overrides);assert.notEqual(record.decision.status,'BUY');
    assert.ok(record.final_selection.gate_checks.some(row=>!row.passed));
  }
});

test('prices never re-rank tickets, and stale, future, partial or unprofitable combined quotes cannot enable BUY',()=>{
  const original=final(),missing=quotes();delete missing.odds_map[original.final_selection.tickets[0]];
  const stale={...quotes(),captured_at:'2026-11-26T04:35:00Z'};
  const future={...quotes(),captured_at:'2026-11-26T04:41:00Z'};
  for(const odds of [null,missing,stale,future]){
    const record=final({odds});assert.equal(record.decision.status,'WATCH');assert.equal(record.decision.price_checked,false);
    assert.deepEqual(record.final_selection.ranked_tickets,original.final_selection.ranked_tickets);
  }
  const loss=final({odds:quotes(1.1)});assert.equal(loss.decision.status,'SKIP');
  assert.ok(loss.final_selection.composite_odds<1);assert.deepEqual(loss.final_selection.tickets,original.final_selection.tickets);
  assert.equal(loss.final_selection.gate_checks.find(row=>row.key==='COMPOSITE').status,'BLOCK');
});

test('the full venue profile is frozen from PRE while a refreshed current profile is only reported as changed',()=>{
  const saved=baseline(),before=structuredClone(saved),changed=profile();
  changed.snapshot_id='venue-new';changed.content_hash='b'.repeat(64);changed.available_at='2026-11-26T04:36:00Z';
  changed.courses['1'].first_rate-=30;changed.courses['1'].second_rate+=30;
  const record=final({baseline:saved,venueProfile:changed});
  assert.equal(record.venue_evidence.source_basis,'BASELINE_SNAPSHOT');assert.equal(record.venue_evidence.baseline_profile_reused,true);
  assert.equal(record.venue_evidence.current_profile_changed,true);assert.equal(record.venue_evidence.inside_first_rate,59.2);
  assert.equal(record.venue_evidence.profile.snapshot_id,'venue-saved');assert.equal(record.comparison.venue_inputs_changed,false);
  assert.equal(record.final_selection.venue_evidence.snapshot_id,'venue-saved');
  assert.equal(record.final_selection.venue_evidence.profile,undefined);assert.deepEqual(saved,before);
});

test('venue source chronology and identity are enforced, and old baselines clearly record a current addition',()=>{
  for(const mutate of [p=>p.venue_code='24',p=>p.available_at='2026-11-27T00:00:00Z',p=>p.period_end='2026-11-30',
    p=>p.sample_size=0,p=>p.course_basis='BOAT_NUMBER']){
    const value=profile();mutate(value);const out=pre({venueProfile:value});assert.equal(out.venue_evidence.profile,null);
  }
  const old=baseline();delete old.venue_evidence;
  const record=final({baseline:old});assert.equal(record.venue_evidence.source_basis,'CURRENT_SNAPSHOT');
  assert.equal(record.comparison.venue_inputs_changed,true);assert.equal(record.comparison.non_exhibition_inputs_changed,true);
  assert.deepEqual(record.comparison.non_exhibition_global_changes,['venue_profile']);assert.match(record.venue_evidence.change_note,/資料追加と展示/);
});

test('venue supplementation gets an immutable source key and calculations at a later time keep the same key',()=>{
  const empty=pre({venueProfile:null}),ready=pre(),later=pre({now:'2026-11-26T01:05:00Z'});
  assert.equal(empty.venue_key,'NO_VENUE');assert.match(ready.venue_key,/^VENUE_[a-f0-9]{8}$/);
  assert.notEqual(empty.forecast_key,ready.forecast_key);assert.equal(ready.forecast_key,later.forecast_key);
  assert.equal(ready.provenance.content_fingerprint,later.provenance.content_fingerprint);
  assert.equal(forecastVenueKey(ready),ready.venue_key);
  assert.equal(forecastVenueKey({race,venueProfile:profile(),stage:'PRE',now:preNow}),ready.venue_key);
  assert.equal(ready.input_as_of,'2026-11-26T00:21:00.000Z');
});

test('replay and malformed or incomplete head candidates never create a final BUY selection',()=>{
  const fixture=modelFixture(),venueEvidence=buildVenueEvidence({race,venueProfile:profile(),stage:'FINAL',now:finalNow,replay:true});
  assert.equal(venueEvidence.profile,null);
  const replay=buildFinalTicketSelection({...fixture,venueEvidence,stage:'FINAL',exhibitionComplete:true,replay:true});
  assert.equal(replay.status,'REPLAY');assert.deepEqual(replay.tickets,[]);
  const missingHead={...fixture,scenarios:fixture.scenarios.filter(row=>row.leader!==6)};
  assert.deepEqual(ranked(missingHead).selection.tickets,[]);
  const invalid={...fixture,scenarios:fixture.scenarios.map(row=>({...row,score:null}))};
  assert.deepEqual(buildFinalTicketSelection({...invalid,venueEvidence,stage:'FINAL',exhibitionComplete:true}).tickets,[]);
  assert.equal(validFinalTickets(['1-2-3']),false);assert.equal(validFinalTickets(Array(6).fill('1-2-3')),false);
});
