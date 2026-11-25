import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScenarioTickets,scenarioTicketView,SCENARIO_TICKET_REVISION,SCENARIO_TICKET_BASIS} from '../base44/shared/v8ScenarioTickets.js';

const boats = () => Array.from({length:6},(_,index)=>({boat_number:index+1,active:true,score:60,
  expected_course:index+1,observed_course:index+1}));
const scenario = (method='MAKURI',leader=3) => ({key:leader+'_'+method,leader,method,beneficiaries:[4,5,1]});
const args = (method='MAKURI') => ({scenario:scenario(method),boats:boats(),stage:'FINAL',exhibitionComplete:true});
const legacy = () => ({id:'stored-pre',stage:'PRE',generated_at:'2026-11-25T00:00:00Z',input_as_of:'2026-11-24T22:00:00Z',
  boats:boats(),scenarios:[scenario()]});
const saved = () => {
  const forecast=legacy(),row=forecast.scenarios[0];
  row.tickets=buildScenarioTickets({scenario:row,boats:forecast.boats,stage:forecast.stage});
  row.ticket_revision=SCENARIO_TICKET_REVISION;row.ticket_basis=SCENARIO_TICKET_BASIS;
  return forecast;
};

test('each conditional set fixes its own leader and contains eight unique legal combinations',()=>{
  for(const method of ['ESCAPE','SASHI','MAKURI','MAKURISASHI']){
    const input=args(method),before=JSON.stringify(input),tickets=buildScenarioTickets(input);
    assert.equal(tickets.length,8);assert.equal(new Set(tickets).size,8);
    assert.ok(tickets.every(ticket=>ticket.startsWith('3-')&&new Set(ticket.split('-')).size===3));
    assert.equal(JSON.stringify(input),before);
    assert.deepEqual(buildScenarioTickets({...input,boats:[...input.boats].reverse()}),tickets);
  }
});
test('same-leader sashi, makuri and makuri-sashi reflect distinct following relationships',()=>{
  // Equal ability isolates the conditional method assumption from boat quality.
  const sashi=buildScenarioTickets(args('SASHI'));
  const makuri=buildScenarioTickets(args('MAKURI'));
  const makuriSashi=buildScenarioTickets(args('MAKURISASHI'));
  assert.notDeepEqual(sashi,makuri);assert.notDeepEqual(makuri,makuriSashi);assert.notDeepEqual(sashi,makuriSashi);
  assert.equal(sashi[0].split('-')[1],'1');
  assert.equal(makuri[0].split('-')[1],'4');
  assert.ok(makuriSashi[0].split('-').includes('1'));
});
test('the ordered beneficiaries affect follower order without changing the winning boat',()=>{
  const input={...args('ESCAPE'),scenario:scenario('ESCAPE',1)};
  const a=buildScenarioTickets({...input,scenario:{...input.scenario,beneficiaries:[2,3,4]}});
  const b=buildScenarioTickets({...input,scenario:{...input.scenario,beneficiaries:[5,6,4]}});
  assert.notDeepEqual(a,b);assert.ok([...a,...b].every(ticket=>ticket.startsWith('1-')));
});
test('PRE ignores observed courses, while complete FINAL follows their saved entry order',()=>{
  const input=args('MAKURI'),changed=input.boats.map(row=>({...row,observed_course:7-row.boat_number}));
  const before=buildScenarioTickets({...input,stage:'PRE'});
  assert.deepEqual(buildScenarioTickets({...input,stage:'PRE',boats:changed}),before);
  assert.notDeepEqual(buildScenarioTickets({...input,boats:changed}),buildScenarioTickets(input));
  assert.deepEqual(buildScenarioTickets({...input,boats:changed,exhibitionComplete:false}),before);
});
test('five-, four- and three-boat races exclude scratches and stop at the possible combinations',()=>{
  for(const activeCount of [5,4,3]){
    const input={...args('ESCAPE'),scenario:scenario('ESCAPE',1),boats:boats().map(row=>({...row,active:row.boat_number<=activeCount}))};
    const tickets=buildScenarioTickets(input);
    assert.equal(tickets.length,Math.min(8,(activeCount-1)*(activeCount-2)));
    assert.ok(tickets.every(ticket=>ticket.split('-').every(value=>Number(value)<=activeCount)));
  }
});
test('ambiguous courses, duplicate boats, missing scores and nonparticipant leaders fail closed',()=>{
  const input=args();
  for(const invalid of [
    {...input,boats:input.boats.map(row=>({...row,observed_course:1}))},
    {...input,boats:[input.boats[0],input.boats[0],...input.boats.slice(2)]},
    {...input,boats:input.boats.map(row=>({...row,score:null}))},
    {...input,boats:input.boats.map(row=>({...row,active:row.boat_number!==3}))},
    {...input,scenario:{...input.scenario,key:'4_MAKURI'}},
    {...input,scenario:{...input.scenario,method:'UNKNOWN'}},
  ])assert.deepEqual(buildScenarioTickets(invalid),[]);
});
test('saved ticket sets are read unchanged and their metadata identifies the source forecast',()=>{
  const forecast=saved(),row=forecast.scenarios[0],tickets=[...row.tickets].reverse();row.tickets=tickets;
  const before=JSON.stringify(forecast),view=scenarioTicketView(forecast,row.key);
  assert.equal(view.status,'SAVED');assert.deepEqual(view.tickets,tickets);
  assert.equal(view.source_forecast_id,forecast.id);assert.equal(view.source_generated_at,forecast.generated_at);
  assert.equal(view.input_as_of,forecast.input_as_of);assert.equal(view.revision,SCENARIO_TICKET_REVISION);
  view.tickets.pop();assert.equal(JSON.stringify(forecast),before);
});
test('legacy reconstruction uses frozen inputs, is explicit, and does not mutate the saved record',()=>{
  const forecast=legacy(),before=JSON.stringify(forecast),view=scenarioTicketView(forecast,'3_MAKURI');
  assert.equal(view.status,'RECONSTRUCTED');assert.equal(view.tickets.length,8);
  assert.equal(JSON.stringify(forecast),before);assert.equal(Object.hasOwn(forecast.scenarios[0],'tickets'),false);
  const contaminated={...forecast,result_trifecta:'6-5-4',current_race:{scratched_boats:[3]},odds:{'6-5-4':99999},
    boats:forecast.boats.map(row=>({...row,finish_order:7-row.boat_number,result:'6-5-4',exhibition_time:1,exhibition_st:0,observed_course:7-row.boat_number}))};
  assert.deepEqual(scenarioTicketView(contaminated,'3_MAKURI'),view);
});
test('malformed stored sets never fall back to reconstructed tickets',()=>{
  const forecast=saved(),key=forecast.scenarios[0].key;
  const modifications=[
    row=>{row.tickets[1]=row.tickets[0];},
    row=>{row.tickets[0]='1-2-3';},
    row=>{row.tickets[0]='3-3-1';},
    row=>{row.tickets.pop();},
    row=>{row.tickets=null;},
    row=>{delete row.tickets;},
    row=>{row.ticket_revision='UNKNOWN';},
    row=>{delete row.ticket_basis;},
  ];
  for(const modify of modifications){
    const invalid=structuredClone(forecast);modify(invalid.scenarios[0]);
    assert.equal(scenarioTicketView(invalid,key).status,'UNAVAILABLE');
    assert.deepEqual(scenarioTicketView(invalid,key).tickets,[]);
  }
  assert.equal(scenarioTicketView({...forecast,scenarios:[forecast.scenarios[0],forecast.scenarios[0]]},key).status,'UNAVAILABLE');
  assert.equal(scenarioTicketView(forecast,'missing').status,'UNAVAILABLE');
  assert.equal(scenarioTicketView({...legacy(),revision:'V8_FORECAST_3_SCENARIOS'},key).status,'UNAVAILABLE');
  assert.equal(scenarioTicketView({...legacy(),provenance:{scenario_ticket_revision:SCENARIO_TICKET_REVISION}},key).status,'UNAVAILABLE');
});
