import test from 'node:test';
import assert from 'node:assert/strict';
import {racerDataHash,assembleRacerDataset,loadLatestRacerDataset,nextRacerCheck} from '../base44/shared/latestRacerStore.js';
import {runLatestRacerSync} from '../base44/shared/latestRacerSync.js';

const copy=value=>JSON.parse(JSON.stringify(value));
function fakeDatabase(){
  const data={},writes=[];let id=0,failPage=null;
  const entities=new Proxy({}, {get(_,name){return {
    filter:async query=>({items:copy((data[name]||[]).filter(r=>Object.entries(query).every(([key,value])=>r[key]===value))),has_more:false,next_cursor:null}),
    create:async doc=>{if(name==='RacerStatsPage'&&doc.page_index===failPage)throw new Error('temporary page write failure');const row={...copy(doc),id:String(++id).padStart(6,'0'),created_date:new Date().toISOString()};(data[name]||=[]).push(row);writes.push([name,'create',copy(row)]);return copy(row);},
    update:async(rowId,patch)=>{const row=(data[name]||[]).find(x=>x.id===rowId);assert.ok(row);Object.assign(row,copy(patch));writes.push([name,'update',copy(patch)]);return copy(row);},
  };}});
  return {client:{asServiceRole:{entities}},data,writes,failPage(value){failPage=value;}};
}
function samplePayload(count=103,checksum='a'.repeat(64)){
  const records=Array.from({length:count},(_,i)=>({registration_number:String(3000+i),racer_name:'選手'+i,term_year:2026,term_half:'SECOND',term_key:'2026_SECOND',term_start_date:'2025-11-01',term_end_date:'2026-04-30',course_stats:{'1':{entries:20,first_count:8,second_count:5,third_count:3}}}));
  return {source:{term_key:'2026_SECOND',url:'https://www.boatrace.jp/static_extra/pc_static/download/data/kibetsu/fan2604.lzh',index_url:'https://www.boatrace.jp/owpc/pc/extra/data/download.html',file_name:'fan2604.lzh'},checksum,fetched_at:new Date().toISOString(),records,record_count:count,term_start_date:'2025-11-01',term_end_date:'2026-04-30'};
}

