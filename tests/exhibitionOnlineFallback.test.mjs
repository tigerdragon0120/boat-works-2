// Exercise the actual manual handler, source selection and commit processing.
// Only network responses, entity storage and the forecast worker are replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readV8Rows} from '../base44/shared/v8Repository.js';
import {buildCommittedExhibitionKey} from '../base44/shared/exhibitionInputKey.js';
import {buildRaceKey} from '../base44/shared/raceKey.js';
import {buildUrl} from '../base44/shared/boatraceOfficialParser.js';
import {fetchExhibitionSource} from '../base44/shared/exhibitionSource.js';
import {fetchBoatcastExhibitionSource} from '../base44/shared/boatcastExhibitionSource.js';
import {fetchOriginalExhibition} from '../base44/shared/originalExhibition.js';

const source=readFileSync(new URL('../base44/functions/fetchOnlineData/entry.ts',import.meta.url),'utf8');
const executable=stripTypeScriptTypes(source.replace(/^import .*;\r?$/gm,''))
  .replace('export default async function','return async function');
const NOW=Date.parse('2026-11-28T02:20:00Z'),OLD=new Date(NOW-60000).toISOString();
const urlFor=type=>`https://race.boatcast.jp/hp_txt/03/bc_j_${type.toLowerCase()}_20261128_03_02.txt`;

