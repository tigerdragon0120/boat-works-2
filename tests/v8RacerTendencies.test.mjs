import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRacerFrameTendencies,loadRacerFrameTendencies,emptyFrameTendencies,frameWindow} from '../base44/shared/v8RacerTendencies.js';
import {selectCaptureBaseline} from '../base44/shared/v8LiveCapture.js';
import {FORECAST_REVISION} from '../base44/shared/v8ForecastEngine.js';

const AS_OF='2026-11-26T00:00:00Z';
function evidence(id='a',method='逃げ',order=[1,2,3,4,5,6]){
  return {id,race_id:'race-'+id,race_key:'2026-11-25_24_'+(id==='a'?'01':'02'),race_date:'2026-11-25',venue_code:'24',race_number:id==='a'?1:2,
    result_trifecta:order.slice(0,3).join('-'),winner_boat:order[0],winner_register:String(4500+order[0]),winning_method:method,
    result_finished_at:'2026-11-25T08:00:00Z',captured_at:'2026-11-25T08:01:00Z',created_date:'2026-11-25T08:01:01.000000',
    source:{result_id:'result-'+id,provenance:'RACE_RESULT_AND_RACER_HISTORY',official_result_checked:true},
    boat_results:Array.from({length:6},(_,i)=>({boat_number:i+1,registration_number:String(4501+i),finish:order.indexOf(i+1)+1,
      entry_known:true,reported_course:6-i,course_verified:false,winning_method:i+1===order[0]?method:null}))};
}

test('boat-number records use confirmed result counts and distinct known-method denominators',()=>{
  const rows=[evidence(),evidence('b','まくり',[3,1,2,4,5,6])],before=structuredClone(rows);
  const {profiles,summary}=buildRacerFrameTendencies({rows,asOf:AS_OF});
  const first=profiles.get('4501'),frame=first.frames['1'];
  assert.equal(summary.accepted_races,2);assert.equal(first.evidence_count,2);
  assert.equal(frame.sample_size,2);assert.equal(frame.first_rate,50);assert.equal(frame.top2_rate,100);
  assert.equal(frame.known_method_wins,1);assert.equal(frame.winning_methods['逃げ'],1);
  assert.equal(frame.opponent_wins_by_method['まくり'],1);assert.equal(frame.method_known_races,2);
  assert.equal(first.frames['6'].sample_size,0);assert.equal(first.frames['6'].first_rate,null);
  assert.equal(first.used_for_scoring,false);assert.equal(first.coverage,'APP_COLLECTED_ONLY');
  assert.deepEqual(rows,before);assert.equal(first.latest_source_at,'2026-11-25T08:01:01.000Z');
});

test('an unknown winning method is not a zero observation of a particular tactic',()=>{
  const row=evidence('a',null),{profiles}=buildRacerFrameTendencies({rows:[row],asOf:AS_OF});
  const frame=profiles.get('4501').frames['1'];
  assert.equal(frame.first_count,1);assert.equal(frame.known_method_wins,0);assert.equal(frame.method_known_races,0);
});

test('partial finishing order, changed identity, conflict, and invalid times are excluded',()=>{
  for(const mutate of [
    row=>{row.boat_results[5].finish=null;},row=>{row.boat_results[5].registration_number='4501';},
    row=>{row.result_trifecta='2-1-3';},row=>{row.winner_register='4999';},
    row=>{row.captured_at='2026-11-25T07:59:00Z';},row=>{row.source.result_id=null;},
  ]){
    const row=evidence();mutate(row);
    const result=buildRacerFrameTendencies({rows:[row],asOf:AS_OF});
    assert.equal(result.profiles.size,0);assert.equal(result.summary.rejected_races,1);
  }
});

test('duplicate race evidence is held; evidence captured after the cutoff cannot influence counts',()=>{
  const row=evidence(),duplicate={...structuredClone(row),id:'duplicate'};
  assert.equal(buildRacerFrameTendencies({rows:[row,duplicate],asOf:AS_OF}).profiles.size,0);
  duplicate.created_date='2026-11-26T01:00:00Z';duplicate.captured_at='2026-11-26T01:00:00Z';
  assert.equal(buildRacerFrameTendencies({rows:[row,duplicate],asOf:AS_OF}).profiles.get('4501').evidence_count,1);
  assert.equal(buildRacerFrameTendencies({rows:[duplicate],asOf:AS_OF}).profiles.size,0);
});

test('the 30-day window and no-data records preserve null rates and never infer course',()=>{
  assert.deepEqual(frameWindow(AS_OF),{window_start:'2026-10-28',window_end:'2026-11-26'});
  const row=evidence();row.race_date='2026-10-27';row.race_key='2026-10-27_24_01';
  assert.equal(buildRacerFrameTendencies({rows:[row],asOf:AS_OF}).profiles.size,0);
  assert.equal(emptyFrameTendencies({asOf:AS_OF}).frames['1'].first_rate,null);
  assert.equal(buildRacerFrameTendencies({rows:null,asOf:AS_OF}).profiles.size,0);
});

test('complete internal ledger reads are cached without any external fetches',async()=>{
  let calls=0;const sr={V8PatternEvidence:{filter:async()=>{calls++;return {items:[evidence()],has_more:false,next_cursor:null};}}};
  const first=await loadRacerFrameTendencies(sr,{asOf:AS_OF});
  const next=await loadRacerFrameTendencies(sr,{asOf:'2026-11-26T00:01:00Z'});
  assert.equal(calls,1);assert.equal(first.profiles.size,6);assert.equal(next.summary.accepted_races,1);
});

test('missing or incomplete ledgers are explicit and do not prevent the official course profile',async()=>{
  assert.equal((await loadRacerFrameTendencies({}, {asOf:AS_OF})).summary.status,'UNAVAILABLE');
  const sr={V8PatternEvidence:{filter:async()=>({items:[evidence()],has_more:true,next_cursor:null})}};
  const result=await loadRacerFrameTendencies(sr,{asOf:AS_OF});
  assert.equal(result.summary.status,'READ_FAILED');assert.equal(result.profiles.size,0);
});

test('FINAL prefers a current-model saved PRE over an old-model DAY_BEFORE and retains historical fallback',()=>{
  const old={id:'old',stage:'DAY_BEFORE',revision:'V8_FORECAST_3_SCENARIOS',generated_at:'2026-11-25T10:00:00Z'};
  const pre={id:'new-pre',stage:'PRE',revision:FORECAST_REVISION,generated_at:'2026-11-26T00:00:00Z'};
  const before=structuredClone([old,pre]);
  assert.equal(selectCaptureBaseline([old,pre]).id,pre.id);
  assert.equal(selectCaptureBaseline([old]).id,old.id);
  assert.deepEqual([old,pre],before);
});

test('FINAL compares with an appended PRE that first captured the shared WAKU10 source',()=>{
  const old={id:'before-source',stage:'DAY_BEFORE',revision:FORECAST_REVISION,generated_at:'2026-11-25T10:00:00Z',
    provenance:{recent_lane_snapshot_id:null}};
  const pre={id:'with-source',stage:'PRE',revision:FORECAST_REVISION,generated_at:'2026-11-26T00:00:00Z',
    provenance:{recent_lane_snapshot_id:'shared-snapshot'}};
  const before=structuredClone([old,pre]);
  assert.equal(selectCaptureBaseline([old,pre]).id,pre.id);
  assert.deepEqual([old,pre],before);
});
