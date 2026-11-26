import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildRaceForecast,forecastRecentLaneKey,FORECAST_REVISION} from '../base44/shared/v8ForecastEngine.js';
import {buildRecentLaneEvidence,validatedRecentLaneSnapshot} from '../base44/shared/v8RecentLaneEvidence.js';
import {summarizeRecentLaneHistory,recentLaneSourceUrl,parseBoatcastWaku10,normalizeRecentLaneSource} from '../base44/shared/v8RecentLaneSource.js';

const race={id:'r',race_key:'2026-11-26_24_05',race_date:'2026-11-26',venue_code:'24',race_number:5,
  deadline:'2026-11-26T05:00:00Z',status:'scheduled',updated_date:'2026-11-25T12:00:00Z'};
const preNow='2026-11-26T01:00:00Z',finalNow='2026-11-26T04:40:00Z';
function profile(number){
  return {revision:'V8_RACER_PROFILE_1',registration_number:String(4500+number),player_name:'選手'+number,
    source:{dataset_key:'period-a',term_key:'2027_FIRST',term_start_date:'2026-05-01',term_end_date:'2026-10-31',
      available_at:'2026-11-22T00:00:00Z',source_url:'https://www.boatrace.jp/official-file',source_file:'fan2610.txt',checksum:'abc'},
    courses:Object.fromEntries(Array.from({length:6},(_,index)=>[String(index+1),{course:index+1,sample_size:40,
      first_count:8,second_count:10,third_count:10,fourth_count:4,fifth_count:4,sixth_count:4,
      first_rate:20,second_rate:25,third_rate:25,top2_rate:45,top3_rate:70,avg_st:.16,avg_st_rank:3,f_count:0,l_count:0}])),
    course_priors:Object.fromEntries(Array.from({length:6},(_,index)=>[String(index+1),{sample_size:1000,
      first_rate:10,second_rate:20,third_rate:20,top2_rate:30,top3_rate:50,avg_st:.19,avg_st_rank:3.5}]))};
}
function entries(){return Array.from({length:6},(_,index)=>({id:'e'+index,race_id:'r',race_key:race.race_key,race_date:race.race_date,
  boat_number:index+1,registration_number:String(4501+index),player_name:'選手'+(index+1),
  national_win_rate:6,local_win_rate:6,national_2rate:40,motor_2rate:40,avg_st:.18,section_points:6,
  updated_date:'2026-11-25T12:00:00Z',v8_racer_profile:profile(index+1)}));}
function snapshot(entry,{finishes=[1,1,1,1,1,2,2,2,2,3],history=null,...overrides}={}){
  const rows=history||finishes.map(finish=>({finish_order:typeof finish==='number'?finish:null,
    finish_status:typeof finish==='number'?null:finish,course:entry.boat_number,course_inferred:true,code:null}));
  const {ok,...summary}=summarizeRecentLaneHistory(rows);assert.equal(ok,true);
  return {revision:'V8_RECENT_LANE_1',source:'BOATCAST_WAKU10',status:'READY',race_id:race.id,race_key:race.race_key,
    boat_number:entry.boat_number,registration_number:entry.registration_number,source_name:entry.player_name,
    identity_status:'MATCHED_NAME_AND_ENTRY',snapshot_id:'snap-a',snapshot_key:'snapshot-a',source_url:recentLaneSourceUrl(race),
    fetched_at:'2026-11-26T00:30:00Z',available_at:'2026-11-26T00:31:00Z',row_hash:'hash-'+entry.boat_number,
    ...summary,avg_st:.1,avg_start_order:1,denominator_rule:'KNOWN_STARTS_EXCLUDING_ABSENT',history:rows,...overrides};
}
function withRecent(){return entries().map(entry=>({...entry,v8_recent_lane:snapshot(entry)}));}
const pre=(input=withRecent(),now=preNow)=>buildRaceForecast({race,entries:input,stage:'PRE',now}).record;
const finalEntries=()=>withRecent().map((entry,index)=>({...entry,exhibition_course:index+1,exhibition_time:6.8,
  exhibition_st:.15,updated_date:'2026-11-26T04:35:00Z'}));
