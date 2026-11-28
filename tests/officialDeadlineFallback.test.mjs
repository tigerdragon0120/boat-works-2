import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {refreshOfficialDeadlines,hasConfirmedOfficialDeadline,normalizeOfficialCardDeadlines,officialDeadlineUrl} from '../base44/shared/officialLiveDeadlines.js';

const DATE='2026-11-28',NOW=Date.parse(DATE+'T02:30:00Z');
const HTML=readFileSync(new URL('./fixtures/official-racelist-deadlines-20261128-03.html',import.meta.url),'utf8');
const row=(code='03',extra={})=>({id:'race-'+code,race_key:DATE+'_'+code+'_02',race_date:DATE,venue_code:code,race_number:2,
  deadline:DATE+'T11:25:00+09:00',status:'pre',updated_date:DATE+'T02:00:00Z',...extra});
const urlFor=code=>'https://boatrace.jp/owpc/pc/race/racelist?rno=1&jcd='+code+'&hd=20261128';
const matches=(row,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'?value.$in?.includes(row[key]):row[key]===value);
function setup(t,{rows=[row()],status=403,fetchError=null,html=HTML,onPrimary=null,onHtml=null,now=NOW}={}){
  t.mock.timers.enable({apis:['Date'],now});
  const records=structuredClone(rows),reads=[],writes=[],requests=[];
  const Race={filter:async query=>{reads.push(query);return {items:structuredClone(records.filter(row=>matches(row,query))),has_more:false,next_cursor:null};},
    updateMany:async(query,update)=>{writes.push({query,update});const found=records.filter(row=>matches(row,query));for(const row of found)Object.assign(row,structuredClone(update.$set));return {updated:found.length};}};
  const fetcher=async()=>{if(onPrimary)onPrimary();if(fetchError)throw fetchError;return new Response(status===200?'{}':'denied',{status});};
  const htmlFetcher=async(url,retries,options)=>{
    requests.push({url,retries,options});if(onHtml)await onHtml(url);
    const code=new URL(url).searchParams.get('jcd');return {ok:true,status:200,html:html.replaceAll('jcd=03','jcd='+code)};
  };
  return {records,reads,writes,requests,run:()=>refreshOfficialDeadlines({asServiceRole:{entities:{Race}}},{date:DATE,deadlineMs:now+8000,fetcher,htmlFetcher})};
}

test('freshly retrieved stale HTML cannot overwrite confirmed official corrections',async t=>{
  for(const provider of ['BOATCAST','BOATRACE'])await t.test(provider,async child=>{
    const deadline=DATE+'T11:34:00+09:00',evidence={provider,url:provider==='BOATCAST'?officialDeadlineUrl(DATE):urlFor('03'),
      http_status:200,fetched_at:DATE+'T02:19:00Z',race_date:DATE,venue_code:'03',race_number:2,deadline,
      ...(provider==='BOATRACE'?{request_race_number:1}:{})};
    const saved=row('03',{deadline,deadline_source:evidence});
    const state=setup(child,{rows:[saved],now:Date.parse(DATE+'T02:20:00Z'),html:HTML.replace('<td>11:34</td>','<td>11:25</td>')});
    const result=await state.run();assert.equal(result.ok,true);assert.equal(result.fallback.accepted,1);
    assert.equal(state.requests.length,1);assert.equal(state.writes.length,0);assert.equal(result.updated,0);
    assert.deepEqual(state.records[0],saved);
  });
});

test('HTML may extend a confirmed BOATRACE deadline but cannot replace a BOATCAST correction',async t=>{
  for(const provider of ['BOATCAST','BOATRACE'])await t.test(provider,async child=>{
    const deadline=DATE+'T11:25:00+09:00',evidence={provider,url:provider==='BOATCAST'?officialDeadlineUrl(DATE):urlFor('03'),
      http_status:200,fetched_at:DATE+'T02:19:00Z',race_date:DATE,venue_code:'03',race_number:2,deadline,
      ...(provider==='BOATRACE'?{request_race_number:1}:{})};
    const saved=row('03',{deadline,deadline_source:evidence});
    const state=setup(child,{rows:[saved],now:Date.parse(DATE+'T02:20:00Z')}),result=await state.run();
    assert.equal(result.ok,true);assert.equal(result.updated,provider==='BOATRACE'?1:0);
    assert.equal(state.writes.length,provider==='BOATRACE'?1:0);
    assert.equal(state.records[0].deadline,provider==='BOATRACE'?DATE+'T11:34:00+09:00':deadline);
  });
});

test('403 fallback uses the official 12-slot card and saves a guarded deadline with its exact source',async t=>{
  const state=setup(t),result=await state.run();
  assert.equal(result.ok,true);assert.equal(result.updated,1);assert.equal(result.primary_failure.reason,'SCHEDULE_HTTP_403');
  assert.equal(result.source.provider,'BOATRACE');assert.equal(result.fallback.accepted,1);
  assert.equal(state.requests.length,1);assert.equal(state.requests[0].url,urlFor('03'));assert.equal(state.requests[0].retries,0);
  assert.ok(state.requests[0].options.timeoutMs<=3000);assert.equal(state.requests[0].options.deadlineMs,NOW+6750);
  const saved=state.records[0];assert.equal(saved.deadline,DATE+'T11:34:00+09:00');
  assert.equal(saved.deadline_source.url,urlFor('03'));assert.equal(saved.deadline_source.race_number,2);
  assert.equal(saved.deadline_source.request_race_number,1);assert.equal(saved.deadline_source.http_status,200);
  assert.equal(state.writes[0].query.deadline,DATE+'T11:25:00+09:00');
  assert.equal(hasConfirmedOfficialDeadline(saved,{date:DATE,now:NOW+10*60000}),true);
  saved.deadline_source.url=urlFor('04');assert.equal(hasConfirmedOfficialDeadline(saved,{date:DATE,now:NOW}),false);
});

test('a repeated caption outside the schedule table is allowed without relaxing row or header identity',async t=>{
  assert.equal(HTML.split('締切予定時刻').length-1,2);
  const state=setup(t),result=await state.run();assert.equal(result.ok,true);assert.equal(result.updated,1);
});

test('duplicate deadline label cells or table headers remain ambiguous and cannot be saved',async t=>{
  for(const kind of ['label','header'])await t.test(kind,async child=>{
    const html=kind==='label'?HTML+'<table><tr><td>締切予定時刻</td><td>11:34</td></tr></table>'
      :HTML.replace('</thead>','</thead><thead><tr><th>another header</th></tr></thead>');
    const state=setup(child,{html}),result=await state.run();assert.equal(result.ok,false);assert.equal(state.writes.length,0);
    assert.equal(result.reason,kind==='label'?'SCHEDULE_CARD_SLOTS_INVALID':'SCHEDULE_CARD_IDENTITY_INVALID');
  });
});

test('only documented acquisition failures activate HTML fallback',async t=>{
  for(const status of [403,404,408,429,500,503,302,400,401])await t.test(String(status),async child=>{
    const state=setup(child,{status}),result=await state.run();
    const eligible=[403,404,408,429,500,503].includes(status);
    assert.equal(state.requests.length,eligible?1:0);assert.equal(state.writes.length,eligible?1:0);
    if(!eligible){assert.equal(result.reason,'SCHEDULE_HTTP_'+status);assert.equal(state.reads.length,0);}
  });
});

test('timeouts can recover while unknown programming errors and malformed JSON fail without fallback',async t=>{
  for(const kind of ['timeout','programming','invalid_json_shape'])await t.test(kind,async child=>{
    const state=setup(child,kind==='timeout'?{fetchError:Object.assign(new Error('aborted'),{name:'AbortError'})}
      :kind==='programming'?{fetchError:new TypeError('invalid local argument')}:{status:200});
    const result=await state.run();assert.equal(state.requests.length,kind==='timeout'?1:0);
    if(kind!=='timeout'){assert.equal(result.ok,false);assert.equal(state.reads.length,0);assert.equal(state.writes.length,0);}
  });
});

test('a mismatched day, reordered slot or incomplete deadline row is never saved',async t=>{
  const variants=[HTML.replaceAll('20261128','20261127'),HTML.replace('rno=2&amp;','rno=3&amp;'),
    HTML.replace('<td>11:34</td>','<td>--</td>'),HTML.replace('<td>11:34</td>','<td>11:07</td>')];
  for(let i=0;i<variants.length;i++)await t.test(String(i),async child=>{
    const state=setup(child,{html:variants[i]}),result=await state.run();
    assert.equal(result.ok,false);assert.equal(state.writes.length,0);assert.equal(state.records[0].deadline,DATE+'T11:25:00+09:00');
  });
});

test('fallback selects at most eight nearby active venues and excludes closed and distant races',async t=>{
  const rows=Array.from({length:10},(_,i)=>row(String(i+1).padStart(2,'0'),{deadline:new Date(NOW+(i+1)*60000).toISOString()}));
  rows.push(row('11',{status:'finished'}),row('12',{status:'cancelled'}),row('13',{deadline:new Date(NOW-16*60000).toISOString()}),
    row('14',{deadline:new Date(NOW+61*60000).toISOString()}));
  const state=setup(t,{rows}),result=await state.run();
  assert.equal(result.fallback.attempted,8);assert.deepEqual(state.requests.map(request=>new URL(request.url).searchParams.get('jcd')),
    ['01','02','03','04','05','06','07','08']);
  assert.equal(state.writes.some(write=>['race-11','race-12','race-13','race-14'].includes(write.query.id)),false);
});

test('one failed venue does not prevent another venue saving and is reported as partial',async t=>{
  const state=setup(t,{rows:[row('03'),row('08')],onHtml:async url=>{if(new URL(url).searchParams.get('jcd')==='03')throw new Error('unavailable');}});
  const result=await state.run();assert.equal(result.ok,false);assert.equal(result.updated,1);
  assert.equal(result.fallback.attempted,2);assert.equal(result.fallback.accepted,1);
  assert.deepEqual(result.updated_keys,[DATE+'_08_02']);assert.equal(state.records[0].deadline,DATE+'T11:25:00+09:00');
});

test('an exhausted shared budget prevents fallback or late writes',async t=>{
  for(const phase of ['primary','html'])await t.test(phase,async child=>{
    const state=setup(child,phase==='primary'?{onPrimary:()=>child.mock.timers.setTime(NOW+6600)}:{onHtml:()=>child.mock.timers.setTime(NOW+7800)});
    const result=await state.run();assert.equal(result.ok,false);assert.equal(state.writes.length,0);
    if(phase==='primary'){assert.equal(state.requests.length,0);assert.equal(state.reads.length,0);}
  });
});

test('duplicate race identity and future source times fail closed',async t=>{
  const state=setup(t,{rows:[row(),row('03',{id:'duplicate'})]}),result=await state.run();
  assert.equal(result.ok,false);assert.equal(state.requests.length,0);assert.equal(state.writes.length,0);
  const source={provider:'BOATRACE',url:urlFor('03'),http_status:200,fetched_at:new Date(NOW+1).toISOString(),
    race_date:DATE,venue_code:'03',request_race_number:1};
  assert.equal(normalizeOfficialCardDeadlines(HTML,{date:DATE,venueCode:'03',source,now:NOW}).ok,false);
});
