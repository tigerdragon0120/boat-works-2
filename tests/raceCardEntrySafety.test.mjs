import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readV8Rows} from '../base44/shared/v8Repository.js';
import {planRaceCardEntries} from '../base44/shared/raceCardEntryPlan.js';

const source=readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts',import.meta.url),'utf8');
const start=source.indexOf('async function fetchAndSaveRaceCards('),end=source.indexOf('\n}',start)+2;
const code=stripTypeScriptTypes(source.slice(start,end));
const DATE='2026-11-22',VENUE='14',NOW=Date.parse('2026-11-22T11:00:00Z');
const key=rno=>DATE+'_'+VENUE+'_'+String(rno).padStart(2,'0');
const races=()=>Array.from({length:12},(_,index)=>({id:'race-'+(index+1),race_key:key(index+1),race_date:DATE,venue_code:VENUE,race_number:index+1,status:'scheduled'}));
const entriesFor=rno=>Array.from({length:6},(_,index)=>({id:'entry-'+rno+'-'+(index+1),race_id:'race-'+rno,race_key:key(rno),race_date:DATE,venue_code:VENUE,race_number:rno,boat_number:index+1,registration_number:String(4000+index+1),national_win_rate:6,exhibition_time:6.8,is_absent:false,is_scratched:false}));
const matches=(row,query)=>Object.entries(query).every(([name,value])=>value&&typeof value==='object'&&'$in'in value?value.$in.includes(row[name]):row[name]===value);
function setup(t,{missingFirst=false,failPhase=null,pageSize=200,onCard=null,duplicates=false}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const store={Race:races(),RaceEntry:Array.from({length:12},(_,index)=>entriesFor(index+1)).flat().filter(row=>!missingFirst||row.race_number!==1)};
  if(duplicates)store.RaceEntry.push({...store.RaceEntry[0],id:'duplicate-first'});
  const calls=[],writes={creates:[],updates:[],race:[]},errors=[];
  const entity=name=>({
    async filter(query,options){
      assert.equal(typeof options,'object','all writer references use the cursor contract');
      calls.push({name,query,options});
      if(name==='RaceEntry'&&((failPhase==='initial'&&query.race_date)||(failPhase==='final'&&!query.race_date)))throw Object.assign(new Error('private upstream body'),{response:{status:403}});
      const rows=store[name].filter(row=>matches(row,query)),offset=options.cursor?Number(options.cursor):0,limit=Math.min(options.limit,pageSize),items=rows.slice(offset,offset+limit);
      return {items:structuredClone(items),has_more:offset+items.length<rows.length,next_cursor:offset+items.length<rows.length?String(offset+items.length):null};
    },
    async update(id,patch){writes.race.push(id);const row=store[name].find(row=>row.id===id);Object.assign(row,patch);return structuredClone(row);},
    async create(patch){const row={...patch,id:name+'-created-'+store[name].length};store[name].push(row);return row;},
    async bulkCreate(rows){writes.creates.push(...structuredClone(rows));for(const row of rows)store[name].push({...row,id:'created-'+row.race_number+'-'+row.boat_number});},
    async bulkUpdate(rows){writes.updates.push(...structuredClone(rows));for(const row of rows)Object.assign(store[name].find(old=>old.id===row.id),row);},
    async delete(){assert.fail('card refresh must not delete history');},
    async deleteMany(){assert.fail('card refresh must not delete history');},
  });
  const client={asServiceRole:{entities:{Race:entity('Race'),RaceEntry:entity('RaceEntry')}}};
  const dependencies={
    readV8Rows,planRaceCardEntries,
    buildUrl:(kind,_date,_venue,rno)=>kind+':'+rno,
    buildRaceKey:(_date,_venue,rno)=>key(rno),
    fetchHtml:async()=>({ok:true,html:'official source'}),
    parseRaceIndex:()=>[{venue_code:VENUE,venue_name:'鳴門'}],
    parseDeadlineTimes:()=>[],parseSeriesName:()=>'',isWomensRace:()=>false,
    parseRaceCard:(_html,_date,_venue,_name,rno)=>{
      if(onCard)onCard(store,rno);
      return {ok:true,data:{venues:[{races:[{entries:entriesFor(rno).map(row=>({boat_number:row.boat_number,registration_number:row.registration_number,player_name:'選手'+row.boat_number,national_win_rate:6}))}]}]}};
    },
    withRateLimitRetry:async fn=>fn(),
    upsertRace:()=>assert.fail('automatic dedup path must not run'),
    dedupRace:()=>assert.fail('automatic race deletion must not run'),
    dedupEntriesForRace:()=>assert.fail('automatic entry deletion must not run'),
  };
  const fn=new Function(...Object.keys(dependencies),code+'\nreturn fetchAndSaveRaceCards;')(...Object.values(dependencies));
  return {store,calls,writes,errors,run:()=>fn(client,DATE,80000,[],errors)};
}