const baseline=()=>({...pre(),id:'pre',created_date:'2026-11-26T01:00:00.100Z'});

test('published winning points and finish frequencies share one limited group, never an 88 percent win probability',()=>{
  const input=withRecent(),before=structuredClone(input),record=pre(input),row=record.recent_lane_evidence.boats[0];
  assert.equal(FORECAST_REVISION,'V8_FORECAST_5_RECENT_LANE');
  assert.equal(row.raw.winning_rate,8.8);assert.equal(row.raw.first_rate,50);
  assert.equal(row.scoring.recent_frequency_score,72);assert.equal(row.scoring.recent_finish_score,75.2);
  assert.equal(row.scoring.blend_weight,.333);
  assert.ok(Math.abs(row.scoring.finish_after-(row.scoring.finish_before+(75.2-row.scoring.finish_before)/3))<.002);
  assert.equal(row.scoring.applied,true);
  assert.deepEqual(row.scoring.used_features,['RECENT_FINISH_FREQUENCY','RECENT_FINISH_POINTS','RECENT_AVG_ST','RECENT_ST_RANK']);
  assert.equal(record.racer_evidence.scoring.feature_weights.course_finish_score,.16);
  assert.equal(record.racer_evidence.scoring.feature_weights.start_parameter_score,.15);
  assert.equal(row.scoring.base_after,record.boats[0].base_score);
  assert.ok(Math.abs(row.scoring.delta-(row.scoring.base_after-row.scoring.base_before))<.00001);
  assert.ok(row.scoring.delta>0);assert.deepEqual(input,before);
  const withoutPoints=withRecent();withoutPoints[0].v8_recent_lane.winning_rate=null;
  const fallback=pre(withoutPoints).recent_lane_evidence.boats[0];
  assert.equal(fallback.scoring.recent_finish_score,72);assert.equal(fallback.scoring.winning_rate_used,false);
});

test('one missing recent history and one missing long-term profile do not discard other racers evidence',()=>{
  const input=withRecent();delete input[5].v8_recent_lane;delete input[5].v8_racer_profile;
  const record=pre(input),rich=record.recent_lane_evidence.boats[0],missing=record.recent_lane_evidence.boats[5];
  assert.equal(record.recent_lane_evidence.status,'PARTIAL');assert.equal(rich.scoring.used,true);
  assert.equal(record.racer_evidence.boats[0].scoring.used_for_scoring,true);
  assert.equal(record.racer_evidence.boats[0].scoring.effective_avg_st,.147);
  assert.equal(missing.snapshot,null);assert.equal(missing.raw,null);assert.equal(missing.scoring.used,false);
  assert.equal(missing.scoring.delta,null);assert.equal(missing.scoring.finish_reference_kind,'COURSE_POPULATION');
  assert.equal(record.racer_evidence.boats[5].raw,null);assert.equal(record.boats[5].course_first_percent,null);
  assert.ok(Number.isFinite(record.boats[5].base_score));
});

test('partial ST and ST-rank availability only falls back for the affected racer and metric',()=>{
  const input=withRecent();input[0].v8_recent_lane.avg_start_order=null;input[1].v8_recent_lane.avg_st=null;
  const record=pre(input),a=record.recent_lane_evidence.boats[0],b=record.recent_lane_evidence.boats[1],c=record.recent_lane_evidence.boats[2];
  assert.ok(a.scoring.used_features.includes('RECENT_AVG_ST'));assert.ok(!a.scoring.used_features.includes('RECENT_ST_RANK'));
  assert.ok(!b.scoring.used_features.includes('RECENT_AVG_ST'));assert.ok(b.scoring.used_features.includes('RECENT_ST_RANK'));
  assert.ok(c.scoring.used_features.includes('RECENT_AVG_ST'));assert.ok(c.scoring.used_features.includes('RECENT_ST_RANK'));
  assert.equal(a.raw.avg_start_order,null);assert.equal(b.raw.avg_st,null);
  assert.equal(record.boats[1].racer_parameters.effective_avg_st,.17);
});

