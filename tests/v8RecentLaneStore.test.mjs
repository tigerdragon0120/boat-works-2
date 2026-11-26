import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildRecentLaneIdentity,normalizeRecentLaneName,parseBoatcastWaku10,normalizeRecentLaneSource,
  recentLaneSourceUrl,summarizeRecentLaneHistory,classifyRecentLaneFinish} from '../base44/shared/v8RecentLaneSource.js';
import {ensureRecentLaneSnapshot,loadRecentLaneSnapshots,validateRecentLaneSnapshot,recentLaneSnapshotResponse} from '../base44/shared/v8RecentLaneStore.js';
import {clearBoatcastCache,fetchBoatcastText} from '../base44/shared/boatcastClient.js';
import {dateValid,readV8Rows} from '../base44/shared/v8Repository.js';

const names=['長田雄樹','山田和彦','古賀太郎','田中康平','佐藤直人','上田信一'];
const race={id:'r-waku',race_key:'2026-11-26_23_01',race_date:'2026-11-26',venue_code:'23',race_number:1};
const entries=()=>names.map((name,index)=>({id:'e'+index,race_id:race.id,race_date:race.race_date,
  boat_number:index+1,registration_number:String(4501+index),player_name:name+' 福岡',created_date:'2026-01-01T00:00:00Z'}));
function sourceText({finishes=['1','2','F','欠','3'],overrides={}}={}){
  return 'data=\n1\t0\n'+names.map((name,index)=>{
    const history=Array.from({length:10},(_,i)=>[finishes[i]??'',i===1?'2':'','']);
    return [name, '8.20','.13','2.1',...history.flat()].map((value,i)=>overrides[index+':'+i]??value).join('\t');
  }).join('\n');
}
function metadata(now=new Date().toISOString()){
  return {source:'BOATCAST',data_type:'WAKU10',source_url:recentLaneSourceUrl(race),http_status:200,
    fetched_at:now,race_date:race.race_date,venue_code:race.venue_code,race_number:race.race_number};
}
function platform(initial=[]){
  const rows=structuredClone(initial),calls={reads:[],creates:0,updates:0};
  const matches=(row,q)=>Object.entries(q).every(([key,value])=>value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[key]):row[key]===value);
  const entity={
    async filter(q){calls.reads.push(structuredClone(q));return {items:structuredClone(rows.filter(row=>matches(row,q))),has_more:false,next_cursor:null};},
    async create(value){calls.creates++;const at=new Date().toISOString(),row={...structuredClone(value),id:'snapshot-'+(rows.length+1),created_date:at,updated_date:at};rows.push(row);return structuredClone(row);},
    async update(id,value){calls.updates++;const index=rows.findIndex(row=>row.id===id);assert.notEqual(index,-1);rows[index]={...rows[index],...structuredClone(value),updated_date:new Date().toISOString()};return structuredClone(rows[index]);},
    async updateMany(q,update){
      calls.updates++;let modified=0;
      for(let index=0;index<rows.length;index++)if(matches(rows[index],q)){
        rows[index]={...rows[index],...structuredClone(update.$set),updated_date:new Date().toISOString()};modified++;
      }
      return {modified_count:modified};
    },
  };
  return {client:{asServiceRole:{entities:{V8RecentLaneSnapshot:entity}}},rows,calls,entity};
}
async function withFetch(fn,run){
  clearBoatcastCache();const original=globalThis.fetch;globalThis.fetch=fn;
  try{return await run();}finally{globalThis.fetch=original;clearBoatcastCache();}
}
const responseText=text=>new Response(text,{status:200});

