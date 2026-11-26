import test from 'node:test';
import assert from 'node:assert/strict';
import {settleForecast,settleExcludedForecast,settleReplayForecast} from '../base44/shared/v8Settlement.js';

const research=['1-2-3','1-2-4','1-2-5','1-2-6','1-3-2','1-3-4','1-3-5','1-3-6'];
const ranked=['1-3-2','3-1-2','1-3-4','3-1-4','1-4-3','1-2-3',
  '3-1-5','1-3-5','1-5-3','3-1-6','1-3-6','1-6-3'];
const base={id:'forecast-final',revision:'V8_FORECAST_6_FINAL_SELECTION',race_id:'race-1',race_key:'2026-11-23_23_08',
  race_date:'2026-11-23',venue_code:'23',race_number:8,deadline:'2026-11-23T15:00:00+09:00',stage:'FINAL',record_mode:'LIVE',
  generated_at:'2026-11-23T05:50:00Z',created_date:'2026-11-23T05:50:00.100Z',input_as_of:'2026-11-23T05:49:00Z',
  research_tickets:research,scenarios:[{key:'escape1',leader:1,method:'ESCAPE'}],top_scenario_key:'escape1'};
const result={id:'result-1',race_id:base.race_id,result_status:'RESULT_FINAL',is_finished:true,result_trifecta:'3-1-2',
  payout:2800,source:'LOCAL',finished_at:'2026-11-23T06:02:00Z',winning_method:'まくり差し'};
const proof={id:'proof-1',evidence_type:'LIVE',race_id:base.race_id,race_key:base.race_key,result_id:result.id,
  result_trifecta:result.result_trifecta,source:'LOCAL',fetched_at:'2026-11-23T06:03:00Z',
  recorded_at:'2026-11-23T06:03:00.100Z',created_date:'2026-11-23T06:03:00.200Z'};
const now='2026-11-23T06:10:00Z';
const forecast=(n=6,status='BUY')=>({...structuredClone(base),
  final_selection:{revision:'V8_FINAL_SELECTION_1',status,ticket_count:n,tickets:ranked.slice(0,n)},
  decision:{status,tickets:ranked.slice(0,n)}});
const run=(source,extra={})=>settleForecast({forecast:source,result,provenance:proof,now,...extra});

test('6 and 12 ticket BUY shortlists charge their actual counts and keep research-eight separate',()=>{
  for(const n of [6,12]){
    const source=forecast(n),before=JSON.stringify(source),out=run(source);
    assert.equal(out.ok,true);
    assert.equal(out.record.research_stake,800);
    assert.equal(out.record.research_hit,false);
    assert.equal(out.record.research_return,0);
    assert.equal(out.record.buy_stake,n*100);
    assert.equal(out.record.buy_hit,true);
    assert.equal(out.record.buy_return,2800);
    assert.equal(out.record.final_selection_result.ticket_count,n);
    assert.equal(out.record.final_selection_result.stake,n*100);
    assert.equal(out.record.final_selection_result.return,2800);
    assert.equal(out.record.final_selection_result.hit_rank,2);
    assert.deepEqual(out.record.final_selection_result.tickets,ranked.slice(0,n));
    assert.equal(out.record.provenance.final_selection_totals_in_research_statistics,false);
    assert.equal(JSON.stringify(source),before);
  }
});

test('WATCH shortlist is evaluated but never enters the BUY cohort',()=>{
  const out=run(forecast(8,'WATCH'));
  assert.equal(out.ok,true);
  assert.equal(out.record.final_selection_result.hit,true);
  assert.equal(out.record.final_selection_result.stake,800);
  assert.equal(out.record.final_selection_result.buy_selected,false);
  assert.equal(out.record.buy_selected,false);
  assert.equal(out.record.buy_stake,0);
  assert.deepEqual(out.record.buy_tickets,[]);
});