test('FINAL freezes the same-frame PRE snapshot even if current recent data was refreshed',()=>{
  const saved=baseline(),input=finalEntries();
  for(const entry of input)Object.assign(entry.v8_recent_lane,{snapshot_id:'snap-b',snapshot_key:'snapshot-b',row_hash:'changed-'+entry.boat_number,
    fetched_at:'2026-11-26T04:36:00Z',available_at:'2026-11-26T04:37:00Z',avg_st:.29});
  const savedBefore=structuredClone(saved);
  const out=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow,baseline:saved}).record;
  assert.equal(out.recent_lane_evidence.baseline_snapshot_reused,true);assert.equal(out.recent_lane_evidence.current_snapshot_changed,true);
  assert.ok(out.recent_lane_evidence.boats.every(row=>row.snapshot_id==='snap-a'&&row.raw.avg_st===.1));
  assert.equal(out.comparison.recent_lane_inputs_changed,false);
  assert.equal(out.input_as_of,'2026-11-26T04:35:00.000Z');assert.deepEqual(saved,savedBefore);
});

test('changed exhibition entry uses only explicitly matching-course finishes and excludes aggregate ST',()=>{
  const before=withRecent();
  before[0].v8_recent_lane=snapshot(before[0],{history:[
    {finish_order:1,finish_status:null,course:2,course_inferred:false,code:null},
    {finish_order:2,finish_status:null,course:2,course_inferred:false,code:null},
    ...Array.from({length:8},()=>({finish_order:1,finish_status:null,course:1,course_inferred:true,code:null}))]});
  const saved={...pre(before),id:'pre',created_date:'2026-11-26T01:00:00.100Z'};
  const input=finalEntries();input[0].exhibition_course=2;input[1].exhibition_course=1;
  const record=buildRaceForecast({race,entries:input,stage:'FINAL',now:finalNow,baseline:saved}).record;
  const row=record.recent_lane_evidence.boats[0];
  assert.equal(row.lane,1);assert.equal(row.selected_course,2);assert.equal(row.snapshot_id,'snap-a');
  assert.equal(row.raw.sample_size,10);assert.equal(row.scoring.finish_sample_size,2);
  assert.equal(row.scoring.finish_selection,'MATCHED_COURSE_HISTORY');assert.equal(row.scoring.blend_weight,.091);
  assert.equal(row.scoring.recent_winning_rate,9);assert.equal(row.scoring.recent_finish_score,78);
  assert.equal(row.scoring.recent_avg_st,null);assert.equal(row.scoring.recent_avg_start_order,null);
  assert.equal(row.scoring.start_before,row.scoring.start_after);
  assert.deepEqual(row.scoring.used_features,['RECENT_FINISH_FREQUENCY','RECENT_FINISH_POINTS']);
  assert.ok(row.scoring.omitted_reasons.includes('COURSE_CHANGED_AGGREGATE_ST_EXCLUDED'));
  const other=record.recent_lane_evidence.boats[1];
  assert.equal(other.scoring.finish_sample_size,0);assert.equal(other.scoring.used,false);
  assert.equal(other.scoring.reason,'NO_MATCHING_COURSE_STARTS');
});

test('source identities, names, source URL, chronology and row sample counts are checked again at the engine boundary',()=>{
  const entry=withRecent()[0];
  for(const mutate of [r=>r.registration_number='9999',r=>r.race_id='other',r=>r.race_key='2026-11-25_24_05',
    r=>r.boat_number=2,r=>r.source_name='別選手',r=>r.identity_status='UNVERIFIED',r=>r.revision='UNKNOWN',
    r=>r.source_url=recentLaneSourceUrl({...race,race_number:6}),r=>r.available_at='2026-11-26T02:00:00Z',
    r=>r.fetched_at='2026-11-26T00:40:00Z',r=>r.sample_size=9,r=>r.normal_sample_size=9,
    r=>r.history[0].finish_status='UNKNOWN']){
    const value=structuredClone(entry.v8_recent_lane);mutate(value);
    assert.equal(validatedRecentLaneSnapshot(value,{race,entry,asOf:preNow}),null);
  }
  const points=structuredClone(entry.v8_recent_lane);points.first_rate=88;
  assert.equal(validatedRecentLaneSnapshot(points,{race,entry,asOf:preNow}).first_rate,50);
});

