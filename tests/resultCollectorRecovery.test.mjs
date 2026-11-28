import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readResultCollectionPlan} from '../base44/shared/resultCollectionPlan.js';
import {isValidTrifecta} from '../base44/shared/resultEvidenceRules.js';

const source=readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts',import.meta.url),'utf8');
const NOW=Date.parse('2026-11-28T06:50:00Z');
const race={id:'miyajima12',race_key:'2026-11-28_17_12',race_date:'2026-11-28',venue_code:'17',venue_name:'宮島',race_number:12,
  deadline:'2026-11-28T15:28:00+09:00',status:'scheduled'};
const final={source:'BOATCAST',complete:true,result:{result_trifecta:'1-2-3',payout:580}};
function bind(dependencies){
  const start=source.indexOf('async function fetchAndSaveResults('),end=source.indexOf('\n}',start)+2;
  return new Function(...Object.keys(dependencies),stripTypeScriptTypes(source.slice(start,end))+'\nreturn fetchAndSaveResults;')(...Object.values(dependencies));
}
function setup({cancelled=0,stored=[],resolver=async()=>final,saveError,html={ok:false,status:403}}={}){
  const rows=[...Array.from({length:cancelled},(_,i)=>({id:'cancel-'+i,race_key:`2026-11-28_15_${String(i+1).padStart(2,'0')}`,
    race_date:race.race_date,venue_code:'15',race_number:i+1,deadline:'2026-11-28T10:00:00+09:00',status:'cancelled'})),race];
  const requests=[],writes=[],repairs=[],errors=[],logs=[];
  const client={asServiceRole:{entities:{
    Race:{filter:async(q,options)=>{assert.equal(typeof options,'object');return {items:rows,has_more:false,next_cursor:null};}},
    RaceResult:{filter:async(q,options)=>{assert.equal(typeof options,'object');return {items:stored,has_more:false,next_cursor:null};}},
  }}};
  const run=bind({readResultCollectionPlan,isValidTrifecta,VENUE_MAP:{'17':'宮島'},
    syncFinishedRace:async(_sr,r,result)=>{repairs.push({race:r.id,result:result.id});},
    resolveRaceResult:async r=>{requests.push(r.race_key);return resolver(r);},
    upsertBoatcastResultAndVerify:async(_client,r,data,options)=>{assert.equal(options.verifyLegacy,false);if(saveError)throw saveError;
      writes.push(r.id);return {saved:{id:'result-'+r.id,race_id:r.id,...data.result}};},
    upsertResultOnly:()=>assert.fail('unexpected local save'),buildUrl:()=> 'official-result',
    fetchHtml:async()=>{requests.push('html');return html;},parseResult:()=>({ok:false}),
  });
  return {requests,writes,repairs,errors,logs,run:()=>run(client,race.race_date,15000,logs,errors)};
}

test('cancelled races cannot consume result requests before the finished Miyajima race',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=setup({cancelled:12}),summary=await f.run();
  assert.deepEqual(f.requests,[race.race_key]);assert.deepEqual(f.writes,[race.id]);
  assert.equal(summary.cancelled,12);assert.equal(summary.fetched,1);assert.deepEqual(f.errors,[]);
});

test('saved results with an unfinished Race are repaired without any source request',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=setup({stored:[{id:'saved-12',race_id:race.id,race_key:race.race_key,source:'BOATCAST',result_trifecta:'1-2-3',payout:580,result_status:'RESULT_FINAL'}]});
  const summary=await f.run();
  assert.equal(summary.repaired,1);assert.deepEqual(f.requests,[]);assert.deepEqual(f.writes,[]);
  assert.deepEqual(f.repairs,[{race:race.id,result:'saved-12'}]);
});

test('unavailable sources are reported as pending rather than a successful zero fetch',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=setup({resolver:async()=>({source:null,reason:'rs1_not_available'})}),summary=await f.run();
  assert.equal(summary.fetched,0);assert.equal(summary.pending,1);assert.equal(summary.partial,true);
  assert.match(f.errors[0],/rs1_not_available.*HTTP_403/);assert.deepEqual(f.writes,[]);
});

test('an incomplete payout never becomes a zero-return final result',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=setup({resolver:async()=>({...final,complete:false,reason:'rs2_not_available',result:{result_trifecta:'1-2-3',payout:0}})});
  const summary=await f.run();assert.equal(summary.fetched,0);assert.equal(summary.pending,1);assert.deepEqual(f.writes,[]);
});

test('a storage error is visible and does not trigger a second source/write attempt',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=setup({saveError:new Error('RACE_STATE_SAVE_FAILED')}),summary=await f.run();
  assert.equal(summary.fetched,0);assert.deepEqual(f.requests,[race.race_key]);assert.match(f.errors[0],/RACE_STATE_SAVE_FAILED/);
});
