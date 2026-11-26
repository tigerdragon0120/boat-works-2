import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonicalVenueCode,expectedVenuePeriodEnd,parseOfficialVenueProfile,validateVenueProfile,
  venueProfileContent,venueProfileHash,venueProfileSnapshotKey,venueRefreshKey} from '../base44/shared/v8VenueProfileSource.js';
import {makeVenueProfileRecord,validateStoredVenueProfile,loadVenueProfiles} from '../base44/shared/v8VenueStore.js';

const html23=fs.readFileSync(new URL('./fixtures/official_venue_20261126_23.html',import.meta.url),'utf8');
const html24=fs.readFileSync(new URL('./fixtures/official_venue_20261126_24.html',import.meta.url),'utf8');
const NOV='2026-11-26T00:00:00.000Z',DEC='2026-12-01T00:00:00.000Z';
let moduleId=0;
const store=()=>import('../base44/shared/v8VenueStore.js?test='+ ++moduleId);
const parse=(html=html23,code='23',at=NOV)=>parseOfficialVenueProfile(html,{venueCode:code,fetchedAt:at,now:at});
function clock(t,initial=NOV){
  const RealDate=globalThis.Date;let now=RealDate.parse(initial);
  class FakeDate extends RealDate{
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  }
  globalThis.Date=FakeDate;t.after(()=>{globalThis.Date=RealDate;});
  return {set:value=>{now=RealDate.parse(value);},advance:ms=>{now+=ms;}};
}
function mockFetch(t,fn){const original=globalThis.fetch;globalThis.fetch=fn;t.after(()=>{globalThis.fetch=original;});}
function platform(initial=[]){
  const rows=structuredClone(initial),calls={reads:[],creates:[],updates:[]};
  const matches=(row,q)=>Object.entries(q).every(([key,value])=>value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]):row[key]===value);
  const entity={
    async filter(q){calls.reads.push(structuredClone(q));return {items:structuredClone(rows.filter(row=>matches(row,q))),has_more:false,next_cursor:null};},
    async create(value){
      calls.creates.push(structuredClone(value));const at=new Date().toISOString();
      const row={...structuredClone(value),id:'snapshot-'+(rows.length+1),created_date:at,updated_date:at};rows.push(row);return structuredClone(row);
    },
    async updateMany(q,value){
      calls.updates.push({q:structuredClone(q),value:structuredClone(value)});let count=0;
      for(let i=0;i<rows.length;i++)if(matches(rows[i],q)){rows[i]={...rows[i],...structuredClone(value.$set),updated_date:new Date().toISOString()};count++;}
      return {modified_count:count};
    },
  };
  return {client:{asServiceRole:{entities:{V8VenueProfileSnapshot:entity}}},sr:{V8VenueProfileSnapshot:entity},rows,calls,entity};
}
async function saved(html=html23,code='23',at=NOV,id='original'){
  const source=await parse(html,code,at);assert.equal(source.ok,true);
  const record=await makeVenueProfileRecord(source.profile,{now:at});assert.ok(record);
  return {...record,id,created_date:at,updated_date:at};
}
function nextPeriod(html=html23){return html.replaceAll('2026/08/01～2026/10/31','2026/09/01～2026/11/30');}

test('official Karatsu and Omura fixtures preserve actual-course rates, conditional methods and frame transitions',async()=>{
  const karatsu=await parse(),omura=await parse(html24,'24');
  assert.equal(karatsu.ok,true);assert.equal(omura.ok,true);
  const p=karatsu.profile,c=p.courses['1'];
  assert.equal(p.venue_name,'唐津');assert.equal(p.period_start,'2026-08-01');assert.equal(p.period_end,'2026-10-31');
  assert.equal(p.course_basis,'ACTUAL_ENTRY_COURSE');assert.equal(p.method_basis,'AMONG_COURSE_WINNERS');
  assert.deepEqual([c.first_rate,c.second_rate,c.third_rate,c.fourth_rate,c.fifth_rate,c.sixth_rate],[59.2,17.3,9.4,5.5,5.5,2.7]);
  assert.equal(c.top2_rate,76.5);assert.equal(c.top3_rate,85.9);
  assert.equal(c.winning_methods['逃げ'],95.4);assert.equal(c.winning_methods['抜き'],4.5);
  assert.equal(c.winning_methods['差し'],0);assert.equal(p.frame_to_course['1']['1'],97.7);
  assert.equal(omura.profile.courses['1'].first_rate,59.6);assert.equal(omura.profile.courses['1'].winning_methods['逃げ'],95.7);
  assert.equal(Object.keys(p.courses).length,6);assert.equal(Object.keys(p.frame_to_course).length,6);
  assert.equal(p.sample_size,null);assert.equal(p.published_at,null);assert.equal(p.sample_size_status,'NOT_PUBLISHED');
  assert.ok(Object.values(p.courses).every(row=>row.sample_size===null&&row.avg_st===null&&row.avg_st_rank===null));
  assert.equal(p.data_quality,'COMPLETE');assert.match(p.content_hash,/^[a-f0-9]{64}$/);
});

