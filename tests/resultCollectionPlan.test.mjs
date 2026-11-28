import test from 'node:test';
import assert from 'node:assert/strict';
import {planResultCollection,readResultCollectionPlan} from '../base44/shared/resultCollectionPlan.js';

const DATE='2026-11-28',NOW=Date.parse(DATE+'T06:46:00Z');
const race=(number=12,extra={})=>({id:`race-17-${number}`,race_key:`${DATE}_17_${String(number).padStart(2,'0')}`,
  race_date:DATE,venue_code:'17',venue_name:'宮島',race_number:number,deadline:DATE+'T15:28:00+09:00',
  status:'scheduled',updated_date:DATE+'T06:00:00Z',...extra});
const result=(row,extra={})=>({id:'result-'+row.id,race_id:row.id,race_key:row.race_key,source:'BOATCAST',
  result_trifecta:'1-2-3',payout:580,is_finished:true,result_status:'RESULT_FINAL',finished_at:DATE+'T06:39:51Z',...extra});
const plan=(races,results=[],now=NOW)=>planResultCollection(races,results,{raceDate:DATE,now});

test('only valid due races are offered for collection and the five-minute boundary is explicit',()=>{
  const due=race(1,{deadline:new Date(NOW-5*60000).toISOString()}),waiting=race(2,{deadline:new Date(NOW-5*60000+1).toISOString()}),
    future=race(3,{deadline:new Date(NOW+60000).toISOString()});
  const invalid=[null,'not-a-date',DATE,'2026-11-27T12:00:00+09:00'].map((deadline,i)=>race(i+4,{deadline}));
  const snapshot=[due,waiting,future,...invalid],before=structuredClone(snapshot),out=plan(snapshot);
  assert.deepEqual(out.candidates.map(row=>row.id),[due.id]);assert.equal(out.not_due,2);assert.equal(out.held.length,4);
  assert.ok(out.held.every(row=>row.reason==='RACE_DEADLINE_INVALID'));assert.deepEqual(snapshot,before);
});

test('explicit cancellations and postponements are excluded before result or clock handling',()=>{
  const rows=[race(1,{status:'cancelled'}),race(2,{schedule_status:'POSTPONED'}),race(3,{schedule_status:'CANCELLED',deadline:null})];
  const out=plan(rows,rows.map(row=>result(row)));assert.equal(out.cancelled,3);
  assert.equal(out.candidates.length,0);assert.equal(out.status_repairs.length,0);assert.equal(out.held.length,0);
});

test('a positive official final result separates completed skips from missing Race status repairs',()=>{
  const finished=race(1,{status:'finished'}),pending=race(2,{status:'final'}),rows=[finished,pending],results=rows.map(row=>result(row));
  const before=structuredClone({rows,results}),out=plan(rows,results);
  assert.equal(out.skipped,1);assert.equal(out.candidates.length,0);assert.equal(out.status_repairs.length,1);
  assert.equal(out.status_repairs[0].race.id,pending.id);assert.equal(out.status_repairs[0].result.id,results[1].id);
  assert.deepEqual({rows,results},before);
});

test('a future or invalid-clock race is not status-repaired from a contradictory stored result',()=>{
  const rows=[race(1,{deadline:new Date(NOW+60000).toISOString()}),race(2,{deadline:null})],out=plan(rows,rows.map(row=>result(row)));
  assert.equal(out.status_repairs.length,0);assert.equal(out.candidates.length,0);assert.equal(out.not_due,1);
  assert.equal(out.held[0].reason,'RACE_DEADLINE_INVALID');
});

test('RS1-only legacy FINAL rows with missing or invalid payout remain eligible without altering stored data',()=>{
  const payouts=[0,null,undefined,-1,NaN,Infinity,'',true],rows=payouts.map((_,i)=>race(i+1,{status:i%2?'finished':'scheduled'})),
    results=rows.map((row,i)=>result(row,{payout:payouts[i]})),before=structuredClone(results),out=plan(rows,results);
  assert.equal(out.candidates.length,payouts.length);assert.equal(out.skipped,0);assert.equal(out.status_repairs.length,0);
  assert.deepEqual(results,before);
});