test('source keeps reported average points and distinct known-start, normal, and absent denominators',()=>{
  const parsed=parseBoatcastWaku10(sourceText());assert.equal(parsed.ok,true);
  const row=parsed.racers[0];
  assert.equal(row.winning_rate,8.2);assert.equal(row.sample_size,4);assert.equal(row.normal_sample_size,3);
  assert.equal(row.special_count,1);assert.equal(row.absent_count,1);assert.equal(row.first_rate,25);
  assert.equal(row.top2_rate,50);assert.equal(row.top3_rate,75);assert.equal(row.history[0].finish_order,1);
  assert.equal(row.history[0].course,1);assert.equal(row.history[0].course_inferred,true);
  assert.equal(row.history[1].course,2);assert.equal(row.history[1].course_inferred,false);
  assert.equal(row.avg_st,.13);assert.equal(row.avg_start_order,2.1);
  assert.equal(summarizeRecentLaneHistory(row.history).winning_rate,8);
});

test('actual Karatsu 2026-11-26 race 1 fixture matches all six displayed racers and ten-run order',async()=>{
  const text=fs.readFileSync(new URL('./fixtures/boatcast_waku10_20261126_23_01.txt',import.meta.url),'utf8');
  const parsed=parseBoatcastWaku10(text);assert.equal(parsed.ok,true);
  const expectedNames=['茶谷信次','富永夏哉人','黒田誠司','松尾基成','網代良芽','大西隆洋'];
  const expectedFinishes=[
    [2,2,1,2,1,1,1,4,1,1],[1,2,3,4,2,3,6,1,1,3],
    [6,6,2,5,5,3,6,6,6,6],[4,3,6,3,3,5,6,6,5,5],
    [3,5,4,3,6,5,5,4,5,4],[6,4,6,6,6,5,5,6,3,5],
  ];
  assert.deepEqual(parsed.racers.map(row=>row.normalized_source_name),expectedNames);
  assert.deepEqual(parsed.racers.map(row=>row.winning_rate),[8.8,6.9,2.4,3.1,3.3,2.1]);
  assert.deepEqual(parsed.racers.map(row=>row.avg_st),[.13,.18,.18,.15,.18,.16]);
  assert.deepEqual(parsed.racers.map(row=>row.avg_start_order),[2.2,3.2,3.9,3.3,3.7,3.5]);
  assert.deepEqual(parsed.racers.map(row=>row.history.map(item=>item.finish_order)),expectedFinishes);
  assert.deepEqual(parsed.racers.map(row=>row.first_rate),[60,30,0,0,0,0]);
  assert.deepEqual(parsed.racers.map(row=>row.top2_rate),[90,50,10,0,0,0]);
  assert.deepEqual(parsed.racers.map(row=>row.top3_rate),[90,80,20,30,20,10]);
  assert.ok(parsed.racers.every(row=>row.sample_size===10&&row.normal_sample_size===10));
  assert.equal(parsed.racers[1].history[7].course,4);assert.equal(parsed.racers[1].history[7].course_inferred,false);
  const targetEntries=entries().map((row,index)=>({...row,player_name:expectedNames[index]}));
  const now=new Date().toISOString(),normalized=await normalizeRecentLaneSource({text,metadata:metadata(now),race,entries:targetEntries,now});
  assert.equal(normalized.ok,true);assert.equal(normalized.racers.length,6);
});

test('actual saved entry names with branch/birthplace suffixes match all six WAKU10 racers',async()=>{
  const allEntries=JSON.parse(fs.readFileSync(new URL('./fixtures/boatcast_waku10_20261126_23_entries.json',import.meta.url),'utf8'));
  const targetEntries=allEntries.filter(row=>row.race_id==='6b06a4e1726cfd9a4fc8713e');
  const savedRace={...race,id:'6b06a4e1726cfd9a4fc8713e'};
  const text=fs.readFileSync(new URL('./fixtures/boatcast_waku10_20261126_23_01.txt',import.meta.url),'utf8');
  const now=new Date().toISOString();
  const normalized=await normalizeRecentLaneSource({text,metadata:metadata(now),race:savedRace,entries:targetEntries,now});
  assert.equal(targetEntries.length,6);assert.equal(normalized.ok,true);
  assert.deepEqual(normalized.racers.map(row=>row.registration_number),['3968','5307','3630','3741','5350','3701']);
  assert.deepEqual(normalized.racers.map(row=>row.normalized_source_name),['茶谷信次','富永夏哉人','黒田誠司','松尾基成','網代良芽','大西隆洋']);
  assert.equal(normalizeRecentLaneName(allEntries.find(row=>row.registration_number==='5115').player_name),'香川颯太');
  assert.equal(normalizeRecentLaneName('香川 颯太（滋賀県／京都府）'),'香川颯太');
  assert.equal(normalizeRecentLaneName('山田香川滋賀/京都'),'山田香川');
  assert.equal(normalizeRecentLaneName('香川颯太'),'香川颯太');
});

