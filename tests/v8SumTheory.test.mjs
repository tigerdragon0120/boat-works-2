import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSumEvidence, sanitizeOriginalExhibition, sumObservationKey} from '../base44/shared/v8SumTheory.js';
import {buildRaceForecast} from '../base44/shared/v8ForecastEngine.js';
import {buildTheoryTrial, theoryTrialKey} from '../base44/shared/v8TheoryTrial.js';

const race = {
  id:'race-sum', race_key:'2026-11-24_21_07', race_date:'2026-11-24', venue_code:'21', race_number:7,
  deadline:'2026-11-24T11:36:00+09:00', status:'scheduled', is_womens:false, updated_date:'2026-11-24T01:00:00Z',
};
// Source: the public BOATERS 2026-11-24 Ashiya 7R SUM table. This is a fixed
// arithmetic fixture, not a claimed performance/strategy backtest.
const laps = [36.04,37.11,37.19,37.40,37.33,37.16];
const times = [6.73,6.79,6.86,6.81,6.86,6.84];
const boats = times.map((value,i) => ({boat_number:i+1,registration_number:String(4500+i),exhibition_time:value,active:true}));
const raw = {
  status:'AVAILABLE', source_kind:'OFFICIAL_ORIGINAL_EXHIBITION', provider:'BOATCAST',
  source_url:'https://race.boatcast.jp/txt/21/bc_oriten_20261124_21_07.txt',
  exhibition_source_url:'https://www.boatrace.jp/owpc/pc/race/beforeinfo?hd=20261124&jcd=21&rno=7',
  captured_at:'2026-11-24T02:20:00Z', exhibition_captured_at:'2026-11-24T02:19:00Z',
  venue_code:'21',race_date:'2026-11-24',race_number:7,
  entries:boats.map((boat,i)=>({...boat,lap_time:laps[i],turn_time:[7.57,8.23,8.16,8.22,8.15,8.11][i],straight_time:7.65+i*.02})),
};
const now='2026-11-24T02:25:00Z';
const args = () => ({race,boats,originalExhibition:structuredClone(raw),stage:'FINAL',now});
const entries=()=>boats.map((boat,i)=>({...boat,id:'entry-'+(i+1),race_id:race.id,race_key:race.race_key,race_date:race.race_date,
  national_win_rate:5.5,national_2rate:40,local_win_rate:5,avg_st:.16,motor_2rate:40,
  section_finishes:'3-4-3',exhibition_st:.13,exhibition_course:i+1,updated_date:'2026-11-24T02:20:00Z'}));
const forecastArgs=()=>({race,entries:entries(),originalExhibition:structuredClone(raw),stage:'FINAL',now});
const trialSnapshot=()=>({id:'snapshot-1',race_id:race.id,race_key:race.race_key,race_date:race.race_date,
  venue_code:race.venue_code,race_number:race.race_number,deadline:race.deadline,snapshot_key:'source-1',snapshot_stage:'FINAL',
  gender_model:'OPEN',observed_at:'2026-11-24T02:22:00Z',created_date:'2026-11-24T02:22:00.001Z',
  boats:entries(),original_exhibition:structuredClone(raw)});

test('reproduces the published six-boat totals and positive-faster differences without rounding inputs first',()=>{
  const {evidence,original_exhibition}=buildSumEvidence(args());
  assert.equal(evidence.status,'READY');
  assert.equal(evidence.selected_model,'SUM_BASIC');
  assert.equal(evidence.basic.mean,43.853333);
  assert.deepEqual(evidence.basic.boats.map(row=>row.total),[42.77,43.90,44.05,44.21,44.19,44.00]);
  assert.deepEqual(evidence.basic.boats.map(row=>Number(row.delta.toFixed(2))),[1.08,-.05,-.20,-.36,-.34,-.15]);
  assert.equal(evidence.basic.boats[0].relative_score,100);
  assert.equal(evidence.venue_specific.status,'UNSUPPORTED_VENUE');
  assert.equal(evidence.input_as_of,'2026-11-24T02:20:00.000Z');
  assert.equal(original_exhibition.entries.length,6);
  assert.equal(evidence.author_strategy_reproduced,false);
});

