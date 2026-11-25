import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {enrichLatestRacerEntries, LATEST_RACER_EVIDENCE_REVISION, V8_RACER_PROFILE_REVISION} from '../base44/shared/latestRacerEvidence.js';
import {buildSnapshot} from '../base44/shared/liveV7Snapshot.js';
import {unifiedV7} from '../base44/shared/liveV7Unified.js';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';
import {FORECAST_REVISION} from '../base44/shared/v8ForecastEngine.js';
import {saveV7Predictions} from '../base44/shared/v7PredictionStore.js';
import {fingerprintInput} from '../base44/shared/liveV7Snapshot.js';
import {digest,raceKey,platformUtc,timeMs} from '../base44/shared/liveV7Time.js';
import {fetchAllPaged} from '../base44/shared/pagedFetch.js';
import {loadOfficialResultsByRace} from '../base44/shared/officialResultRead.js';
import {selectV7RaceEntries} from '../base44/shared/v7RaceEntrySelector.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';
import {jstDate,groupBy,chronological,canonicalForecasts} from '../base44/shared/v8Repository.js';
import {loadRacerFrameTendencies,emptyFrameTendencies} from '../base44/shared/v8RacerTendencies.js';

export const NOW = '2026-11-22T04:00:00.000Z';
export const race = {id:'race-1',race_key:'2026-11-22_01_08',race_date:'2026-11-22',venue_code:'01',race_number:8,
  deadline:'2026-11-22T05:00:00.000Z',status:'scheduled',is_womens:false,series_name:'一般戦',updated_date:'2026-11-22T03:00:00.000Z'};
export const entries = () => Array.from({length:6},(_,i)=>({id:'entry-'+i,race_id:race.id,race_key:race.race_key,race_date:race.race_date,
  boat_number:i+1,registration_number:String(4501+i),national_win_rate:5.2,local_win_rate:5.3,national_2rate:35,
  motor_f2_rate:40,avg_st:.18,section_finishes:'3-4-5',updated_date:race.updated_date}));
export const dataset = () => ({metadata:{dataset_key:'official:fan2610:checksum',term_key:'2027_FIRST',source_file:'fan2610.txt',
  source_url:'https://www.boatrace.jp/fixture/fan2610.lzh',first_seen_at:'2026-11-21T10:00:00.000Z',activated_at:'2026-11-21T11:00:00.000Z',
  checksum:'checksum',record_count:6,term_start_date:'2026-05-01',term_end_date:'2026-10-31'},
  records:Array.from({length:6},(_,i)=>({id:'term-'+i,registration_number:String(4501+i),term_key:'2027_FIRST',
    term_start_date:'2026-05-01',term_end_date:'2026-10-31',race_count:200,win_rate:9,fukusho_rate:80,avg_st:.1,
    // imported_at is deliberately historical: only verified dataset activation
    // may serve as availability evidence, never a record's old import date.
    imported_at:'2025-01-01T00:00:00Z',course_stats:Object.fromEntries(Array.from({length:6},(_,c)=>[String(c+1),{
      entries:100,first_count:i===5?80:c===0?40:5,second_count:10,third_count:5,win_rate:999,
    }]))}))});
const adapt = (options={}) => enrichLatestRacerEntries({race,entries:entries(),stage:'PRE',asOf:NOW,dataset:dataset(),...options});

