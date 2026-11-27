import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResearchRace} from '../base44/shared/v8ResearchRaceDeadline.js';
import {settleForecast,settleReplayForecast} from '../base44/shared/v8Settlement.js';
import {currentDecision} from '../base44/shared/v8Repository.js';

const race={id:'race-miyajima-10',race_key:'2026-11-27_17_10',race_date:'2026-11-27',venue_code:'17',race_number:10,
  deadline:'2026-11-27T14:21:00+09:00',status:'finished'};
const tickets=['1-4-3','1-3-4','1-4-5','1-3-5','1-4-2','1-5-4','1-5-3','1-3-2','1-4-6','1-3-6','1-5-2'];
const source={id:'first-buy',race_id:race.id,race_key:race.race_key,race_date:race.race_date,venue_code:race.venue_code,race_number:10,
  revision:'V8_FORECAST_7_HEAD_COVERAGE',forecast_key:'saved-first-buy',stage:'FINAL',record_mode:'LIVE',
  deadline:'2026-11-27T14:22:00+09:00',generated_at:'2026-11-27T05:06:13.019Z',created_date:'2026-11-27T05:06:13.310000',
  input_as_of:'2026-11-27T05:06:07.548Z',exhibition_complete:true,research_tickets:tickets.slice(0,8),
  decision:{status:'BUY',tickets},final_selection:{revision:'V8_FINAL_SELECTION_1',status:'BUY',tickets,ticket_count:11}};
const result={id:'result-miyajima-10',race_id:race.id,source:'BOATCAST',result_status:'RESULT_FINAL',is_finished:true,
  result_trifecta:'5-4-1',payout:13000,finished_at:'2026-11-27T05:35:09.095Z'};
const proof={id:'proof-miyajima-10',race_id:race.id,race_key:race.race_key,result_id:result.id,source:'BOATCAST',
  result_trifecta:result.result_trifecta,evidence_type:'LIVE',fetched_at:'2026-11-27T05:35:08.696Z',
  recorded_at:'2026-11-27T05:35:09.353Z',created_date:'2026-11-27T05:35:09.697000'};
const now='2026-11-28T00:00:00Z';
const settle=(forecast=source,extra={})=>settleForecast({forecast,race,result,provenance:proof,now,...extra});

test('the observed 14:22 to 14:21 correction settles immutable pre-cutoff BUY evidence and records both deadlines',()=>{
  const before=JSON.stringify({source,race,result,proof}),out=settle();
  assert.equal(out.ok,true);assert.equal(out.record.forecast_id,source.id);
  assert.equal(out.record.final_selection_result.status,'SETTLED');
  assert.equal(out.record.final_selection_result.stake,1100);
  assert.equal(out.record.final_selection_result.hit,false);assert.equal(out.record.final_selection_result.return,0);
  assert.deepEqual(out.record.provenance.race_deadline_reconciliation,{
    revision:'V8_RESEARCH_RACE_DEADLINE_1',basis:'SAME_RACE_EARLIEST_CUTOFF_LATEST_RESULT',
    saved_deadline:source.deadline,current_deadline:race.deadline,source_cutoff_at:'2026-11-27T05:20:00.000Z',
    result_not_before:'2026-11-27T05:22:00.000Z',source_kind:'FORECAST',
  });
  assert.equal(JSON.stringify({source,race,result,proof}),before);
});

test('records only before the later deadline cannot become prospective results',()=>{
  for(const changes of [
    {generated_at:'2026-11-27T05:20:00Z',created_date:'2026-11-27T05:20:00.100Z'},
    {created_date:'2026-11-27T05:20:00Z'},
    {input_as_of:'2026-11-27T05:20:00Z'},
    {input_as_of:'invalid'},
  ])assert.equal(settle({...source,...changes}).ok,false);
  // Even a postponement may not make a forecast saved after its original cutoff eligible.
  const postponed={...race,deadline:'2026-11-27T14:23:00+09:00'};
  assert.equal(settle({...source,generated_at:'2026-11-27T05:21:00Z',created_date:'2026-11-27T05:21:00.100Z'},
    {race:postponed}).reason,'SOURCE_NOT_SAVED_BEFORE_CURRENT_CUTOFF');
});

test('result and fetched evidence must occur after the later of the two deadlines',()=>{
  assert.equal(settle(source,{result:{...result,finished_at:'2026-11-27T05:21:30Z'}}).reason,'RESULT_TIME_ORDER_INVALID');
  assert.equal(settle(source,{provenance:{...proof,fetched_at:'2026-11-27T05:21:30Z'}}).reason,'RESULT_TIME_ORDER_INVALID');
  assert.equal(settle(source,{race:{...race,deadline:'2026-11-27T14:23:00+09:00'},
    result:{...result,finished_at:'2026-11-27T05:22:30Z'}}).reason,'RESULT_TIME_ORDER_INVALID');
});

test('missing dates, conflicting race identity and malformed timestamps remain held',()=>{
  for(const changed of [
    {...race,deadline:null},{...race,deadline:'bad-date'},{...race,deadline:'2026-11-28T14:21:00+09:00'},
    {...race,id:'other-race'},{...race,race_key:'2026-11-27_17_11'},{...race,venue_code:'18'},
    {...race,race_number:11},{...race,race_date:'2026-11-26'},
  ])assert.equal(settle(source,{race:changed}).ok,false);
  for(const changed of [{...source,venue_code:undefined},{...source,race_number:undefined},
    {...source,created_date:'bad-date'},{...source,generated_at:'bad-date'}])assert.equal(settle(changed).ok,false);
});

test('equal deadlines keep PRE settlement behavior and live BUY still demands exact race deadlines',()=>{
  const pre={...source,stage:'PRE',deadline:race.deadline,decision:{status:'WATCH'},final_selection:null,exhibition_complete:false};
  const out=settle(pre);assert.equal(out.ok,true);assert.equal(out.record.buy_selected,false);
  assert.equal(out.record.provenance.race_deadline_reconciliation,undefined);
  assert.equal(currentDecision(source,{...race,status:'scheduled'},Date.parse('2026-11-27T05:07:00Z')),'WAIT');
});

test('REPLAY stays retrospective and must have been reconstructed after both recorded deadlines',()=>{
  const replay={...source,id:'replay-final',record_mode:'REPLAY',decision:{status:'REPLAY'},final_selection:null,
    generated_at:'2026-11-27T06:00:00Z',created_date:'2026-11-27T06:00:00.100Z',input_as_of:'2026-11-27T05:35:00Z',
    provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true}};
  const run=forecast=>settleReplayForecast({forecast,race,result,provenance:proof,now});
  const out=run(replay);assert.equal(out.ok,true);assert.equal(out.record.source_kind,'REPLAY');
  assert.equal(out.record.buy_selected,false);assert.equal(out.record.provenance.prospective_statistics_eligible,false);
  assert.equal(run({...replay,generated_at:'2026-11-27T05:21:30Z',created_date:'2026-11-27T05:21:31Z',input_as_of:null}).ok,false);
  assert.equal(validateResearchRace({...replay,generated_at:'2026-11-27T05:22:30Z',created_date:'2026-11-27T05:22:31Z',input_as_of:null},
    {...race,deadline:'2026-11-27T14:23:00+09:00'}).reason,'REPLAY_BEFORE_CURRENT_DEADLINE');
});
