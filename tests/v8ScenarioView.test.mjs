import test from 'node:test';
import assert from 'node:assert/strict';
import {scenarioViews,scenarioSelectionContext,selectedScenarioView} from '../src/components/liveV8/v8ScenarioView.js';
import {buildTicketOdds} from '../src/components/liveV8/v8TicketOdds.js';
import {buildScenarioTickets,SCENARIO_TICKET_REVISION,SCENARIO_TICKET_BASIS} from '../base44/shared/v8ScenarioTickets.js';

const forecast = (saved = true) => {
  const row={id:'f1',race_id:'r1',race_key:'2026-11-25_24_05',race_date:'2026-11-25',stage:'FINAL',
    generated_at:'2026-11-25T08:00:00Z',created_date:'2026-11-25T08:00:01Z',input_as_of:'2026-11-25T07:59:00Z',
    deadline:'2026-11-25T08:30:00Z',exhibition_complete:true,top_scenario_key:'1_ESCAPE',research_tickets:['1-2-3'],
    boats:Array.from({length:6},(_,i)=>({boat_number:i+1,active:true,score:60,expected_course:i+1,observed_course:i+1})),
    scenarios:[[1,'ESCAPE'],[3,'MAKURI'],[3,'MAKURISASHI'],[3,'SASHI'],[5,'MAKURISASHI'],[5,'MAKURI']]
      .map(([leader,method])=>({key:`${leader}_${method}`,leader,method,label:`${leader}号艇 ${method}`,beneficiaries:[4,5,1]}))};
  if(saved)for(const scenario of row.scenarios)Object.assign(scenario,{
    tickets:buildScenarioTickets({scenario,boats:row.boats,stage:row.stage,exhibitionComplete:true}),
    ticket_revision:SCENARIO_TICKET_REVISION,ticket_basis:SCENARIO_TICKET_BASIS,
  });
  return row;
};
const receipt = row => ({forecast_id:row.id,race_id:row.race_id,race_key:row.race_key,race_date:row.race_date,stage:row.stage,
  status:'SETTLED',source_kind:'FORECAST',result_id:'result1',evidence_id:'evidence1',result_trifecta:'3-4-5',result_payout:1200,
  source_generated_at:row.generated_at,source_created_at:row.created_date,settled_at:'2026-11-25T08:40:00Z',
  actual_winning_method:'まくり',research_hit:true,provenance:{prospective_statistics_eligible:true,result_evidence_type:'LIVE',result_and_source_race_matched:true}});

test('six scenario choices expose their own ticket sets and distinguish saved from reconstructed inputs',()=>{
  for(const saved of [true,false]){
    const row=forecast(saved),before=JSON.stringify(row),views=scenarioViews(row);
    assert.equal(views.length,6);
    for(const view of views){
      assert.equal(view.available,true);assert.equal(view.tickets.length,8);
      assert.ok(view.tickets.every(ticket=>ticket.startsWith(`${view.scenario.leader}-`)));
      assert.equal(view.sourceLabel,saved?'保存済み':'保存データから計算');
      assert.equal(view.resultLabel,'結果照合待ち');
      assert.notDeepEqual(view.tickets,row.research_tickets);
    }
    assert.equal(JSON.stringify(row),before);
  }
});

test('selecting a different leader or attack method changes the displayed tickets and prices from the same quote snapshot',()=>{
  const row=forecast(),views=scenarioViews(row),context=scenarioSelectionContext(row);
  const oddsMap={};for(const view of views)for(const ticket of view.tickets)oddsMap[ticket]=Number(ticket.replaceAll('-',''))/10;
  const displayOdds={status:'AVAILABLE',snapshot:{id:'odds1',race_id:'r1',captured_at:'2026-11-25T08:02:00Z',created_date:'2026-11-25T08:02:01Z',odds_map:oddsMap}};
  const selected=[];
  for(const key of ['1_ESCAPE','3_MAKURI','3_SASHI','3_MAKURISASHI']){
    const view=selectedScenarioView(views,{context,key},row);
    assert.equal(view.scenario.key,key);selected.push(view.tickets);
    const odds=buildTicketOdds({tickets:view.tickets,displayOdds,race:{id:'r1',deadline:row.deadline},now:Date.parse('2026-11-25T08:03:00Z')});
    assert.equal(odds.status,'AVAILABLE');assert.equal(odds.total,view.tickets.length);
    assert.deepEqual(Object.keys(odds.quotes),view.tickets);
    assert.equal(odds.composite,1/view.tickets.reduce((sum,ticket)=>sum+1/oddsMap[ticket],0));
  }
  assert.notDeepEqual(selected[0],selected[1]);assert.notDeepEqual(selected[1],selected[2]);assert.notDeepEqual(selected[2],selected[3]);
});