test('only Amagasaki enables the confirmed three-component sum, with basic SUM retained separately',()=>{
  const input=args();
  input.race={...race,venue_code:'13',race_key:'2026-11-24_13_07'};
  input.originalExhibition={...raw,venue_code:'13',source_url:raw.source_url.replaceAll('21','13'),
    exhibition_source_url:raw.exhibition_source_url.replace('jcd=21','jcd=13')};
  const {evidence}=buildSumEvidence(input);
  assert.equal(evidence.selected_model,'SUM_AMAGASAKI');
  assert.equal(evidence.venue_specific.boats[0].total,50.34);
  assert.equal(evidence.basic.boats[0].total,42.77);
  input.originalExhibition.entries=raw.entries.map((row,i)=>i===2?{...row,turn_time:null}:row);
  const partial=buildSumEvidence(input).evidence;
  assert.equal(partial.venue_specific.status,'INSUFFICIENT');
  assert.equal(partial.selected_model,'SUM_BASIC');
});

test('missing or invalid input never becomes zero or a mean of the available subset',()=>{
  for(const value of [null,undefined,0,NaN,Infinity,'36.04','']){
    const input=args();input.originalExhibition.entries[0].lap_time=value;
    const evidence=buildSumEvidence(input).evidence;
    assert.equal(evidence.status,'INSUFFICIENT');
    assert.equal(evidence.basic.mean,null);
    assert.ok(evidence.basic.boats.every(row=>row.delta==null&&row.relative_score==null));
  }
  const input=args();input.originalExhibition.entries.pop();
  assert.equal(buildSumEvidence(input).evidence.basic.mean,null);
});

test('same-race source URLs, registration identities and two timestamps must all agree',()=>{
  const mutations=[
    input=>input.originalExhibition.entries[0].registration_number='9999',
    input=>input.originalExhibition.entries[1]=input.originalExhibition.entries[0],
    input=>input.originalExhibition.venue_code='13',
    input=>input.originalExhibition.race_number=8,
    input=>input.originalExhibition.source_url='https://example.com/times',
    input=>input.originalExhibition.source_url=raw.source_url.replace('_07.txt','_08.txt'),
    input=>input.originalExhibition.exhibition_source_url=raw.exhibition_source_url.replace('rno=7','rno=8'),
    input=>input.originalExhibition.source_kind='USER_ENTERED',
    input=>input.originalExhibition.captured_at='2026-11-24T02:26:00Z',
    input=>input.originalExhibition.exhibition_captured_at='2026-11-24T02:26:00Z',
    input=>input.originalExhibition.exhibition_captured_at=null,
    input=>input.originalExhibition.captured_at='2026-11-23T02:20:00Z',
    input=>input.originalExhibition.entries[0].exhibition_time=6.74,
  ];
  for(const mutate of mutations){
    const input=args();mutate(input);
    const result=buildSumEvidence(input);
    assert.equal(result.evidence.status,'INVALID');
    assert.equal(result.original_exhibition,null);
    assert.equal(result.evidence.selected_model,null);
  }
});

test('an existing source row needs a confirmed four-digit registration and never inherits a guessed identity',()=>{
  for(const value of [undefined,null,'','450','A500',true]){
    const input=args();input.originalExhibition.entries[0].registration_number=value;
    const result=buildSumEvidence(input);
    assert.equal(result.evidence.status,'INVALID');
    assert.ok(result.evidence.missing.includes('ORIGINAL_RACER_MISMATCH'));
    assert.equal(result.evidence.selected_model,null);
    assert.equal(result.original_exhibition,null);
    const forecast=forecastArgs();forecast.originalExhibition=input.originalExhibition;
    const record=buildRaceForecast(forecast).record;
    const fallback=buildRaceForecast({...forecast,originalExhibition:null}).record;
    assert.equal(record.sum_evidence.used_for_scoring,false);
    assert.deepEqual(record.research_tickets,fallback.research_tickets);
  }
  const absent=args();absent.originalExhibition.entries.shift();
  const partial=buildSumEvidence(absent);
  assert.equal(partial.evidence.status,'INSUFFICIENT');
  assert.ok(partial.evidence.basic.missing.includes('BOAT_1_SUM_INPUT_MISSING'));
});

