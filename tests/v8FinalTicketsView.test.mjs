import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {finalSelectionView, finalSelectionOdds, finalSelectionDecision, finalSelectionResultView, finalSelectionStats} from '../src/components/liveV8/v8FinalTicketsView.js';
import * as study from '../src/components/liveV8/v8StudyView.js';
import {buildFinalTicketSelection} from '../base44/shared/v8FinalTickets.js';

const NOW = Date.parse('2026-11-26T04:07:30Z');
const race = {id: 'race-a', race_key: '2026-11-26_08_07', venue_code: '08', race_number: 7, race_date: '2026-11-26', deadline: '2026-11-26T04:11:00Z', status: 'scheduled'};
const allTickets = ['1-2-3', '1-3-2', '1-2-4', '1-4-2', '1-2-5', '1-5-2', '1-3-4', '1-4-3', '1-3-5', '1-5-3', '1-4-5', '1-5-4'];
function forecast(count=8) {
  const tickets = allTickets.slice(0,count), odds = Object.fromEntries(tickets.map((ticket,index)=>[ticket,20+index]));
  const common = {status: 'BUY', tickets: [...tickets], odds: {...odds}, odds_snapshot_id: 'odds-original', odds_captured_at: '2026-11-26T04:07:00Z', composite_odds: 2.91, price_checked: true, valid_until: '2026-11-26T04:10:00Z'};
  return {id: 'final-a', race_id: race.id, race_key: race.race_key, venue_code: race.venue_code, race_date: race.race_date,
    deadline: race.deadline, record_mode: 'LIVE', stage: 'FINAL', quality: 'CAPTURED', exhibition_complete: true,
    generated_at: '2026-11-26T04:07:08Z', created_date: '2026-11-26T04:07:09Z',
    boats: [{boat_number: 1, player_name: '保存選手'}], research_tickets: ['2-1-3', '2-1-4'], decision: {...common,tickets:[...tickets],odds:{...odds}},
    final_selection: {...common, revision: 'V8_FINAL_SELECTION_1', stage: 'FINAL', probability_calibrated: false,
      ticket_count: tickets.length, ranked_tickets: tickets.map((ticket,index)=>({rank:index+1,ticket,score:80-index,reasons:['保存した1着の根拠','保存した相手の根拠']})),
      role_evidence: [{boat_number:1,course:1,role:'INSIDE_AXIS',reasons:['保存時の根拠']}], gate_checks: []}};
}
function settlement(row, {hit=true,buy=true,status='SETTLED'}={}) {
  return {forecast_id:row.id,status,source_kind:'FORECAST',race_id:row.race_id,result_trifecta:hit?row.final_selection.tickets[1]:'6-5-4',
    final_selection_result:{revision:'V8_FINAL_SELECTION_VERIFICATION_1',source_revision:row.final_selection.revision,
      source_forecast_id:row.id,status,tickets:[...row.final_selection.tickets],ticket_count:row.final_selection.ticket_count,
      unit_stake:100,hit,hit_rank:hit?2:null,stake:row.final_selection.ticket_count*100,return:hit?2800:0,
      decision_status:row.decision.status,buy_selected:buy}};
}

function balancedForecast() {
  const row=forecast(12),tickets=[...allTickets.slice(0,8),'3-1-2','3-2-1','4-1-2','4-2-1'];
  row.revision='V8_FORECAST_7_HEAD_BALANCE';
  const odds=Object.fromEntries(tickets.map((ticket,index)=>[ticket,20+index]));
  Object.assign(row.final_selection,{policy_revision:'V8_RULE_BUY_2',policy:{head_score_window:12,min_tickets_per_head:2,max_head_boats:3},
    tickets:[...tickets],ticket_count:12,candidate_count:120,odds:{...odds},
    ranked_tickets:tickets.map((ticket,index)=>({rank:index+1,ticket,score:80-index,
      global_rank:index<8?index+1:index<10?index+13:index+21,
      selection_basis:index<8?'SCORE_RANK':'HEAD_COVERAGE',reasons:['保存した評価理由']})),
    head_allocations:[
      {boat_number:1,course:1,kind:'MAIN',ticket_count:8,first_score:63,score_gap:0,scenario_key:'1_ESCAPE',best_global_rank:1,reason:'保存した本線の根拠'},
      {boat_number:3,course:3,kind:'COUNTER',ticket_count:2,first_score:59,score_gap:4,scenario_key:'3_MAKURI',best_global_rank:21,reason:'本線との1着評価差は4点'},
      {boat_number:4,course:4,kind:'COUNTER',ticket_count:2,first_score:55,score_gap:8,scenario_key:'4_MAKURISASHI',best_global_rank:31,reason:'本線との1着評価差は8点'},
    ],role_evidence:[{boat_number:1,course:1,role:'INSIDE_AXIS',reasons:['内側の評価']},
      {boat_number:3,course:3,role:'WIN_CANDIDATE',reasons:['外側の評価']},
      {boat_number:4,course:4,role:'WIN_CANDIDATE',reasons:['外側の評価']}],
  });
  row.decision.tickets=[...tickets];row.decision.odds={...odds};
  return row;
}