test('a source acquired after PRE cannot be relabelled as frozen prior evidence',()=>{
  const saved=baseline();saved.recent_lane_evidence.boats[0].snapshot.available_at='2026-11-26T02:00:00Z';
  const out=buildRaceForecast({race,entries:finalEntries(),stage:'FINAL',now:finalNow,baseline:saved}).record;
  assert.equal(out.recent_lane_evidence.boats[0].source_basis,'CURRENT_SNAPSHOT');
  assert.equal(out.recent_lane_evidence.boats[1].source_basis,'BASELINE_SNAPSHOT');
  assert.equal(out.recent_lane_evidence.source_basis,'MIXED');
});

test('old or absent PRE evidence is explicitly recorded as a non-exhibition addition',()=>{
  const saved={...pre(entries()),id:'pre',created_date:'2026-11-26T01:00:00.100Z'};
  const out=buildRaceForecast({race,entries:finalEntries(),stage:'FINAL',now:finalNow,baseline:saved}).record;
  assert.equal(out.recent_lane_evidence.baseline_snapshot_reused,false);assert.equal(out.recent_lane_evidence.source_basis,'CURRENT_SNAPSHOT');
  assert.match(out.recent_lane_evidence.change_note,/履歴の追加と展示の変化/);
  assert.equal(out.comparison.recent_lane_inputs_changed,true);assert.equal(out.comparison.non_exhibition_inputs_changed,true);
  assert.ok(out.comparison.non_exhibition_changes.every(row=>row.fields.includes('recent_lane_snapshot')));
});

test('REPLAY never receives current recent history or reuses a live recent baseline',()=>{
  const out=buildRecentLaneEvidence({race,entries:withRecent(),stage:'FINAL',now:finalNow,baseline:baseline(),exhibitionComplete:true,replay:true});
  assert.equal(out.status,'UNAVAILABLE');assert.equal(out.baseline_snapshot_reused,false);
  assert.ok(out.boats.every(row=>row.snapshot===null&&row.raw===null&&row.reason==='REPLAY_CURRENT_SOURCE_EXCLUDED'));
});

test('PRE supplementation changes only the source-identity suffix and ignores calculation time',()=>{
  const noData=pre(entries()),ready=pre(),later=pre(withRecent(),'2026-11-26T01:05:00Z');
  assert.equal(noData.recent_lane_key,'NO_RECENT');assert.match(noData.forecast_key,/:NO_RECENT$/);
  assert.match(ready.recent_lane_key,/^RECENT_[0-9a-f]{8}$/);assert.notEqual(noData.forecast_key,ready.forecast_key);
  assert.equal(ready.forecast_key,later.forecast_key);assert.equal(ready.provenance.content_fingerprint,later.provenance.content_fingerprint);
  assert.equal(forecastRecentLaneKey(ready),ready.recent_lane_key);
  assert.equal(forecastRecentLaneKey({race,entries:withRecent(),stage:'PRE',now:preNow}),ready.recent_lane_key);
  const input=withRecent();input[0].v8_recent_lane.row_hash='a-new-source-row';
  assert.notEqual(pre(input).forecast_key,ready.forecast_key);
  const late=withRecent();for(const entry of late)entry.v8_recent_lane.available_at='2026-11-26T00:55:00Z';
  assert.equal(pre(late).input_as_of,'2026-11-26T00:55:00.000Z');
});