function setup(t,{mode='fallback',legacyFailure=false,user={role:'admin'}}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const race={id:'race-1',race_key:'2026-11-28_03_02',race_date:'2026-11-28',venue_code:'03',race_number:2,
    deadline:new Date(NOW+840000).toISOString(),status:'scheduled',exhibition_ready:mode==='partial',
    original_exhibition:{status:'UNAVAILABLE',reasons:['HTTP_403']}};
  const entries=Array.from({length:6},(_,i)=>({id:'entry-'+(i+1),race_id:race.id,race_key:race.race_key,
    boat_number:i+1,registration_number:String(4001+i),player_name:'選手'+(i+1),
    ...(mode==='partial'?{exhibition_time:6.8,exhibition_st:.2,exhibition_st_raw:.2,exhibition_course:i+1}:{})}));
  if(mode==='partial'){
    race.exhibition_input_key=buildCommittedExhibitionKey(race,entries);race.exhibition_committed_at=OLD;
    race.exhibition_collection={provider:'BOATRACE',captured_at:OLD,input_key:race.exhibition_input_key};
  }
  const prior=structuredClone(race),events=[],requests=[],originalInputs=[];
  const logs=legacyFailure?[{fetch_type:'exhibition',race_date:race.race_date,venue_code:'03',race_number:2,
    status:'no_data',http_status:403,error_message:'HTTP 403',fetched_at:OLD}]:[];
  const account={user};
  const entities={
    Race:{filter:async query=>{events.push('race:read');assert.deepEqual(query,{race_key:race.race_key});return [structuredClone(race)];},
      update:async(id,patch)=>{events.push('race:write');assert.equal(id,race.id);Object.assign(race,patch);return structuredClone(race);}},
    RaceEntry:{filter:async query=>{events.push('roster:read');assert.deepEqual(query,{race_key:race.race_key});
      return {items:structuredClone(entries),has_more:false,next_cursor:null};},
      update:async(id,patch)=>{events.push('entry:'+id);const row=entries.find(entry=>entry.id===id);Object.assign(row,patch);return structuredClone(row);}},
    OnlineFetchLog:{filter:async(query,sort,limit)=>{
      events.push('log:read');assert.equal(sort,'-fetched_at');
      const matches=logs.filter(log=>Object.entries(query).every(([key,value])=>
        value&&typeof value==='object'&&Array.isArray(value.$in)?value.$in.includes(log[key]):log[key]===value));
      return structuredClone(matches.slice().reverse().slice(0,limit));
    },create:async doc=>{events.push('log:'+doc.status);logs.push(structuredClone(doc));return {id:'log-'+logs.length,...doc};}},
  };
  const client={auth:{me:async()=>{events.push('auth');return account.user;}},asServiceRole:{entities}};
  const partial=entries.map(row=>({...row,exhibition_time:6.7,exhibition_st:.1,exhibition_st_raw:.1}));
  delete partial[1].exhibition_st;delete partial[1].exhibition_st_raw;
  const tkz=['data=','1',...entries.map(row=>`${row.player_name}\t6.70\t0\t0\t0\t0\t0.0`),
    entries.flatMap(row=>[String(row.boat_number),row.boat_number===1?'.04':'.10',row.boat_number===1?'F':'']).join('\t')].join('\n');
  const stt=['data=','1',...entries.map(row=>`${row.boat_number}\t${row.boat_number}\t${row.player_name}\t0\t${row.boat_number===1?'.04\tF':'.10\t'}`)].join('\n');
  const originalText=['data=','1\t1','一周',...entries.map(row=>`${row.boat_number}\t${row.player_name}\t36.00`)].join('\n');
  const dependencies={createClientFromRequest:()=>client,buildRaceKey,buildUrl,readV8Rows,buildCommittedExhibitionKey,
    fetchExhibitionSource:async options=>{
      assert.equal(options.race.id,race.id);assert.equal(options.entries.length,6);assert.equal(options.deadlineMs,Date.now()+12000);
      return fetchExhibitionSource({...options,
        fetchOfficial:async(url,retries)=>{requests.push('primary');assert.equal(retries,0);
          assert.equal(url,buildUrl('beforeinfo',race.race_date,'03',2));
          return mode==='partial'?{ok:true,status:200,html:'partial-fixture'}:{ok:false,status:403,error:'HTTP 403'};},
        parseOfficial:()=>({ok:true,data:{entries:structuredClone(partial),scratched_boats:[],real_exhibition_count:5,active_boat_count:6}}),
        fetchBackup:options=>fetchBoatcastExhibitionSource({...options,fetcher:async({dataType})=>{
          requests.push(dataType);
          if(mode!=='fallback')return {ok:false,status:403};
          return {ok:true,text:dataType==='TKZ'?tkz:stt,metadata:{source:'BOATCAST',http_status:200,data_type:dataType,
            race_date:race.race_date,venue_code:'03',race_number:2,source_url:urlFor(dataType),
            fetched_at:new Date(NOW-(dataType==='TKZ'?1000:500)).toISOString(),cache:'MISS'}};
        }}),
      });
    },
    fetchOriginalExhibition:async options=>{
      originalInputs.push(structuredClone(options));
      return fetchOriginalExhibition({...options,fetcher:async url=>{
        assert.equal(url,'https://race.boatcast.jp/txt/03/bc_oriten_20261128_03_02.txt');
        return new Response(originalText,{status:200});
      }});
    },
    runV8LiveGeneration:async(_client,options)=>{
      events.push('forecast');assert.deepEqual(options.race_keys,[race.race_key]);
      assert.equal(race.exhibition_input_key,buildCommittedExhibitionKey(race,entries));
      assert.equal(race.exhibition_committed_at,new Date(NOW).toISOString());return {ok:true,v8:{final:1}};
    },
    fetchHtml:()=>assert.fail('exhibition must use source selection, not the legacy direct HTML path'),
  };
  const handler=new Function(...Object.keys(dependencies),executable)(...Object.values(dependencies));
  return {race,prior,entries,logs,events,requests,originalInputs,account,run:()=>handler(new Request('https://app.invalid/fetchOnlineData',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fetch_type:'exhibition',race_date:race.race_date,venue_code:'03',race_number:2}),
  }))};
}

