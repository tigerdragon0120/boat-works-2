import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {finalSelectionView, finalSelectionOdds, finalSelectionDecision, finalSelectionResultView, finalSelectionStats} from '../src/components/liveV8/v8FinalTicketsView.js';
import * as study from '../src/components/liveV8/v8StudyView.js';

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