test('activation, first observation, race cutoff and mode all prevent future or replay enrichment',()=>{
  for (const change of [{activated_at:'2026-11-22T04:00:01Z'},{first_seen_at:'2026-11-22T04:00:01Z'}]) {
    const data=dataset();Object.assign(data.metadata,change);
    const out=adapt({dataset:data});assert.equal(out.provenance.reason,'DATASET_NOT_AVAILABLE_AS_OF');assert.deepEqual(out.entries,entries());
  }
  for (const options of [{recordMode:'REPLAY'},{asOf:race.deadline},{race:{...race,status:'finished'}},{asOf:'2026-11-21T10:30:00Z'}]) {
    const out=adapt(options);assert.equal(out.provenance.applied_boats,0);assert.deepEqual(out.entries,entries());
  }
});
test('actual period dates govern eligibility even when the period label names the next year',()=>{
  assert.equal(adapt().provenance.status,'APPLIED');
  for (const end of ['2026-11-30','2026-11-22']) {
    const data=dataset();data.metadata.term_end_date=end;data.records.forEach(r=>r.term_end_date=end);
    assert.equal(adapt({dataset:data}).provenance.reason,'TERM_PERIOD_NOT_COMPLETE_AS_OF');
  }
});
test('course counts supply existing V7 and V8 units and actual acquisition time',()=>{
  const out=adapt(),first=out.entries[0],sample=first.v7_evidence.course;
  assert.equal(out.provenance.revision,LATEST_RACER_EVIDENCE_REVISION);
  assert.deepEqual([sample.number,sample.n,...sample.rank_counts],[1,100,40,10,5]);
  assert.equal(first.v7_evidence.acquired_at,dataset().metadata.activated_at);
  assert.equal(first.course_stats['1'].win_percent,40);assert.equal(first.course_stats['1'].starts,100);
  assert.equal(first.v7_evidence.race_key,race.race_key);assert.match(first.v7_evidence.source_ref,/fan2610/);
  assert.equal(out.provenance.source.available_at,dataset().metadata.activated_at);
});
test('PRE and FINAL choose the correct course without substituting a missing exhibition course',()=>{
  const before=entries();before[0].expected_entry_course=4;
  const pre=adapt({entries:before});assert.equal(pre.entries[0].v7_evidence.course.number,1);
  assert.equal(pre.provenance.boats[0].courses.v8.number,4);
  const shown=entries().map(e=>({...e,exhibition_course:7-e.boat_number}));
  const final=adapt({stage:'FINAL',entries:shown});assert.equal(final.entries[0].v7_evidence.course.number,6);
  assert.equal(final.entries[0].v7_evidence.course.rank_counts[0],5);
  const missing=adapt({stage:'FINAL'});assert.equal(missing.entries[0].v7_evidence,undefined);
  assert.equal(missing.provenance.boats[0].courses.v8,undefined);
});
test('daily card values have priority; only missing or invalid national rate and ST use term values',()=>{
  const input=entries();input[0].national_win_rate=0;input[0].avg_st=.22;
  input[1].national_win_rate=99;input[1].national_2rate=null;input[1].national_f2_rate=47;input[1].avg_st=null;input[1].average_st=.19;
  input[2].national_2rate='';input[2].avg_st='';input[2].national_win_rate=null;
  const out=adapt({entries:input});
  assert.equal(out.entries[0].national_win_rate,0);assert.equal(out.entries[0].avg_st,.22);
  assert.equal(out.entries[1].national_win_rate,9);assert.equal(out.entries[1].national_2rate,47);assert.equal(out.entries[1].avg_st,.19);
  assert.equal(out.entries[2].national_win_rate,9);assert.equal(out.entries[2].national_2rate,80);assert.equal(out.entries[2].avg_st,.1);
  assert.equal(out.provenance.boats[0].fields.national_win_rate.source,'RACE_ENTRY');
  assert.equal(out.provenance.boats[2].fields.national_win_rate.source,'OFFICIAL_TERM_FALLBACK');
  assert.equal(out.entries[2].local_win_rate,input[2].local_win_rate);
});
test('valid existing V7 lane and section evidence survive course replacement without changing the source input',()=>{
  const input=entries();input[0].v7_evidence={race_key:race.race_key,source_ref:'lane-history',acquired_at:'2026-11-22T03:00:00Z',
    lane:{number:1,finishes:[1,3,2]},section:{scale:'points_0_10',points:7},course:{number:1,n:20,rank_counts:[4,4,4]}};
  const original=structuredClone(input),out=adapt({entries:input,stage:'FINAL'});
  assert.deepEqual(input,original);assert.deepEqual(out.entries[0].v7_evidence,input[0].v7_evidence);
  input[0].exhibition_course=6;const merged=adapt({entries:input,stage:'FINAL'}).entries[0].v7_evidence;
  assert.deepEqual(merged.lane,input[0].v7_evidence.lane);assert.deepEqual(merged.section,input[0].v7_evidence.section);
  assert.equal(merged.course.number,6);assert.equal(merged.acquired_at,'2026-11-22T03:00:00.000Z');
  assert.match(merged.source_ref,/lane-history/);assert.equal(input[0].v7_evidence.course.number,1);
});
test('future and other-race V7 branches cannot become valid by merging an official course',()=>{
  for (const override of [{acquired_at:'2026-11-23T00:00:00Z'},{race_key:'2026-11-22_02_08'}]) {
    const input=entries();input[0].v7_evidence={race_key:race.race_key,acquired_at:'2026-11-22T03:00:00Z',source_ref:'existing',
      lane:{number:1,finishes:[1,1,1]},section:{scale:'points_0_10',points:10},...override};
    const proof=adapt({entries:input}).entries[0].v7_evidence;assert.equal(proof.lane,undefined);assert.equal(proof.section,undefined);
    assert.equal(proof.course.number,1);assert.equal(proof.acquired_at,dataset().metadata.activated_at);
  }
});
test('invalid or zero course samples and missing racer records remain missing',()=>{
  const data=dataset();for(const c of Object.values(data.records[0].course_stats))c.entries=0;
  data.records[1].course_stats['2'].first_count=101;
  data.records[2].registration_number='9999';
  const out=adapt({dataset:data});assert.equal(out.entries[0].course_stats,undefined);assert.equal(out.entries[0].v7_evidence,undefined);
  assert.equal(out.entries[1].course_stats['2'],undefined);assert.equal(out.entries[1].v7_evidence,undefined);
  assert.equal(out.entries[2].course_stats,undefined);assert.ok(out.provenance.missing_registration_numbers.includes('4503'));
});
test('an explicitly newer existing course does not regress to an older period',()=>{
  const input=entries(),later='2026-11-05';input[0].course_stats={'1':{win_percent:75,starts:20,term_end_date:later}};
  input[0].v7_evidence={race_key:race.race_key,source_ref:'newer',acquired_at:'2026-11-22T03:00:00Z',
    course:{number:1,n:20,rank_counts:[15,2,1],term_end_date:later}};
  const out=adapt({entries:input});assert.equal(out.entries[0].course_stats['1'].win_percent,75);
  assert.equal(out.entries[0].v7_evidence.course.rank_counts[0],15);
});
test('the existing V7 and V8 engines actually consume the new evidence without changing their weights',()=>{
  const input=entries(),original=structuredClone(input),out=adapt({entries:input});
  const baseV7=unifiedV7(buildSnapshot({race,entries:input,observedAt:NOW},'PRE'),'PRE');
  const termV7=unifiedV7(buildSnapshot({race,entries:out.entries,observedAt:NOW},'PRE'),'PRE');
  assert.equal(baseV7.status,'READY');assert.equal(termV7.status,'READY');
  assert.ok(termV7.marginals[0]['6']>baseV7.marginals[0]['6']);
  const baseV8=buildRaceForecast({race,entries:input,stage:'PRE',now:NOW}).record;
  const termV8=buildRaceForecast({race,entries:out.entries,stage:'PRE',now:NOW}).record;
  assert.equal(baseV8.boats[5].course_win_percent,null);assert.equal(termV8.boats[5].course_win_percent,80);
  assert.ok(termV8.boats[5].base_score>baseV8.boats[5].base_score);
  assert.notDeepEqual(termV8.scenarios,baseV8.scenarios);assert.deepEqual(input,original);
});
test('absent dataset preserves the original prediction input exactly',()=>{
  const out=adapt({dataset:null});assert.deepEqual(out.entries,entries());assert.equal(out.provenance.reason,'DATASET_UNAVAILABLE');
});

