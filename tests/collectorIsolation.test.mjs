import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readV8Rows} from '../base44/shared/v8Repository.js';
import {selectLiveInputRaces,isSavedExhibitionComplete} from '../base44/shared/liveInputPriority.js';
import {buildCommittedExhibitionKey} from '../base44/shared/exhibitionInputKey.js';

const source=readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts',import.meta.url),'utf8');
const NOW=Date.parse('2026-11-27T00:00:00Z'),TODAY='2026-11-27',TOMORROW='2026-11-28';
function bind(name,dependencies){
  const start=source.indexOf(`async function ${name}(`),end=source.indexOf('\n}',start)+2;
  assert.ok(start>=0&&end>start);
  return new Function(...Object.keys(dependencies),stripTypeScriptTypes(source.slice(start,end))+`\nreturn ${name};`)(...Object.values(dependencies));
}
const race=no=>({id:'race-'+no,race_key:TODAY+'_14_0'+no,race_date:TODAY,venue_code:'14',race_number:no,
  deadline:new Date(NOW+600000+no*60000).toISOString(),status:'scheduled',exhibition_ready:no===1,
  original_exhibition:{status:'AVAILABLE',saved_value:'keep-'+no}});
const boats=r=>Array.from({length:6},(_,i)=>({id:r.id+'-'+(i+1),race_id:r.id,race_key:r.race_key,boat_number:i+1,
  registration_number:String(4001+i),player_name:'選手'+i,exhibition_time:6.7,exhibition_st:i===0?0:.1,
  exhibition_st_raw:i===0?0:.1,exhibition_course:i+1}));

for(const failure of ['read','truncated','identity'])test(`failed ${failure} of the first race preserves saved READY and original data while the next race proceeds`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const races=[race(1),race(2)],original=structuredClone(races[0]),writes=[],errors=[],originalCalls=[],sourceCalls=[];
  const rows=races.flatMap(boats);
  const entities={Race:{filter:async()=>structuredClone(races),update:async(id,patch)=>{
    writes.push({id,patch});Object.assign(races.find(row=>row.id===id),patch);return {id,...patch};
  }},RaceEntry:{filter:async query=>{
    const found=rows.filter(row=>row.race_key===query.race_key);
    if(query.race_key===races[0].race_key){
      if(failure==='read')throw new Error('stored read failed');
      if(failure==='truncated')return {items:found.slice(0,2),has_more:true,next_cursor:null};
      return {items:found.map(row=>({...row,race_id:'another-race'})),has_more:false,next_cursor:null};
    }
    return {items:structuredClone(found),has_more:false,next_cursor:null};
  },update:async()=>assert.fail('unchanged saved inputs need no writes')}};
  const run=bind('fetchAndSaveExhibition',{
    uniqueRacesByKey:rows=>rows,readV8Rows,selectLiveInputRaces,isSavedExhibitionComplete,buildCommittedExhibitionKey,VENUE_MAP:{'14':'鳴門'},
    fetchExhibitionSource:async({race,entries,deadlineMs,skipPrimary})=>{
      sourceCalls.push(race.id);assert.ok(deadlineMs<=NOW+30000);assert.equal(entries.length,6);assert.equal(skipPrimary,false);
      return {ok:true,complete:true,primary_http_status:200,
        data:{entries:boats(race),scratched_boats:[],real_exhibition_count:6,active_boat_count:6},
        source:{provider:'BOATRACE',url:'official-beforeinfo',urls:['official-beforeinfo'],captured_at:new Date(NOW).toISOString()}};
    },
    fetchOriginalExhibition:async({race})=>{originalCalls.push(race.id);return {snapshot:race.original_exhibition};},
    withRateLimitRetry:async fn=>fn(),sleep:async()=>{},runV8LiveGeneration:()=>assert.fail('collection must not invoke forecasts'),
  });
  const result=await run({asServiceRole:{entities}},TODAY,30000,[],errors,{liveOnly:true,deferForecasts:true});
  assert.deepEqual(races[0],original);assert.equal(writes.some(row=>row.id===original.id),false);
  assert.equal(races[1].exhibition_ready,true);assert.deepEqual(originalCalls,['race-2']);
  assert.deepEqual(sourceCalls,['race-2'],'source acquisition cannot run against an unconfirmed saved roster');
  assert.deepEqual(result.ready_keys,[races[1].race_key]);assert.equal(errors.length,1);
});