test('unknown percentages remain null and do not manufacture zero, sample counts or a top rate',async()=>{
  const missing=await parse(html23.replace('>59.2</td>','>―</td>'));
  assert.equal(missing.ok,true);const p=missing.profile;
  assert.equal(p.courses['1'].first_rate,null);assert.equal(p.courses['1'].top2_rate,null);assert.equal(p.courses['1'].top3_rate,null);
  assert.equal(p.courses['1'].winning_methods['差し'],0);assert.equal(p.data_quality,'PARTIAL');
  assert.ok(p.missing_fields.includes('courses.1.first_rate'));assert.equal(p.sample_size,null);
  assert.equal((await parse(html23.replace('>59.2</td>','>101</td>'))).reason,'VENUE_RATE_INVALID');
  assert.equal((await parse(html23.replace('>59.2</td>','>99</td>'))).reason,'VENUE_RATE_TOTAL_INVALID');
});

test('venue identity, own table period and exact completed three months must be proved',async()=>{
  assert.equal((await parse(html23,'24')).reason,'VENUE_NAME_MISMATCH');
  assert.equal((await parseOfficialVenueProfile(html23,{venueCode:'23',sourceUrl:'https://example.test/stadium',fetchedAt:NOV})).ok,false);
  assert.equal((await parse(html23.replace('最近3ヶ月のデータ','未知の表'))).reason,'RECENT_VENUE_SECTION_MISSING');
  assert.equal((await parse(html23.replace('集計期間：2026/08/01～2026/10/31','期間不明'))).reason,'VENUE_TABLE_INCOMPLETE');
  assert.equal((await parse(html23.replace('2026/08/01～2026/10/31','2026/07/01～2026/10/31'))).reason,'VENUE_PERIOD_INVALID');
  assert.equal((await parse(nextPeriod(),'23',NOV)).reason,'VENUE_PERIOD_INVALID');
  assert.equal((await parse(html23,'23','2026-10-31T14:00:00Z')).reason,'VENUE_PERIOD_INVALID');
  assert.equal(canonicalVenueCode(1),'01');assert.equal(canonicalVenueCode('25'),null);
  assert.equal(expectedVenuePeriodEnd('2026-11-30T14:59:59Z'),'2026-10-31');
  assert.equal(expectedVenuePeriodEnd('2026-11-30T15:00:00Z'),'2026-11-30');
});

test('source hashes exclude observation metadata and include every published course field',async()=>{
  const first=await parse(),later=await parse(html23,'23','2026-11-27T00:00:00Z');
  assert.equal(first.profile.content_hash,later.profile.content_hash);assert.equal(first.profile.source_hash,later.profile.source_hash);
  const changed=await parse(html23.replace('>59.2</td>','>58.2</td>'));
  assert.notEqual(first.profile.content_hash,changed.profile.content_hash);
  assert.equal(first.profile.content_hash,await venueProfileHash(venueProfileContent(first.profile)));
});

test('seed construction and database validation reject tampering and preserve actual availability',async()=>{
  const row=await saved(),original=structuredClone(row),validated=await validateStoredVenueProfile(row,{venueCode:'23',asOf:NOV});
  assert.ok(validated);assert.equal(validated.profile.available_at,NOV);assert.equal(validated.profile.snapshot_id,'original');
  assert.deepEqual(row,original);validated.profile.courses['1'].first_rate=0;assert.equal(row.profile.courses['1'].first_rate,59.2);
  const modified=structuredClone(row);modified.profile.courses['1'].first_rate=58.2;
  assert.equal(await validateStoredVenueProfile(modified,{venueCode:'23',asOf:NOV}),null);
  assert.equal(await makeVenueProfileRecord(modified.profile,{now:NOV}),null);
  assert.equal(await makeVenueProfileRecord(row.profile,{attemptedAt:'2026-11-27T00:00:00Z',now:'2026-11-28T00:00:00Z'}),null);
  const future={...row,created_date:'2026-11-26T00:00:01Z',updated_date:'2026-11-26T00:00:01Z'};
  assert.equal(await validateStoredVenueProfile(future,{venueCode:'23',asOf:NOV}),null);
  const later=await validateStoredVenueProfile(future,{venueCode:'23',asOf:'2026-11-26T00:00:02Z'});
  assert.equal(later.profile.available_at,'2026-11-26T00:00:01.000Z');
  assert.equal(validateVenueProfile(later.profile,{venueCode:'23',raceDate:'2026-11-26',asOf:NOV}),null);
  assert.equal(validateVenueProfile(later.profile,{venueCode:'24',raceDate:'2026-11-26',asOf:'2026-11-26T00:00:02Z'}),null);
  assert.equal(validateVenueProfile(later.profile,{venueCode:'23',raceDate:'2026-10-31',asOf:'2026-11-26T00:00:02Z'}),null);
});

