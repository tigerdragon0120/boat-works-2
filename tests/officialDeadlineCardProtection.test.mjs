import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {readV8Rows} from '../base44/shared/v8Repository.js';
import {planRaceCardEntries} from '../base44/shared/raceCardEntryPlan.js';
import {hasConfirmedOfficialDeadline,officialDeadlineUrl} from '../base44/shared/officialLiveDeadlines.js';

const source=readFileSync(new URL('../base44/functions/runDailyAutoUpdate/entry.ts',import.meta.url),'utf8');
const start=source.indexOf('async function fetchAndSaveRaceCards('),end=source.indexOf('\n}',start)+2;
const code=stripTypeScriptTypes(source.slice(start,end));
const DATE='2026-11-28',VENUE='03',NOW=Date.parse(DATE+'T02:30:00Z');
const key=rno=>DATE+'_'+VENUE+'_'+String(rno).padStart(2,'0');
const official=()=>({provider:'BOATCAST',url:officialDeadlineUrl(DATE),http_status:200,
  fetched_at:DATE+'T02:29:30Z',published_at:DATE+'T02:29:00Z',race_date:DATE,
  venue_code:VENUE,race_number:2,deadline:DATE+'T11:34:00+09:00'});
const race=(rno=2)=>({id:'race-'+rno,race_key:key(rno),race_date:DATE,venue_code:VENUE,
  race_number:rno,status:'pre',deadline:DATE+'T11:34:00+09:00',updated_date:DATE+'T02:29:30Z',
  ...(rno===2?{deadline_source:official()}:{})});
const entriesFor=rno=>Array.from({length:6},(_,i)=>({id:'entry-'+rno+'-'+(i+1),race_id:'race-'+rno,
  race_key:key(rno),race_date:DATE,venue_code:VENUE,race_number:rno,boat_number:i+1,
  registration_number:String(4001+i),national_win_rate:6}));
const matches=(row,query)=>Object.entries(query).every(([name,value])=>value&&typeof value==='object'
  ? '$in' in value&&value.$in.includes(row[name]):value===null?row[name]==null:row[name]===value);

function setup(t,{forceCard=false,missingRace=false,confirmed=true,status='pre',noSchedule=false,beforeWrite=null,onCard=null,deadlineSlots=null,cardTime='11:25'}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const store={Race:Array.from({length:12},(_,i)=>race(i+1)).filter(row=>!missingRace||row.race_number!==2),
    RaceEntry:Array.from({length:12},(_,i)=>entriesFor(i+1)).flat().filter(row=>!missingRace||row.race_number!==2)};
  const target=store.Race.find(row=>row.race_number===2);
  if(target){target.status=status;if(!confirmed)delete target.deadline_source;}
  if(forceCard)for(const row of store.RaceEntry)if(row.race_number===2)row.national_win_rate=null;
  const writes={conditional:[],metadata:[],created:[]},errors=[];
  const entity=name=>({
    async filter(query){return {items:structuredClone(store[name].filter(row=>matches(row,query))),has_more:false,next_cursor:null};},
    async updateMany(query,update){
      writes.conditional.push({query:structuredClone(query),update:structuredClone(update)});
      if(beforeWrite)beforeWrite(store,writes.conditional.length);
      const found=store[name].filter(row=>matches(row,query));
      for(const row of found)Object.assign(row,structuredClone(update.$set));
      return {updated:found.length};
    },
    async update(id,patch){
      writes.metadata.push(structuredClone(patch));const row=store[name].find(row=>row.id===id);
      Object.assign(row,patch);return structuredClone(row);
    },
    async create(patch){const row={...patch,id:'race-'+patch.race_number};writes.created.push(structuredClone(row));store[name].push(row);return row;},
    async bulkCreate(rows){for(const row of rows)store[name].push({...row,id:'entry-'+row.race_number+'-'+row.boat_number});},
    async bulkUpdate(rows){for(const row of rows)Object.assign(store[name].find(old=>old.id===row.id),row);},
  });
  const dependencies={readV8Rows,planRaceCardEntries,hasConfirmedOfficialDeadline,
    buildUrl:(kind,_date,_venue,rno)=>kind+':'+rno,buildRaceKey:(_date,_venue,rno)=>key(rno),
    fetchHtml:async()=>({ok:true,html:'official-card'}),parseRaceIndex:()=>[{venue_code:VENUE,venue_name:'江戸川'}],
    parseDeadlineTimes:()=>deadlineSlots??(noSchedule?[]:Array.from({length:12},(_,i)=>i===1?'11:25':'')),
    parseSeriesName:()=>'',isWomensRace:()=>false,
    parseRaceCard:(_html,_date,_venue,_name,rno)=>{
      if(onCard)onCard(store);
      return {ok:true,data:{venues:[{races:[{deadline_time:cardTime,race_name:'テスト',entries:entriesFor(rno).map(row=>({
        boat_number:row.boat_number,registration_number:row.registration_number,player_name:'選手'+row.boat_number,national_win_rate:6}))}]}]}};
    },withRateLimitRetry:async fn=>fn(),
  };
  const fn=new Function(...Object.keys(dependencies),code+'\nreturn fetchAndSaveRaceCards;')(...Object.values(dependencies));
  return {store,writes,errors,run:()=>fn({asServiceRole:{entities:{Race:entity('Race'),RaceEntry:entity('RaceEntry')}}},DATE,80000,[],errors)};
}

