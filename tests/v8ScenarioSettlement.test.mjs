import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScenarioTickets, SCENARIO_TICKET_REVISION, SCENARIO_TICKET_BASIS} from '../base44/shared/v8ScenarioTickets.js';
import {settleForecast, settleReplayForecast, settleExcludedForecast, SETTLEMENT_REVISION} from '../base44/shared/v8Settlement.js';
import {deriveScenarioVerification, SCENARIO_VERIFICATION_REVISION} from '../base44/shared/v8ScenarioSettlement.js';

const race = {id:'race-1',race_key:'2026-11-25_17_01',race_date:'2026-11-25',deadline:'2026-11-25T01:19:00Z',venue_code:'17',race_number:1};
const boats = [72,65,70,56,63,60].map((score,index)=>({boat_number:index+1,score,active:true,expected_course:index+1,observed_course:index+1}));
const scenarios = [
  [1,'ESCAPE',[3,2,5]], [2,'SASHI',[1,3,5]], [3,'MAKURI',[4,5,6]],
  [3,'MAKURISASHI',[1,4,5]], [3,'SASHI',[1,2,5]], [5,'MAKURI',[6,1,3]],
].map(([leader,method,beneficiaries])=>({key:leader+'_'+method,label:leader+' '+method,leader,method,beneficiaries,score:60}));
const researchTickets = ['1-2-3','1-2-4','1-2-5','1-2-6','1-3-2','1-3-4','1-3-5','1-3-6'];
function forecast(overrides={}) {
  const base = {...race,id:'forecast-1',race_id:race.id,revision:'V8_FORECAST_3_SCENARIOS',record_mode:'LIVE',stage:'FINAL',
    generated_at:'2026-11-25T01:10:00Z',created_date:'2026-11-25T01:10:00.100Z',input_as_of:'2026-11-25T01:09:00Z',
    boats:structuredClone(boats),exhibition_complete:true,research_tickets:[...researchTickets],decision:{status:'WATCH'},top_scenario_key:'1_ESCAPE',
    scenarios:scenarios.map(scenario=>({...scenario,tickets:buildScenarioTickets({scenario,boats,stage:'FINAL',exhibitionComplete:true}),
      ticket_revision:SCENARIO_TICKET_REVISION,ticket_basis:SCENARIO_TICKET_BASIS})),...overrides};
  return base;
}
const result = {id:'result-1',race_id:race.id,result_status:'RESULT_FINAL',is_finished:true,result_trifecta:'1-2-3',payout:2800,
  source:'LOCAL',finished_at:'2026-11-25T01:22:00Z',winning_method:'逃げ'};
const proof = {id:'proof-1',evidence_type:'LIVE',race_id:race.id,race_key:race.race_key,result_id:result.id,
  result_trifecta:result.result_trifecta,source:'LOCAL',fetched_at:'2026-11-25T01:23:00Z',
  recorded_at:'2026-11-25T01:23:00.100Z',created_date:'2026-11-25T01:23:00.200Z'};
const now='2026-11-25T01:30:00Z';
const settle=(f=forecast(),r=result)=>settleForecast({forecast:f,result:r,provenance:{...proof,result_trifecta:r.result_trifecta},now});

test('all six saved scenario ticket sets are independently settled without inflating combined investment',()=>{
  const f=forecast(),before=JSON.stringify(f),out=settle(f);
  assert.equal(out.ok,true);const receipt=out.record;
  assert.equal(receipt.revision,SETTLEMENT_REVISION);assert.equal(receipt.revision,'V8_SETTLEMENT_2');
  assert.equal(receipt.scenario_verification_revision,SCENARIO_VERIFICATION_REVISION);
  assert.equal(receipt.scenario_results.length,6);
  assert.equal(receipt.research_stake,800);assert.equal(receipt.research_return,2800);
  assert.deepEqual(receipt.research_tickets,researchTickets);assert.equal(receipt.buy_stake,0);
  assert.equal(receipt.provenance.scenario_totals_in_combined_statistics,false);
  for(const row of receipt.scenario_results){
    assert.equal(row.ticket_count,8);assert.equal(row.stake,800);assert.equal(row.ticket_basis,'SAVED');
    assert.equal(row.prospective_statistics_eligible,true);assert.equal(row.source_forecast_id,f.id);
    assert.equal(row.hit,row.tickets.includes(result.result_trifecta));
    assert.equal(row.returned,row.hit?2800:0);assert.equal(row.net_return,row.returned-800);
  }
  assert.equal(JSON.stringify(f),before);
});

test('same leader with different methods can have different tickets and independent hit results',()=>{
  const f=forecast(),makuri=f.scenarios.find(s=>s.key==='3_MAKURI'),sashi=f.scenarios.find(s=>s.key==='3_SASHI');
  const chosen=makuri.tickets.find(ticket=>!sashi.tickets.includes(ticket));assert.ok(chosen);
  const receipt=settle(f,{...result,result_trifecta:chosen,winning_method:'まくり'}).record;
  const m=receipt.scenario_results.find(r=>r.scenario_key===makuri.key),s=receipt.scenario_results.find(r=>r.scenario_key===sashi.key);
  assert.equal(m.hit,true);assert.equal(s.hit,false);assert.equal(m.winning_method_hit,true);assert.equal(s.winning_method_hit,false);
  assert.equal(m.leader_hit,true);assert.equal(s.leader_hit,true);
  assert.equal(receipt.research_stake,800);assert.equal(receipt.research_return,0);
});

