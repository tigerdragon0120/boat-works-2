// Exercise the real request handler with its platform dependencies injected.
// No Base44 API, provider access, or real database mutation occurs in these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {buildExternalPrediction} from '../base44/shared/v8ExternalEvidence.js';

const source = readFileSync(new URL('../base44/functions/v8RecordExternalPrediction/entry.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const executable = stripTypeScriptTypes(source).replace('export default async function', 'return async function');
const factory = new Function('createClientFromRequest', 'acquireLock', 'releaseLock', 'buildExternalPrediction', executable);
const now = Date.parse('2026-11-23T05:30:00Z');
const race = {id:'race-1',race_key:'2026-11-23_01_01',race_date:'2026-11-23',venue_code:'01',venue_name:'桐生',race_number:1,
  deadline:'2026-11-23T15:00:00+09:00',status:'scheduled',exhibition_ready:false};
const entries = Array.from({length:6},(_,i)=>({id:'entry-'+i,race_id:race.id,boat_number:i+1}));
const input = {race_id:race.id,source_name:'提供元',forecaster_name:'予想者',source_type:'TRACK_TIPSTER',stage:'PRE',
  published_at:'2026-11-23T05:00:00Z',source_url:'https://example.test/forecast',tickets:['1-2-3'],stake_per_ticket:100,permission_confirmed:true};

async function exercise(t,{freshRace=race,freshEntries=entries}={}) {
  t.mock.timers.enable({apis:['Date'],now});
  let raceReads=0,entryReads=0,releases=0;
  const saved=[];
  const sr={
    Race:{get:async()=>++raceReads===1?structuredClone(race):structuredClone(freshRace)},
    RaceEntry:{filter:async()=>++entryReads===1?structuredClone(entries):structuredClone(freshEntries)},
    V8ExternalPrediction:{filter:async()=>[],create:async(record)=>{saved.push(structuredClone(record));return {...record,id:'external-1',created_date:new Date().toISOString()};}},
  };
  const client={auth:{me:async()=>({id:'admin-1',role:'admin'})},asServiceRole:{entities:sr}};
  const handler=factory(()=>client,async()=>({id:'lock-1'}),async()=>{releases++;},buildExternalPrediction);
  const response=await handler(new Request('https://test.invalid/function',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}));
  return {response,body:await response.json(),saved,raceReads,entryReads,releases};
}

test('cancellation arriving after preflight is saved only as historical evidence',async(t)=>{
  const out=await exercise(t,{freshRace:{...race,status:'cancelled'}});
  assert.equal(out.response.status,200);assert.equal(out.body.created,1);
  assert.equal(out.raceReads,2);assert.equal(out.entryReads,2);
  assert.equal(out.saved[0].verification_eligible,false);
  assert.equal(out.saved[0].evidence_type,'HISTORICAL');
  assert.ok(out.saved[0].ineligibility_reasons.includes('RACE_ALREADY_CLOSED'));
  assert.equal(out.releases,1);
});
test('exhibition arriving after preflight is not recorded as a clean PRE prediction',async(t)=>{
  const freshEntries=entries.map((entry,i)=>i===0?{...entry,exhibition_st:-.02}:entry);
  const out=await exercise(t,{freshEntries});
  assert.equal(out.response.status,200);assert.equal(out.entryReads,2);
  assert.equal(out.saved[0].verification_eligible,false);
  assert.ok(out.saved[0].ineligibility_reasons.includes('EXHIBITION_ALREADY_OBSERVED'));
});
test('an incomplete refreshed entry read prevents saving the cached preflight state',async(t)=>{
  const out=await exercise(t,{freshEntries:{items:entries,has_more:true}});
  assert.equal(out.response.status,503);assert.equal(out.body.error,'ENTRY_READ_INCOMPLETE');
  assert.equal(out.saved.length,0);assert.equal(out.releases,1);
});
test('a changed race identity is rejected before any write',async(t)=>{
  const out=await exercise(t,{freshRace:{...race,race_key:'2026-11-23_01_02'}});
  assert.equal(out.response.status,409);assert.equal(out.body.error,'RACE_IDENTITY_CHANGED');
  assert.equal(out.saved.length,0);
});