test('a complete card keeps the official delay before the six-entrant skip',async t=>{
  const env=setup(t);await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');
  assert.deepEqual(env.writes,{conditional:[],metadata:[],created:[]});assert.deepEqual(env.errors,[]);
});

test('card metadata cannot overwrite a confirmed live deadline or current status',async t=>{
  const env=setup(t,{forceCard:true});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');assert.equal(env.store.Race[1].status,'pre');
  assert.equal(env.writes.conditional.length,0);assert.equal(env.writes.metadata.length,1);
  assert.equal('deadline' in env.writes.metadata[0],false);assert.equal('status' in env.writes.metadata[0],false);
  assert.deepEqual(env.errors,[]);
});

test('a saved official correction still wins on later unchanged cycles after five minutes',async t=>{
  const env=setup(t);await env.run();t.mock.timers.setTime(NOW+10*60000);await env.run();
  for(const row of env.store.RaceEntry)if(row.race_number===2)row.national_win_rate=null;
  await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');assert.equal(env.writes.conditional.length,0);
  assert.equal(env.store.Race[1].deadline_source.fetched_at,DATE+'T02:29:30Z');assert.deepEqual(env.errors,[]);
});

test('the individual card path is protected even without a parsed schedule row',async t=>{
  const env=setup(t,{forceCard:true,noSchedule:true});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');assert.equal(env.writes.conditional.length,0);
  assert.equal(env.writes.metadata.length,1);assert.equal('deadline' in env.writes.metadata[0],false);
});

test('confirmed provenance rejects mismatched identity, source and future observations',()=>{
  const valid=race();assert.equal(hasConfirmedOfficialDeadline(valid,{date:DATE,now:NOW}),true);
  assert.equal(hasConfirmedOfficialDeadline(valid,{date:DATE,now:NOW+60*60000}),true);
  const mutations=[
    row=>row.deadline_source.provider='OTHER',row=>row.deadline_source.url=officialDeadlineUrl('2026-11-27'),
    row=>row.deadline_source.http_status=403,row=>row.deadline_source.race_date='2026-11-27',
    row=>row.deadline_source.venue_code='04',row=>row.deadline_source.race_number=3,
    row=>row.deadline_source.deadline=DATE+'T11:25:00+09:00',row=>row.race_key=DATE+'_03_03',
    row=>row.deadline_source.fetched_at=DATE+'T02:30:01Z',row=>row.deadline_source.fetched_at='2026-11-27T02:29:00Z',
    row=>row.deadline_source.published_at=DATE+'T02:29:31Z',row=>row.deadline_source.published_at='invalid',
  ];
  for(const mutate of mutations){const row=structuredClone(valid);mutate(row);assert.equal(hasConfirmedOfficialDeadline(row,{date:DATE,now:NOW}),false);}
  assert.equal(hasConfirmedOfficialDeadline(valid,{date:DATE,now:Date.parse('2026-11-29T01:00:00Z')}),false);
});

