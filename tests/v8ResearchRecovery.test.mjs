import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectResearchRecoveryWork} from '../base44/shared/v8ResearchRecovery.js';
import {selectResearchDay,researchDayComplete} from '../base44/shared/v8ResearchQueue.js';
import {groupBy} from '../base44/shared/v8Repository.js';
import {utcMs} from '../base44/shared/v7FeatureObservation.js';
import {isSavedExhibitionComplete} from '../base44/shared/liveInputPriority.js';
import {buildProvenanceDoc,isValidTrifecta} from '../base44/shared/resultProvenance.js';
import {parseResult} from '../base44/shared/boatraceOfficialParser.js';
import {hasCompleteResultDetails} from '../base44/shared/v8ResultDetails.js';

const NOW=Date.parse('2026-11-22T11:00:00Z');
const race=(id='r1',extra={})=>({id,race_key:'2026-11-22_07_'+id,race_date:'2026-11-22',venue_code:'07',race_number:2,deadline:'2026-11-22T06:43:00Z',status:'finished',exhibition_ready:false,...extra});
const entries=()=>Array.from({length:6},(_,i)=>({id:'e'+(i+1),race_id:'r1',boat_number:i+1}));
const observed=()=>entries().map((row,i)=>({...row,exhibition_time:6.71+i*.01,exhibition_st:.11,exhibition_course:i+1}));
const resultBoats=Array.from({length:6},(_,i)=>({boat_number:i+1,finish_order:i+1}));
const result={id:'result',race_id:'r1',source:'LOCAL',result_status:'RESULT_FINAL',is_finished:true,result_trifecta:'1-2-3',payout:1200,finished_at:'2026-11-22T07:00:00Z',boats:resultBoats};
const proof={id:'proof',race_id:'r1',evidence_type:'LIVE',result_id:'result',source:'LOCAL',result_trifecta:'1-2-3',fetched_at:'2026-11-22T07:00:00Z'};

test('official result keeps the complete まくり差し winning method for scenario comparison',()=>{
 const parsed=parseResult('<div>3連単 3-1-2 ¥2,340</div><div>決まり手 まくり差し</div>','2026-11-22','07','蒲郡');
 assert.equal(parsed.ok,true);assert.equal(parsed.data.venues[0].results[0].winning_method,'まくり差し');
});

test('finished races remain input-recovery candidates beyond thirty minutes after deadline',()=>{
 const work=selectResearchRecoveryWork({races:[race()],entriesByRace:new Map([['r1',entries()]]),resultsByRace:new Map([['r1',[result]]]),proofByRace:new Map([['r1',[proof]]]),now:NOW});
 assert.equal(work.work.length,1);assert.equal(work.work[0].exhibition,true);assert.equal(work.work[0].result,false);
});
test('cancelled and future races are excluded from postdeadline recovery',()=>{
 const work=selectResearchRecoveryWork({races:[race('cancel',{status:'cancelled'}),race('future',{deadline:'2026-11-22T12:00:00Z'})],entriesByRace:new Map(),resultsByRace:new Map(),proofByRace:new Map(),now:NOW});
 assert.equal(work.work.length,0);
});
test('recovery rotates past an unavailable oldest race instead of starving later races',()=>{
 const races=Array.from({length:4},(_,i)=>race('r'+i));
 const input={races,entriesByRace:new Map(),resultsByRace:new Map(),proofByRace:new Map(),now:NOW,maxRaces:2};
 const a=selectResearchRecoveryWork(input),b=selectResearchRecoveryWork({...input,cursor:a.nextCursor});
 assert.equal(new Set([...a.work,...b.work].map(row=>row.race.id)).size,4);
});
test('unfinished dates survive a week boundary and are retried before a recent attempt',()=>{
 const old={id:'old',race_date:'2026-11-01',status:'PARTIAL',last_attempt_at:'2026-11-22T10:00:00Z'};
 const today={id:'new',race_date:'2026-11-22',status:'PARTIAL',last_attempt_at:'2026-11-22T10:05:00Z'};
 assert.equal(selectResearchDay([today,old],'2026-11-22').id,'old');
 assert.equal(selectResearchDay([{...old,status:'COMPLETE'},today],'2026-11-22').id,'new');
});
test('day completion requires all actual races verified, excluded or cancelled',()=>{
 assert.equal(researchDayComplete({expected_races:1,pending_races:0,verified_races:1},[race()]),true);
 assert.equal(researchDayComplete({expected_races:1,pending_races:0,verified_races:0},[race()]),false);
 assert.equal(researchDayComplete({expected_races:0,pending_races:0,verified_races:0},[]),false);
 assert.throws(()=>selectResearchDay([{race_date:'2026-11-22'},{race_date:'2026-11-22'}],'2026-11-22'),/AMBIGUOUS/);
});