test('BUY must use the identical saved shortlist and cannot silently use the research set',()=>{
  const row=forecast();row.decision.tickets=research;
  assert.equal(run(row).reason,'BUY_SELECTION_MISMATCH');
  for(const revision of ['V8_FORECAST_6_FINAL_SELECTION','V8_FORECAST_7_HEAD_COVERAGE']){
    const missing=forecast();missing.revision=revision;delete missing.final_selection;
    assert.equal(run(missing).reason,'BUY_SELECTION_MISSING');
  }
  for(const n of [5,13]){
    const invalid=forecast();invalid.final_selection.ticket_count=n;
    assert.equal(run(invalid).reason,'BUY_SELECTION_MISMATCH');
  }
  const duplicate=forecast();duplicate.final_selection.tickets[1]=duplicate.final_selection.tickets[0];
  assert.equal(run(duplicate).reason,'BUY_SELECTION_MISMATCH');
});

test('multi-head policy records settle their saved ranks and retain the original policy identity',()=>{
  const source=forecast(12);source.revision='V8_FORECAST_7_HEAD_COVERAGE';
  source.final_selection.policy_revision='V8_RULE_BUY_2';
  source.final_selection.tickets[10]='4-1-3';source.final_selection.tickets[11]='4-3-1';
  source.decision.tickets=[...source.final_selection.tickets];
  const original=JSON.stringify(source);
  const actual={...result,result_trifecta:'4-1-3'};
  const evidence={...proof,result_trifecta:actual.result_trifecta};
  const out=run(source,{result:actual,provenance:evidence});
  assert.equal(out.ok,true);assert.equal(out.record.buy_stake,1200);
  assert.equal(out.record.final_selection_result.hit_rank,11);
  assert.equal(out.record.final_selection_result.source_policy_revision,'V8_RULE_BUY_2');
  assert.equal(out.record.source_revision,'V8_FORECAST_7_HEAD_COVERAGE');
  assert.equal(out.record.research_hit,false);assert.equal(JSON.stringify(source),original);
  const old=run(forecast(12));assert.equal(old.ok,true);
  assert.equal(old.record.final_selection_result.source_policy_revision,null);
});

test('a missing historical shortlist stays unrecorded and is never derived from research tickets',()=>{
  const legacy={...structuredClone(base),revision:'V8_FORECAST_5_RECENT_LANE',decision:{status:'WATCH',tickets:research}};
  const out=run(legacy);
  assert.equal(out.ok,true);
  assert.equal(out.record.final_selection_result,null);
  assert.equal(out.record.research_stake,800);
});

test('refund exclusions preserve shortlist identity without fabricating loss or payout',()=>{
  const out=settleExcludedForecast({forecast:forecast(),result:{...result,refund_boats:[6]},provenance:proof,now});
  assert.equal(out.ok,true);
  const selected=out.record.final_selection_result;
  assert.equal(selected.status,'EXCLUDED_REFUND');
  assert.equal(selected.buy_selected,false);
  assert.equal(selected.ticket_count,6);
  for(const key of ['hit','hit_rank','stake','return'])assert.equal(Object.hasOwn(selected,key),false);
});

test('a replay shortlist remains retrospective and has no prospective BUY stake',()=>{
  const source={...forecast(6,'REPLAY'),record_mode:'REPLAY',exhibition_complete:true,
    generated_at:'2026-11-23T06:05:00Z',created_date:'2026-11-23T06:05:00.100Z',
    provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true}};
  source.decision.tickets=[];
  const out=settleReplayForecast({forecast:source,result,provenance:proof,now});
  assert.equal(out.ok,true);
  assert.equal(out.record.source_kind,'REPLAY');
  assert.equal(out.record.final_selection_result.hit,true);
  assert.equal(out.record.final_selection_result.buy_selected,false);
  assert.equal(out.record.buy_stake,0);
  assert.equal(out.record.provenance.prospective_statistics_eligible,false);
});