test('the saved 6–12 ticket order, role and reasons survive without research-ticket fallback or mutation',()=>{
  for(const count of [6,8,12]) {
    const row=forecast(count),before=structuredClone(row),view=finalSelectionView(row);
    assert.equal(view.available,true);assert.equal(view.count,count);
    assert.deepEqual(view.tickets,row.final_selection.tickets);
    assert.equal(view.ranked[0].reason,'保存した1着の根拠。保存した相手の根拠');
    assert.equal(view.roles[0].player_name,'保存選手');assert.equal(view.roles[0].label,'1着の軸');
    assert.deepEqual(row,before);
  }
  const old=forecast();delete old.final_selection;
  assert.equal(finalSelectionView(old).kind,'LEGACY');assert.deepEqual(finalSelectionView(old).tickets,[]);
});

test('policy2 shows all three saved heads with counts checked against the actual tickets and keeps original scores/odds',()=>{
  const row=balancedForecast(),before=structuredClone(row),view=finalSelectionView(row);
  assert.equal(view.available,true);assert.equal(view.head_balanced,true);assert.equal(view.rank_label,'選抜内の評価順');
  assert.equal(view.head_allocation_basis,'SAVED');assert.equal(view.head_allocation_status,'VALID');
  assert.deepEqual(view.head_allocations.map(item=>item.summary),['本線 1号艇頭 8点','対抗 3号艇頭 2点','対抗 4号艇頭 2点']);
  assert.equal(view.head_allocations.reduce((sum,item)=>sum+item.ticket_count,0),12);
  assert.deepEqual(view.ranked.map(item=>item.score),row.final_selection.ranked_tickets.map(item=>item.score));
  assert.deepEqual(view.ranked.map(item=>item.global_rank),[1,2,3,4,5,6,7,8,21,22,31,32]);
  assert.equal(view.coverage_count,4);assert.equal(view.roles[0].label,'本線の1着候補');assert.equal(view.roles[1].label,'対抗の1着候補');
  assert.ok(view.ranked.every(item=>item.label==='選抜内の評価順'));
  assert.equal(finalSelectionOdds(row,race,NOW).quotes['3-1-2'],28);assert.equal(finalSelectionOdds(row,race,NOW).composite,2.91);
  assert.equal(finalSelectionDecision(row,race,NOW).key,'BUY');assert.equal(finalSelectionResultView(row,settlement(row)).status,'SETTLED');
  assert.deepEqual(row,before);
});

test('the saved MAIN may be an outside boat; the UI does not promote boat one or reinterpret points as probabilities',()=>{
  const row=balancedForecast(),[inside,main,counter]=row.final_selection.head_allocations;
  Object.assign(inside,{kind:'COUNTER',first_score:62,score_gap:2});
  Object.assign(main,{kind:'MAIN',first_score:64,score_gap:0});
  Object.assign(counter,{first_score:60,score_gap:4});
  const view=finalSelectionView(row);
  assert.equal(view.head_allocation_status,'VALID');assert.equal(view.head_allocations[0].boat_number,3);
  assert.equal(view.head_allocations[0].summary,'本線 3号艇頭 2点');assert.equal(view.roles[0].label,'対抗の1着候補');
  assert.equal(view.roles[1].label,'本線の1着候補');assert.equal(view.head_allocations[0].first_score,64);
  assert.equal(view.head_allocations[0].score_gap,0);assert.equal(view.plan.probability_calibrated,false);
  assert.ok(view.head_allocations.every(item=>!item.summary.includes('%')));
});

