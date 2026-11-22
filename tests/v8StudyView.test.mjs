import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStudyRows,isReplay,studyStageLabel,studySettlementIndex,studyStats,studyPairs} from '../src/components/liveV8/v8StudyView.js';

const race={id:'r1',race_key:'2026-11-22_24_10',race_date:'2026-11-22',venue_code:'24'};
const forecast=(id,stage,mode='LIVE',time='2026-11-22T10:00:00Z')=>({id,race_id:race.id,race_key:race.race_key,stage,record_mode:mode,generated_at:time});
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