test('actual Mikuni race 3 engine-failure token stays in known starts and preserves the published 5.67',async()=>{
  const text=fs.readFileSync(new URL('./fixtures/boatcast_waku10_20261126_10_03.txt',import.meta.url),'utf8');
  const parsed=parseBoatcastWaku10(text);assert.equal(parsed.ok,true);assert.equal(parsed.racers.length,6);
  const row=parsed.racers[1];
  assert.equal(row.normalized_source_name,'安田政彦');assert.equal(row.winning_rate,5.67);
  assert.equal(row.history.length,10);assert.equal(row.sample_size,10);assert.equal(row.normal_sample_size,9);
  assert.equal(row.special_count,1);assert.equal(row.absent_count,0);
  assert.equal(row.history[8].finish_order,null);assert.equal(row.history[8].finish_status,'エ');
  assert.equal(row.first_rate,20);assert.equal(row.top2_rate,30);assert.equal(row.top3_rate,50);
  assert.equal(classifyRecentLaneFinish('エ').kind,'SPECIAL');
  assert.equal(classifyRecentLaneFinish('?').kind,'UNKNOWN');
  const targetRace={...race,id:'mikuni-r3',race_key:'2026-11-26_10_03',venue_code:'10',race_number:3};
  const targetEntries=entries().map((entry,index)=>({...entry,race_id:targetRace.id,player_name:parsed.racers[index].source_name}));
  const now=new Date().toISOString();
  const normalized=await normalizeRecentLaneSource({text,metadata:{...metadata(now),source_url:recentLaneSourceUrl(targetRace),venue_code:'10',race_number:3},race:targetRace,entries:targetEntries,now});
  assert.equal(normalized.ok,true);assert.equal(normalized.racers[1].winning_rate,5.67);
});

test('actual Tokuyama and Tokoname fixtures retain L, エ and absence without replacing published averages',()=>{
  const tokuyama=parseBoatcastWaku10(fs.readFileSync(new URL('./fixtures/boatcast_waku10_20261126_18_05.txt',import.meta.url),'utf8'));
  const tokoname=parseBoatcastWaku10(fs.readFileSync(new URL('./fixtures/boatcast_waku10_20261126_08_05.txt',import.meta.url),'utf8'));
  assert.equal(tokuyama.ok,true);assert.equal(tokoname.ok,true);
  assert.equal(tokuyama.racers.length,6);assert.equal(tokoname.racers.length,6);
  const minami=tokuyama.racers[0],takada=tokoname.racers[4],hosokawa=tokoname.racers[1];
  assert.equal(minami.normalized_source_name,'南佑典');assert.equal(minami.winning_rate,9);
  assert.equal(minami.sample_size,10);assert.equal(minami.normal_sample_size,8);assert.equal(minami.special_count,2);
  assert.equal(minami.history[0].finish_status,'L');assert.equal(minami.history[5].finish_status,'エ');
  assert.equal(takada.normalized_source_name,'高田ひかる');assert.equal(takada.winning_rate,5.2);
  assert.equal(takada.sample_size,10);assert.equal(takada.normal_sample_size,9);assert.equal(takada.history[8].finish_status,'エ');
  assert.equal(hosokawa.normalized_source_name,'細川裕子');assert.equal(hosokawa.winning_rate,7.5);
  assert.equal(hosokawa.history.length,10);assert.equal(hosokawa.sample_size,9);assert.equal(hosokawa.normal_sample_size,9);
  assert.equal(hosokawa.absent_count,1);assert.equal(hosokawa.history[9].finish_status,'欠');
});

