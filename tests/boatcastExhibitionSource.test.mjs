import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fetchBoatcastExhibitionSource} from '../base44/shared/boatcastExhibitionSource.js';
import {buildCommittedExhibitionKey} from '../base44/shared/exhibitionInputKey.js';

const NOW=Date.parse('2026-11-28T02:41:41Z');
const files=new URL('./fixtures/boatcast-exhibition/',import.meta.url);
const fixture=Object.fromEntries(['TKZ','STT'].map(type=>[type,fs.readFileSync(new URL(`bc_j_${type.toLowerCase()}_20261128_03_02.txt`,files),'utf8')]));
const race={id:'race-edogawa-2',race_key:'2026-11-28_03_02',race_date:'2026-11-28',venue_code:'03',race_number:2,scratched_boats:[]};
const names=['坪内実','野村誠','須藤博倫','佐藤右京','成田華音','鈴木雄登'];
const registrations=['3370','4486','3983','5292','5466','5441'];
const entries=names.map((player_name,index)=>({id:'entry-'+(index+1),race_id:race.id,race_key:race.race_key,race_date:race.race_date,
  boat_number:index+1,player_name,registration_number:registrations[index],exhibition_time:9,exhibition_st:.99,exhibition_course:index+1}));
const response=(type,overrides={})=>({ok:true,text:fixture[type],metadata:{source:'BOATCAST',http_status:200,
  data_type:type,source_url:`https://race.boatcast.jp/hp_txt/03/bc_j_${type.toLowerCase()}_20261128_03_02.txt`,
  race_date:race.race_date,venue_code:'03',race_number:2,fetched_at:new Date(NOW-1000).toISOString(),cache:'MISS'},...overrides});
const changeRow=(text,index,transform)=>{
  const lines=text.split('\n');lines[index+2]=transform(lines[index+2].split('\t')).join('\t');return lines.join('\n');
};
const changeTkzStart=(text,boat,value,flag='')=>{
  const lines=text.split('\n'),parts=lines[8].split('\t');parts[(boat-1)*3+1]=value;parts[(boat-1)*3+2]=flag;
  lines[8]=parts.join('\t');return lines.join('\n');
};
const run=(modify=()=>{},options={})=>{
  const calls=[],sources={TKZ:response('TKZ'),STT:response('STT')};modify(sources);
  const promise=fetchBoatcastExhibitionSource({race,entries,deadlineMs:NOW+5000,now:()=>NOW,
    fetcher:async args=>{calls.push(args);return sources[args.dataType];},...options});
  return {promise,calls,sources};
};

test('real Edogawa pair reproduces all six official values, including F and .73, without old local values',async()=>{
  const before=JSON.stringify({race,entries}),state=run(),result=await state.promise;
  assert.equal(result.ok,true);assert.equal(result.data.real_exhibition_count,6);
  assert.deepEqual(result.data.entries.map(row=>row.exhibition_time),[6.78,6.85,6.71,6.81,6.79,6.71]);
  assert.deepEqual(result.data.entries.map(row=>row.exhibition_st),[-.04,.04,.73,.12,.11,.12]);
  assert.deepEqual(result.data.entries.map(row=>row.exhibition_st_raw),[-.04,.04,.73,.12,.11,.12]);
  assert.deepEqual(result.data.entries.map(row=>row.exhibition_course),[1,2,3,4,5,6]);
  assert.equal(result.data.entries[0].exhibition_st===.23,false,'STT column 3 is not the exhibition ST');
  assert.ok(buildCommittedExhibitionKey(race,result.data.entries));
  assert.equal(JSON.stringify({race,entries}),before);assert.equal(result.source.provider,'BOATCAST');
  assert.equal(result.source.urls.length,2);assert.equal(result.source.captured_at,new Date(NOW-1000).toISOString());
  assert.equal(state.calls.length,2);for(const call of state.calls){assert.equal(call.maxRetries,0);assert.ok(call.timeoutMs<=4000);}
});