test('all requested venues load in one paged query and current saved periods perform no HTTP or write',async t=>{
  clock(t);const p=platform([await saved(),await saved(html24,'24',NOV,'omura')]);
  mockFetch(t,async()=>{throw new Error('No HTTP should run');});
  const loaded=await loadVenueProfiles(p.sr,{venueCodes:['23','24','23']});
  assert.equal(loaded.status,'READY');assert.equal(p.calls.reads.length,1);assert.equal(loaded.byVenueCode.size,2);
  assert.deepEqual(p.calls.reads[0],{venue_code:{$in:['23','24']}});
  const {ensureVenueProfile}=await store();
  const ready=await ensureVenueProfile(p.client,{venueCode:'23',cached:loaded.byVenueCode.get('23'),allowFetch:true});
  assert.equal(ready.status,'READY');assert.equal(ready.profile.snapshot_id,'original');assert.equal(p.calls.reads.length,1);
  assert.equal(p.calls.creates.length,0);assert.equal(p.calls.updates.length,0);
});

test('one initial source fetch is saved once and shared by simultaneous callers without mutating the input',async t=>{
  clock(t);const p=platform(),{ensureVenueProfile}=await store();let fetches=0;
  mockFetch(t,async(url,options)=>{fetches++;assert.match(url,/jcd=23$/);assert.ok(options.signal instanceof AbortSignal);return new Response(html23,{status:200});});
  const [a,b]=await Promise.all([1,2].map(()=>ensureVenueProfile(p.client,{venueCode:'23',cached:[],allowFetch:true})));
  assert.equal(a.status,'READY');assert.equal(b.status,'READY');assert.equal(fetches,1);assert.equal(p.calls.creates.length,1);
  assert.equal(a.profile.snapshot_id,b.profile.snapshot_id);assert.equal(a.snapshot.record_type,'PROFILE');
  assert.equal(a.profile.available_at,NOV);assert.equal(a.profile.snapshot_key,venueProfileSnapshotKey('23','2026-10-31'));
  assert.equal(p.calls.updates.length,0);const before=structuredClone(p.rows);
  await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(fetches,1);assert.deepEqual(p.rows,before);
});

test('a delayed month publication leaves the old source immutable and retries after 24 hours',async t=>{
  const time=clock(t,DEC),old=await saved(),p=platform([old]),{ensureVenueProfile}=await store();let fetches=0;
  mockFetch(t,async()=>{fetches++;return new Response(fetches<2?html23:nextPeriod(),{status:200});});
  const first=await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(first.status,'READY');assert.equal(first.reason,'VENUE_SOURCE_PERIOD_NOT_CURRENT');assert.equal(first.profile.snapshot_id,'original');
  assert.equal(fetches,1);assert.deepEqual(p.rows[0],old);assert.equal(p.rows.length,2);
  const retry=p.rows.find(row=>row.record_type==='REFRESH');
  assert.equal(retry.status,'FAILED');assert.equal(retry.snapshot_key,venueRefreshKey('23','2026-11-30'));
  assert.equal(Date.parse(retry.next_retry_at)-Date.parse(retry.attempted_at),86400000);
  time.advance(3600000);
  const held=await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(held.status,'READY');assert.equal(fetches,1);
  time.set('2026-12-02T00:00:01Z');
  const updated=await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(updated.status,'READY');assert.equal(updated.profile.period_end,'2026-11-30');assert.notEqual(updated.profile.snapshot_id,'original');
  assert.equal(fetches,2);assert.deepEqual(p.rows[0],old);assert.equal(p.calls.updates.length,0);
  assert.equal(p.rows.filter(row=>row.record_type==='PROFILE').length,2);
  assert.equal(validateVenueProfile(updated.profile,{venueCode:'23',raceDate:'2026-12-01',asOf:DEC}),null);
  assert.ok(validateVenueProfile(first.profile,{venueCode:'23',raceDate:'2026-12-01',asOf:DEC}));
});