test('published 10.20 survives source parsing, durable storage and validation without clipping',async()=>{
  // Official Omura 2026-11-21 11R publishes 10.20 for ten first-place finishes.
  // https://www.omurakyotei.jp/yosou/syussou.php?day=20261121&race=11
  const text=sourceText({finishes:Array(10).fill('1'),overrides:{'0:1':'10.20','1:1':'13.00','2:1':'13.01'}});
  const parsed=parseBoatcastWaku10(text);assert.equal(parsed.ok,true);
  assert.equal(parsed.racers[0].winning_rate,10.2);assert.equal(parsed.racers[0].first_rate,100);
  assert.equal(parsed.racers[1].winning_rate,13);assert.equal(parsed.racers[2].winning_rate,null);
  const p=platform();
  await withFetch(async()=>responseText(text),async()=>{
    const saved=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true});
    assert.equal(saved.status,'READY');assert.equal(saved.rows[0].winning_rate,10.2);assert.equal(saved.rows[1].winning_rate,13);
    const reused=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:false});
    assert.equal(reused.status,'READY');assert.equal(reused.rows[0].winning_rate,10.2);
    assert.equal(p.rows[0].parser_revision,'BOATCAST_WAKU10_PARSER_1');
  });
});

test('blank values stay null, actual zero is retained, and empty history is not ten observations',()=>{
  const parsed=parseBoatcastWaku10(sourceText({finishes:[],overrides:{'0:1':'','0:2':'','0:3':'','1:1':'0','1:2':'0','1:3':'0'}}));
  assert.equal(parsed.ok,true);const [empty,zero]=parsed.racers;
  assert.equal(empty.history.length,0);assert.equal(empty.sample_size,0);assert.equal(empty.first_rate,null);
  assert.equal(empty.winning_rate,null);assert.equal(empty.avg_st,null);assert.equal(empty.avg_start_order,null);
  assert.equal(zero.winning_rate,0);assert.equal(zero.avg_st,0);assert.equal(zero.avg_start_order,null);
});

test('unknown finishes, inconsistent statuses, missing racer rows, and invalid actual courses fail closed',()=>{
  assert.equal(parseBoatcastWaku10(sourceText({finishes:['?']})).reason,'SOURCE_FINISH_UNKNOWN');
  assert.equal(parseBoatcastWaku10(sourceText({overrides:{'0:5':'9'}})).reason,'SOURCE_COURSE_INVALID');
  assert.equal(parseBoatcastWaku10(sourceText().split('\n').slice(0,-1).join('\n')).ok,false);
  assert.equal(summarizeRecentLaneHistory([{finish_order:1,finish_status:'F'}]).ok,false);
  assert.equal(classifyRecentLaneFinish('Ｆ').kind,'SPECIAL');assert.equal(classifyRecentLaneFinish('K1').kind,'ABSENT');
});

test('source names must match saved entrants; official aliases do not change the persistent lineup key',async()=>{
  const now=new Date().toISOString(),raw=entries(),rich=structuredClone(raw);
  rich[0].v8_racer_profile={revision:'V8_RACER_PROFILE_1',registration_number:'4501',player_name:'長田 雄樹',source:{available_at:'2026-01-01T00:00:00Z'}};
  assert.equal(normalizeRecentLaneName('長田　雄樹（福岡県）'),'長田雄樹');
  assert.equal((await buildRecentLaneIdentity(race,raw,now)).snapshot_key,(await buildRecentLaneIdentity(race,rich,now)).snapshot_key);
  const good=await normalizeRecentLaneSource({text:sourceText(),metadata:metadata(now),race,entries:raw,now});
  assert.equal(good.ok,true);assert.equal(good.racers[0].registration_number,'4501');
  const bad=await normalizeRecentLaneSource({text:sourceText({overrides:{'0:0':'別人太郎'}}),metadata:metadata(now),race,entries:raw,now});
  assert.equal(bad.reason,'SOURCE_NAME_MISMATCH');
  raw[1].registration_number=raw[0].registration_number;
  assert.equal((await buildRecentLaneIdentity(race,raw,now)).reason,'ENTRY_IDENTITY_DUPLICATE');
});