test('a complete BOATCAST fallback saves F values and skips a denied primary for the next race in the same batch',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const races=[race(1),race(2)].map(row=>({...row,exhibition_ready:false}));
  const incoming=races.flatMap(boats).map(row=>row.boat_number===1?{...row,exhibition_st:-.04,exhibition_st_raw:-.04}:row);
  const stored=incoming.map(({exhibition_time,exhibition_st,exhibition_st_raw,exhibition_course,...row})=>row);
  const sourceCalls=[],entryWrites=[],raceWrites=[],errors=[];
  const entities={Race:{filter:async()=>structuredClone(races),update:async(id,patch)=>{
    raceWrites.push({id,patch:structuredClone(patch)});Object.assign(races.find(row=>row.id===id),patch);return {id,...patch};
  }},RaceEntry:{filter:async query=>({items:structuredClone(stored.filter(row=>row.race_key===query.race_key)),has_more:false,next_cursor:null}),
    update:async(id,patch)=>{entryWrites.push(id);const row=stored.find(row=>row.id===id);Object.assign(row,patch);return structuredClone(row);}}};
  const run=bind('fetchAndSaveExhibition',{
    uniqueRacesByKey:rows=>rows,readV8Rows,selectLiveInputRaces,isSavedExhibitionComplete,buildCommittedExhibitionKey,VENUE_MAP:{'14':'鳴門'},
    fetchExhibitionSource:async({race,entries,deadlineMs,skipPrimary})=>{
      sourceCalls.push({id:race.id,skipPrimary});assert.equal(entries.length,6);assert.equal(deadlineMs,NOW+30000);
      const url='boatcast-fixture/'+race.race_key;
      return {ok:true,complete:true,primary_http_status:skipPrimary?null:403,
        data:{entries:structuredClone(incoming.filter(row=>row.race_key===race.race_key)),scratched_boats:[],real_exhibition_count:6,active_boat_count:6},
        source:{provider:'BOATCAST',url,urls:[url,url+'/starts'],captured_at:new Date(NOW).toISOString()}};
    },
    fetchOriginalExhibition:async({race})=>({snapshot:race.original_exhibition}),
    withRateLimitRetry:async fn=>fn(),sleep:async()=>{},runV8LiveGeneration:()=>assert.fail('deferred collection must not generate forecasts'),
  });
  const result=await run({asServiceRole:{entities}},TODAY,30000,[],errors,{liveOnly:true,deferForecasts:true});
  assert.deepEqual(sourceCalls,[{id:'race-1',skipPrimary:false},{id:'race-2',skipPrimary:true}]);
  assert.equal(entryWrites.length,12);assert.equal(raceWrites.length,2);
  for(const row of races){
    const entries=stored.filter(entry=>entry.race_key===row.race_key);
    assert.equal(row.exhibition_ready,true);assert.equal(entries[0].exhibition_st,-.04);assert.equal(entries[0].exhibition_st_raw,-.04);
    assert.equal(row.exhibition_input_key,buildCommittedExhibitionKey(row,entries));
    assert.deepEqual(JSON.parse(row.exhibition_input_key).boats[0][3],[-.04,'F']);
    assert.equal(row.exhibition_collection.provider,'BOATCAST');
    assert.equal(row.exhibition_collection.input_key,row.exhibition_input_key);
    assert.deepEqual(row.exhibition_collection.urls,['boatcast-fixture/'+row.race_key,'boatcast-fixture/'+row.race_key+'/starts']);
    assert.equal(row.exhibition_collection.captured_at,new Date(NOW).toISOString());
  }
  assert.deepEqual(result.ready_keys,races.map(row=>row.race_key));assert.deepEqual(errors,[]);
});