test('refund exclusions retain conditional ticket evidence without assigning wins, losses or returns',()=>{
  const f=forecast(),out=settleExcludedForecast({forecast:f,result:{...result,refund_boats:[6]},provenance:proof,now});
  assert.equal(out.ok,true);assert.equal(out.record.status,'EXCLUDED_REFUND');assert.equal(out.record.scenario_results.length,6);
  for(const row of out.record.scenario_results){
    assert.equal(row.status,'EXCLUDED_REFUND');assert.equal(row.prospective_statistics_eligible,false);
    assert.equal(row.stake,800);assert.equal(row.tickets.length,8);
    for(const key of ['hit','returned','net_return','leader_hit','winning_method_hit'])assert.equal(Object.hasOwn(row,key),false);
  }
});

test('replayed scenario sets stay outside prospective statistics even when their tickets are saved',()=>{
  const f=forecast({id:'replay-1',record_mode:'REPLAY',stage:'FINAL',generated_at:'2026-11-25T01:25:00Z',created_date:'2026-11-25T01:25:00.100Z',
    input_as_of:'2026-11-25T01:24:00Z',decision:{status:'REPLAY'},provenance:{result_excluded:true,reconstruction:true,input_fields_whitelisted:true}});
  const out=settleReplayForecast({forecast:f,result,provenance:proof,now});assert.equal(out.ok,true);
  assert.equal(out.record.scenario_results.length,6);
  for(const row of out.record.scenario_results){assert.equal(row.record_mode,'REPLAY');assert.equal(row.ticket_basis,'SAVED');assert.equal(row.prospective_statistics_eligible,false);}
});

test('older saved forecasts derive reference-only outcomes from their frozen inputs without rewriting history',()=>{
  const f=forecast({revision:'V8_FORECAST_2_SUM',scenarios:structuredClone(scenarios)}),receipt=settle(f).record;
  delete receipt.scenario_results;delete receipt.scenario_verification_revision;
  const before=JSON.stringify({f,receipt}),rows=deriveScenarioVerification(f,receipt);
  assert.equal(rows.length,6);assert.equal(JSON.stringify({f,receipt}),before);
  for(const row of rows){assert.equal(row.ticket_basis,'RECONSTRUCTED');assert.equal(row.prospective_statistics_eligible,false);assert.equal(row.verification_basis,'RECONSTRUCTED_FROM_FROZEN_FORECAST');}
  const other=deriveScenarioVerification(f,{...receipt,result_trifecta:'6-5-4',result_payout:9999});
  assert.deepEqual(other.map(row=>row.tickets),rows.map(row=>row.tickets));
});

test('receipt identity, official evidence and source times must match before any reference comparison',()=>{
  const f=forecast(),receipt=settle(f).record;
  for(const change of [{forecast_id:'other'},{race_id:'other'},{race_key:'other'},{race_date:'2026-11-24'},
    {stage:'PRE'},{source_kind:'EXTERNAL'},{status:'PENDING'},{result_payout:0},{result_trifecta:'1-1-2'},
    {source_generated_at:'2026-11-25T01:11:00Z'},{source_created_at:'2026-11-25T01:11:00Z'},
    {provenance:{...receipt.provenance,result_evidence_type:'BACKFILL'}}]){
    assert.deepEqual(deriveScenarioVerification(f,{...receipt,...change}),[]);
  }
});

test('invalid or duplicate stored scenario sets cannot silently turn into reconstructed wins',()=>{
  const f=forecast(),receipt=settle(f).record;
  const invalid=structuredClone(f);invalid.scenarios[0].tickets[1]=invalid.scenarios[0].tickets[0];
  assert.equal(deriveScenarioVerification(invalid,receipt).some(row=>row.scenario_key==='1_ESCAPE'),false);
  const duplicate=structuredClone(f);duplicate.scenarios.push(duplicate.scenarios[0]);
  assert.equal(deriveScenarioVerification(duplicate,receipt).some(row=>row.scenario_key==='1_ESCAPE'),false);
});

test('three active boats use the actual two tickets and a missing winning method stays unknown',()=>{
  const small=boats.slice(0,3),scenario=scenarios[0],f=forecast({boats:small,
    scenarios:[{...scenario,tickets:buildScenarioTickets({scenario,boats:small,stage:'FINAL',exhibitionComplete:true}),
      ticket_revision:SCENARIO_TICKET_REVISION,ticket_basis:SCENARIO_TICKET_BASIS}]});
  const row=settle(f,{...result,winning_method:null}).record.scenario_results[0];
  assert.equal(row.ticket_count,2);assert.equal(row.stake,200);assert.equal(row.hit,true);assert.equal(row.returned,2800);
  assert.equal(row.winning_method_hit,null);
});