test('selection survives a fresh forecast for the same race and stage but resets for another race, prior-record mode or missing key',()=>{
  const row=forecast(),selection={context:scenarioSelectionContext(row,'AUTO'),key:'3_MAKURI'};
  const refreshed={...row,id:'f2',top_scenario_key:'5_MAKURI',generated_at:'2026-11-25T08:05:00Z'};
  assert.equal(selectedScenarioView(scenarioViews(refreshed),selection,refreshed,'AUTO').scenario.key,'3_MAKURI');
  assert.equal(selectedScenarioView(scenarioViews(refreshed),selection,refreshed,'DAY_BEFORE').scenario.key,'5_MAKURI');
  const another={...refreshed,race_key:'2026-11-25_24_06'};
  assert.equal(selectedScenarioView(scenarioViews(another),selection,another,'AUTO').scenario.key,'5_MAKURI');
  const missing={...refreshed,scenarios:refreshed.scenarios.filter(scenario=>scenario.key!=='3_MAKURI')};
  assert.equal(selectedScenarioView(scenarioViews(missing),selection,missing,'AUTO').scenario.key,'5_MAKURI');
  assert.equal(selectedScenarioView([],selection,refreshed,'AUTO'),null);
});

test('scenario settlement does not borrow the combined V8 hit and labels reconstructed results as reference comparisons',()=>{
  for(const saved of [true,false]){
    const row=forecast(saved),views=scenarioViews(row,receipt(row));
    const escape=views.find(view=>view.scenario.key==='1_ESCAPE'),makuri=views.find(view=>view.scenario.key==='3_MAKURI');
    assert.equal(escape.result.hit,false);assert.equal(makuri.result.hit,true);
    assert.equal(makuri.result.stake,800);assert.equal(makuri.result.returned,1200);
    assert.equal(makuri.resultLabel,saved?'的中':'参考照合：的中');
    assert.equal(escape.resultLabel,saved?'不的中':'参考照合：不的中');
    const wrong={...receipt(row),forecast_id:'someone-else'};
    assert.ok(scenarioViews(row,wrong).every(view=>view.result===null));
  }
});

test('a malformed saved set is unavailable and is never replaced by combined or reconstructed tickets',()=>{
  const row=forecast();row.scenarios[1].tickets[0]='1-2-3';
  const view=scenarioViews(row,receipt(row)).find(view=>view.scenario.key==='3_MAKURI');
  assert.equal(view.available,false);assert.deepEqual(view.tickets,[]);assert.equal(view.result,null);
  assert.equal(view.sourceLabel,'買い目の情報不足');
});

test('refunds and replay comparisons keep their distinct labels and do not invent returns',()=>{
  const row=forecast(),excluded={...receipt(row),status:'EXCLUDED_REFUND'};
  const views=scenarioViews(row,excluded);
  assert.ok(views.every(view=>view.excluded&&view.resultLabel==='返還等・集計対象外'));
  assert.ok(views.every(view=>view.result.returned===undefined&&view.result.hit===undefined));
  const replay={...row,record_mode:'REPLAY'},verification={...receipt(replay),source_kind:'REPLAY'};
  const view=scenarioViews(replay,verification).find(view=>view.scenario.key==='3_MAKURI');
  assert.equal(view.sourceLabel,'事後検証・保存済み');assert.equal(view.resultLabel,'参考照合：的中');
});