test('live cutoff excludes late inputs while replay identifies a later observation honestly',()=>{
  const input=args();input.now='2026-11-24T03:00:00Z';
  input.originalExhibition.captured_at='2026-11-24T02:35:00Z';
  assert.equal(buildSumEvidence(input).evidence.status,'INVALID');
  const replay=buildSumEvidence({...input,replay:true});
  assert.equal(replay.evidence.status,'READY');
  assert.equal(replay.evidence.source_period,'REPLAY_OBSERVATION');
  input.originalExhibition.captured_at='2026-11-24T03:01:00Z';
  assert.equal(buildSumEvidence({...input,replay:true}).evidence.status,'INVALID');
});

test('scratch handling excludes the inactive boat and explicitly identifies the active-boat extension',()=>{
  const input=args();input.boats=boats.map((boat,i)=>({...boat,active:i!==0}));
  input.originalExhibition.entries=input.originalExhibition.entries.slice(1);
  const {evidence}=buildSumEvidence(input);
  assert.equal(evidence.status,'READY');assert.equal(evidence.active_count,5);
  assert.equal(evidence.mean_basis,'ACTIVE_STARTERS_EXTENSION');
  assert.equal(evidence.basic.boats.length,5);
  assert.ok(evidence.note.includes('独自拡張'));
  assert.equal(evidence.basic.mean,44.07);
});

test('pre-exhibition stages ignore even complete original times, with no leaked raw data',()=>{
  for(const stage of ['PRE','DAY_BEFORE']){
    const actual=buildSumEvidence({...args(),stage});
    const empty=buildSumEvidence({...args(),stage,originalExhibition:null});
    assert.deepEqual(actual,empty);
    assert.equal(actual.evidence.status,'WAIT_EXHIBITION');
    assert.equal(actual.original_exhibition,null);
  }
});

test('input whitelist and observation key exclude results and unchanged fetch timestamps',()=>{
  const input={...raw,result:'6-5-4',payout:10000,entries:raw.entries.map(row=>({...row,finish_order:1}))};
  assert.equal(JSON.stringify(sanitizeOriginalExhibition(input)).includes('finish_order'),false);
  assert.equal(JSON.stringify(sanitizeOriginalExhibition(input)).includes('payout'),false);
  assert.equal(sumObservationKey(input),sumObservationKey(raw));
  assert.equal(sumObservationKey({...raw,captured_at:now,exhibition_captured_at:now}),sumObservationKey(raw));
  const corrected=structuredClone(raw);corrected.entries[0].lap_time+=.01;
  assert.notEqual(sumObservationKey(corrected),sumObservationKey(raw));
});

test('allowlisted acquisition reasons survive unavailable and partial observations without changing data keys',()=>{
  const codes=['HALF_LAP_NOT_SUPPORTED','MEASUREMENT_UNAVAILABLE','LAP_TIME_NOT_PUBLISHED',
    'ORIGINAL_TIMES_PARTIAL','HTTP_403','HTTP_404','HTTP_429','HTTP_503','FETCH_TIMEOUT','FETCH_FAILED',
    'FETCH_TIME_BUDGET','NOT_PUBLISHED','ROSTER_AMBIGUOUS','SOURCE_RACER_MISMATCH'];
  for(const code of codes){
    const input=args();input.originalExhibition={...input.originalExhibition,status:'UNAVAILABLE',entries:[],reasons:[code]};
    const result=buildSumEvidence(input);
    assert.equal(result.evidence.status,'INSUFFICIENT');
    assert.deepEqual(result.evidence.acquisition_reasons,[code]);
    assert.deepEqual(sanitizeOriginalExhibition(input.originalExhibition).reasons,[code]);
    assert.deepEqual(buildSumEvidence({...input,stage:'PRE'}).evidence.acquisition_reasons,[]);
  }
  const partial=args();partial.originalExhibition.status='PARTIAL';partial.originalExhibition.entries[0].lap_time=null;
  partial.originalExhibition.reasons=['ORIGINAL_TIMES_PARTIAL','HTTP_429','ORIGINAL_TIMES_PARTIAL',
    'result=1-2-3','HTTP_999',{},null,'<script>bad</script>'];
  const result=buildSumEvidence(partial);
  assert.deepEqual(result.evidence.acquisition_reasons,['ORIGINAL_TIMES_PARTIAL','HTTP_429']);
  assert.deepEqual(result.original_exhibition.reasons,['ORIGINAL_TIMES_PARTIAL','HTTP_429']);
  assert.equal(result.evidence.basic.mean,null);
  assert.equal(sumObservationKey({...raw,reasons:['HTTP_429']}),sumObservationKey(raw));
  assert.equal(sumObservationKey({...raw,reasons:['NOT_PUBLISHED']}),sumObservationKey(raw));
  const invalid=args();invalid.originalExhibition.entries[0].registration_number=null;
  invalid.originalExhibition.reasons=['SOURCE_RACER_MISMATCH'];
  assert.deepEqual(buildSumEvidence(invalid).evidence.acquisition_reasons,['SOURCE_RACER_MISMATCH']);
});

