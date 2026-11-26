// Exercise the production display helper and verification summary with Node only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import * as study from '../src/components/liveV8/v8StudyView.js';
import {finalSelectionStats} from '../src/components/liveV8/v8FinalTicketsView.js';
const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('src/components/liveV8/v8Client.js',root),'utf8');
const client=new Function('isReplay',source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn {displayForecastStatus,displayDecision,latestRows,timeMs};')(study.isReplay);
const {displayForecastStatus:status}=client;
const NOW=Date.parse('2026-11-24T04:07:30Z');
const race={id:'race',race_key:'2026-11-24_08_07',race_date:'2026-11-24',venue_code:'08',race_number:7,deadline:'2026-11-24T04:11:00Z',status:'scheduled'};
const final={id:'final',race_id:race.id,race_key:race.race_key,race_date:race.race_date,venue_code:race.venue_code,race_number:race.race_number,deadline:race.deadline,stage:'FINAL',record_mode:'LIVE',quality:'CAPTURED',generated_at:'2026-11-24T04:07:08Z',created_date:'2026-11-24T04:07:09Z',exhibition_complete:true,research_tickets:['1-4-5','1-5-4','1-4-2','1-4-3','1-5-2','1-5-3','1-4-6','1-2-4'],decision:{status:'WATCH',strategy:'V7',reasons:['保存済みV7の研究判定はWATCH'],tickets:['1-2-3']}};
function expect(row,expected,{now=NOW,currentRace=race,options={}}={}){assert.equal(status(row,now,currentRace,options).key,expected);}
test('V8 saved state uses its own tickets and holds failed, ambiguous, mismatched or late records',()=>{
  for(const legacy of ['WAIT','WATCH','BUY','SKIP'])expect({...final,effective_status:legacy,decision:{...final.decision,status:legacy}},'READY');
  expect({...final,research_tickets:[]},'WAIT');
  expect({...final,research_tickets:['1-1-2']},'WAIT');
  expect({...final,research_tickets:['1-2-3','1-2-3']},'WAIT');
  expect({...final,research_tickets:['1-2-3','bad']},'WAIT');
  expect({...final,exhibition_complete:false},'PARTIAL');
  expect({...final,quality:'PARTIAL'},'PARTIAL');
  expect({...final,stage:'PRE',exhibition_complete:false},'PRE');
  expect({...final,stage:'DAY_BEFORE',exhibition_complete:false},'PRE');
  expect(final,'WAIT',{options:{unavailable:true}});
  expect(final,'WAIT',{options:{ambiguous:true}});
  expect(final,'WAIT',{currentRace:{...race,id:'other'}});
  expect(final,'WAIT',{currentRace:{...race,race_key:'other'}});
  expect(final,'WAIT',{currentRace:{...race,deadline:'2026-11-24T04:12:00Z'}});
  expect(final,'WAIT',{currentRace:{...race,deadline:null}});
  expect({...final,created_date:'2026-11-24T04:07:31Z'},'WAIT');
  expect({...final,generated_at:'2026-11-24T04:07:31Z'},'WAIT');
  expect({...final,created_date:'2026-11-24T04:07:07Z'},'WAIT');
  expect({...final,created_date:null},'WAIT');
  expect({...final,record_mode:'UNKNOWN'},'WAIT');
  expect({...final,stage:'LOCK'},'WAIT');
  expect({...final,generated_at:'2026-11-24T04:10:00Z',created_date:'2026-11-24T04:10:01Z'},'WAIT',{now:Date.parse('2026-11-24T04:12:00Z')});
  expect(final,'READY',{now:Date.parse('2026-11-24T04:09:59Z')});
  expect(final,'CLOSED',{now:Date.parse('2026-11-24T04:10:00Z')});
  expect(final,'CLOSED',{now:Date.parse('2026-11-24T04:11:00Z')});
  expect(final,'CLOSED',{currentRace:{...race,status:'finished'}});
  expect(final,'CANCELLED',{currentRace:{...race,status:'cancelled'}});
  expect(null,'WAIT');
  expect(null,'CLOSED',{now:Date.parse('2026-11-24T04:11:00Z')});
});

const replay={...final,id:'replay-final',record_mode:'REPLAY',generated_at:'2026-11-24T04:12:00Z',created_date:'2026-11-24T04:12:01Z'};
test('post-deadline REPLAY stays separate and keeps identity and timing guards',()=>{
  expect(replay,'REPLAY',{now:Date.parse('2026-11-24T04:13:00Z')});
  expect({...replay,generated_at:'2026-11-24T04:10:00Z'},'WAIT',{now:Date.parse('2026-11-24T04:13:00Z')});
  expect(replay,'WAIT',{now:Date.parse('2026-11-24T04:13:00Z'),options:{ambiguous:true}});
  expect(replay,'WAIT',{now:Date.parse('2026-11-24T04:13:00Z'),currentRace:{...race,id:'other'}});
});

test('V8 verification separates stages and modes, tracks pending and refunds, and ignores legacy BUY returns',()=>{
  const verificationSource=readFileSync(new URL('src/components/liveV8/V8Verification.jsx',root),'utf8');
  const summaryBody=verificationSource.split('const summary=useMemo(()=>{')[1].split('},[data,venue]);')[0];
  const helpers={...study,...client,finalSelectionStats,stats:study.studyStats,settlementIndex:(rows,field)=>new Map(rows.filter(row=>row.status==='SETTLED'&&row[field]).map(row=>[row[field],row]))};
  const summarize=new Function('data','venue',...Object.keys(helpers),summaryBody);
  const forecast=(id,stage,extra={})=>({...final,id,stage,...extra});
  const day=forecast('day','DAY_BEFORE',{generated_at:'2026-11-23T13:59:00Z'});
  const pre=forecast('pre','PRE',{generated_at:'2026-11-24T01:00:00Z'});
  const replayPre={...replay,id:'replay-pre',stage:'PRE'};
  const outcome=(forecast_id,extra={})=>({forecast_id,status:'SETTLED',source_kind:forecast_id.startsWith('replay')?'REPLAY':'FORECAST',research_hit:false,research_stake:800,research_return:0,research_tickets:final.research_tickets,...extra});
  const data={races:[race,{...race,id:'other',race_key:'other',venue_code:'01'}],forecasts:[day,pre,final,forecast('older-final','FINAL',{generated_at:'2026-11-24T04:02:00Z'}),forecast('other-pre','PRE',{race_id:'other',race_key:'other',venue_code:'01'})],replay_forecasts:[replayPre,replay],verifications:[outcome('day'),outcome('pre',{status:'EXCLUDED_REFUND'}),outcome('final',{research_hit:true,research_return:1500,buy_selected:true,buy_hit:false,buy_return:0})],replay_verifications:[outcome('replay-final')]};
  const summary=summarize(data,'08',...Object.values(helpers));
  assert.equal(summary.researchGroups.length,5);
  assert.equal(summary.studyRecords.length,5);
  assert.equal(summary.liveFinal.forecasts.length,1);
  assert.equal(summary.liveFinal.metrics.returns,1500);
  assert.equal(summary.liveFinal.metrics.hits,1);
  assert.equal(summary.researchGroups.find(row=>row.mode==='LIVE'&&row.stage==='PRE').excluded,1);
  assert.equal(summary.researchGroups.find(row=>row.mode==='LIVE'&&row.stage==='PRE').pending,0);
  assert.equal(summary.researchGroups.find(row=>row.mode==='LIVE'&&row.stage==='PRE').metrics.n,0);
  assert.equal(summary.researchGroups.find(row=>row.mode==='REPLAY'&&row.stage==='PRE').pending,1);
  assert.equal(summary.researchGroups.find(row=>row.mode==='REPLAY'&&row.stage==='FINAL').metrics.hits,0);
  assert.equal(summarize(undefined,'ALL',...Object.values(helpers)).liveFinal.metrics.n,0);
});
