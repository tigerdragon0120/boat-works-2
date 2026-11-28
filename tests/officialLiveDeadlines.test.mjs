import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeOfficialDeadlines,officialDeadlineUrl,refreshOfficialDeadlines} from '../base44/shared/officialLiveDeadlines.js';
import {selectLiveInputRaces} from '../base44/shared/liveInputPriority.js';

const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/official-live-deadlines-20261128.json',import.meta.url),'utf8'));
const DATE='2026-11-28',NOW=Date.parse(DATE+'T02:30:00Z');
const race=(id='edogawa-2',extra={})=>({id,race_key:DATE+'_03_02',race_date:DATE,venue_code:'03',race_number:2,
  deadline:DATE+'T11:25:00+09:00',status:'pre',updated_date:DATE+'T02:00:00Z',...extra});
const delayed=()=>{
  // Synthetic timing variant of the observed contract reproduces the incident:
  // the saved 11:25 deadline has passed, but the official race now closes 11:34.
  const data=structuredClone(fixture.payload),venue=data.return_info[0];
  venue.RecentRace='02';venue.DeadlineTime='11:34';venue.DeadlineTimeAll[1]='11:34';return data;
};
function setup(t,{rows=[race()],payload=delayed(),status=200,beforeWrite=()=>{},headers={}}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const records=structuredClone(rows),calls=[],requests=[];
  const match=(row,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'
    ? '$in' in value&&value.$in.includes(row[key]):row[key]===value);
  const entity={
    async filter(query){calls.push({method:'filter',query});return {items:structuredClone(records.filter(row=>match(row,query))),has_more:false,next_cursor:null};},
    async updateMany(query,update){calls.push({method:'updateMany',query,update});beforeWrite(records);
      const found=records.filter(row=>match(row,query));for(const row of found)Object.assign(row,structuredClone(update.$set));return {updated:found.length};},
  };
  const fetcher=async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(payload),{status,
    headers:{'content-type':'application/json','last-modified':new Date(NOW-1000).toUTCString(),...headers}});};
  return {records,calls,requests,client:{asServiceRole:{entities:{Race:entity}}},fetcher};
}
const run=state=>refreshOfficialDeadlines(state.client,{date:DATE,deadlineMs:Date.now()+8000,fetcher:state.fetcher,
  htmlFetcher:async()=>({ok:false,status:403,html:''})});

test('edge-compatible manual redirects reject 302 without reading the body or database',async t=>{
  const state=setup(t),before=structuredClone(state.records);let requests=0,bodyRead=false;
  const result=await refreshOfficialDeadlines(state.client,{date:DATE,deadlineMs:NOW+8000,fetcher:async(_url,options)=>{
    requests++;assert.equal(options.redirect,'manual');
    return {status:302,text:async()=>{bodyRead=true;return JSON.stringify(delayed());}};
  }});
  assert.equal(requests,1);assert.equal(bodyRead,false);assert.equal(result.ok,false);
  assert.equal(result.reason,'SCHEDULE_HTTP_302');assert.equal(result.source.http_status,302);
  assert.equal(result.updated,0);assert.deepEqual(state.calls,[]);assert.deepEqual(state.records,before);
});

test('the observed public schedule maps 12 race slots and never treats closed text as a time',()=>{
  const normalized=normalizeOfficialDeadlines(fixture.payload,{date:DATE,source:fixture.source,now:Date.parse(fixture.source.fetched_at)});
  assert.equal(normalized.ok,true);assert.equal(normalized.deadlines.has(DATE+'_03_02'),false);
  assert.equal(normalized.deadlines.get(DATE+'_03_03').deadline,DATE+'T11:59:00+09:00');assert.equal(normalized.deadlines.size,10);
  assert.equal(officialDeadlineUrl(DATE),fixture.source.url);assert.equal(officialDeadlineUrl('2026-02-30'),null);
});