test('observed entry-course change follows the explicit boat identity rather than row position',async()=>{
  const {promise}=run(sources=>{
    let text=changeRow(sources.STT.text,1,p=>{p[0]='3';return p;});
    text=changeRow(text,2,p=>{p[0]='2';return p;});
    const lines=text.split('\n');[lines[3],lines[4]]=[lines[4],lines[3]];sources.STT.text=lines.join('\n');
  });
  const result=await promise;assert.equal(result.ok,true);
  assert.deepEqual(result.data.entries.map(row=>row.exhibition_course),[1,3,2,4,5,6]);
  assert.equal(result.data.entries[1].exhibition_st,.04);assert.equal(result.data.entries[2].exhibition_st,.73);
});

test('missing source boats are not completed from the six fully populated local entries',async()=>{
  for(const type of ['TKZ','STT']){
    const {promise}=run(sources=>{const lines=sources[type].text.split('\n');lines.splice(4,1);sources[type].text=lines.join('\n');});
    const result=await promise;assert.equal(result.ok,false);assert.equal(result.data,undefined);
  }
});

test('conflicting names, boats, courses and observed starts are rejected',async t=>{
  const cases={
    tkz_name:s=>{s.TKZ.text=changeRow(s.TKZ.text,0,p=>{p[0]='別人';return p;});},
    stt_name:s=>{s.STT.text=changeRow(s.STT.text,0,p=>{p[2]='別人';return p;});},
    repeated_boat:s=>{s.STT.text=changeRow(s.STT.text,1,p=>{p[1]='1';return p;});},
    repeated_course:s=>{s.STT.text=changeRow(s.STT.text,1,p=>{p[0]='1';return p;});},
    st_conflict:s=>{s.STT.text=changeRow(s.STT.text,0,p=>{p[4]='.09';return p;});},
    f_conflict:s=>{s.STT.text=changeRow(s.STT.text,0,p=>{p[5]='';return p;});},
    missing_time:s=>{s.TKZ.text=changeRow(s.TKZ.text,0,p=>{p[1]='';return p;});},
    unknown_flag:s=>{s.STT.text=changeRow(s.STT.text,0,p=>{p[5]='?';return p;});},
  };
  for(const [label,mutate] of Object.entries(cases))await t.test(label,async()=>{
    const result=await run(mutate).promise;assert.equal(result.ok,false);assert.equal(result.data,undefined);
  });
});

test('observed L and F.00 never become a normal numeric zero in the existing numeric entity schema',async()=>{
  for(const [value,flag] of [['L',''],['.00','F'],['-.00','']]){
    const result=await run(s=>{
      s.TKZ.text=changeTkzStart(s.TKZ.text,1,value,flag);
      s.STT.text=changeRow(s.STT.text,0,p=>{p[4]=value;p[5]=flag;return p;});
    }).promise;
    assert.equal(result.ok,false);assert.equal(result.reason,'SOURCE_START_FLAG_UNREPRESENTABLE');assert.equal(result.data,undefined);
  }
});

test('an observed exact normal zero is accepted when both independent fields agree',async()=>{
  const result=await run(s=>{
    s.TKZ.text=changeTkzStart(s.TKZ.text,1,'.00','');
    s.STT.text=changeRow(s.STT.text,0,p=>{p[4]='.00';p[5]='';return p;});
  }).promise;
  assert.equal(result.ok,true);assert.equal(result.data.entries[0].exhibition_st,0);
});

test('roster, registration and race identity conflicts fail before contacting the source',async()=>{
  const variants=[entries.slice(0,5),entries.map((x,i)=>i===0?{...x,race_id:'wrong'}:x),
    entries.map((x,i)=>i===0?{...x,registration_number:'4486'}:x),
    entries.map((x,i)=>i===0?{...x,register_number:'9999'}:x),entries.map((x,i)=>i===0?{...x,racer_name:'別人'}:x)];
  for(const roster of variants){const state=run(()=>{},{entries:roster}),result=await state.promise;
    assert.equal(result.ok,false);assert.equal(result.reason,'SOURCE_ROSTER_UNCONFIRMED');assert.equal(state.calls.length,0);}
});