test('JST scheduled times advance through all three daily checks and midnight',()=>{
  assert.equal(nextRacerCheck(Date.parse('2026-11-22T06:19:00+09:00')),'2026-11-21T21:20:00.000Z');
  assert.equal(nextRacerCheck(Date.parse('2026-11-22T06:20:00+09:00')),'2026-11-22T03:20:00.000Z');
  assert.equal(nextRacerCheck(Date.parse('2026-11-22T12:20:00+09:00')),'2026-11-22T09:20:00.000Z');
  assert.equal(nextRacerCheck(Date.parse('2026-11-22T23:59:00+09:00')),'2026-11-22T21:20:00.000Z');
});
test('complete read-back and checksum validation precede the single active pointer update',async()=>{
  const db=fakeDatabase(),payload=samplePayload();
  const result=await runLatestRacerSync(db.client,{scheduled:true,fetchDataset:async()=>payload});
  assert.equal(result.ok,true);assert.equal(result.complete,true);assert.equal(result.latest_racer_sync.record_count,103);
  assert.equal(db.data.RacerStatsPage.length,2);
  const activate=db.writes.findIndex(([name,op,doc])=>name==='RacerStatsSync'&&op==='update'&&doc.active_dataset_key);
  const ready=db.writes.findIndex(([name,op,doc])=>name==='RacerStatsDataset'&&op==='update'&&doc.status==='ready');
  assert.ok(activate>ready);
  const loaded=await loadLatestRacerDataset(db.client.asServiceRole.entities);
  assert.equal(loaded.records.length,103);assert.ok(loaded.metadata.activated_at>=loaded.metadata.first_seen_at);
  assert.equal(loaded.records[102].registration_number,'3102');
});
test('failed partial import keeps the previous active dataset and resumes saved pages exactly once',async()=>{
  const db=fakeDatabase(),old=samplePayload(5,'b'.repeat(64)),fresh=samplePayload(103,'c'.repeat(64));
  assert.equal((await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>old})).ok,true);
  const oldKey=db.data.RacerStatsSync[0].active_dataset_key;
  db.failPage(1);
  const failed=await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>fresh});
  assert.equal(failed.ok,false);assert.equal(db.data.RacerStatsSync[0].active_dataset_key,oldKey);
  assert.equal((await loadLatestRacerDataset(db.client.asServiceRole.entities)).records.length,5);
  db.failPage(null);
  const retry=await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>fresh});
  assert.equal(retry.complete,true);
  const newPages=db.data.RacerStatsPage.filter(r=>r.dataset_key.endsWith('c'.repeat(64)));
  assert.equal(newPages.length,2);assert.equal(new Set(newPages.map(r=>r.page_index)).size,2);
  assert.notEqual(db.data.RacerStatsSync[0].active_dataset_key,oldKey);
});
test('unchanged published content writes no racer page or manifest and keeps first availability',async()=>{
  const db=fakeDatabase(),payload=samplePayload(3,'d'.repeat(64));
  await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>payload});
  const before={pages:db.data.RacerStatsPage.length,datasets:db.data.RacerStatsDataset.length,metadata:copy(db.data.RacerStatsSync[0].active_metadata)};
  const result=await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>({...payload,fetched_at:new Date(Date.now()+1000).toISOString()})});
  assert.equal(result.unchanged,true);assert.equal(db.data.RacerStatsPage.length,before.pages);assert.equal(db.data.RacerStatsDataset.length,before.datasets);
  assert.deepEqual(db.data.RacerStatsSync[0].active_metadata,before.metadata);
});
test('read failure never becomes an empty ledger that creates a new state or dataset',async()=>{
  let fetched=false;
  const db=fakeDatabase();
  const client={asServiceRole:{entities:{ProcessLock:{filter:async()=>{throw new Error('permission denied');}}}}};
  const result=await runLatestRacerSync(client,{fetchDataset:async()=>{fetched=true;return samplePayload();}});
  assert.equal(result.ok,false);assert.equal(fetched,false);assert.equal(db.writes.length,0);
});
test('missing, corrupt, duplicate-racer and inconsistent period pages cannot become ready',async()=>{
  const records=samplePayload(2).records,hash=await racerDataHash(records);
  const manifest={dataset_key:'test',record_count:2,page_count:1,records_hash:hash,term_key:'2026_SECOND',term_start_date:'2025-11-01',term_end_date:'2026-04-30'};
  const page={dataset_key:'test',page_index:0,record_count:2,records,content_hash:hash};
  await assert.rejects(assembleRacerDataset(manifest,[]),/INCOMPLETE/);
  await assert.rejects(assembleRacerDataset(manifest,[{...page,records:[{...records[0],racer_name:'changed'},records[1]]}]),/HASH_MISMATCH/);
  const repeated=[records[0],records[0]];
  await assert.rejects(assembleRacerDataset(manifest,[{...page,records:repeated,content_hash:await racerDataHash(repeated)}]),/COUNT_MISMATCH/);
  const shifted=[records[0],{...records[1],term_key:'2027_FIRST'}];
  await assert.rejects(assembleRacerDataset(manifest,[{...page,records:shifted,content_hash:await racerDataHash(shifted)}]),/PERIOD_MISMATCH/);
  assert.deepEqual(await assembleRacerDataset(manifest,[page,{...page,id:'second'}]),records);
});
test('a regressing official index cannot replace an already newer active period',async()=>{
  const db=fakeDatabase(),payload=samplePayload(2,'e'.repeat(64));
  await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>payload});
  const prior=db.data.RacerStatsSync[0].active_dataset_key;
  const result=await runLatestRacerSync(db.client,{force:true,fetchDataset:async()=>({...payload,source:{...payload.source,term_key:'2025_SECOND'}})});
  assert.equal(result.ok,false);assert.equal(db.data.RacerStatsSync[0].active_dataset_key,prior);
});