test('a delayed official deadline restores collection eligibility and records its source in the same conditional write',async t=>{
  const state=setup(t),old=structuredClone(state.records[0]);
  assert.equal(selectLiveInputRaces(state.records,NOW).length,0);
  const result=await run(state);
  assert.equal(result.ok,true);assert.equal(result.updated,1);assert.equal(result.checked,1);
  assert.deepEqual(result.updated_keys,[DATE+'_03_02']);assert.equal(state.requests.length,1);
  const saved=state.records[0];assert.equal(saved.deadline,DATE+'T11:34:00+09:00');assert.equal(saved.status,'pre');
  assert.equal(selectLiveInputRaces(state.records,NOW).length,1);
  assert.equal(saved.deadline_source.provider,'BOATCAST');assert.equal(saved.deadline_source.fetched_at,new Date(NOW).toISOString());
  assert.equal(saved.deadline_source.url,fixture.source.url);assert.equal(saved.deadline_source.race_number,2);
  const writes=state.calls.filter(call=>call.method==='updateMany');assert.equal(writes.length,1);
  assert.deepEqual(Object.keys(writes[0].update.$set).sort(),['deadline','deadline_source']);
  assert.equal(writes[0].query.deadline,old.deadline);assert.equal(writes[0].query.updated_date,old.updated_date);
  assert.equal(state.calls.some(call=>call.method==='create'),false);
});

test('equivalent existing times do not rewrite Race or refresh provenance',async t=>{
  const source={provider:'older-observation'},state=setup(t,{rows:[race('same',{deadline:DATE+'T02:34:00Z',deadline_source:source})]});
  const before=structuredClone(state.records),result=await run(state);
  assert.equal(result.ok,true);assert.equal(result.updated,0);assert.equal(result.checked,1);
  assert.deepEqual(state.records,before);assert.equal(state.calls.filter(call=>call.method==='updateMany').length,0);
});

test('finished, cancelled, missing and explicitly closed official races are never reopened or created',async t=>{
  for(const kind of ['finished','cancelled','missing','source_closed','source_cancelled'])await t.test(kind,async child=>{
    const payload=delayed();let rows=[race()];
    if(['finished','cancelled'].includes(kind))rows[0].status=kind;
    if(kind==='missing')rows=[];
    if(kind==='source_closed'){payload.return_info[0].DeadlineTimeAll[1]='締切';payload.return_info[0].DeadlineTime='締切';}
    if(kind==='source_cancelled')payload.return_info[0].CancelStatusAll[1]='1';
    const state=setup(child,{rows,payload}),before=structuredClone(state.records),result=await run(state);
    assert.equal(result.updated,0);assert.deepEqual(state.records,before);assert.equal(state.calls.some(call=>call.method==='updateMany'),false);
  });
});

test('identity errors and duplicate canonical race slots fail closed',async t=>{
  for(const kind of ['wrong_key','wrong_date','duplicate','conflicting_slot'])await t.test(kind,async child=>{
    const rows=[race()];
    if(kind==='wrong_key')rows[0].race_key=DATE+'_03_03';
    if(kind==='wrong_date')rows[0].race_date='2026-11-27';
    if(kind==='duplicate')rows.push(race('other'));
    if(kind==='conflicting_slot')rows.push(race('other',{race_key:DATE+'_03_09'}));
    const state=setup(child,{rows}),before=structuredClone(state.records),result=await run(state);
    assert.equal(result.updated,0);assert.deepEqual(state.records,before);assert.equal(state.calls.some(call=>call.method==='updateMany'),false);
  });
});

test('concurrent completion or another deadline correction is not overwritten',async t=>{
  for(const kind of ['finished','new_deadline'])await t.test(kind,async child=>{
    const state=setup(child,{beforeWrite:rows=>{
      if(kind==='finished')rows[0].status='finished';else rows[0].deadline=DATE+'T11:40:00+09:00';
    }}),result=await run(state);
    assert.equal(result.ok,false);assert.equal(result.updated,0);assert.equal(result.reason,'SCHEDULE_SAVE_NOT_CONFIRMED');
    assert.equal(kind==='finished'?state.records[0].status:state.records[0].deadline,kind==='finished'?'finished':DATE+'T11:40:00+09:00');
  });
});

