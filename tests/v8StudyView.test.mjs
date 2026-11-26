import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStudyRows,latestStudyStage,isReplay,studyStageLabel,studySettlementIndex,studyStats,studyPairs} from '../src/components/liveV8/v8StudyView.js';

const race={id:'r1',race_key:'2026-11-22_24_10',race_date:'2026-11-22',venue_code:'24'};
const forecast=(id,stage,mode='LIVE',time='2026-11-22T10:00:00Z')=>({id,race_id:race.id,race_key:race.race_key,stage,record_mode:mode,generated_at:time,...(stage==='FINAL'?{exhibition_complete:true,research_tickets:['1-2-3']}:{} )});
const settled=(id,hit,mode='FORECAST')=>({forecast_id:id,source_kind:mode,status:'SETTLED',research_hit:hit,research_stake:800,research_return:hit?2100:0,research_tickets:['1-2-3','1-3-2','1-2-4','1-4-2','1-2-5','1-5-2','1-2-6','1-6-2']});

test('newer replay cannot replace an existing saved-in-time stage',()=>{
 const pre=forecast('lp','PRE'),final=forecast('lf','FINAL');
 const rows=buildStudyRows({races:[race],forecasts:[pre,final],replay_forecasts:[forecast('rp','PRE','REPLAY','2026-11-22T12:00:00Z'),forecast('rf','FINAL','REPLAY','2026-11-22T12:00:00Z')]});
 assert.equal(rows[0].pre.id,'lp'); assert.equal(rows[0].final.id,'lf');
});
test('missing final is filled by research record with its own settlement',()=>{
 const rp=forecast('rp','PRE','REPLAY'),rf={...forecast('rf','FINAL','REPLAY'),comparison:{baseline_id:'rp'}};
 const rows=buildStudyRows({races:[race],replay_forecasts:[rp,rf],replay_verifications:[settled('rp',false,'REPLAY'),settled('rf',true,'REPLAY')]});
 assert.equal(rows[0].pre.id,'rp');assert.equal(rows[0].final.id,'rf');assert.equal(rows[0].finalResult.research_hit,true);
 assert.equal(studyPairs(rows,'LIVE').count,0); assert.equal(studyPairs(rows,'REPLAY').improved,1);
});
test('races with missing forecasts remain in the denominator and have no fabricated result',()=>{
 const rows=buildStudyRows({races:[race,{id:'r2',race_key:'other'}],forecasts:[forecast('lp','PRE')]});
 assert.equal(rows.length,2);assert.equal(rows[1].pre,null);assert.equal(rows[1].finalResult,null);
});
test('cross-race baseline cannot be linked into a study pair',()=>{
 const other={...forecast('other','PRE'),race_id:'other-race',race_key:'other-key'};
 const own=forecast('own','PRE'),final={...forecast('lf','FINAL'),comparison:{baseline_id:other.id}};
 const rows=buildStudyRows({races:[race],forecasts:[own,final,other]});
 assert.equal(rows.find(row=>row.race.id===race.id).pre.id,'own');
});
test('duplicate settlement records are withheld instead of selecting a favorable outcome',()=>{
 const index=studySettlementIndex([settled('f',true),settled('f',false)]);
 assert.equal(index.has('f'),false);
});
test('the same saved verification in latest and first-BUY lists is counted once, independently of object key order',()=>{
 const receipt={id:'verified-1',...settled('f',true),final_selection_result:{status:'SETTLED',tickets:['1-2-3'],stake:100,return:2100,hit:true}};
 const copy=Object.fromEntries(Object.entries(structuredClone(receipt)).reverse());
 copy.final_selection_result=Object.fromEntries(Object.entries(copy.final_selection_result).reverse());
 const before=structuredClone([receipt,copy]),index=studySettlementIndex([receipt,copy]);
 assert.equal(index.size,1);assert.equal(index.get('f'),receipt);
 const metrics=studyStats([...index.values()]);assert.equal(metrics.n,1);assert.equal(metrics.stake,800);assert.equal(metrics.returns,2100);
 assert.deepEqual([receipt,copy],before);
});
test('different verification IDs remain ambiguous even when their outcomes match',()=>{
 const receipt=settled('f',true);
 assert.equal(studySettlementIndex([{...receipt,id:'a'},{...receipt,id:'b'}]).has('f'),false);
 assert.equal(studySettlementIndex([receipt,structuredClone(receipt)]).has('f'),false);
});
test('conflicting content for the same physical ID stays on hold, including nested final-selection returns',()=>{
 const receipt={id:'verified-1',...settled('f',true),final_selection_result:{status:'SETTLED',tickets:['1-2-3'],stake:100,return:2100,hit:true}};
 for(const changed of [{...receipt,research_return:4200},{...receipt,status:'EXCLUDED_REFUND'},
  {...receipt,final_selection_result:{...receipt.final_selection_result,return:4200}}]) {
  assert.equal(studySettlementIndex([receipt,changed]).has('f'),false);
 }
});
test('reusing one physical ID across two forecasts withholds both while unrelated valid receipts remain usable',()=>{
 const first={id:'reused',...settled('f',true)},second={id:'reused',...settled('g',false)},other={id:'other',...settled('h',true)};
 const index=studySettlementIndex([first,second,other,structuredClone(first)]);
 assert.equal(index.has('f'),false);assert.equal(index.has('g'),false);assert.equal(index.get('h'),other);
});
test('partial and unmatched records do not inflate hit rates',()=>{
 const metric=studyStats([settled('f',true),settled('g',false),{...settled('h',true),status:'PENDING'}]);
 assert.deepEqual({n:metric.n,hits:metric.hits,stake:metric.stake,returns:metric.returns},{n:2,hits:1,stake:1600,returns:2100});
});
test('mixed-time pairs are counted only in the research cohort',()=>{
 const row={pre:forecast('p','PRE'),final:forecast('f','FINAL','REPLAY'),preResult:settled('p',true),finalResult:settled('f',false,'REPLAY')};
 assert.equal(studyPairs([row],'LIVE').count,0);assert.equal(studyPairs([row],'REPLAY').worsened,1);
});
test('different staking or ticket counts cannot imply an exhibition improvement',()=>{
 const row={pre:forecast('p','PRE'),final:forecast('f','FINAL','REPLAY'),preResult:settled('p',false),finalResult:{...settled('f',true,'REPLAY'),research_stake:1600}};
 assert.equal(studyPairs([row],'REPLAY').count,0);assert.equal(studyPairs([row],'REPLAY').excluded_points,1);
});
test('a reconstructed PRE is labelled without claiming it was generated before exhibition',()=>{
 assert.equal(studyStageLabel(forecast('p','PRE','REPLAY')),'展示を使わない予想');assert.equal(isReplay(forecast('f','FINAL')),false);
});
test('refund receipts complete the pipeline but never count as losses or recovery-rate observations',()=>{
 const pre=forecast('p','PRE','REPLAY'),final=forecast('f','FINAL','REPLAY');
 const receipts=[{...settled('p',false,'REPLAY'),status:'EXCLUDED_REFUND'},{...settled('f',false,'REPLAY'),status:'EXCLUDED_REFUND'}];
 const [row]=buildStudyRows({races:[race],replay_forecasts:[pre,final],replay_verifications:receipts});
 assert.equal(row.preResult.status,'EXCLUDED_REFUND');assert.equal(row.finalResult.status,'EXCLUDED_REFUND');
 assert.equal(studyStats(receipts).n,0);assert.equal(studyPairs([row],'REPLAY').count,0);
});