test('inconsistent head metadata falls back to ticket-derived counts without invented MAIN, course, score or reason',()=>{
  const changes=[row=>{row.final_selection.head_allocations[0].ticket_count=9;},row=>{row.final_selection.head_allocations.pop();},
    row=>{row.final_selection.head_allocations[1].boat_number=1;},row=>{row.final_selection.head_allocations[1].kind='MAIN';},
    row=>{row.final_selection.head_allocations[1].kind='DARK_HORSE';},row=>{row.final_selection.head_allocations[0].course=null;},
    row=>{row.final_selection.head_allocations[0].first_score=null;},row=>{row.final_selection.head_allocations[1].score_gap=-1;},
    row=>{row.final_selection.head_allocations[1].score_gap=8;},row=>{row.final_selection.head_allocations[1].scenario_key='1_ESCAPE';},
    row=>{row.final_selection.head_allocations[1].best_global_rank=1;},row=>{row.final_selection.head_allocations[1].reason=null;},
    row=>{row.final_selection.head_allocations={};},row=>{row.final_selection.head_allocations=[null];}];
  for(const change of changes){
    const row=balancedForecast();change(row);const before=structuredClone(row),view=finalSelectionView(row);
    assert.equal(view.available,true);assert.equal(view.head_allocation_status,'INVALID');assert.equal(view.head_allocation_basis,'TICKETS');
    assert.deepEqual(view.head_allocations.map(item=>item.summary),['1号艇頭 8点','3号艇頭 2点','4号艇頭 2点']);
    assert.ok(view.head_allocations.every(item=>item.kind===null&&item.reason===null&&item.course===null&&item.first_score===null));
    assert.equal(view.roles[0].label,'内側の1着候補');assert.equal(finalSelectionDecision(row,race,NOW).key,'BUY');
    assert.deepEqual(row,before);
  }
});

test('old plans retain their rank labels, saved decisions and settlements while missing optional metadata has a neutral fallback',()=>{
  const old=forecast(),before=structuredClone(old),view=finalSelectionView(old);
  assert.equal(view.head_balanced,false);assert.equal(view.rank_label,'推定順位');assert.equal(view.head_allocation_status,'MISSING');
  assert.deepEqual(view.head_allocations.map(item=>item.summary),['1号艇頭 8点']);assert.equal(view.head_allocations[0].kind,null);
  assert.equal(view.coverage_count,null);assert.equal(view.roles[0].label,'1着の軸');
  assert.equal(finalSelectionDecision(old,race,NOW).key,'BUY');assert.equal(finalSelectionResultView(old,settlement(old)).status,'SETTLED');
  assert.deepEqual(old,before);
  const current=balancedForecast();delete current.final_selection.head_allocations;
  const currentView=finalSelectionView(current);assert.equal(currentView.head_allocation_status,'MISSING');
  assert.equal(currentView.head_allocations.length,3);assert.equal(currentView.rank_label,'選抜内の評価順');
});

test('optional ranking metadata cannot invent coverage or reuse an invalid global rank',()=>{
  const row=balancedForecast();row.final_selection.ranked_tickets[8].selection_basis='UNKNOWN';
  assert.equal(finalSelectionView(row).coverage_count,null);
  row.final_selection.ranked_tickets[8].global_rank=1;
  const view=finalSelectionView(row);assert.equal(view.available,true);
  assert.ok(view.ranked.every(item=>item.global_rank===null));assert.equal(view.head_allocation_status,'INVALID');
  assert.deepEqual(view.tickets,row.final_selection.tickets);
});

