import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeOfficialDeadlines,normalizeOfficialCardDeadlines,refreshOfficialDeadlines} from '../base44/shared/officialLiveDeadlines.js';
import {parseDeadlineTimes} from '../base44/shared/boatraceOfficialParser.js';

const DATE='2026-11-28';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/official-schedule-disruptions-20261128.json',import.meta.url),'utf8'));
const NOW=Date.parse(fixture.source.fetched_at);
const HTML=readFileSync(new URL('./fixtures/official-racelist-deadlines-20261128-03.html',import.meta.url),'utf8');
const CANCELLED=readFileSync(new URL('./fixtures/official-racelist-cancelled-20261128-15.html',import.meta.url),'utf8');
const POSTPONED=readFileSync(new URL('./fixtures/official-racelist-postponed-20261128-20.html',import.meta.url),'utf8');
const INDEX=readFileSync(new URL('./fixtures/official-race-index-20261128.html',import.meta.url),'utf8');
const key=(code,n)=>`${DATE}_${code}_${String(n).padStart(2,'0')}`;
const race=(code,n,extra={})=>({id:key(code,n),race_key:key(code,n),race_date:DATE,venue_code:code,race_number:n,
  deadline:DATE+'T13:00:00+09:00',status:'scheduled',updated_date:DATE+'T05:00:00Z',...extra});
const normalize=(payload=fixture.payload,source=fixture.source)=>normalizeOfficialDeadlines(payload,{date:DATE,source,now:NOW});
const card=(html,code)=>normalizeOfficialCardDeadlines(html,{date:DATE,venueCode:code,now:NOW,source:{provider:'BOATRACE',
  url:`https://boatrace.jp/owpc/pc/race/racelist?rno=1&jcd=${code}&hd=20261128`,http_status:200,
  fetched_at:fixture.source.fetched_at,race_date:DATE,venue_code:code,request_race_number:1}});

function setup(t,{rows,payload=fixture.payload,beforeWrite=()=>{},httpStatus=200,htmlFetcher}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const records=structuredClone(rows),writes=[];
  const matches=(row,query)=>Object.entries(query).every(([name,value])=>value&&typeof value==='object'
    ?value.$in?.includes(row[name]):row[name]===value);
  const Race={filter:async query=>({items:structuredClone(records.filter(row=>matches(row,query))),has_more:false,next_cursor:null}),
    updateMany:async(query,update)=>{writes.push({query,update});beforeWrite(records);const found=records.filter(row=>matches(row,query));
      for(const row of found)Object.assign(row,structuredClone(update.$set));return {updated:found.length};}};
  const run=()=>refreshOfficialDeadlines({asServiceRole:{entities:{Race}}},{date:DATE,deadlineMs:NOW+8000,
    fetcher:async()=>new Response(JSON.stringify(payload),{status:httpStatus}),htmlFetcher});
  return {records,writes,run};
}

test('the observed full day accepts ended venues and closing headers and identifies exactly 42 disrupted races',()=>{
  const result=normalize();assert.equal(result.ok,true);assert.equal(result.disruptions.size,42);
  for(const code of ['15','24'])for(let n=1;n<=12;n++)assert.equal(result.disruptions.get(key(code,n)).schedule_status,'CANCELLED');
  for(let n=1;n<=12;n++)assert.equal(result.disruptions.get(key('20',n)).schedule_status,'POSTPONED');
  for(let n=1;n<=12;n++)assert.equal(result.disruptions.has(key('18',n)),n>=7);
  assert.equal(result.disruptions.get(key('18',7)).reason,'途中中止');
  assert.equal(result.deadlines.get(key('03',11)).deadline,DATE+'T15:30:00+09:00');
  assert.equal(result.deadlines.has(key('02',11)),false); // Heading 締切, slot 15:22.
  assert.equal(result.deadlines.has(key('14',12)),false); // RecentRace 99, all 確定.
  assert.equal(result.disruptions.has(key('14',12)),false);
});