test('future source times and mismatched source URL/race identifiers are rejected',async()=>{
  const now=new Date().toISOString();
  for(const patch of [{fetched_at:new Date(Date.now()+60000).toISOString()},{source_url:'https://example.test/wrong'},{race_number:2}]){
    const result=await normalizeRecentLaneSource({text:sourceText(),metadata:{...metadata(now),...patch},race,entries:entries(),now});
    assert.equal(result.reason,'SOURCE_METADATA_INVALID');
  }
});

test('one saved snapshot is shared by capture and UI without refetches or READY updates',async()=>{
  const p=platform();let fetches=0;
  await withFetch(async()=>{fetches++;return responseText(sourceText());},async()=>{
    const first=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true});
    assert.equal(first.status,'READY');assert.equal(fetches,1);assert.equal(p.calls.creates,1);assert.equal(p.calls.updates,0);
    assert.equal(first.rows.length,6);assert.equal(first.rows[0].snapshot_id,p.rows[0].id);
    assert.ok(Date.parse(first.rows[0].available_at)>=Date.parse(first.rows[0].fetched_at));
    const before=structuredClone(p.rows);
    const second=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:false});
    assert.equal(second.status,'READY');assert.equal(second.rows[0].row_hash,first.rows[0].row_hash);assert.equal(fetches,1);
    assert.deepEqual(p.rows,before);assert.equal(p.calls.updates,0);
    const ui=recentLaneSnapshotResponse(second);
    assert.equal(ui.metadata.snapshot_id,first.rows[0].snapshot_id);assert.equal(ui.rows[0].winning_rate,ui.racers[0].winRate);
    second.rows[0].history[0].finish_order=6;assert.equal(p.rows[0].racers[0].history[0].finish_order,1);
  });
});

test('concurrent missing-snapshot requests share one source acquisition and one saved row',async()=>{
  const p=platform();let fetches=0;
  await withFetch(async()=>{fetches++;return responseText(sourceText());},async()=>{
    const results=await Promise.all([1,2].map(()=>ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true})));
    assert.equal(fetches,1);assert.equal(p.calls.creates,1);assert.ok(results.every(row=>row.status==='READY'));
    assert.equal(results[0].rows[0].snapshot_id,results[1].rows[0].snapshot_id);
  });
});

test('404 waits 30 minutes and transport/server failure waits 5 minutes without repeated HTTP',async()=>{
  for(const status of [404,503]){
    const p=platform();let fetches=0;
    await withFetch(async()=>{fetches++;return new Response('',{status});},async()=>{
      const first=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true});
      assert.equal(first.status,'FAILED');assert.equal(p.rows.length,1);
      const delay=Date.parse(p.rows[0].next_retry_at)-Date.parse(p.rows[0].attempted_at);
      assert.ok(delay>=(status===404?30:5)*60000&&delay<(status===404?30:5)*60000+2000);
      const retry=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:true});
      assert.equal(retry.status,'COOLDOWN');assert.equal(fetches,1);assert.equal(p.calls.updates,0);
    });
  }
});

test('future, edited, and duplicate READY records cannot enter the forecast',async()=>{
  const p=platform();
  await withFetch(async()=>responseText(sourceText()),async()=>{
    const result=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true});assert.equal(result.status,'READY');
    const future={...structuredClone(p.rows[0]),updated_date:new Date(Date.now()+60000).toISOString()};
    assert.equal((await validateRecentLaneSnapshot(future,{race,entries:entries(),now:new Date().toISOString()})).status,'INVALID');
    const edited=structuredClone(p.rows[0]);edited.racers[0].registration_number='4999';
    assert.equal((await validateRecentLaneSnapshot(edited,{race,entries:entries(),now:new Date().toISOString()})).reason,'SNAPSHOT_CONTENT_HASH_INVALID');
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[p.rows[0],{...p.rows[0],id:'duplicate'}],allowFetch:true})).status,'CONFLICT');
  });
});