test('the actual policy2 engine output renders all saved head allocations without rewriting its source scores',()=>{
  const boats=[75,35,80,70,25,20].map((score,index)=>({boat_number:index+1,score,base_score:score,
    active:true,expected_course:index+1,observed_course:index+1}));
  const scenarios=boats.map((row,index)=>({key:`${row.boat_number}_${index===0?'ESCAPE':'MAKURI'}`,
    leader:row.boat_number,method:index===0?'ESCAPE':'MAKURI',score:[80,30,78,74,25,20][index],beneficiaries:[]}));
  const selection=buildFinalTicketSelection({boats,scenarios,venueEvidence:{status:'UNAVAILABLE'},stage:'FINAL',exhibitionComplete:true});
  const row={...forecast(),boats,final_selection:selection},before=structuredClone(row),view=finalSelectionView(row);
  assert.equal(view.available,true);assert.equal(view.head_allocation_status,'VALID');assert.equal(view.head_allocations.length,3);
  assert.equal(view.coverage_count,selection.ranked_tickets.filter(ticket=>ticket.selection_basis==='HEAD_COVERAGE').length);
  for(const allocation of view.head_allocations){
    assert.equal(allocation.ticket_count,selection.tickets.filter(ticket=>ticket.startsWith(`${allocation.boat_number}-`)).length);
    assert.ok(allocation.ticket_count>=2);
  }
  assert.deepEqual(view.ranked.map(ticket=>[ticket.ticket,ticket.score,ticket.global_rank]),
    selection.ranked_tickets.map(ticket=>[ticket.ticket,ticket.score,ticket.global_rank]));
  assert.deepEqual(row,before);
});

test('invalid counts, duplicate combinations, missing or inconsistent ranks never become a final plan',()=>{
  const changes=[row=>{row.final_selection.tickets.pop();}, row=>{row.final_selection.ticket_count=13;},
    row=>{row.final_selection.tickets[1]=row.final_selection.tickets[0];},row=>{row.final_selection.tickets[0]='1-1-2';},
    row=>{row.final_selection.ranked_tickets[0].rank=2;},row=>{row.final_selection.ranked_tickets[0].ticket='6-5-4';},
    row=>{row.final_selection.ranked_tickets[0].score=null;},row=>{row.final_selection.ranked_tickets[0]=null;},row=>{row.final_selection.probability_calibrated=true;},
    row=>{row.final_selection.stage='PRE';},row=>{row.final_selection.status='READY';}];
  for(const change of changes){const row=forecast();change(row);assert.equal(finalSelectionView(row).kind,'INVALID');}
  assert.equal(finalSelectionView(forecast(5)).kind,'INVALID');
  const waiting=forecast();Object.assign(waiting.final_selection,{status:'WAIT',tickets:[],ticket_count:0,ranked_tickets:[]});
  assert.equal(finalSelectionView(waiting).kind,'WAIT');
  waiting.final_selection.status='REPLAY';waiting.record_mode='REPLAY';
  assert.equal(finalSelectionView(waiting).kind,'REPLAY');
  assert.equal(finalSelectionResultView(waiting).status,'NOT_RECORDED');
});

test('final quote display uses only the saved snapshot and composite, including historical display',()=>{
  const row=forecast(),before=structuredClone(row);
  row.final_selection.composite_odds=2.123;
  row.display_odds={odds_map:{'1-2-3':999},captured_at:'2026-11-26T04:07:29Z'};
  const view=finalSelectionOdds(row,race,NOW);
  assert.equal(view.saved,true);assert.equal(view.quotes['1-2-3'],20);
  assert.equal(view.composite,2.123);assert.equal(view.snapshotId,'odds-original');
  assert.equal(view.capturedAt,before.final_selection.odds_captured_at);
  const later=finalSelectionOdds(row,{...race,status:'finished'},Date.parse('2026-11-26T04:15:00Z'));
  assert.equal(later.historical,true);assert.equal(later.composite,2.123);assert.equal(later.stale,true);
  assert.deepEqual(row.final_selection.ranked_tickets,before.final_selection.ranked_tickets);
});

test('missing quotes stay missing and mismatched/future/blocked quote snapshots are unavailable',()=>{
  const row=forecast();row.final_selection.odds['1-2-3']=null;
  const partial=finalSelectionOdds(row,race,NOW);
  assert.equal(partial.status,'PARTIAL');assert.equal(partial.available,7);assert.equal(partial.composite,null);
  assert.equal(partial.quotes['1-2-3'],undefined);
  for(const change of [r=>r.race_id='other',r=>r.race_key='other',r=>r.final_selection.odds_captured_at='2026-11-26T04:07:31Z']){
    const bad=forecast();change(bad);assert.equal(finalSelectionOdds(bad,race,NOW).status,'INVALID');
  }
  assert.equal(finalSelectionOdds(forecast(),race,NOW,true).status,'UNAVAILABLE');
});