test('42 explicit disruptions are saved without modifying completed results, forecasts or race dates',async t=>{
  const normalized=normalize(),rows=[...normalized.disruptions.values()].map(item=>race(item.venue_code,item.race_number,
    {prediction:{kept:true},result:{kept:true}}));
  rows.push(race('18',6,{status:'finished',result:{trifecta:'1-2-3'}}),race('14',12),
    race('03',11,{status:'pre',deadline:DATE+'T15:38:00+09:00'}));
  const state=setup(t,{rows}),before=structuredClone(state.records),result=await state.run();
  assert.equal(result.ok,true);assert.equal(result.disruption_updated,42);assert.equal(result.deadline_updated,1);assert.equal(result.updated,43);
  for(let i=0;i<42;i++){
    const saved=state.records[i];assert.equal(saved.status,'cancelled');assert.equal(saved.race_date,DATE);
    assert.equal(saved.deadline,before[i].deadline);assert.deepEqual(saved.prediction,before[i].prediction);assert.deepEqual(saved.result,before[i].result);
    assert.equal(saved.schedule_source.provider,'BOATCAST');assert.equal(saved.schedule_source.url,fixture.source.url);
    assert.equal(saved.schedule_source.race_number,saved.race_number);assert.equal(saved.schedule_source.fetched_at,new Date(NOW).toISOString());
  }
  assert.deepEqual(state.records[42],before[42]);assert.deepEqual(state.records[43],before[43]);
  assert.equal(state.records[44].deadline,DATE+'T15:30:00+09:00');
  assert.deepEqual(Object.keys(state.writes[0].update.$set).sort(),['schedule_reason','schedule_source','schedule_status','status']);
  assert.equal(state.writes[0].query.updated_date,DATE+'T05:00:00Z');
  const writeCount=state.writes.length,again=await state.run();assert.equal(again.updated,0);assert.equal(state.writes.length,writeCount);
});

test('fresh explicit postponement refines legacy cancellation without reopening it',async t=>{
  for(const old of [{},{schedule_status:'CANCELLED',schedule_reason:'中止',schedule_source:{fetched_at:DATE+'T05:00:00Z'}}])await t.test(JSON.stringify(old),async child=>{
    const state=setup(child,{rows:[race('20',1,{status:'cancelled',...old})]}),result=await state.run();
    assert.equal(result.ok,true);assert.equal(result.disruption_updated,1);
    assert.equal(state.records[0].status,'cancelled');assert.equal(state.records[0].schedule_status,'POSTPONED');assert.equal(state.records[0].schedule_reason,'順延');
    assert.equal(state.writes[0].query.status,'cancelled');
    const again=await state.run();assert.equal(again.updated,0);assert.equal(state.writes.length,1);
  });
});

test('a cancellation write cannot overwrite concurrent completion or a newer schedule classification',async t=>{
  for(const kind of ['concurrent_finished','newer_source'])await t.test(kind,async child=>{
    const state=setup(child,{rows:[race('15',1,kind==='newer_source'?{schedule_source:{fetched_at:new Date(NOW+1000).toISOString()}}:{})],
      beforeWrite:records=>{if(kind==='concurrent_finished')records[0].status='finished';}}),result=await state.run();
    assert.equal(result.ok,false);assert.equal(result.updated,0);assert.equal(state.records[0].schedule_status,undefined);
    assert.equal(state.records[0].status,kind==='concurrent_finished'?'finished':'scheduled');
  });
});

test('an explicit cancellation can close a race with no deadline without inventing one',async t=>{
  const state=setup(t,{rows:[race('15',1,{deadline:null})]}),result=await state.run();
  assert.equal(result.ok,true);assert.equal(result.disruption_updated,1);assert.equal(state.records[0].deadline,null);
  assert.equal(state.writes[0].query.deadline,null);
});

test('the official index saves all 42 disruptions including the partial range when JSON and race cards fail',async t=>{
  const rows=[...normalize().disruptions.values()].map(item=>race(item.venue_code,item.race_number));
  rows.push(race('18',6,{status:'finished',result:{trifecta:'1-2-3'}}));
  const requests=[],state=setup(t,{rows,httpStatus:403,htmlFetcher:async url=>{
    requests.push(url);return new URL(url).pathname.endsWith('/index')?{ok:true,status:200,html:INDEX}:{ok:false,status:503,html:''};
  }}),result=await state.run();
  assert.equal(result.ok,false);assert.equal(result.reason,'SCHEDULE_CARD_HTTP_503');
  assert.equal(result.disruption_updated,42);assert.equal(result.updated,42);assert.equal(result.deadline_updated,0);
  assert.ok(requests.length<=8);assert.equal(requests.filter(url=>new URL(url).pathname.endsWith('/index')).length,1);
  const partial=state.records.find(row=>row.race_key===key('18',7));assert.equal(partial.schedule_reason,'7R以降中止');
  assert.equal(partial.schedule_source.url,'https://boatrace.jp/owpc/pc/race/index?hd=20261128');
  assert.equal(state.records.find(row=>row.race_key===key('20',1)).schedule_reason,'中止順延');
  assert.equal(state.records.at(-1).status,'finished');assert.deepEqual(state.records.at(-1).result,{trifecta:'1-2-3'});
});