test('repeated source failure updates only the separate failed retry row with an identity predicate',async t=>{
  const time=clock(t,DEC),old=await saved(),p=platform([old]),{ensureVenueProfile}=await store();let fetches=0;
  mockFetch(t,async()=>{fetches++;return new Response('',{status:503});});
  const first=await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(first.status,'READY');assert.equal(first.reason,'VENUE_SOURCE_HTTP_503');
  time.set('2026-12-02T00:00:01Z');
  await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(fetches,2);assert.equal(p.rows.length,2);assert.deepEqual(p.rows[0],old);
  assert.equal(p.calls.updates.length,1);const q=p.calls.updates[0].q;
  assert.equal(q.record_type,'REFRESH');assert.equal(q.status,'FAILED');assert.equal(q.id,p.rows[1].id);assert.ok(q.updated_date);
  const held=await ensureVenueProfile(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(held.status,'READY');assert.equal(fetches,2);
});

test('a first-time failed venue has a durable daily cooldown and is not silently treated as empty statistics',async t=>{
  clock(t);const p=platform(),{ensureVenueProfile}=await store();let fetches=0;
  mockFetch(t,async()=>{fetches++;return new Response('',{status:404});});
  const failed=await ensureVenueProfile(p.client,{venueCode:'23',cached:[],allowFetch:true});
  assert.equal(failed.status,'FAILED');assert.equal(failed.profile,null);assert.equal(p.rows[0].record_type,'REFRESH');
  const {ensureVenueProfile:nextIsolate}=await store();
  const held=await nextIsolate(p.client,{venueCode:'23',cached:p.rows,allowFetch:true});
  assert.equal(held.status,'COOLDOWN');assert.equal(held.profile,null);assert.equal(fetches,1);
  assert.equal(p.calls.creates.length,1);
});

test('conflicting, future or corrupted sources are not used; retired rows do not conflict with one active source',async t=>{
  clock(t);const original=await saved(),p=platform(),{ensureVenueProfile}=await store();
  const duplicate={...structuredClone(original),id:'duplicate'};
  let fetches=0;mockFetch(t,async()=>{fetches++;return new Response(html23,{status:200});});
  const conflict=await ensureVenueProfile(p.client,{venueCode:'23',cached:[original,duplicate],allowFetch:true});
  assert.equal(conflict.profile,null);assert.equal(conflict.status,'CONFLICT');assert.equal(fetches,0);
  const retired={...duplicate,status:'SUPERSEDED'};
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',cached:[original,retired]})).profile.snapshot_id,'original');
  const future={...duplicate,created_date:'2026-11-27T00:00:00Z',updated_date:'2026-11-27T00:00:00Z'};
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',cached:[future]})).profile,null);
  const broken={...original,content_hash:'f'.repeat(64)};
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',cached:[broken]})).profile,null);
});

test('no permissions, historical acquisition, insufficient budget, or incomplete DB read never trigger source HTTP',async t=>{
  clock(t);const p=platform(),{ensureVenueProfile}=await store();let fetches=0;
  mockFetch(t,async()=>{fetches++;return new Response(html23,{status:200});});
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',cached:[],allowFetch:false})).status,'MISSING');
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',cached:[],allowFetch:true,now:'2026-11-25T00:00:00Z'})).reason,'VENUE_LIVE_ACQUISITION_ONLY');
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',cached:[],allowFetch:true,budget:Date.now()+3000})).status,'BUDGET');
  p.entity.filter=async()=>[];
  assert.equal((await ensureVenueProfile(p.client,{venueCode:'23',allowFetch:true})).status,'READ_FAILED');
  assert.equal(fetches,0);assert.equal(p.calls.creates.length,0);
});

test('the source fetch aborts once within its bound, without detached writes or repeated HTTP',async t=>{
  clock(t);const p=platform(),{ensureVenueProfile}=await store();let fetches=0,aborted=0;
  mockFetch(t,async(_url,{signal})=>{
    fetches++;
    return new Promise((resolve,reject)=>{
      const keepAlive=setTimeout(()=>reject(new Error('source did not abort')),3500);
      signal.addEventListener('abort',()=>{aborted++;clearTimeout(keepAlive);reject(signal.reason);},{once:true});
    });
  });
  const result=await ensureVenueProfile(p.client,{venueCode:'23',cached:[],allowFetch:true});
  assert.equal(result.status,'FAILED');assert.equal(result.reason,'VENUE_SOURCE_FETCH_FAILED');
  assert.equal(fetches,1);assert.equal(aborted,1);assert.equal(p.calls.creates.length,1);
  assert.equal(p.rows[0].record_type,'REFRESH');
});