test('BUY means the same saved tickets and odds are current, with the 60-second cutoff retained',()=>{
  assert.equal(finalSelectionDecision(forecast(),race,NOW).key,'BUY');
  for(const change of [r=>r.decision.tickets.reverse(),r=>r.decision.odds_snapshot_id='other',r=>r.decision.price_checked=false,
    r=>r.final_selection.price_checked=false,r=>r.final_selection.valid_until='2026-11-26T04:07:30Z',
    r=>r.decision.valid_until='2026-11-26T04:07:30Z',r=>r.final_selection.odds['1-2-3']=null,
    r=>r.created_date=null,r=>r.created_date='2026-11-26T04:07:07Z',r=>r.generated_at='2026-11-26T04:07:31Z',
    r=>r.record_mode='UNKNOWN',r=>r.final_selection.composite_odds=1]){
    const row=forecast();change(row);assert.equal(finalSelectionDecision(row,race,NOW).key,'STALE');
  }
  const stale=forecast();stale.final_selection.odds_captured_at=stale.decision.odds_captured_at='2026-11-26T04:02:30Z';
  assert.equal(finalSelectionDecision(stale,race,NOW).key,'STALE');
  assert.equal(finalSelectionDecision(forecast(),race,Date.parse('2026-11-26T04:09:59Z')).key,'BUY');
  assert.equal(finalSelectionDecision(forecast(),race,Date.parse('2026-11-26T04:10:00Z')).key,'CLOSED');
  for(const current of [{...race,id:'other'},{...race,deadline:null},{...race,deadline:'2026-11-26T04:12:00Z'}])assert.equal(finalSelectionDecision(forecast(),current,NOW).key,'WAIT');
});

test('PRE, replay, partial inputs, server hold, cancelled and blocked views cannot show an active BUY',()=>{
  const pre=forecast();pre.stage=pre.final_selection.stage='PRE';
  assert.equal(finalSelectionDecision(pre,race,NOW).key,'PRE');
  assert.equal(finalSelectionDecision({...forecast(),record_mode:'REPLAY'},race,NOW).key,'REPLAY');
  assert.equal(finalSelectionDecision({...forecast(),exhibition_complete:false},race,NOW).key,'WAIT');
  assert.equal(finalSelectionDecision({...forecast(),quality:'PARTIAL'},race,NOW).key,'WAIT');
  assert.equal(finalSelectionDecision({...forecast(),effective_status:'WAIT'},race,NOW).key,'STALE');
  assert.equal(finalSelectionDecision(forecast(),{...race,status:'cancelled'},NOW).key,'CANCELLED');
  assert.equal(finalSelectionDecision(forecast(),race,NOW,{blocked:true}).key,'WAIT');
});

test('settlement must reference the saved forecast and exact ticket order; missing, refunded and legacy remain separate',()=>{
  const row=forecast(12),outcome=settlement(row),view=finalSelectionResultView(row,outcome);
  assert.equal(view.status,'SETTLED');assert.equal(view.count,12);assert.equal(view.result.stake,1200);assert.equal(view.result.hit_rank,2);
  assert.equal(finalSelectionResultView(row).status,'PENDING');
  assert.equal(finalSelectionResultView(row,settlement(row,{status:'EXCLUDED_REFUND'})).status,'EXCLUDED_REFUND');
  assert.equal(finalSelectionResultView(row,settlement(row,{status:'RESULT_PENDING'})).status,'PENDING');
  for(const change of [r=>r.forecast_id='other',r=>r.final_selection_result.source_forecast_id='other',
    r=>r.final_selection_result.tickets.reverse(),r=>r.final_selection_result.ticket_count=8,
    r=>r.final_selection_result.stake=800,r=>r.final_selection_result.hit_rank=13,r=>r.final_selection_result.unit_stake=50]){
    const bad=settlement(row);change(bad);assert.equal(finalSelectionResultView(row,bad).status,'INVALID');
  }
  const old={...row,final_selection:undefined};assert.equal(finalSelectionResultView(old,outcome).status,'NOT_RECORDED');
});