test('a READY row created by another isolate cannot be overwritten after a stale FAILED read',async()=>{
  const p=platform();
  await withFetch(async()=>new Response('',{status:503}),async()=>{
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true})).status,'FAILED');
  });
  p.rows[0].next_retry_at=new Date(Date.now()-1000).toISOString();
  const update=p.entity.updateMany;
  p.entity.updateMany=async(q,change)=>{
    const now=new Date().toISOString(),other=await normalizeRecentLaneSource({text:sourceText({finishes:['6','5','4']}),metadata:metadata(now),race,entries:entries(),now});
    p.rows[0]={...p.rows[0],status:'READY',racers:other.racers,content_hash:other.content_hash,
      fetched_at:now,next_retry_at:null,reason:null,updated_date:new Date().toISOString()};
    const written=await update(q,change);assert.equal(written.modified_count,0);return written;
  };
  await withFetch(async()=>responseText(sourceText()),async()=>{
    const result=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:true});
    assert.equal(result.status,'READY');assert.equal(result.rows[0].history[0].finish_order,6);
    assert.equal(p.rows.length,1);assert.equal(p.calls.creates,1);
  });
});

test('cross-isolate duplicate creation is held and cannot trigger endless additional acquisitions',async()=>{
  const p=platform(),create=p.entity.create;let fetches=0;
  p.entity.create=async record=>{
    const first=await create(record);p.rows.push({...structuredClone(first),id:'other-isolate'});return first;
  };
  await withFetch(async()=>{fetches++;return responseText(sourceText());},async()=>{
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true})).status,'CONFLICT');
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:true})).status,'CONFLICT');
    assert.equal(fetches,1);assert.equal(p.rows.length,2);assert.equal(p.calls.creates,1);
  });
});

test('one active snapshot plus retired records is reusable, while two active records still conflict',async()=>{
  const p=platform();
  await withFetch(async()=>responseText(sourceText()),async()=>{
    const result=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true});
    assert.equal(result.status,'READY');
  });
  const active=structuredClone(p.rows[0]),retired={...structuredClone(active),id:'retired',status:'SUPERSEDED',
    superseded_at:new Date().toISOString(),superseded_reason:'PUBLISHED_RATE_REPARSE'};
  await withFetch(async()=>{throw new Error('must not fetch');},async()=>{
    const reusable=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[retired,active],allowFetch:true});
    assert.equal(reusable.status,'READY');assert.equal(reusable.snapshot.id,active.id);
    const duplicate={...structuredClone(active),id:'active-duplicate'};
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[retired,active,duplicate],allowFetch:true})).status,'CONFLICT');
    assert.equal(p.calls.creates,1);assert.equal(p.calls.updates,0);
  });
});

test('retired-only cache can append a new READY observation without modifying the retired payload',async()=>{
  const p=platform();
  await withFetch(async()=>responseText(sourceText()),async()=>{
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true})).status,'READY');
  });
  // Administrative retirement is supplied by the caller; the normal API has no retirement operation.
  p.rows[0].status='SUPERSEDED';p.rows[0].superseded_at=new Date().toISOString();p.rows[0].superseded_reason='PUBLISHED_RATE_REPARSE';
  const before=structuredClone(p.rows[0]);let fetches=0;
  await withFetch(async()=>{fetches++;return responseText(sourceText({overrides:{'0:1':'10.20'}}));},async()=>{
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:false})).status,'MISSING');
    const replacement=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:true});
    assert.equal(replacement.status,'READY');assert.equal(replacement.rows[0].winning_rate,10.2);
    assert.equal(replacement.snapshot.snapshot_key,before.snapshot_key);assert.notEqual(replacement.snapshot.id,before.id);
    assert.equal(p.rows.length,2);assert.deepEqual(p.rows[0],before);assert.equal(p.calls.updates,0);assert.equal(fetches,1);
    const reused=await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:p.rows,allowFetch:false});
    assert.equal(reused.status,'READY');assert.equal(reused.snapshot.id,replacement.snapshot.id);
  });
});