test('initial existing-entry read failure cannot become an empty ledger or create rows',async(t)=>{
  const env=setup(t,{failPhase:'initial'});await env.run();
  assert.equal(env.writes.creates.length,0);assert.equal(env.writes.updates.length,0);assert.equal(env.writes.race.length,0);
  assert.match(env.errors[0],/最後まで確認できない/);assert.equal(env.errors.some(row=>row.includes('private upstream')),false);
});
test('the final identity recheck must succeed before any entrant is created or updated',async(t)=>{
  const env=setup(t,{missingFirst:true,failPhase:'final'});await env.run();
  assert.equal(env.writes.creates.length,0);assert.equal(env.writes.updates.length,0);assert.equal(env.store.RaceEntry.length,66);
  assert.ok(env.errors.some(error=>error.includes('保存直前')));
});
test('complete cursor pagination finds later entrants instead of recreating their slots',async(t)=>{
  const env=setup(t,{pageSize:13});await env.run();
  assert.ok(env.calls.filter(call=>call.name==='RaceEntry').length>1);
  assert.equal(env.writes.creates.length,0);assert.equal(env.writes.updates.length,0);assert.equal(env.store.RaceEntry.length,72);
});
test('missing entrants are created once and a second card refresh creates no duplicates',async(t)=>{
  const env=setup(t,{missingFirst:true});await env.run();
  assert.equal(env.writes.creates.length,6);assert.equal(env.store.RaceEntry.length,72);
  await env.run();assert.equal(env.writes.creates.length,6);assert.equal(env.store.RaceEntry.length,72);
  assert.deepEqual(env.errors,[]);
});
test('a concurrent complete card appearing before recheck is updated, never inserted again',async(t)=>{
  const env=setup(t,{missingFirst:true,onCard:(store,rno)=>{if(rno===1)store.RaceEntry.push(...entriesFor(1).map(row=>({...row,is_absent:row.boat_number===6,is_scratched:row.boat_number===6})));}});
  await env.run();assert.equal(env.writes.creates.length,0);assert.equal(env.writes.updates.length,6);assert.equal(env.store.RaceEntry.length,72);
  const last=env.store.RaceEntry.find(row=>row.race_number===1&&row.boat_number===6);
  assert.equal(last.exhibition_time,6.8);assert.equal(last.is_absent,true);assert.equal(last.is_scratched,true);
});
test('a different racer discovered in the same slot holds the entire race without overwriting',async(t)=>{
  const env=setup(t,{missingFirst:true,onCard:(store,rno)=>{if(rno===1)store.RaceEntry.push(...entriesFor(1).map(row=>row.boat_number===1?{...row,registration_number:'9999'}:row));}});
  await env.run();assert.equal(env.writes.creates.length,0);assert.equal(env.writes.updates.length,0);
  assert.ok(env.errors.some(error=>error.includes('IDENTITY_CONFLICT')));
  assert.equal(env.store.RaceEntry.find(row=>row.race_number===1&&row.boat_number===1).registration_number,'9999');
});
test('existing duplicate rows are retained and never repaired by deletion in card refresh',async(t)=>{
  const env=setup(t,{duplicates:true});await env.run();
  assert.equal(env.store.RaceEntry.length,73);assert.equal(env.writes.creates.length,0);assert.equal(env.writes.updates.length,0);
  assert.ok(env.errors.some(error=>error.includes('出走表重複')));
});
test('a legacy row found by race_id prevents duplicate insertion even without race_key',()=>{
  const incoming=entriesFor(1),old={...incoming[0]};delete old.race_key;
  const plan=planRaceCardEntries([old],incoming);
  assert.equal(plan.creates.length,5);assert.equal(plan.updates.length,1);assert.equal(plan.updates[0].id,old.id);
  const conflict=planRaceCardEntries([{...old,race_key:'different-race'}],incoming);
  assert.equal(conflict.creates.length,0);assert.equal(conflict.updates.length,0);assert.equal(conflict.held.length,1);
});