test('candidate and first-BUY totals use different saved cohorts without treating old records or refunds as losses',()=>{
  const first=forecast(6),latest=forecast(12);latest.id='latest';latest.decision.status=latest.final_selection.status='WATCH';
  const pending=forecast();pending.id='pending';
  const refund=forecast();refund.id='refunded';
  const old=forecast();old.id='old';delete old.final_selection;
  const waiting=forecast();waiting.id='waiting';Object.assign(waiting.final_selection,{status:'WAIT',tickets:[],ticket_count:0,ranked_tickets:[]});
  const replay={...forecast(),id:'replay',record_mode:'REPLAY'};
  const settlements=new Map([[first.id,settlement(first)],[latest.id,settlement(latest,{hit:false,buy:false})],[refund.id,settlement(refund,{status:'EXCLUDED_REFUND'})]]);
  const candidates=finalSelectionStats([latest,pending,refund,old,waiting,replay,latest],settlements);
  assert.deepEqual({n:candidates.n,hits:candidates.hits,stake:candidates.stake,returns:candidates.returns},{n:1,hits:0,stake:1200,returns:0});
  assert.equal(candidates.saved,3);assert.equal(candidates.pending,1);assert.equal(candidates.excluded,1);assert.equal(candidates.legacy,1);assert.equal(candidates.unselected,1);
  const selected=finalSelectionStats([first,replay,latest],settlements,{buyOnly:true});
  assert.equal(selected.n,1);assert.equal(selected.hits,1);assert.equal(selected.stake,600);assert.equal(selected.returns,2800);
});

test('the Verification integration uses server first-BUY rows, not latest WATCH or research results',()=>{
  const source=readFileSync(new URL('../src/components/liveV8/V8Verification.jsx',import.meta.url),'utf8');
  const body=source.split('const summary=useMemo(()=>{')[1].split('},[data,venue]);')[0];
  const clientSource=readFileSync(new URL('../src/components/liveV8/v8Client.js',import.meta.url),'utf8');
  const client=new Function('isReplay',clientSource.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn {latestRows,timeMs};')(study.isReplay);
  const helpers={...study,...client,finalSelectionStats,stats:study.studyStats,settlementIndex:()=>new Map()};
  const summarize=new Function('data','venue',...Object.keys(helpers),body);
  const first=forecast(6),latest=forecast(12);latest.id='latest';latest.generated_at='2026-11-26T04:08:08Z';
  latest.decision.status=latest.final_selection.status='WATCH';
  const data={races:[race],forecasts:[latest],buy_forecasts:[first],verifications:[settlement(latest,{hit:false,buy:false})],buy_verifications:[settlement(first)]};
  const summary=summarize(data,'ALL',...Object.values(helpers));
  assert.equal(summary.finalStats.n,1);assert.equal(summary.finalStats.hits,0);assert.equal(summary.finalStats.stake,1200);
  assert.equal(summary.buyStats.n,1);assert.equal(summary.buyStats.hits,1);assert.equal(summary.buyStats.stake,600);
  assert.equal(summary.liveFinal.metrics.n,0);
});

test('a latest FINAL that is also the first BUY is counted once when both response lists contain the same receipt',()=>{
  const source=readFileSync(new URL('../src/components/liveV8/V8Verification.jsx',import.meta.url),'utf8');
  const body=source.split('const summary=useMemo(()=>{')[1].split('},[data,venue]);')[0];
  const clientSource=readFileSync(new URL('../src/components/liveV8/v8Client.js',import.meta.url),'utf8');
  const client=new Function('isReplay',clientSource.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn {latestRows,timeMs};')(study.isReplay);
  const helpers={...study,...client,finalSelectionStats,stats:study.studyStats,settlementIndex:()=>new Map()};
  const summarize=new Function('data','venue',...Object.keys(helpers),body);
  const selected=forecast(6),receipt={id:'receipt-1',...settlement(selected)};
  const data={races:[race],forecasts:[selected],buy_forecasts:[selected],verifications:[receipt],buy_verifications:[structuredClone(receipt)]};
  const summary=summarize(data,'ALL',...Object.values(helpers));
  assert.equal(summary.finalStats.n,1);assert.equal(summary.buyStats.n,1);assert.equal(summary.buyStats.pending,0);
  assert.equal(summary.buyStats.stake,600);assert.equal(summary.buyStats.returns,2800);
  data.buy_verifications=[{...receipt,id:'receipt-2'}];
  const conflict=summarize(data,'ALL',...Object.values(helpers));
  assert.equal(conflict.buyStats.n,0);assert.equal(conflict.buyStats.pending,1);assert.equal(conflict.finalStats.n,1);
});