test('a valid positive duplicate can complete the same official outcome without choosing a partial record',()=>{
  const row=race(),partial=result(row,{id:'partial',payout:0}),complete=result(row,{id:'complete',payout:580});
  const out=plan([row],[partial,complete]);assert.equal(out.candidates.length,0);assert.equal(out.status_repairs[0].result.id,'complete');
});

test('missing or partial results trigger collection even when an older process already set finished',()=>{
  const missing=race(1,{status:'finished'}),partial=race(2),out=plan([missing,partial],[result(partial,{is_finished:false,result_status:'RESULT_PARTIAL'})]);
  assert.equal(out.candidates.length,2);assert.equal(out.status_repairs.length,0);assert.equal(out.skipped,0);
});

test('an explicit PARTIAL record with a stale finished flag and positive payout is reacquired',()=>{
  const row=race(),out=plan([row],[result(row,{is_finished:true,result_status:'RESULT_PARTIAL',payout:580})]);
  assert.deepEqual(out.candidates.map(row=>row.id),[row.id]);assert.equal(out.status_repairs.length,0);assert.equal(out.skipped,0);
});

test('invalid, conflicting or misidentified official final rows are held instead of silently skipped',()=>{
  for(const kind of ['invalid_combo','unknown_source','conflict','wrong_key']){
    const row=race(),rows=[result(row)];
    if(kind==='invalid_combo')rows[0].result_trifecta='1-1-3';
    if(kind==='unknown_source')rows[0].source='BACKFILL';
    if(kind==='conflict')rows.push(result(row,{id:'another',result_trifecta:'3-1-2'}));
    if(kind==='wrong_key')rows[0].race_key=DATE+'_03_12';
    const out=plan([row],rows);assert.equal(out.held.length,1,kind);assert.equal(out.candidates.length,0,kind);
    assert.equal(out.status_repairs.length,0,kind);assert.equal(out.skipped,0,kind);
  }
});

test('duplicate and contradictory Race identities do not select a forecast-rich row arbitrarily',()=>{
  const row=race(),duplicate=race(12,{id:'other',has_final:true}),out=plan([row,duplicate]);
  assert.equal(out.candidates.length,0);assert.equal(out.held.length,2);assert.ok(out.held.every(row=>row.reason==='RACE_IDENTITY_AMBIGUOUS'));
  const wrong=race(2,{race_key:row.race_key}),conflicting=plan([row,wrong]);assert.equal(conflicting.candidates.length,0);
  assert.deepEqual(conflicting.held.map(row=>row.reason),['RACE_IDENTITY_AMBIGUOUS','RACE_IDENTITY_INVALID']);
});

test('recent due races lead most cycles while older missing results receive deterministic rotating turns',()=>{
  const start=NOW-NOW%(15*60000),rows=[race(1,{deadline:new Date(start-10*60000).toISOString()}),
    race(2,{deadline:new Date(start-20*60000).toISOString()}),race(3,{deadline:new Date(start-120*60000).toISOString()}),
    race(4,{deadline:new Date(start-130*60000).toISOString()})];
  const first=plan(rows,[],start),second=plan(rows,[],start+5*60000),backlog=plan(rows,[],start+10*60000),nextBacklog=plan(rows,[],start+25*60000);
  assert.equal(first.priority_mode,'RECENT_FIRST');assert.equal(second.priority_mode,'RECENT_FIRST');assert.equal(backlog.priority_mode,'BACKLOG_TURN');
  assert.equal(first.candidates[0].id,rows[0].id);assert.equal(second.candidates[0].id,rows[0].id);
  assert.notEqual(backlog.candidates[0].id,nextBacklog.candidates[0].id);
  assert.ok([rows[2].id,rows[3].id].includes(backlog.candidates[0].id));
  assert.deepEqual(plan(rows,[],start+10*60000).candidates.map(row=>row.id),backlog.candidates.map(row=>row.id));
});