function detailedDataset() {
  const data=dataset();
  data.records.forEach((record,index)=>{
    record.racer_name='選手'+(index+1);
    Object.values(record.course_stats).forEach(course=>Object.assign(course,{
      fourth_count:0,fifth_count:0,sixth_count:course.entries-course.first_count-course.second_count-course.third_count,
      avg_st:.16,avg_st_rank:2.5,f_count:0,l0_count:0,l1_count:0,
    }));
  });
  return data;
}
const zeroCourse=()=>({entries:0,first_count:0,second_count:0,third_count:0,fourth_count:0,fifth_count:0,sixth_count:0,
  avg_st:0,avg_st_rank:0,f_count:0,l0_count:0,l1_count:0});

test('V8 profiles retain six observed-course parameters and immutable official source metadata',()=>{
  const data=detailedDataset(),input=entries(),beforeData=structuredClone(data),beforeInput=structuredClone(input);
  const out=adapt({dataset:data,entries:input}),profile=out.entries[0].v8_racer_profile;
  assert.equal(profile.revision,V8_RACER_PROFILE_REVISION);assert.equal(profile.registration_number,'4501');
  assert.equal(profile.player_name,'選手1');assert.deepEqual(Object.keys(profile.courses),['1','2','3','4','5','6']);
  assert.deepEqual(profile.courses['1'],{course:1,sample_size:100,first_count:40,second_count:10,third_count:5,
    fourth_count:0,fifth_count:0,sixth_count:45,first_rate:40,second_rate:10,third_rate:5,top2_rate:50,top3_rate:55,
    avg_st:.16,avg_st_rank:2.5,f_count:0,l_count:0});
  assert.deepEqual(profile.source,{dataset_key:data.metadata.dataset_key,term_key:data.metadata.term_key,
    source_url:data.metadata.source_url,source_file:data.metadata.source_file,term_start_date:data.metadata.term_start_date,
    term_end_date:data.metadata.term_end_date,checksum:data.metadata.checksum,available_at:data.metadata.activated_at});
  assert.equal(out.provenance.profiled_boats,6);
  assert.equal(out.entries[0].course_stats['1'].avg_st_rank,2.5);
  assert.equal(out.entries[0].course_stats['1'].top3_rate,55);
  profile.courses['1'].first_count=999;profile.course_priors['1'].sample_size=999;
  assert.notEqual(out.entries[1].v8_racer_profile.course_priors['1'].sample_size,999);
  assert.deepEqual(data,beforeData);assert.deepEqual(input,beforeInput);
});
test('course priors weight the full dataset by observations rather than by racer or displayed entrants',()=>{
  const data=detailedDataset();
  data.records.forEach(record=>{record.course_stats['1']=zeroCourse();});
  Object.assign(data.records[0].course_stats['1'],{entries:20,first_count:4,second_count:5,third_count:3,
    fourth_count:2,fifth_count:3,sixth_count:3,avg_st:.16,avg_st_rank:2.5});
  Object.assign(data.records[1].course_stats['1'],{entries:80,first_count:16,second_count:24,third_count:8,
    fourth_count:8,fifth_count:12,sixth_count:12,avg_st:.2,avg_st_rank:3.5});
  const out=adapt({dataset:data,entries:[entries()[0]]}),prior=out.entries[0].v8_racer_profile.course_priors['1'];
  assert.equal(prior.sample_size,100);
  assert.deepEqual([prior.first_rate,prior.second_rate,prior.third_rate,prior.top2_rate,prior.top3_rate],[20,29,11,49,60]);
  assert.ok(Math.abs(prior.avg_st-.192)<1e-12);assert.equal(prior.avg_st_rank,3.3);
});
test('a known zero course sample differs from a missing course and never becomes a zero performance rate',()=>{
  const data=detailedDataset();data.records[0].course_stats['1']=zeroCourse();delete data.records[0].course_stats['2'];
  const profile=adapt({dataset:data}).entries[0].v8_racer_profile;
  assert.equal(profile.courses['1'].sample_size,0);assert.equal(profile.courses['1'].first_count,0);
  for(const metric of ['first_rate','second_rate','third_rate','top2_rate','top3_rate','avg_st','avg_st_rank'])assert.equal(profile.courses['1'][metric],null);
  assert.equal(profile.courses['2'].sample_size,null);assert.equal(profile.courses['2'].first_count,null);
  assert.equal(profile.course_priors['2'].sample_size,null);
});
test('invalid and missing profile values remain null and cannot silently bias a complete-dataset prior',()=>{
  const data=detailedDataset(),raw=data.records[0].course_stats['1'];
  delete raw.second_count;raw.avg_st='NaN';raw.avg_st_rank=7;raw.f_count=101;raw.l0_count=80;raw.l1_count=30;
  const profile=adapt({dataset:data}).entries[0].v8_racer_profile,course=profile.courses['1'],prior=profile.course_priors['1'];
  assert.equal(course.first_rate,40);assert.equal(course.second_count,null);assert.equal(course.top2_rate,null);assert.equal(course.top3_rate,null);
  for(const metric of ['avg_st','avg_st_rank','f_count','l_count'])assert.equal(course[metric],null);
  assert.equal(prior.sample_size,600);assert.equal(prior.top2_rate,null);assert.equal(prior.avg_st,null);assert.equal(prior.avg_st_rank,null);
  raw.second_count=10;raw.third_count=101;
  const contradictory=adapt({dataset:data}).entries[0].v8_racer_profile.courses['1'];
  assert.equal(contradictory.first_count,null);assert.equal(contradictory.first_rate,null);assert.equal(contradictory.top3_rate,null);
});
test('profile availability is established anew and cannot be inherited from an unverified caller object',()=>{
  const input=entries();input[0].v8_racer_profile={registration_number:'9999',source:{available_at:NOW}};
  const original=structuredClone(input);
  for(const change of [{dataset:null},{recordMode:'REPLAY'},{asOf:race.deadline}]){
    const out=adapt({...change,entries:input});assert.equal(out.entries[0].v8_racer_profile,undefined);
  }
  const future=detailedDataset();future.metadata.first_seen_at='2026-11-22T04:00:01Z';
  assert.equal(adapt({entries:input,dataset:future}).entries[0].v8_racer_profile,undefined);
  assert.deepEqual(input,original);
});
test('duplicate or wrong-period dataset identities do not produce apparently complete priors',()=>{
  for(const corrupt of [data=>{data.records[0].registration_number=data.records[1].registration_number;},
    data=>{data.records[0].term_start_date='2026-01-01';}]){
    const data=detailedDataset();corrupt(data);
    const out=adapt({dataset:data});assert.equal(out.entries[0].v8_racer_profile,undefined);
    const other=out.entries[2].v8_racer_profile;
    assert.ok(other);assert.equal(other.course_priors['1'].sample_size,null);assert.equal(other.course_priors['1'].first_rate,null);
  }
});

