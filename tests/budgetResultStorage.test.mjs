// Exercise production result-storage functions while making any legacy scoring visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const service=readFileSync(new URL('../base44/shared/predictionService.js',import.meta.url),'utf8');
const collector=readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts',import.meta.url),'utf8');
const NOW=Date.parse('2026-11-23T11:00:00Z');
const race={id:'race-1',race_key:'2026-11-23_01_10',race_date:'2026-11-23',venue_code:'01',venue_name:'桐生',race_number:10,deadline:'2026-11-23T10:45:00Z'};
function bind(source,name,dependencies) {
  const token=`async function ${name}(`,start=source.indexOf(token),end=source.indexOf('\n}',start)+2;
  assert.ok(start>=0&&end>start,`${name} exists`);
  return new Function(...Object.keys(dependencies),stripTypeScriptTypes(source.slice(start,end))+`\nreturn ${name};`)(...Object.values(dependencies));
}
function fixture({failSave=false}={}) {
  const writes={results:[],races:[],created:[],updated:[],legacy:[]};
  const entries=[{boat_number:1,registration_number:'4001'},{boat_number:2,register_number:'4002'}];
  const entities={
    Race:{filter:async()=>[race],update:async(id,patch)=>{writes.races.push({id,patch});return{id,...patch};}},
    RaceResult:{filter:async()=>[]},
    RaceEntry:{filter:async()=>entries},
    RacerRaceHistory:{filter:async()=>[{id:'history-1',registration_number:'4001'}],
      bulkCreate:async(rows)=>{writes.created.push(...rows);return rows;},
      bulkUpdate:async(rows)=>{writes.updated.push(...rows);return rows;}},
  };
  const dependencies={saveSingleRaceResult:async(_sr,_race,doc,observedAt)=>{
    if(failSave)throw new Error('result storage unavailable');
    writes.results.push({doc,observedAt});return{id:'result-1',...doc};
  }};
  for(const name of ['verifyPrediction','verifyV2Prediction','verifyV3Prediction','verifyV31Prediction','verifyV4Prediction']){
    dependencies[name]=async()=>{writes.legacy.push(name);return{id:'verification-1'};};
  }
  return {client:{asServiceRole:{entities}},writes,dependencies,
    boatcast:bind(service,'upsertBoatcastResultAndVerify',dependencies),
    local:bind(service,'upsertResultOnly',dependencies)};
}
const result={result_trifecta:'1-2-3',finish_order:[1,2,3,4,5,6],payout:1240,
  payouts:{trifecta:[{combination:'1-2-3',payout:1240}]},
  boats:[{boat_number:1,course:1,finish_order:1,st:.11,winning_method:'逃げ'},
    {boat_number:2,course:2,finish_order:2,st:.13}],
  conditions:{weather:'晴',wind_speed:3,wave_height:2,wind_dir:'南'}};

test('BOATCAST collection stores result, per-racer outcomes and weather with zero retired scoring',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=fixture();
  const saved=await f.boatcast(f.client,race,{source:'BOATCAST',result,fetched_at:'2026-11-23T10:59:00Z'},{verifyLegacy:false});
  assert.equal(saved.saved.id,'result-1');assert.equal(saved.skipped,false);assert.equal(saved.verification,null);
  assert.equal(f.writes.results[0].doc.result_trifecta,'1-2-3');
  assert.deepEqual(f.writes.results[0].doc.boats,result.boats);
  assert.deepEqual(f.writes.results[0].doc.payouts,result.payouts);
  assert.equal(f.writes.results[0].observedAt,'2026-11-23T10:59:00Z');
  assert.equal(f.writes.updated[0].id,'history-1');assert.equal(f.writes.updated[0].finish_order,1);
  assert.equal(f.writes.created[0].registration_number,'4002');assert.equal(f.writes.created[0].st,.13);
  assert.deepEqual(f.writes.races.map(row=>row.patch),[{status:'finished'},{weather:'晴',wind_speed:3,wave_height:2,wind_dir:'南'}]);
  assert.deepEqual(f.writes.legacy,[]);
});

test('default BOATCAST behavior remains compatible for other callers',async()=>{
  const f=fixture();
  const saved=await f.boatcast(f.client,race,{source:'BOATCAST',result});
  assert.equal(saved.verification.id,'verification-1');
  assert.deepEqual(f.writes.legacy,['verifyPrediction','verifyV2Prediction','verifyV3Prediction','verifyV31Prediction','verifyV4Prediction']);
});

test('LOCAL fallback retains result, history and weather without legacy verification',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=fixture(),errors=[];
  const parsed={...result,entries:result.boats,weather:'曇',wind_speed:0,water_temp:18,air_temp:16,wave_height:0};
  const run=bind(collector,'fetchAndSaveResults',{
    uniqueRacesByKey:rows=>rows,VENUE_MAP:{'01':'桐生'},
    resolveRaceResult:async()=>({source:'NONE'}),
    upsertBoatcastResultAndVerify:f.boatcast,upsertResultOnly:f.local,
    buildUrl:()=> 'https://fixture.invalid/result',fetchHtml:async()=>({ok:true,html:'fixture'}),
    parseResult:()=>({ok:true,data:{venues:[{results:[parsed]}]}}),
    num:value=>value==null||value===''?null:Number.isFinite(Number(value))?Number(value):null,
    str:value=>value==null?'':String(value).trim(),sleep:async()=>{},
  });
  const summary=await run(f.client,race.race_date,10000,[],errors);
  assert.equal(summary.fetched,1);assert.equal(summary.local,1);assert.deepEqual(errors,[]);
  assert.equal(f.writes.results[0].doc.source,'LOCAL');
  assert.deepEqual(f.writes.results[0].doc.payouts,result.payouts);
  assert.equal(f.writes.results[0].doc.payout,1240);
  assert.equal(f.writes.updated[0].registration_number,'4001');
  assert.equal(f.writes.created[0].registration_number,'4002');
  assert.deepEqual(f.writes.races.map(row=>row.patch),[{status:'finished'},{weather:'曇',wind_speed:0,water_temp:18,air_temp:16,wave_height:0}]);
  assert.deepEqual(f.writes.legacy,[]);
});

test('result save failures propagate before recording finished state or secondary history',async()=>{
  for(const source of ['BOATCAST','LOCAL']){
    const f=fixture({failSave:true});
    const run=source==='BOATCAST'?f.boatcast(f.client,race,{source,result},{verifyLegacy:false}):f.local(f.client,race,result);
    await assert.rejects(run,/result storage unavailable/);
    assert.deepEqual(f.writes.races,[]);assert.deepEqual(f.writes.created,[]);assert.deepEqual(f.writes.updated,[]);assert.deepEqual(f.writes.legacy,[]);
  }
});
