import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommittedExhibitionKey,EXHIBITION_INPUT_KEY_REVISION} from '../base44/shared/exhibitionInputKey.js';

const race={id:'r1',race_key:'2026-11-27_01_03',race_date:'2026-11-27',venue_code:'01',race_number:3,scratched_boats:[]};
const entries=()=>Array.from({length:6},(_,index)=>({id:'e'+index,race_id:race.id,race_key:race.race_key,
  boat_number:index+1,registration_number:String(4501+index),exhibition_time:6.7+index*.01,
  exhibition_st:.1+index*.01,exhibition_course:index+1,updated_date:'2026-11-27T00:00:00Z'}));

test('canonical values ignore row order, numeric spelling and unequal source timestamps',()=>{
  const input=entries(),key=buildCommittedExhibitionKey(race,input);
  assert.equal(JSON.parse(key).revision,EXHIBITION_INPUT_KEY_REVISION);
  const other=input.map((row,index)=>({...row,boat_number:String(row.boat_number),registration_number:Number(row.registration_number),
    exhibition_time:String(row.exhibition_time),exhibition_st:String(row.exhibition_st),exhibition_st_raw:String(row.exhibition_st),
    exhibition_course:String(row.exhibition_course),updated_date:index?'2026-11-26T23:00:00Z':'2026-11-27T00:01:00Z'})).reverse();
  assert.equal(buildCommittedExhibitionKey({...race,venue_code:1,race_number:'3',updated_date:'2026-11-27T00:02:00Z'},other),key);
  assert.equal(buildCommittedExhibitionKey(race,input),key);
});

test('partial application of an ST correction cannot equal the committed source',()=>{
  const old=entries(),source=structuredClone(old),mixed=structuredClone(old);
  source[0].exhibition_st=.25;source[1].exhibition_st=.01;mixed[0].exhibition_st=.25;
  assert.notEqual(buildCommittedExhibitionKey(race,mixed),buildCommittedExhibitionKey(race,old));
  assert.notEqual(buildCommittedExhibitionKey(race,mixed),buildCommittedExhibitionKey(race,source));
  assert.equal(buildCommittedExhibitionKey(race,structuredClone(source)),buildCommittedExhibitionKey(race,source));
});

test('raw ST priority and F/L meaning match the forecast input',()=>{
  const raw=entries();raw[0].exhibition_st_raw='F.03';
  const signed=entries();signed[0].exhibition_st=-.03;
  assert.equal(buildCommittedExhibitionKey(race,raw),buildCommittedExhibitionKey(race,signed));
  raw[0].exhibition_st_raw=' F0.03 ';
  assert.equal(buildCommittedExhibitionKey(race,raw),buildCommittedExhibitionKey(race,signed));
  raw[0].exhibition_st_raw='F.00';signed[0].exhibition_st=0;
  assert.notEqual(buildCommittedExhibitionKey(race,raw),buildCommittedExhibitionKey(race,signed));
  raw[0].exhibition_st_raw='L';assert.ok(buildCommittedExhibitionKey(race,raw));
  raw[0].exhibition_st_raw='invalid';assert.equal(buildCommittedExhibitionKey(race,raw),null);
});

test('missing active values and conflicting courses cannot be committed',()=>{
  for(const field of ['exhibition_time','exhibition_st','exhibition_course']){
    for(const value of [null,'',undefined]){
      const input=entries();input[5][field]=value;assert.equal(buildCommittedExhibitionKey(race,input),null);
    }
  }
  const duplicate=entries();duplicate[5].exhibition_course=1;assert.equal(buildCommittedExhibitionKey(race,duplicate),null);
  const badTime=entries();badTime[0].exhibition_time=20;assert.equal(buildCommittedExhibitionKey(race,badTime),null);
  assert.equal(buildCommittedExhibitionKey(race,entries().slice(0,5)),null);
});

test('race and all six entrant identities are required without lane-only fallback',()=>{
  for(const replacement of [{race_key:'2026-11-27_01_04'},{race_date:'2026-11-31'},{venue_code:25},{race_number:13},{id:''}])
    assert.equal(buildCommittedExhibitionKey({...race,...replacement},entries()),null);
  for(const replacement of [{registration_number:null},{registration_number:'4502'},{register_number:'4999'},
    {boat_number:2},{race_id:'other'},{race_key:'2026-11-27_01_04'},{race_date:'2026-11-26'}]){
    const input=entries();Object.assign(input[0],replacement);assert.equal(buildCommittedExhibitionKey(race,input),null);
  }
  const source=entries().map(({race_id,race_key,id,updated_date,...row})=>row);
  assert.equal(buildCommittedExhibitionKey(race,source),buildCommittedExhibitionKey(race,entries()));
});

test('absence is part of identity while excluded old timings are not required',()=>{
  const full=entries(),absent=entries();absent[5]={...absent[5],is_absent:true,exhibition_time:null,exhibition_st:null,exhibition_course:null};
  const key=buildCommittedExhibitionKey(race,absent);assert.ok(key);
  assert.notEqual(key,buildCommittedExhibitionKey(race,full));
  assert.equal(key,buildCommittedExhibitionKey({...race,scratched_boats:[6]},full));
  assert.equal(buildCommittedExhibitionKey({...race,scratched_boats:[7]},full),null);
});

test('input objects are not changed',()=>{
  const input=entries(),before=JSON.stringify({race,input});buildCommittedExhibitionKey(race,input);
  assert.equal(JSON.stringify({race,input}),before);
});