test('batch loading is one DB query and incomplete reads never cause source acquisition',async()=>{
  const p=platform([{id:'x',race_id:'r1'},{id:'y',race_id:'r2'}]);
  const batch=await loadRecentLaneSnapshots(p.client.asServiceRole.entities,{raceIds:['r1','r2','r1']});
  assert.equal(batch.status,'READY');assert.equal(p.calls.reads.length,1);assert.equal(batch.byRaceId.size,2);
  const bad={V8RecentLaneSnapshot:{filter:async()=>[]}};
  assert.equal((await loadRecentLaneSnapshots(bad,{raceIds:['r1']})).status,'READ_FAILED');
  await withFetch(async()=>{throw new Error('must not fetch');},async()=>{
    assert.equal((await ensureRecentLaneSnapshot({asServiceRole:{entities:bad}},{race,entries:entries(),allowFetch:true})).status,'READ_FAILED');
  });
});

test('anonymous/cache-only and exhausted-budget requests do not fetch or write',async()=>{
  const p=platform();
  await withFetch(async()=>{throw new Error('must not fetch');},async()=>{
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:false})).status,'MISSING');
    assert.equal((await ensureRecentLaneSnapshot(p.client,{race,entries:entries(),cached:[],allowFetch:true,budget:Date.now()+2000})).status,'BUDGET');
    assert.equal(p.calls.creates,0);assert.equal(p.calls.updates,0);
  });
});

test('bounded common-client calls abort the actual request and do not retry',async()=>{
  let calls=0,aborted=false;
  await withFetch(async(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));},async()=>{
    // Keep the process alive while exercising AbortSignal.timeout's unref timer.
    const keeper=setInterval(()=>{},1000);
    try{
      const result=await fetchBoatcastText({venueCode:'23',raceDate:race.race_date,raceNumber:1,dataType:'WAKU10',timeoutMs:10,maxRetries:0});
      assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(aborted,true);
    }finally{clearInterval(keeper);}
  });
});

test('endpoint permits anonymous saved reads but only authenticated requests acquire a missing source',async()=>{
  const p=platform();let authenticated=false,fetches=0;
  p.client.auth={me:async()=>authenticated?{id:'user'}:null};
  p.client.asServiceRole.entities.Race={filter:async()=>({items:[race],has_more:false,next_cursor:null})};
  p.client.asServiceRole.entities.RaceEntry={filter:async()=>({items:entries(),has_more:false,next_cursor:null})};
  const source=fs.readFileSync(new URL('../base44/functions/fetchBoatcastWaku10/entry.ts',import.meta.url),'utf8')
    .replace(/^import .*\n/gm,'').replace('export default async function(req:Request)','return async function(req)');
  const handler=new Function('createClientFromRequest','dateValid','readV8Rows','loadRecentLaneSnapshots','ensureRecentLaneSnapshot','recentLaneSnapshotResponse',source)
    (()=>p.client,dateValid,readV8Rows,loadRecentLaneSnapshots,ensureRecentLaneSnapshot,recentLaneSnapshotResponse);
  const request=()=>new Request('https://test.local',{method:'POST',body:JSON.stringify({race_id:race.id,race_key:race.race_key,race_date:race.race_date,venue_code:race.venue_code,race_number:1})});
  await withFetch(async()=>{fetches++;return responseText(sourceText());},async()=>{
    assert.equal((await (await handler(request())).json()).status,'MISSING');assert.equal(fetches,0);
    authenticated=true;const created=await (await handler(request())).json();assert.equal(created.ok,true);assert.equal(fetches,1);
    authenticated=false;const saved=await (await handler(request())).json();assert.equal(saved.ok,true);assert.equal(fetches,1);
    assert.equal(created.rows[0].snapshot_id,saved.rows[0].snapshot_id);assert.equal(created.rows[0].row_hash,saved.rows[0].row_hash);
  });
});