test('the strict fallback does not infer an absent boat from missing numeric observations',async()=>{
  const state=run(()=>{},{race:{...race,scratched_boats:[6]}}),result=await state.promise;
  assert.equal(result.ok,false);assert.equal(result.reason,'SCRATCHED_ROSTER_REQUIRES_OFFICIAL_SOURCE');assert.equal(state.calls.length,0);
});

test('HTTP403 remains an explicit unavailable source with no immediate retry or local-value fallback',async()=>{
  const state=run(s=>{s.TKZ={ok:false,status:403};}),result=await state.promise;
  assert.equal(result.ok,false);assert.equal(result.http_status,403);assert.equal(result.reason,'SOURCE_HTTP_403');
  assert.equal(result.data,undefined);assert.equal(state.calls.length,2);assert.ok(state.calls.every(call=>call.maxRetries===0));
});

test('source metadata must identify the requested race and retain its actual acquisition time',async()=>{
  for(const update of [{race_date:'2026-11-27'},{venue_code:'04'},{race_number:3},{data_type:'RS1'},
    {source_url:'https://example.invalid/same-name.txt'},{fetched_at:new Date(NOW+1000).toISOString()},
    {fetched_at:new Date(NOW-300001).toISOString()}]){
    const result=await run(s=>Object.assign(s.TKZ.metadata,update)).promise;
    assert.equal(result.ok,false);assert.equal(result.data,undefined);
  }
  const cached=await run(s=>{for(const source of Object.values(s)){source.metadata.cache='HIT';source.metadata.fetched_at=new Date(NOW-120000).toISOString();}}).promise;
  assert.equal(cached.ok,true);assert.equal(cached.source.captured_at,new Date(NOW-120000).toISOString());
  const skewed=await run(s=>{s.TKZ.metadata.fetched_at=new Date(NOW-30000).toISOString();}).promise;
  assert.equal(skewed.ok,false);assert.equal(skewed.reason,'SOURCE_PAIR_TIME_MISMATCH');
});

test('expired work budgets stop before fetch, and observations returned too late are not committed',async()=>{
  const early=run(()=>{},{deadlineMs:NOW}),result=await early.promise;
  assert.equal(result.reason,'SOURCE_TIME_BUDGET');assert.equal(early.calls.length,0);
  let clock=NOW;
  const late=await fetchBoatcastExhibitionSource({race,entries,deadlineMs:NOW+1000,now:()=>clock,
    fetcher:async({dataType})=>{clock=NOW+1001;return response(dataType);}});
  assert.equal(late.reason,'SOURCE_TIME_BUDGET');assert.equal(late.data,undefined);
});

test('known source transport errors are reported, while implementation and unknown failures propagate',async()=>{
  const transport=await run(()=>{},{fetcher:async()=>{throw Object.assign(new Error('unavailable'),{code:'ECONNRESET'});}}).promise;
  assert.equal(transport.reason,'SOURCE_TRANSPORT_UNAVAILABLE');
  const denied=await run(()=>{},{fetcher:async()=>{throw Object.assign(new Error('denied'),{response:{status:403}});}}).promise;
  assert.equal(denied.http_status,403);
  for(const error of [new TypeError('programming failure'),new Error('unknown failure')])
    await assert.rejects(run(()=>{},{fetcher:async()=>{throw error;}}).promise,e=>e===error);
});

test('one unavailable public response does not hide a programming failure in the other parallel request',async()=>{
  const error=new TypeError('programming failure');
  await assert.rejects(run(()=>{},{fetcher:async({dataType})=>{
    if(dataType==='TKZ')throw Object.assign(new Error('denied'),{response:{status:403}});
    throw error;
  }}).promise,e=>e===error);
});