function auto(t,failures={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const calls=[],errors=[],logs=[];
  const phase=name=>async(_client,_date,budget)=>{
    calls.push({name,budget,at:Date.now()});
    if(failures[name]){t.mock.timers.tick(failures[name].spend||0);throw failures[name].error;}
    return {ok:true,updated:1,checked:2,fetched:1,saved:1,ready_keys:[],races:1,entries:6};
  };
  const run=bind('autoUpdate',{nowJSTTime:()=> '19:00',
    refreshOfficialDeadlines:async(client,{date,deadlineMs})=>{assert.equal(date,TODAY);return phase('deadlines')(client,date,deadlineMs-Date.now());},
    fetchAndSaveExhibition:phase('exhibition'),
    fetchLiveOdds:phase('odds'),fetchAndSaveResults:phase('results'),fetchAndSaveRaceCards:phase('cards')});
  return {calls,errors,run:()=>run({},TODAY,TOMORROW,80000,logs,errors)};
}

test('a failed exhibition phase does not restart saved work or stop odds and maintenance',async t=>{
  const state=auto(t,{exhibition:{error:new Error('upstream unavailable'),spend:30000}}),result=await state.run();
  assert.deepEqual(state.calls.map(row=>row.name),['deadlines','exhibition','odds','results','cards','cards']);
  assert.equal(result.ok,false);assert.equal(result.partial,true);assert.equal(result.failed,false);
  assert.equal(result.phases.find(row=>row.phase==='exhibition').status,'FAILED');assert.equal(state.errors.length,1);
  assert.ok(state.calls.every(row=>row.at+row.budget<=NOW+80000));
});

test('an exhausted phase returns deferred work for the next invocation without an extra retry budget',async t=>{
  const state=auto(t,{deadlines:{error:new Error('schedule unavailable')},exhibition:{error:new Error('deadline exceeded'),spend:80000}}),result=await state.run();
  assert.deepEqual(state.calls.map(row=>row.name),['deadlines','exhibition']);assert.equal(result.partial,true);
  assert.equal(result.failed,true);assert.equal(Date.now()-NOW,80000);
});

test('all acquisition failures remain explicitly failed rather than reporting successful zero counts',async t=>{
  const failures=Object.fromEntries(['deadlines','exhibition','odds','results','cards'].map(name=>[name,{error:new Error('unavailable')}]));
  const state=auto(t,failures),result=await state.run();
  assert.equal(result.ok,false);assert.equal(result.failed,true);assert.equal(result.phases.length,6);
  assert.ok(result.phases.every(row=>row.status==='FAILED'));assert.equal(state.errors.length,6);
});

for(const error of [Object.assign(new Error('forbidden'),{http_status:403}),new TypeError('invalid program input')]){
  test(`${error.name} ${error.http_status||'programming fault'} is not hidden as a routine partial acquisition`,async t=>{
    const state=auto(t,{exhibition:{error}});
    await assert.rejects(state.run(),e=>e===error);assert.deepEqual(state.calls.map(row=>row.name),['deadlines','exhibition']);
  });
}

test('card index acquisition receives a bounded timeout and the absolute phase deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  let observed;
  const run=bind('fetchAndSaveRaceCards',{buildUrl:()=> 'official-index',fetchHtml:async(...args)=>{observed=args;return {ok:true,html:''};},parseRaceIndex:()=>[]});
  await run({asServiceRole:{entities:{}}},TODAY,2400,[],[]);
  assert.equal(observed[1],0);assert.equal(observed[2].timeoutMs,6000);assert.equal(observed[2].deadlineMs,NOW+2400);
});