test('conflicting explicit index and selected-day statuses do not mutate the disputed race',async t=>{
  const state=setup(t,{rows:[race('15',1)],httpStatus:403,htmlFetcher:async url=>({ok:true,status:200,
    html:new URL(url).pathname.endsWith('/index')?INDEX:POSTPONED.replaceAll('jcd=20','jcd=15')})});
  const before=structuredClone(state.records),result=await state.run();
  assert.equal(result.ok,false);assert.equal(result.reason,'SCHEDULE_DISRUPTION_CONFLICT');assert.equal(result.updated,0);
  assert.deepEqual(state.records,before);assert.equal(state.writes.length,0);
});

test('a stalled conditional write releases the schedule budget and never reports its late completion as confirmed',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  const record=race('15',1),writes=[];let finishWrite,signalWrite;
  const started=new Promise(resolve=>{signalWrite=resolve;});
  const Race={filter:async()=>({items:[structuredClone(record)],has_more:false,next_cursor:null}),
    updateMany:async(query,update)=>{writes.push({query,update});signalWrite();return new Promise(resolve=>{
      finishWrite=()=>{Object.assign(record,structuredClone(update.$set));resolve({updated:1});};
    });}};
  const client={asServiceRole:{entities:{Race}}},options={date:DATE,deadlineMs:NOW+8000,
    fetcher:async()=>new Response(JSON.stringify(fixture.payload),{status:200})};
  const pending=refreshOfficialDeadlines(client,options);await started;
  t.mock.timers.tick(7250);const result=await pending;
  assert.equal(result.ok,false);assert.equal(result.reason,'SCHEDULE_SAVE_TIMEOUT');assert.equal(result.updated,0);
  assert.equal(result.disruption_updated,0);assert.equal(record.status,'scheduled');assert.equal(writes.length,1);
  finishWrite();await Promise.resolve();assert.equal(record.status,'cancelled');assert.equal(result.updated,0);
  const reconciled=await refreshOfficialDeadlines(client,{...options,deadlineMs:Date.now()+8000});
  assert.equal(reconciled.ok,true);assert.equal(reconciled.updated,0);assert.equal(writes.length,1);
});

test('ended headers with live uncancelled clocks and unknown cancellation values are rejected',()=>{
  for(const kind of ['ended_live','unknown_cancel']){
    const payload=structuredClone(fixture.payload),row=payload.return_info.find(row=>row.RaceStudiumNo==='14');
    if(kind==='ended_live')row.DeadlineTimeAll[11]='18:00';else row.CancelStatusAll[11]='?';
    const result=normalize(payload);assert.equal(result.ok,false);assert.equal(result.deadlines.size,0);assert.equal(result.disruptions.size,0);
  }
});

test('official selected-day cancellation or postponement overrides retained numeric deadlines',()=>{
  for(const [html,code,status] of [[CANCELLED,'15','CANCELLED'],[POSTPONED,'20','POSTPONED']]){
    const result=card(html,code);assert.equal(result.ok,true);assert.equal(result.deadlines.size,0);assert.equal(result.disruptions.size,12);
    assert.equal(result.disruptions.get(key(code,12)).schedule_status,status);
  }
});

test('older postponed days and other-date active tabs cannot cancel the requested day',()=>{
  assert.match(CANCELLED,/11月24日[\s\S]*?順延/);
  const normal=CANCELLED.replace('11月28日<span>中止</span>','11月28日<span>５日目</span>');
  const result=card(normal,'15');assert.equal(result.ok,true);assert.equal(result.disruptions.size,0);
  const wrongDay=CANCELLED.replace('11月28日<span>中止</span>','11月27日<span>中止</span>');
  assert.equal(card(wrongDay,'15').reason,'SCHEDULE_CARD_IDENTITY_INVALID');
});

test('deadline parsing retains twelve numbered positions across closed, empty and duplicate-clock cells',()=>{
  const times=parseDeadlineTimes(HTML);assert.equal(times.length,12);assert.equal(times[1],'11:34');
  const changed=HTML.replace('<td>11:34</td>','<td>中止</td>').replace('<td>11:59</td>','<td></td>');
  const parsed=parseDeadlineTimes(changed);assert.equal(parsed.length,12);assert.equal(parsed[1],null);assert.equal(parsed[2],null);
  assert.equal(parsed[3],times[3]);assert.equal(parsed[11],times[11]);
  const duplicates=parseDeadlineTimes(HTML.replace('<td>11:34</td>','<td>11:07</td>'));
  assert.equal(duplicates.length,12);assert.equal(duplicates[0],duplicates[1]);assert.equal(duplicates[2],times[2]);
  assert.deepEqual(parseDeadlineTimes('<table><tr><td>締切予定時刻</td><td>11:34</td></tr></table>'),[]);
});