function pagedFixture(t,{pageSize=200,brokenRace=false,brokenResults=false}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const codes=['01','02','03','06','07','08','13','14','15','17','18','20','23','24'];
  const races=codes.flatMap(code=>Array.from({length:12},(_,i)=>race(i+1,{id:`race-${code}-${i+1}`,
    race_key:`${DATE}_${code}_${String(i+1).padStart(2,'0')}`,venue_code:code,status:code==='17'&&i===11?'scheduled':'finished'})));
  const results=races.filter(row=>row.id!=='race-17-12').map(row=>result(row)),calls=[];
  const entity=(name,rows,broken)=>({filter:async(query,options)=>{
    calls.push({name,query,options});assert.equal(typeof options,'object');assert.equal(options.limit,200);assert.ok(Array.isArray(options.fields));
    const offset=options.cursor==null?0:Number(options.cursor),items=rows.slice(offset,offset+pageSize),has_more=offset+items.length<rows.length;
    return {items,has_more,next_cursor:has_more?(broken?null:String(offset+items.length)):null};
  }});
  return {races,results,calls,client:{asServiceRole:{entities:{Race:entity('Race',races,brokenRace),RaceResult:entity('RaceResult',results,brokenResults)}}}};
}

test('complete cursor reads reach Miyajima 12R beyond the first fifty rows',async t=>{
  for(const pageSize of [50,200])await t.test(String(pageSize),async child=>{
    const state=pagedFixture(child,{pageSize}),out=await readResultCollectionPlan(state.client,{raceDate:DATE,deadlineMs:NOW+15000,now:NOW});
    assert.equal(out.total,168);assert.equal(out.read_counts.races,168);assert.equal(out.read_counts.results,167);
    assert.deepEqual(out.candidates.map(row=>row.id),['race-17-12']);assert.equal(out.skipped,167);
    assert.equal(state.calls.length,pageSize===200?2:8);
    if(pageSize===50)assert.ok(state.calls.some(call=>call.options.cursor==='150'));
    assert.deepEqual(state.calls.find(call=>call.name==='Race').query,{race_date:DATE});
  });
});

test('an incomplete Race or result ledger throws rather than returning successful zero work',async t=>{
  for(const kind of ['races','results'])await t.test(kind,async child=>{
    const state=pagedFixture(child,{pageSize:50,brokenRace:kind==='races',brokenResults:kind==='results'});
    await assert.rejects(readResultCollectionPlan(state.client,{raceDate:DATE,deadlineMs:NOW+15000,now:NOW}),/INCOMPLETE_READ/);
    if(kind==='races')assert.equal(state.calls.some(call=>call.name==='RaceResult'),false);
  });
});

test('an unrelated result returned by a filtered read invalidates the result snapshot',()=>{
  assert.throws(()=>plan([race()],[result(race(),{race_id:'another-race'})]),/RESULT_COLLECTION_RESULT_IDENTITY_INVALID/);
});

test('a stalled first read obeys the caller budget and never starts result reads',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});let signalRead,resultsRead=false;
  const started=new Promise(resolve=>{signalRead=resolve;});
  const client={asServiceRole:{entities:{Race:{filter:async()=>{signalRead();return new Promise(()=>{});}},
    RaceResult:{filter:async()=>{resultsRead=true;return {items:[],has_more:false,next_cursor:null};}}}}};
  const pending=readResultCollectionPlan(client,{raceDate:DATE,deadlineMs:NOW+1000,now:NOW});await started;
  t.mock.timers.tick(1000);await assert.rejects(pending,/INCOMPLETE_READ/);assert.equal(resultsRead,false);
});
