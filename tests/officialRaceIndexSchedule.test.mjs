import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeOfficialIndexDisruptions} from '../base44/shared/officialRaceIndexSchedule.js';

// Unmodified official daily index retrieved 2026-11-28 15:30:58 JST.
const HTML=readFileSync(new URL('./fixtures/official-race-index-20261128.html',import.meta.url),'utf8');
const DATE='2026-11-28',NOW=Date.parse('2026-11-28T06:30:58.577Z');
const SOURCE=Object.freeze({provider:'BOATRACE',url:'https://boatrace.jp/owpc/pc/race/index?hd=20261128',
  http_status:200,fetched_at:new Date(NOW).toISOString(),race_date:DATE});
const parse=(html=HTML,options={})=>normalizeOfficialIndexDisruptions(html,{date:DATE,source:SOURCE,now:NOW,...options});
const bodyFor=(code,html=HTML)=>[...html.matchAll(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/gi)]
  .map(match=>match[0]).find(body=>body.includes(`text_place1_${code}.png`));
const key=(code,number)=>`${DATE}_${code}_${String(number).padStart(2,'0')}`;
const rejected=(result,reason)=>{
  assert.equal(result.ok,false);assert.equal(result.reason,reason);assert.equal(result.disruptions.size,0);
};

test('the real 14-venue daily index yields exactly the 42 explicitly disrupted races',()=>{
  assert.equal([...HTML.matchAll(/<tbody\b/gi)].length,14);
  const result=parse();assert.equal(result.ok,true);assert.equal(result.reason,null);
  const expected=[...Array.from({length:12},(_,i)=>key('15',i+1)),
    ...Array.from({length:6},(_,i)=>key('18',i+7)),
    ...Array.from({length:12},(_,i)=>key('20',i+1)),
    ...Array.from({length:12},(_,i)=>key('24',i+1))];
  assert.deepEqual([...result.disruptions.keys()].sort(),expected.sort());
  for(const entry of result.disruptions.values()){
    assert.equal(entry.race_key,key(entry.venue_code,entry.race_number));
    assert.equal(entry.schedule_status,entry.venue_code==='20'?'POSTPONED':'CANCELLED');
    assert.equal(entry.reason,entry.venue_code==='20'?'順延':entry.venue_code==='18'?'途中中止':'中止');
    assert.equal(entry.schedule_reason,entry.venue_code==='20'?'中止順延':entry.venue_code==='18'?'7R以降中止':'中止');
    assert.equal(entry.source,SOURCE);
  }
});

test('Tokuyama 1R–6R and the normally ended Naruto/Karatsu races are never cancelled',()=>{
  const {disruptions}=parse();
  assert.match(bodyFor('14'),/最終Ｒ発売終了/);assert.match(bodyFor('23'),/最終Ｒ発売終了/);
  for(let number=1;number<=12;number++){
    assert.equal(disruptions.has(key('18',number)),number>=7);
    assert.equal(disruptions.has(key('14',number)),false);
    assert.equal(disruptions.has(key('23',number)),false);
  }
});

test('ordinary closure, unknown non-cancellation notices and unmarked prose do not imply cancellations',()=>{
  const normal=HTML.replace(/中止順延|7R以降中止|>中止</g,word=>word==='>中止<'?'>最終Ｒ発売終了<':'最終Ｒ発売終了');
  assert.equal(parse(normal).ok,true);assert.equal(parse(normal).disruptions.size,0);
  const notice=normal.replace('最終Ｒ発売終了','調整中');
  assert.equal(parse(notice).ok,true);assert.equal(parse(notice).disruptions.size,0);
  const unmarked=HTML.replaceAll('is-attentionColor1','is-p10-10');
  assert.equal(parse(unmarked).ok,true);assert.equal(parse(unmarked).disruptions.size,0);
});

test('full-width letters, numeric entities and line breaks preserve the explicit range',()=>{
  const html=HTML.replace('7R以降中止','７Ｒ以降<br />中止').replace('中止順延','中止&#38918;&#24310;');
  const result=parse(html);assert.equal(result.ok,true);assert.equal(result.disruptions.size,42);
  assert.equal(result.disruptions.get(key('18',7)).schedule_reason,'7R以降中止');
  assert.equal(result.disruptions.get(key('20',1)).schedule_status,'POSTPONED');
});

test('unbounded, contradictory and out-of-range cancellation notices reject the complete observation',()=>{
  for(const notice of ['途中中止','7-12R中止','0R以降中止','13R以降中止','7R以前中止','7R以降中止予定','7R以降中止順延','中止解除','順延予定']){
    rejected(parse(HTML.replace('7R以降中止',notice)),'SCHEDULE_INDEX_DISRUPTION_AMBIGUOUS');
  }
  const duplicate=HTML.replace('7R以降中止</td>','7R以降中止</td><td class="is-attentionColor1">中止</td>');
  rejected(parse(duplicate),'SCHEDULE_INDEX_DISRUPTION_AMBIGUOUS');
});