test('V8 replaces its single 15 percent speed component and persists the exact evidence',()=>{
  const input=forecastArgs();
  const without=buildRaceForecast({...input,originalExhibition:null}).record;
  const original=JSON.stringify(input);
  const output=buildRaceForecast(input).record;
  assert.equal(output.sum_evidence.used_for_scoring,true);
  assert.equal(output.provenance.sum_speed_weight,.15);
  assert.equal(output.provenance.sum_replaces_exhibition_speed,true);
  assert.equal(output.original_exhibition.source_url,raw.source_url);
  assert.notEqual(output.forecast_key,without.forecast_key);
  for(const boat of output.boats){
    const expected=.75*boat.base_score+.15*boat.sum_speed_score+.10*boat.exhibition_start_score;
    assert.ok(Math.abs(boat.score-expected)<.002);
    assert.equal(boat.speed_feature,'SUM_BASIC');
  }
  assert.equal(output.research_tickets.length,8);
  assert.deepEqual(output.decision.tickets,output.research_tickets);
  assert.equal(output.decision.status,'WATCH');
  assert.equal(JSON.stringify(input),original);
  // Source corrections feed the saved V8 score/ticket ordering, rather than
  // decorating an independently unchanged prediction.
  input.originalExhibition.entries=input.originalExhibition.entries.map((row,i)=>({...row,lap_time:40-i}));
  const changed=buildRaceForecast(input).record;
  assert.notDeepEqual(changed.research_tickets,output.research_tickets);
  assert.ok(changed.boats[5].score>output.boats[5].score);
});

test('invalid SUM preserves existing V8 scoring and records a clear fallback',()=>{
  const input=forecastArgs();input.originalExhibition.entries[3].lap_time=null;
  const invalid=buildRaceForecast(input).record;
  const without=buildRaceForecast({...input,originalExhibition:null}).record;
  assert.equal(invalid.sum_evidence.used_for_scoring,false);
  assert.ok(invalid.missing.includes('SUM_NOT_APPLIED'));
  assert.deepEqual(invalid.boats.map(row=>row.score),without.boats.map(row=>row.score));
  assert.deepEqual(invalid.research_tickets,without.research_tickets);
});

test('independent SUM model records the arithmetic but labels ticket ordering as own research',()=>{
  const snapshot=trialSnapshot();
  snapshot.original_exhibition.race_id=race.id;
  const result=buildTheoryTrial(snapshot,now);
  assert.equal(result.ok,true);
  assert.equal(result.record.trial_key,theoryTrialKey(snapshot));
  assert.ok(result.record.trial_key.includes(':SUM:'));
  const model=result.record.models.find(row=>row.key==='SUM_BASIC');
  assert.equal(model.status,'READY');assert.equal(model.tickets.length,8);
  assert.equal(model.sum_evidence.formula,'展示＋1周');
  assert.equal(model.sum_evidence.boats[0].total,42.77);
  assert.equal(model.author_strategy_reproduced,false);
  assert.ok(model.note.includes('独自式'));
  snapshot.original_exhibition.captured_at='2026-11-24T02:23:00Z';
  const later=buildTheoryTrial(snapshot,now).record.models.find(row=>row.key==='SUM_BASIC');
  assert.equal(later.status,'INVALID');assert.deepEqual(later.tickets,[]);
});