for(const status of ['finished','cancelled'])test(`HTML cannot change a ${status} race deadline or status`,async t=>{
  const env=setup(t,{forceCard:true,confirmed:false,status});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');assert.equal(env.store.Race[1].status,status);
  assert.equal(env.writes.conditional.length,0);assert.equal('status' in env.writes.metadata[0],false);
});

test('unconfirmed card corrections retain compare-and-set protection',async t=>{
  const env=setup(t,{forceCard:true,confirmed:false});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:25:00+09:00');assert.equal(env.writes.conditional.length,1);
  assert.deepEqual(env.writes.conditional[0].query,{id:'race-2',deadline:DATE+'T11:34:00+09:00',status:'pre',updated_date:DATE+'T02:29:30Z'});
  assert.equal('deadline' in env.writes.metadata[0],false);assert.deepEqual(env.errors,[]);
});

test('a concurrent official correction wins over a pending HTML correction and metadata save',async t=>{
  const env=setup(t,{forceCard:true,confirmed:false,beforeWrite:(store,count)=>{
    if(count===1)Object.assign(store.Race[1],{deadline:DATE+'T11:40:00+09:00',updated_date:DATE+'T02:30:00Z',
      deadline_source:{...official(),deadline:DATE+'T11:40:00+09:00'}});
  }});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:40:00+09:00');assert.equal(env.writes.conditional.length,1);
  assert.equal(env.writes.metadata.length,1);assert.equal('deadline' in env.writes.metadata[0],false);
});

test('a race completed after the initial read is never reset by card metadata',async t=>{
  const env=setup(t,{forceCard:true,confirmed:false,noSchedule:true,onCard:store=>{store.Race[1].status='finished';}});
  await env.run();assert.equal(env.store.Race[1].status,'finished');assert.equal(env.writes.conditional.length,0);
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');assert.equal('status' in env.writes.metadata[0],false);
});

test('new races still receive their parsed card deadline',async t=>{
  const env=setup(t,{missingRace:true});await env.run();
  assert.equal(env.writes.created.length,1);assert.equal(env.writes.created[0].race_key,key(2));
  assert.equal(env.writes.created[0].deadline,DATE+'T11:25:00+09:00');assert.equal(env.writes.created[0].status,'scheduled');
  assert.deepEqual(env.errors,[]);
});

test('a missing race slot never shifts the later deadline into the missing race',async t=>{
  const slots=Array(12).fill(null);slots[2]='12:08';
  const env=setup(t,{forceCard:true,confirmed:false,deadlineSlots:slots,cardTime:null});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');
  assert.equal(env.store.Race[2].deadline,DATE+'T12:08:00+09:00');
  assert.equal(env.writes.conditional.length,1);
  assert.equal(env.writes.conditional[0].query.id,'race-3');
});

test('official status text cannot be persisted as a datetime during card repair',async t=>{
  const slots=Array(12).fill(null);slots[1]='中止';
  const env=setup(t,{forceCard:true,confirmed:false,deadlineSlots:slots,cardTime:'中止'});await env.run();
  assert.equal(env.store.Race[1].deadline,DATE+'T11:34:00+09:00');
  assert.equal(env.writes.conditional.length,0);
  assert.equal('deadline' in env.writes.metadata[0],false);
});