test('ambiguous schedules, duplicate venues and conflicting current-race headings never reach the database',async t=>{
  for(const kind of ['short_array','invalid_clock','duplicate_venue','heading','reordered','error_payload'])await t.test(kind,async child=>{
    const payload=delayed(),venue=payload.return_info[0];
    if(kind==='short_array')venue.DeadlineTimeAll.pop();
    if(kind==='invalid_clock')venue.DeadlineTimeAll[3]='12:99';
    if(kind==='duplicate_venue')payload.return_info.push(structuredClone(venue));
    if(kind==='heading')venue.DeadlineTime='11:25';
    if(kind==='reordered')venue.DeadlineTimeAll[3]='11:20';
    if(kind==='error_payload')payload.res_cd=1;
    const state=setup(child,{payload}),result=await run(state);
    assert.equal(result.ok,false);assert.equal(result.updated,0);assert.equal(state.calls.length,0);
  });
});

test('HTTP403 and failed HTML fallback stay explicit and preserve existing rows',async t=>{
  const state=setup(t,{status:403}),before=structuredClone(state.records),result=await run(state);
  assert.equal(result.ok,false);assert.equal(result.reason,'SCHEDULE_CARD_HTTP_403');assert.equal(result.source.http_status,403);
  assert.equal(result.primary_failure.reason,'SCHEDULE_HTTP_403');assert.equal(result.fallback.attempted,1);
  assert.equal(state.requests.length,1);assert.equal(state.calls.length,1);assert.deepEqual(state.records,before);
});

test('future acquisition/publication times, another day and a newer stored source are rejected',async t=>{
  const fetched=Date.parse(fixture.source.fetched_at),source={...fixture.source,fetched_at:new Date(fetched+1000).toISOString()};
  assert.equal(normalizeOfficialDeadlines(fixture.payload,{date:DATE,source,now:fetched}).reason,'SCHEDULE_OBSERVATION_TIME_INVALID');
  assert.equal(normalizeOfficialDeadlines(fixture.payload,{date:DATE,source:{...fixture.source,url:officialDeadlineUrl('2026-11-27')},now:fetched}).reason,'SCHEDULE_SOURCE_INVALID');
  const state=setup(t,{headers:{'last-modified':new Date(NOW+1000).toUTCString()}}),result=await run(state);
  assert.equal(result.ok,false);assert.equal(result.reason,'SCHEDULE_PUBLICATION_TIME_INVALID');assert.equal(state.calls.length,0);
  state.records[0].deadline_source={fetched_at:new Date(NOW+2000).toISOString()};
  state.fetcher=async()=>new Response(JSON.stringify(delayed()),{status:200});
  const newer=await run(state);assert.equal(newer.updated,0);assert.equal(newer.reason,'SCHEDULE_RACE_TIME_INVALID');
});

test('expired or consumed time budgets prevent new work',async t=>{
  const state=setup(t);
  const first=await refreshOfficialDeadlines(state.client,{date:DATE,deadlineMs:NOW,fetcher:state.fetcher});
  assert.equal(first.reason,'SCHEDULE_TIME_BUDGET');assert.equal(state.requests.length,0);
  const fetcher=async(...args)=>{const response=await state.fetcher(...args);t.mock.timers.tick(8000);return response;};
  const result=await refreshOfficialDeadlines(state.client,{date:DATE,deadlineMs:NOW+8000,fetcher});
  assert.equal(result.reason,'SCHEDULE_TIME_BUDGET');assert.equal(state.calls.length,0);
});

test('write errors are explicit and never reported as a confirmed correction',async t=>{
  const state=setup(t,{beforeWrite:()=>{throw Object.assign(new Error('rate limit'),{response:{status:429}});}}),result=await run(state);
  assert.equal(result.ok,false);assert.equal(result.updated,0);assert.equal(result.reason,'SCHEDULE_SAVE_HTTP_429');
  assert.equal(state.records[0].deadline,DATE+'T11:25:00+09:00');
});
