import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReplayForecast,REPLAY_REVISION} from '../base44/shared/v8ReplayForecast.js';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';

const now='2026-11-22T11:00:00.000Z';
const race={id:'r1',race_key:'2026-11-22_01_01',race_date:'2026-11-22',venue_code:'01',race_number:1,deadline:'2026-11-22T05:00:00.000Z',status:'finished',updated_date:'2026-11-22T05:10:00.000Z'};
const entries=()=>Array.from({length:6},(_,i)=>({id:'e'+i,race_id:'r1',race_key:race.race_key,race_date:race.race_date,boat_number:i+1,registration_number:String(4501+i),player_name:'選手'+(i+1),national_win_rate:i===0?8:5,national_2rate:i===0?70:25,local_win_rate:i===0?7:5,motor_f2_rate:50-i,avg_st:.12+i*.02,section_finishes:'1-1-1',section_points:10,exhibition_time:6.60+i*.04,exhibition_st:.12+i*.02,exhibition_course:i+1,updated_date:'2026-11-22T05:09:00.000Z'}));
const args=(stage='PRE')=>({race,entries:entries(),stage,now});
const stored=record=>({...record,id:'replay-pre',created_date:now});

test('closed-race reconstruction retains real time, while live forecasting still refuses it',()=>{
  const a=args();assert.equal(buildRaceForecast(a).ok,false);
  const before=JSON.stringify(a),result=buildReplayForecast(a);
  assert.equal(result.ok,true);assert.equal(JSON.stringify(a),before);
  assert.equal(result.record.record_mode,'REPLAY');assert.equal(result.record.generated_at,now);
  assert.equal(result.record.deadline,race.deadline);assert.equal(result.record.forecast_key,REPLAY_REVISION+':'+race.race_key+':PRE');
  assert.equal(result.record.decision.status,'REPLAY');assert.deepEqual(result.record.decision.tickets,[]);
  assert.equal(result.record.provenance.result_excluded,true);assert.equal(result.record.provenance.prospective_performance_eligible,false);
  assert.equal(buildReplayForecast({...a,stage:'DAY_BEFORE'}).reason,'REPLAY_STAGE_INVALID');
});
test('replay ignores results, prices and mutable section aggregates rather than using them as prediction input',()=>{
  const original=buildReplayForecast(args()).record;
  const contaminated=buildReplayForecast({...args(),race:{...race,result_trifecta:'6-5-4',winning_method:'まくり',payout:999999,wind_speed:25},entries:entries().map((row,i)=>({...row,finish_order:6-i,result:'1',f_flag:true,section_finishes:'6-6-6',section_points:1,course_stats:[{course:i+1,win_percent:99,starts:100}]})),result:{result_trifecta:'6-5-4'},odds:{odds_map:{'6-5-4':99999}},prediction:{plans:{hit_8:{judgment:'BUY',tickets:['6-5-4']}}}}).record;
  assert.deepEqual(contaminated.scenarios,original.scenarios);assert.deepEqual(contaminated.research_tickets,original.research_tickets);
  assert.deepEqual(contaminated.input_snapshot,original.input_snapshot);
  assert.equal(Object.hasOwn(contaminated.input_snapshot.race,'result_trifecta'),false);
  assert.equal(Object.hasOwn(contaminated.input_snapshot.entries[0],'section_finishes'),false);
});
test('PRE excludes all exhibition values while FINAL uses their observed differences',()=>{
  const before=buildReplayForecast(args()).record;
  const reversed=entries().map((row,i)=>({...row,exhibition_course:6-i,exhibition_time:7.2-i*.10,exhibition_st:.3-i*.03}));
  const changedBefore=buildReplayForecast({...args(),entries:reversed}).record;
  assert.deepEqual(before.scenarios,changedBefore.scenarios);assert.deepEqual(before.research_tickets,changedBefore.research_tickets);
  assert.equal(Object.hasOwn(before.input_snapshot.entries[0],'exhibition_time'),false);
  const baseline=stored(before),after=buildReplayForecast({...args('FINAL'),baseline}).record;
  const changedAfter=buildReplayForecast({...args('FINAL'),entries:reversed,baseline}).record;
  assert.notDeepEqual(after.scenarios,changedAfter.scenarios);
  assert.equal(after.comparison.baseline_id,baseline.id);assert.equal(changedAfter.comparison.entry_changed,true);
  assert.equal(after.exhibition_complete,true);assert.equal(after.generated_at,now);
});
test('archived live inputs protect base scores from later mutable entry updates',()=>{
  const preTime='2026-11-22T04:00:00.000Z';
  const liveRace={...race,status:'scheduled',updated_date:preTime};
  const liveEntries=entries().map(row=>{const copy={...row,updated_date:preTime};for(const key of ['exhibition_time','exhibition_st','exhibition_course'])delete copy[key];return copy;});
  const archive={...buildRaceForecast({race:liveRace,entries:liveEntries,stage:'PRE',now:preTime}).record,id:'live-pre',created_date:preTime};
  const base=buildReplayForecast({...args('FINAL'),baseline:archive}).record;
  const changed=buildReplayForecast({...args('FINAL'),baseline:archive,entries:entries().map(row=>({...row,national_win_rate:1,motor_f2_rate:1,avg_st:.5,section_points:0}))}).record;
  assert.deepEqual(changed.research_tickets,base.research_tickets);assert.deepEqual(changed.scenarios,base.scenarios);
  assert.equal(base.input_snapshot.historical_as_of_verified,true);assert.equal(base.comparison.baseline_id,'live-pre');
});
test('incomplete exhibition can create PRE but FINAL remains retryable and unsaved',()=>{
  const partial=entries();partial[5].exhibition_st=null;
  assert.equal(buildReplayForecast({...args(),entries:partial}).ok,true);
  assert.equal(buildReplayForecast({...args('FINAL'),entries:partial}).reason,'EXHIBITION_INCOMPLETE');
  partial[5].exhibition_st='L';assert.equal(buildReplayForecast({...args('FINAL'),entries:partial}).record.exhibition_complete,true);
});
test('explicitly scratched boat is excluded from research scenarios and tickets',()=>{
  const fewer=entries();fewer[5].is_absent=true;fewer[5].exhibition_time=null;fewer[5].exhibition_st=null;fewer[5].exhibition_course=null;
  const result=buildReplayForecast({...args('FINAL'),race:{...race,scratched_boats:[6]},entries:fewer});
  assert.equal(result.ok,true);assert.equal(result.record.exhibition_complete,true);
  assert.ok(result.record.research_tickets.every(ticket=>!ticket.split('-').includes('6')));
  assert.ok(result.record.scenarios.every(row=>row.leader!==6));
});
test('reconstruction still rejects mismatched identities and future source timestamps',()=>{
  const bad=entries();bad[0].registration_number=bad[1].registration_number;
  assert.equal(buildReplayForecast({...args(),entries:bad}).reason,'ENTRY_IDENTITY_INVALID');
  assert.equal(buildReplayForecast({...args(),entries:entries().map(row=>({...row,updated_date:'2026-11-23T00:00:00Z'}))}).reason,'ENTRY_SOURCE_TIME_INVALID');
  assert.equal(buildReplayForecast({...args(),race:{...race,race_number:2}}).reason,'RACE_IDENTITY_MISMATCH');
});
test('a reconstructed baseline can never satisfy the live BUY baseline gate',()=>{
  const reconstructed=stored(buildReplayForecast(args()).record);
  const at='2026-11-22T04:50:00Z';
  const before={...reconstructed,generated_at:'2026-11-22T04:00:00Z',created_date:'2026-11-22T04:00:00Z'};
  const result=buildRaceForecast({race:{...race,status:'scheduled',updated_date:at},entries:entries().map(row=>({...row,updated_date:at})),stage:'FINAL',now:at,baseline:before});
  assert.equal(result.ok,true);assert.equal(result.record.comparison.status,'NO_BASE');assert.equal(result.record.decision.status,'WAIT');
});