function bindRecovery(dependencies){
 const source=readFileSync(new URL('../base44/shared/v8ResearchRecovery.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
 const all={groupBy,utcMs,isSavedExhibitionComplete,buildProvenanceDoc,isValidTrifecta,hasCompleteResultDetails,...dependencies};
 return new Function(...Object.keys(all),source+'\nreturn recoverRaceResearchInputs;')(...Object.values(all));
}
function setup(t,{failedBoat=null,hasResult=true,parseExhibition=true,missingResultDetails=false}={}){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const row=race(),boats=entries(),raceUpdates=[],writes=[],resultUpdates=[];
 const savedResult=missingResultDetails?{...result,boats:[]}:result;
 const sr={Race:{kind:'Race',update:async(id,doc)=>{raceUpdates.push(doc);return {id,...doc};}},RaceEntry:{kind:'RaceEntry',update:async(id,doc)=>{if(id==='e'+failedBoat)throw new Error('write failed');writes.push({id,...doc});return {id,...doc};}},RaceResult:{kind:'RaceResult',get:async()=>savedResult,update:async(id,doc)=>{resultUpdates.push(doc);return {id,...doc};},create:async doc=>({id:'newresult',...doc})},ResultProvenance:{kind:'ResultProvenance',create:async doc=>({id:'newproof',...doc})}};
 const run=bindRecovery({readV8Rows:async entity=>({Race:[row],RaceEntry:boats,RaceResult:hasResult?[savedResult]:[],ResultProvenance:hasResult?[proof]:[]}[entity.kind]),fetchHtml:async()=>({ok:true,html:'official fetched page'}),buildUrl:(kind)=>kind,parseBeforeInfo:()=>parseExhibition?{ok:true,data:{entries:observed(),scratched_boats:[]}}:{ok:false},parseResult:()=>({ok:true,data:{venues:[{results:[{result_trifecta:'1-2-3',payout:1200,entries:resultBoats,finish_order:[1,2,3,4,5,6]}]}]}})});
 return {run:()=>run({asServiceRole:{entities:sr}},{date:'2026-11-22'}),raceUpdates,writes,resultUpdates};
}
test('actual recovery saves exhibition for an already finished race',async t=>{
 const state=setup(t),out=await state.run();
 assert.equal(out.exhibition_saved,1);assert.equal(out.failures.length,0);assert.equal(state.writes.length,6);
 assert.equal(state.raceUpdates.at(-1).exhibition_ready,true);
});
test('failed exhibition row does not produce a complete flag and is left retryable',async t=>{
 const state=setup(t,{failedBoat:3}),out=await state.run();
 assert.equal(out.exhibition_saved,0);assert.equal(out.failures.length,1);
 assert.equal(state.raceUpdates.some(row=>row.exhibition_ready===true),false);
});
test('result recovery still runs when official exhibition is not available',async t=>{
 const state=setup(t,{hasResult:false,parseExhibition:false}),out=await state.run();
 assert.equal(out.exhibition_saved,0);assert.equal(out.result_saved,1);
 assert.equal(out.failures[0].phase,'EXHIBITION');
 assert.equal(state.raceUpdates.some(row=>'result_trifecta' in row||'payout' in row),false);
});
test('existing payout-only results are enriched from fresh official details without rewriting payout or finish timestamp',async t=>{
 const state=setup(t,{missingResultDetails:true}),out=await state.run();
 assert.equal(out.result_saved,1);assert.equal(state.resultUpdates.length,1);
 assert.equal(state.resultUpdates[0].boats.length,6);
 assert.equal(state.resultUpdates[0].details_complete,true);
 for(const key of ['payout','result_trifecta','finished_at','source'])assert.equal(key in state.resultUpdates[0],false);
});