// A partial server snapshot must not suppress a completed study record.
test('incomplete LIVE final falls back to the completed REPLAY final',()=>{
 const partial={...forecast('live-partial','FINAL'),exhibition_complete:false};
 const replay=forecast('replay-complete','FINAL','REPLAY');
 const data={races:[race],forecasts:[partial],replay_forecasts:[replay],replay_verifications:[settled(replay.id,true,'REPLAY')]};
 const [row]=buildStudyRows(data);
 assert.equal(row.final.id,replay.id);assert.equal(row.finalResult.research_hit,true);
 assert.equal(data.forecasts[0].id,partial.id);assert.equal(data.forecasts.length,1);
});
test('a newer partial LIVE version cannot hide an older completed LIVE version',()=>{
 const complete=forecast('live-complete','FINAL','LIVE','2026-11-22T09:00:00Z');
 const partial={...forecast('live-partial','FINAL','LIVE','2026-11-22T11:00:00Z'),exhibition_complete:false};
 const replay=forecast('replay-complete','FINAL','REPLAY','2026-11-22T12:00:00Z');
 assert.equal(latestStudyStage([complete,partial],'FINAL').id,complete.id);
 const [row]=buildStudyRows({races:[race],forecasts:[complete,partial],replay_forecasts:[replay]});
 assert.equal(row.final.id,complete.id);
});
test('an empty ticket set is incomplete even when exhibition is marked ready',()=>{
 const empty={...forecast('live-empty','FINAL'),research_tickets:[]};
 const replay=forecast('replay-complete','FINAL','REPLAY');
 const [row]=buildStudyRows({races:[race],forecasts:[empty],replay_forecasts:[replay]});
 assert.equal(row.final.id,replay.id);
});
test('partial records in both cohorts remain pending without destroying raw history',()=>{
 const live={...forecast('live-partial','FINAL'),exhibition_complete:false};
 const replay={...forecast('replay-partial','FINAL','REPLAY'),research_tickets:[]};
 const pre=forecast('pre','PRE');
 const data={races:[race],forecasts:[pre,live],replay_forecasts:[replay]};
 const [row]=buildStudyRows(data);
 assert.equal(row.final,null);assert.equal(row.pre.id,pre.id);
 assert.deepEqual(data.forecasts.map(item=>item.id),['pre','live-partial']);
 assert.equal(data.replay_forecasts.length,1);
});