test('AUTO completion saves failures and next-run recovery without recounting or clearing saved counts',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const existing={id:'status-1',today_races:120,tomorrow_entries:72},calls=[];
  const entities={AutoUpdateStatus:{filter:async(query,sort,limit)=>{
    calls.push('read');assert.deepEqual(query,{name:'default'});assert.equal(sort,'-last_updated');assert.equal(limit,1);return [existing];
  },update:async(id,doc)=>{calls.push('write');assert.equal(id,existing.id);Object.assign(existing,doc);return existing;}}};
  const update=bind('updateAutoUpdateStatus',{checkCompleteness:()=>assert.fail('AUTO status must not recount datasets')});
  const result=await update({asServiceRole:{entities}},TODAY,TOMORROW,'auto',{
    ok:false,partial:true,errors:['one race unavailable'],logs:['later race saved'],phases:[{phase:'exhibition',status:'PARTIAL'}],
  });
  assert.deepEqual(result,{saved:true});assert.deepEqual(calls,['read','write']);
  assert.equal(existing.status,'partial');assert.equal(existing.today_races,120);assert.equal(existing.tomorrow_entries,72);
  assert.deepEqual(existing.errors,['one race unavailable']);assert.deepEqual(existing.logs,['later race saved']);
  assert.equal(existing.job_summary.next_retry,'NEXT_SCHEDULED_RUN');
});

for(const failure of ['read','write'])test(`status ${failure} failure is reported and does not create a duplicate default`,async t=>{
  t.mock.method(console,'warn',()=>{});
  let creates=0;
  const entities={AutoUpdateStatus:{filter:async()=>{if(failure==='read')throw new Error('private provider message');return [{id:'existing'}];},
    update:async()=>{throw new Error('private provider message');},create:async()=>{creates++;}}};
  const update=bind('updateAutoUpdateStatus',{});
  assert.deepEqual(await update({asServiceRole:{entities}},TODAY,TOMORROW,'auto',{errors:[]}),{saved:false});
  assert.equal(creates,0);
});

function handler(dependencies){
  const start=source.indexOf('export default async function(req: Request)');
  return new Function(...Object.keys(dependencies),stripTypeScriptTypes(source.slice(start))
    .replace('export default async function','return async function'))(...Object.values(dependencies));
}
const request=()=>new Request('https://app.invalid/collector',{method:'POST',body:JSON.stringify({step:'auto'})});

test('a completion-status failure returns 503 with collected counts intact',async()=>{
  const run=handler({createClientFromRequest:()=>({auth:{me:async()=>({role:'admin'})}}),
    getTodayJST:()=>TODAY,getTomorrowJST:()=>TOMORROW,nowJSTTime:()=> '09:00',
    autoUpdate:async()=>({ok:true,fetched:4,steps:['exhibition: 4R']}),updateAutoUpdateStatus:async()=>({saved:false})});
  const response=await run(request()),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.ok,false);assert.equal(body.status_saved,false);
  assert.equal(body.fetched,4);assert.deepEqual(body.steps,['exhibition: 4R']);
});

test('partial acquisition with a persisted worker outcome returns 200 and an explicit non-success result',async()=>{
  const run=handler({createClientFromRequest:()=>({auth:{me:async()=>({role:'admin'})}}),
    getTodayJST:()=>TODAY,getTomorrowJST:()=>TOMORROW,nowJSTTime:()=> '09:00',
    autoUpdate:async()=>({ok:false,partial:true,fetched:3,errors:['one race failed']}),updateAutoUpdateStatus:async()=>({saved:true})});
  const response=await run(request()),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.ok,false);assert.equal(body.partial,true);
  assert.equal(body.status_saved,true);assert.equal(body.fetched,3);
});

test('handler preserves authentication failures and records unexpected programming failures as failed',async()=>{
  for(const [user,status] of [[null,401],[{role:'user'},403]]){
    const run=handler({createClientFromRequest:()=>({auth:{me:async()=>user}})});
    assert.equal((await run(request())).status,status);
  }
  let recorded;
  const run=handler({createClientFromRequest:()=>({auth:{me:async()=>({role:'admin'})}}),
    getTodayJST:()=>TODAY,getTomorrowJST:()=>TOMORROW,
    autoUpdate:async()=>{throw new TypeError('programming error');},
    updateAutoUpdateStatus:async(...args)=>{recorded=args.at(-1);return {saved:true};}});
  const response=await run(request()),body=await response.json();
  assert.equal(response.status,500);assert.equal(body.failed,true);assert.equal(body.status_saved,true);
  assert.equal(recorded.failed,true);assert.equal(recorded.ok,false);
});