test('a legacy primary-only 403 permits BOATCAST fallback and commits its actual six-boat source before forecasting',async t=>{
  const state=setup(t,{legacyFailure:true}),response=await state.run(),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.ok,true);assert.equal(body.exhibition_committed,true);
  assert.deepEqual(state.requests,['primary','TKZ','STT']);assert.equal(body.entries_updated,6);
  assert.equal(state.events.filter(event=>event.startsWith('entry:')).length,6);
  assert.deepEqual(state.events.slice(-3),['race:write','forecast','log:success']);
  assert.equal(state.race.exhibition_ready,true);
  assert.deepEqual(JSON.parse(state.race.exhibition_input_key).boats[0][3],[-.04,'F']);
  assert.equal(state.race.exhibition_collection.provider,'BOATCAST');
  assert.equal(state.race.exhibition_collection.primary_http_status,403);
  assert.equal(state.race.exhibition_collection.input_key,buildCommittedExhibitionKey(state.race,state.entries));
  assert.deepEqual(state.race.exhibition_collection.urls,[urlFor('TKZ'),urlFor('STT')]);
  assert.equal(state.race.exhibition_collection.captured_at,new Date(NOW-500).toISOString());
  assert.equal(state.originalInputs[0].exhibitionSourceUrl,urlFor('TKZ'));
  assert.equal(state.originalInputs[0].exhibitionCapturedAt,new Date(NOW-500).toISOString());
  assert.equal(state.race.original_exhibition.status,'AVAILABLE');
  assert.equal(state.race.original_exhibition.entries.length,6);
  assert.equal(state.race.original_exhibition.entries[0].lap_time,36);
});

test('failure of both sources preserves saved data and keeps cooldown across repeated requests without extending it',async t=>{
  const state=setup(t,{mode:'unavailable'}),before=structuredClone(state.entries);
  const first=await(await state.run()).json();
  assert.equal(first.ok,false);assert.equal(first.status,'no_data');
  assert.equal(state.logs.at(-1).http_status,403);assert.match(state.logs.at(-1).error_message,/^EXHIBITION_SOURCES_UNAVAILABLE:/);
  for(let attempt=0;attempt<2;attempt++){
    t.mock.timers.tick(60000);
    const body=await(await state.run()).json();assert.equal(body.status,'skipped');assert.equal(body.ok,false);
  }
  assert.deepEqual(state.requests,['primary','TKZ','STT']);
  assert.deepEqual(state.race,state.prior);assert.deepEqual(state.entries,before);
  assert.equal(state.events.includes('forecast'),false);assert.equal(state.events.includes('race:write'),false);
  t.mock.timers.tick(180001);
  assert.equal((await(await state.run()).json()).status,'no_data');
  assert.deepEqual(state.requests,['primary','TKZ','STT','primary','TKZ','STT']);
});

test('a partial primary and unavailable fallback cannot turn an older READY marker into a successful new collection',async t=>{
  const state=setup(t,{mode:'partial'}),body=await(await state.run()).json();
  assert.equal(body.ok,false);assert.equal(body.status,'not_ready');assert.equal(body.exhibition_committed,false);
  assert.equal(body.exhibition_ready,true,'the older saved READY flag is preserved');
  assert.equal(body.forecasts,null);assert.equal(state.events.includes('forecast'),false);
  assert.equal(state.race.exhibition_input_key,state.prior.exhibition_input_key);
  assert.equal(state.race.exhibition_committed_at,state.prior.exhibition_committed_at);
  assert.deepEqual(state.race.exhibition_collection,state.prior.exhibition_collection);
  assert.equal(state.entries[0].exhibition_st,.1);assert.equal(state.entries[1].exhibition_st,.2);
  assert.equal(state.logs.at(-1).status,'not_ready');
});

test('unauthenticated and non-admin requests cannot read a roster, request fallback data or write entities',async t=>{
  const state=setup(t,{user:null});
  assert.equal((await state.run()).status,401);
  state.account.user={role:'user'};
  assert.equal((await state.run()).status,403);
  assert.deepEqual(state.events,['auth','auth']);assert.deepEqual(state.requests,[]);assert.deepEqual(state.logs,[]);
});