test('special starts affect finish denominators while absence and true zero history do not fabricate metrics',()=>{
  const input=withRecent();input[0].v8_recent_lane=snapshot(input[0],{finishes:[1,'F','L','欠'],avg_st:null,avg_start_order:null});
  input[1].v8_recent_lane=snapshot(input[1],{finishes:[],avg_st:0,avg_start_order:1,winning_rate:0});
  const out=pre(input),row=out.recent_lane_evidence.boats[0],empty=out.recent_lane_evidence.boats[1];
  assert.equal(row.raw.sample_size,3);assert.equal(row.raw.normal_sample_size,1);assert.equal(row.raw.absent_count,1);
  assert.equal(row.raw.first_rate,33.333);assert.equal(row.raw.avg_st,null);
  assert.ok(!row.scoring.used_features.includes('RECENT_AVG_ST'));
  assert.equal(empty.raw.sample_size,0);assert.equal(empty.scoring.used,false);assert.equal(empty.scoring.delta,null);
  assert.equal(empty.scoring.recent_avg_st,null);assert.equal(empty.scoring.reason,'NO_KNOWN_STARTS');
});

test('recent evidence changes scenario and ticket rankings through the existing boat score rather than an extra ticket bonus',()=>{
  const input=entries(),without=pre(input);
  input[5].v8_recent_lane=snapshot(input[5],{finishes:Array(10).fill(1),avg_st:0,avg_start_order:1});
  const withData=pre(input);
  assert.ok(withData.boats[5].base_score>without.boats[5].base_score);
  assert.notDeepEqual(withData.research_tickets,without.research_tickets);
  assert.ok(withData.scenarios.every(row=>row.ticket_revision==='V8_SCENARIO_TICKETS_2_RACER_PARAMETERS'));
  assert.equal(withData.provenance.recent_lane_used,true);
});

test('the captured BOATCAST fixture for Chatani passes source normalization and reaches the persisted scoring evidence',async()=>{
  const text=await readFile(new URL('./fixtures/boatcast_waku10_20261126_23_01.txt',import.meta.url),'utf8');
  const parsed=parseBoatcastWaku10(text);assert.equal(parsed.ok,true);
  const actualRace={...race,race_key:'2026-11-26_23_01',venue_code:'23',race_number:1};
  const input=entries().map((entry,index)=>{
    const name=parsed.racers[index].source_name,registration=index===0?'3968':entry.registration_number;
    return {...entry,race_key:actualRace.race_key,player_name:name,registration_number:registration,
      v8_racer_profile:{...entry.v8_racer_profile,player_name:name,registration_number:registration}};
  });
  const normalized=await normalizeRecentLaneSource({text,race:actualRace,entries:input,now:preNow,metadata:{
    source:'BOATCAST',data_type:'WAKU10',source_url:recentLaneSourceUrl(actualRace),http_status:200,
    race_date:'20261126',venue_code:'23',race_number:1,fetched_at:'2026-11-26T00:30:00Z'}});
  assert.equal(normalized.ok,true);
  for(const entry of input){
    entry.v8_recent_lane={...normalized.racers.find(row=>row.boat_number===entry.boat_number),
      snapshot_id:'captured-fixture-snapshot',snapshot_key:normalized.snapshot_key,
      source_url:normalized.source_url,fetched_at:normalized.fetched_at,available_at:'2026-11-26T00:31:00Z'};
  }
  const out=buildRaceForecast({race:actualRace,entries:input,stage:'PRE',now:preNow});assert.equal(out.ok,true);
  const row=out.record.recent_lane_evidence.boats[0];
  assert.equal(row.registration_number,'3968');assert.equal(row.raw.winning_rate,8.8);
  assert.equal(row.raw.first_rate,60);assert.equal(row.raw.top2_rate,90);assert.equal(row.raw.top3_rate,90);
  assert.equal(row.raw.avg_st,.13);assert.equal(row.raw.avg_start_order,2.2);
  assert.equal(row.scoring.recent_frequency_score,75);assert.equal(row.scoring.recent_finish_score,77.6);
  assert.equal(row.scoring.applied,true);assert.ok(row.scoring.delta>0);
  assert.equal(out.record.boats[0].base_score,row.scoring.base_after);
});