test('the selected day heading, venue links and images must agree before any entry is accepted',()=>{
  const identityVariants=[
    HTML.replace('11月28日のレース情報','11月27日のレース情報'),
    HTML.replace('title2_mainLabel','title2_otherLabel'),
    HTML.replace('11月28日のレース情報</span>','11月28日のレース情報</span><span class="title2_mainLabel">11月28日のレース情報</span>'),
    HTML.replace('raceindex?jcd=18&amp;hd=20261128','raceindex?jcd=18&amp;hd=20261127'),
    HTML.replace('raceindex?jcd=18&amp;hd=20261128','raceindex?jcd=19&amp;hd=20261128'),
    HTML.replace('/owpc/pc/race/raceindex?jcd=18&amp;hd=20261128','https://example.com/owpc/pc/race/raceindex?jcd=18&amp;hd=20261128'),
    HTML.replace('raceindex?jcd=18&amp;hd=20261128','raceindex?jcd=18&amp;hd=20261128&amp;hd=20261127'),
    HTML.replace('raceindex?jcd=18&amp;hd=20261128','raceindex?jcd=18&amp;hd=20251128'),
    HTML.replace('racelist?rno=12&amp;jcd=18&amp;hd=20261128','racelist?rno=12&amp;jcd=18&amp;hd=20261127'),
    HTML.replace('text_place1_18.png','text_place1_19.png'),
  ];
  for(const html of identityVariants)rejected(parse(html),'SCHEDULE_INDEX_IDENTITY_INVALID');
  for(const replacement of ['text_place1_99.png','text_place1_18.png?other=1','unknown_place_18.png']){
    rejected(parse(HTML.replace('text_place1_18.png',replacement)),'SCHEDULE_INDEX_VENUE_AMBIGUOUS');
  }
});

test('duplicate venues, duplicate identity images and broken table boundaries are rejected',()=>{
  const body=bodyFor('18');
  const malformed=[
    HTML.replace(body,body+body),
    HTML.replace(body,body.replace('</td>','<img src="/static_extra/pc/images/text_place1_18.png" /></td>')),
    HTML.replace(body,body.replace('</tbody>','')),
    HTML.replace(body,body.replace('<tbody>','<tbody><tbody>')),
  ];
  for(const html of malformed)rejected(parse(html),'SCHEDULE_INDEX_VENUE_AMBIGUOUS');
});

test('a caller cannot relabel an old day, an untrusted origin or an unsuccessful response as current evidence',()=>{
  for(const source of [
    {...SOURCE,provider:'OTHER'}, {...SOURCE,url:SOURCE.url.replace('boatrace.jp','example.com')},
    {...SOURCE,url:SOURCE.url.replace('20261128','20261127')}, {...SOURCE,http_status:403},
    {...SOURCE,http_status:'200'}, {...SOURCE,race_date:'2026-11-27'}, {...SOURCE,race_date:undefined},
  ])rejected(parse(HTML,{source}),'SCHEDULE_INDEX_SOURCE_INVALID');
  for(const date of ['2026-11-27','2026-02-30','2026-11-29','invalid']){
    rejected(parse(HTML,{date}),'SCHEDULE_INDEX_DATE_INVALID');
  }
  rejected(parse(HTML,{now:NaN}),'SCHEDULE_INDEX_DATE_INVALID');
});

test('observation time must be present, not in the future, within five minutes and on the same JST day',()=>{
  for(const value of [undefined,'invalid',new Date(NOW+1).toISOString(),new Date(NOW-300001).toISOString()]){
    rejected(parse(HTML,{source:{...SOURCE,fetched_at:value}}),'SCHEDULE_INDEX_OBSERVATION_TIME_INVALID');
  }
  assert.equal(parse(HTML,{source:{...SOURCE,fetched_at:new Date(NOW-300000).toISOString()}}).ok,true);
  rejected(parse(HTML,{now:Date.parse('2026-11-27T15:00:00Z'),source:{...SOURCE,fetched_at:'2026-11-27T14:59:59Z'}}),
    'SCHEDULE_INDEX_OBSERVATION_TIME_INVALID');
});

test('empty, oversized, commented or script-only markup never supplies venue evidence',()=>{
  for(const html of [null,'',' '.repeat(10),'x'.repeat(512*1024+1)])rejected(parse(html),'SCHEDULE_INDEX_PAYLOAD_INVALID');
  const inert=HTML.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  for(const html of [`<!--${inert}-->`,`<script>${inert}</script>`])rejected(parse(html),'SCHEDULE_INDEX_IDENTITY_INVALID');
});