// Exercise the actual scheduled generation functions and the real V7 saver.
// Only platform/network dependencies are replaced; no production mutations occur.
const withoutImports = source => source.replace(/^import .*;\r?\n/gm,'');
const autoSource=withoutImports(readFileSync(new URL('../base44/shared/v7AutoGeneration.js',import.meta.url),'utf8')).replace('export async function','async function');
const captureRunnerSource=withoutImports(readFileSync(new URL('../base44/shared/v8LiveCapture.js',import.meta.url),'utf8')).replace(/^export /gm,'');
const captureSource=stripTypeScriptTypes(withoutImports(readFileSync(new URL('../base44/functions/v8CaptureForecasts/entry.ts',import.meta.url),'utf8')))
  .replace('export default async function','return async function');
function fakePlatform({shown=false}={}) {
  const r={...race,exhibition_ready:shown}, table={Race:[r],RaceEntry:entries().map(e=>shown?{...e,exhibition_course:7-e.boat_number,exhibition_st:.15,exhibition_time:6.7}:e),
    RaceResult:[],OddsSnapshot:[],OnlineFetchLog:[],PredictionV7:[],V7GenerationTrace:[],V8RaceForecast:[],V7WeatherObservation:[],V8PatternEvidence:[],
    V7StageClaim:['PRE','FINAL'].map(stage=>({id:'claim-'+stage,claim_key:race.race_key+'::'+stage,state:'free'}))};
  const matches=(row,query)=>Object.entries(query).every(([key,value])=>value&&typeof value==='object'&&'$in' in value?value.$in.includes(row[key]):row[key]===value);
  const sr=Object.fromEntries(Object.entries(table).map(([name,rows])=>[name,{name,rows,
    filter:async(query,sort)=>{const filtered=structuredClone(rows.filter(row=>matches(row,query)));return typeof sort==='object'?{items:filtered,has_more:false,next_cursor:null}:filtered;},
    get:async id=>structuredClone(rows.find(row=>row.id===id)),
    create:async payload=>{const saved={...structuredClone(payload),id:name+'-'+(rows.length+1),created_date:new Date().toISOString()};rows.push(saved);return structuredClone(saved);},
    updateMany:async(query,change)=>{const matching=rows.filter(row=>matches(row,query));matching.forEach(row=>Object.assign(row,change.$set));return {updated:matching.length};},
  }]));
  return {table,sr,client:{auth:{me:async()=>({role:'admin'})},asServiceRole:{entities:sr}}};
}
function v7Runner(state,load) {
  const dependencies={buildSnapshot,fingerprintInput,unifiedV7,digest,raceKey,platformUtc,timeMs,saveV7Predictions,
    createGenerationTrace:()=>({applySavedPredictions(){},fillUntouched(){},observe(){},flush:async()=>({tracked:0})}),
    hasPartialExhibition:rows=>rows.some(e=>e.exhibition_time!=null),refreshRaceForGeneration:async()=>({status:'READY',race:structuredClone(state.table.Race[0])}),
    fetchAllPaged,loadOfficialResultsByRace,provisionStageClaims:async()=>({expected:2,created:0,ready:2,missing:[],duplicate:[],read_complete:true,creation_unconfirmed:0,
      readyPairs:new Set(['PRE','FINAL'].map(stage=>race.race_key+'::'+stage))}),acquireLock:async()=> 'lock',releaseLock:async()=>{},selectV7RaceEntries,
    loadLatestRacerDataset:load,enrichLatestRacerEntries};
  return new Function(...Object.keys(dependencies),autoSource+'\nreturn runV7AutoGeneration;')(...Object.values(dependencies));
}
function v8Handler(state,load) {
  const dependencies={createClientFromRequest:()=>state.client,acquireLock:async()=> 'lock',releaseLock:async()=>{},selectV7RaceEntries,utcMs,
    buildRaceForecast,FORECAST_REVISION,jstDate,readV8Rows:async(entity,query)=>entity.filter(query),groupBy,chronological,canonicalForecasts,
    loadLatestRacerDataset:load,enrichLatestRacerEntries,loadRacerFrameTendencies,emptyFrameTendencies};
  return new Function(...Object.keys(dependencies),captureRunnerSource+'\n'+captureSource)(...Object.values(dependencies));
}
test('V7 scheduled generation reads once, stores real term provenance, and never updates an existing prediction',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});const state=fakePlatform();let reads=0,current=dataset();
  const run=v7Runner(state,async()=>{reads++;return current;});
  const first=await run(state.client,{race_keys:[race.race_key]});assert.equal(first.saved,1);assert.equal(reads,1);
  const saved=structuredClone(state.table.PredictionV7[0]);assert.equal(saved.racer_term_evidence.source.dataset_key,current.metadata.dataset_key);
  assert.equal(saved.racer_term_evidence.boats[5].courses.v7.rank_counts[0],80);assert.equal(first.racer_term.enriched_predictions,1);
  assert.ok(saved.input_hash);current=dataset();current.records[5].course_stats['6'].first_count=0;
  const second=await run(state.client,{race_keys:[race.race_key]});assert.equal(second.saved,0);assert.equal(state.table.PredictionV7.length,1);
  assert.deepEqual(state.table.PredictionV7[0],saved);
});
test('V7 optional dataset failures retain the daily-card prediction and a saved diagnostic',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});const state=fakePlatform();
  const summary=await v7Runner(state,async()=>{throw new Error('simulated read failure');})(state.client,{race_keys:[race.race_key]});
  assert.equal(summary.saved,1);assert.equal(summary.racer_term.status,'READ_FAILED');
  assert.equal(state.table.PredictionV7[0].racer_term_evidence.dataset_read_status,'READ_FAILED');
  assert.equal(state.table.PredictionV7[0].racer_term_evidence.applied_boats,0);
});
test('V8 live FINAL uses observed courses and persists the provenance once',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});const state=fakePlatform({shown:true});let reads=0;
  const handle=v8Handler(state,async()=>{reads++;return dataset();}),request=()=>new Request('https://test.invalid/capture',{method:'POST'});
  const first=await (await handle(request())).json();assert.equal(first.created,1);assert.equal(first.final,1);assert.equal(reads,1);
  const saved=structuredClone(state.table.V8RaceForecast[0]);assert.equal(saved.boats[0].observed_course,6);assert.equal(saved.boats[0].course_win_percent,5);
  assert.equal(saved.provenance.racer_term_evidence.boats[0].courses.v8.number,6);
  const again=await (await handle(request())).json();assert.equal(again.created,0);assert.deepEqual(state.table.V8RaceForecast[0],saved);
});
test('V8 optional dataset failures still capture an otherwise complete PRE forecast',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});const state=fakePlatform();
  const response=await v8Handler(state,async()=>{throw new Error('simulated read failure');})(new Request('https://test.invalid/capture',{method:'POST'}));
  const summary=await response.json();assert.equal(response.status,200);assert.equal(summary.created,1);assert.equal(summary.racer_term.status,'READ_FAILED');
  const saved=state.table.V8RaceForecast[0];assert.equal(saved.boats[0].course_win_percent,null);
  assert.equal(saved.provenance.racer_term_evidence.dataset_read_status,'READ_FAILED');
});
test('the V7 saver does not attach official provenance from browser input or a mismatched snapshot',()=>{
  const src=withoutImports(readFileSync(new URL('../base44/shared/v7PredictionStore.js',import.meta.url),'utf8')).replace('export async function','async function');
  const sanitize=new Function('timeMs','LATEST_RACER_EVIDENCE_REVISION',src+'\nreturn sanitize;')(timeMs,LATEST_RACER_EVIDENCE_REVISION);
  const doc={race_key:race.race_key,stage:'PRE',source:'SERVER',record_hash:'server:'+race.race_key+':PRE',generated_at:NOW,
    plans:{hit_4:{tickets:['1-2-3']}},racer_term_evidence:adapt().provenance};
  assert.ok(sanitize(doc).racer_term_evidence);assert.equal(sanitize({...doc,source:'BROWSER'}).racer_term_evidence,undefined);
  assert.equal(sanitize({...doc,racer_term_evidence:{...doc.racer_term_evidence,as_of:'2026-11-22T04:01:00Z'}}).racer_term_evidence,undefined);
});
