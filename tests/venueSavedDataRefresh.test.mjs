import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Execute the component's actual non-JSX code without a DOM or a new React test
// dependency. Hooks retain state/refs and run dependency cleanup on rerender.
const source=readFileSync(new URL('../src/pages/Venue.jsx',import.meta.url),'utf8');
const start=source.indexOf('export default function Venue() {');
const end=source.indexOf('  if (loading && !raceList.length) return',start);
assert.ok(start>=0&&end>start,'Venue component extraction boundary must exist');
const executable=source.slice(start+'export default function Venue() {'.length,end);
const DATE='2026-11-28',NOW=Date.parse(DATE+'T07:31:00Z');
const clone=value=>structuredClone(value);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const race=(number=4)=>({id:'gamagori-'+number,race_key:`${DATE}_07_${String(number).padStart(2,'0')}`,
  race_date:DATE,venue_code:'07',venue_name:'蒲郡',race_number:number,status:'pre',deadline:DATE+'T07:53:00Z'});
const entries=(number=4,tag='saved',complete=false)=>Array.from({length:6},(_,index)=>({
  id:`entry-${number}-${index+1}`,race_id:race(number).id,race_key:race(number).race_key,boat_number:index+1,
  racer_name:`saved-${index+1}`,tag,
  ...(complete?{exhibition_time:6.8+index/100,exhibition_st:0.12+index/100,exhibition_course:index+1}:{}),
}));

function harness(t,{initialEntries=entries(),sectionPresent=false,resultRead=async()=>null,externalRead=null}={}){
  t.mock.timers.enable({apis:['Date'],now:NOW});
  let cursor=0,renderQueued=false,disposed=false,output=null,effects=[];
  let parameters=new URLSearchParams({date:DATE,race:'4'});
  const slots=[],intervals=new Map(),events=[],warnings=[],external=deferred(),entryQueue=[];
  let nextTimer=0;
  const db={races:[race(4),race(5)],entries:new Map([[race(4).id,clone(initialEntries)],[race(5).id,entries(5,'other-race',true)]])};
  if(sectionPresent)for(const rows of db.entries.values())for(const row of rows)row.section_points=5;
  const schedule=()=>{
    if(disposed||renderQueued)return;
    renderQueued=true;queueMicrotask(()=>{renderQueued=false;if(!disposed)render();});
  };
  const dependencies={
    useParams:()=>({code:'07'}),useSearchParams:()=>[parameters],
    useState:initial=>{
      const index=cursor++;
      if(!slots[index])slots[index]={value:typeof initial==='function'?initial():initial};
      return [slots[index].value,next=>{if(disposed)return;const value=typeof next==='function'?next(slots[index].value):next;
        if(!Object.is(value,slots[index].value)){slots[index].value=value;schedule();}}];
    },
    useRef:initial=>{const index=cursor++;return slots[index]||(slots[index]={current:initial});},
    useMemo:factory=>factory(),
    useEffect:(effect,deps)=>{
      const index=cursor++,previous=slots[index];
      if(!previous||!deps||!previous.deps||deps.some((value,i)=>!Object.is(value,previous.deps[i])))
        effects.push(()=>{previous?.cleanup?.();slots[index]={deps,cleanup:effect()};});
    },
    listTodayRaces:async options=>{events.push({kind:'list',options});return clone(db.races);},
    base44:{entities:{Race:{filter:async()=>clone(db.races)}}},
    getRaceEntries:async(id,key)=>{
      events.push({kind:'entries',id,key});
      if(entryQueue.length){const queued=entryQueue.shift();return typeof queued==='function'?queued(id,key):queued;}
      return clone(db.entries.get(id)||[]);
    },
    getRaceResult:async selected=>{events.push({kind:'result',id:selected.id});return resultRead(selected);},
    fetchOnlineData:(...args)=>{events.push({kind:'external',args});return externalRead?externalRead(...args):external.promise;},
    document:{hidden:false},
    window:{setInterval:(callback,ms)=>{const id=++nextTimer;intervals.set(id,{callback,ms});return id;},
      clearInterval:id=>intervals.delete(id)},
    console:{warn:(...args)=>warnings.push(args)},
  };
  for(const version of ['61','62','63','64','65']){
    dependencies['getV'+version+'Stages']=async()=>({pre:{id:'saved-pre'},final:{id:'saved-final'}});
    dependencies['ensureV'+version+'Final']=async()=>null;
    dependencies['generateV'+version+'PredictionForRace']=async()=>null;
  }
  // Each callback captures its render's state, as in the production component.
  const renderComponent=new Function(...Object.keys(dependencies),'return function renderVenue(){'+executable+`\nreturn {
    loadDetail,refreshPredictions,refreshAll,setSelectedId,
    readSavedDetail: typeof readSavedDetail==='function'?readSavedDetail:null,
    state:{race,entries,races,selectedId,listNotice,loading}
  };};`)(...Object.values(dependencies));
  function render(){
    cursor=0;effects=[];output=renderComponent();
    const committed=effects;effects=[];for(const effect of committed)effect();
  }
  render();
  t.after(()=>{disposed=true;for(const slot of slots)slot?.cleanup?.();intervals.clear();});
  return {
    db,events,warnings,external,entryQueue,
    get output(){return output;},get state(){return output.state;},
    settle:async()=>{for(let i=0;i<3;i++)await flush();},
    poll:()=>{const timer=[...intervals.values()].sort((a,b)=>a.ms-b.ms)[0];assert.ok(timer,'background DB poll must be installed');timer.callback();},
    select:number=>{parameters=new URLSearchParams({date:DATE,race:String(number)});output.setSelectedId(race(number).id);},
  };
}

test('six saved entries render while the optional section acquisition is still unresolved',{timeout:2000},async t=>{
  const saved=entries(4,'six-saved',true),h=harness(t,{initialEntries:saved});
  await h.settle();
  assert.ok(h.events.some(event=>event.kind==='external'&&event.args[0]==='section'),'section supplement must remain in flight');
  assert.deepEqual(h.state.entries,saved,'saved entries must render before the external supplement resolves');
  assert.equal(h.state.race.id,race(4).id);
});

test('saved entries and DB polling/manual refresh remain available during slow exhibition acquisition',{timeout:2000},async t=>{
  const h=harness(t,{sectionPresent:true});await h.settle();
  assert.equal(h.state.entries.length,6);
  assert.ok(h.events.some(event=>event.kind==='external'&&event.args[0]==='exhibition'));
  const count=()=>h.events.filter(event=>event.kind==='entries').length,initialCount=count();
  h.db.entries.set(race(4).id,entries(4,'poll-saved',true));h.poll();await h.settle();
  assert.ok(count()>initialCount,'a pending source request must not lock the DB reader');
  assert.equal(h.state.entries[0].tag,'poll-saved');
  const beforeManual=count();h.db.entries.set(race(4).id,entries(4,'manual-saved',true));
  let manualDone=false;const manual=h.output.refreshAll().then(()=>{manualDone=true;});
  await h.settle();
  assert.ok(count()>beforeManual);assert.equal(h.state.entries[0].tag,'manual-saved');
  assert.equal(manualDone,true,'manual DB refresh must finish while external acquisition is unresolved');
  await manual;
});

test('an older initial detail read cannot replace a newer saved read for the same race',{timeout:2000},async t=>{
  const h=harness(t,{sectionPresent:true});await h.settle();
  const older=deferred();h.entryQueue.push(older.promise);
  const oldRead=h.output.loadDetail();await h.settle();
  h.db.entries.set(race(4).id,entries(4,'newer-read',true));
  const newerRead=h.output.refreshPredictions();await h.settle();
  assert.equal(h.state.entries[0]?.tag,'newer-read');
  older.resolve(entries(4,'older-read',true));await oldRead;await newerRead;await h.settle();
  assert.equal(h.state.entries[0].tag,'newer-read','late same-race reads cannot roll back the display');
});

test('late responses from the previous race cannot update the selected race or its entries',{timeout:2000},async t=>{
  const h=harness(t,{sectionPresent:true});await h.settle();
  const older=deferred();h.entryQueue.push(older.promise);
  const oldRead=h.output.refreshPredictions();await h.settle();
  h.select(5);await h.settle();
  assert.equal(h.state.selectedId,race(5).id);assert.equal(h.state.race.id,race(5).id);
  assert.equal(h.state.entries.length,6);
  assert.ok(h.state.entries.every(entry=>entry.race_id===race(5).id));
  older.resolve(entries(4,'old-race-response',true));await oldRead;await h.settle();
  assert.equal(h.state.race.id,race(5).id);
  assert.equal(h.state.entries.length,6);
  assert.ok(h.state.entries.every(entry=>entry.race_id===race(5).id));
});

test('a source 403 keeps saved entries visible and the next DB poll can still refresh them',{timeout:2000},async t=>{
  const h=harness(t,{sectionPresent:true});await h.settle();
  const displayed=clone(h.state.entries);
  assert.equal(displayed.length,6);
  assert.ok(h.events.some(event=>event.kind==='external'));
  h.external.reject(Object.assign(new Error('source HTTP 403'),{status:403}));
  await h.settle();assert.deepEqual(h.state.entries,displayed);
  h.db.entries.set(race(4).id,entries(4,'saved-after-source-error',true));
  const before=h.events.filter(event=>event.kind==='entries').length;
  h.poll();await h.settle();
  assert.ok(h.events.filter(event=>event.kind==='entries').length>before);
  assert.equal(h.state.entries[0].tag,'saved-after-source-error');
});

test('a slow result endpoint cannot delay entries or their subsequent DB refresh',{timeout:2000},async t=>{
  const pendingResult=deferred();
  const h=harness(t,{sectionPresent:true,resultRead:()=>pendingResult.promise,externalRead:async()=>({ok:true})});
  await h.settle();assert.equal(h.state.entries.length,6);
  assert.ok(h.events.some(event=>event.kind==='result'));
  h.db.entries.set(race(4).id,entries(4,'saved-while-result-waits',true));
  h.poll();await h.settle();
  assert.equal(h.state.entries[0].tag,'saved-while-result-waits');
  assert.equal(h.events.filter(event=>event.kind==='result').length,1,'the pending result request must be shared');
});

test('a newly saved cancellation or postponement stops the remaining supplement steps',{timeout:2000},async t=>{
  for(const change of [{status:'cancelled'}, {schedule_status:'CANCELLED'}, {schedule_status:'POSTPONED'}]){
    await t.test(JSON.stringify(change),async child=>{
      const h=harness(child);await h.settle();
      assert.deepEqual(h.events.filter(event=>event.kind==='external').map(event=>event.args[0]),['section']);
      Object.assign(h.db.races[0],change);h.poll();await h.settle();
      assert.equal(h.state.entries.length,6);
      for(const [key,value] of Object.entries(change))assert.equal(h.state.race[key],value);
      h.external.resolve({ok:true});await h.settle();
      assert.deepEqual(h.events.filter(event=>event.kind==='external').map(event=>event.args[0]),['section'],
        'do not start exhibition or odds after the fresh stored race becomes cancelled/postponed');
    });
  }
});

test('a pending periodic DB read suppresses duplicate polls while forced manual refresh can supersede it',{timeout:2000},async t=>{
  const h=harness(t,{sectionPresent:true});await h.settle();
  const count=()=>h.events.filter(event=>event.kind==='entries').length;
  const before=count(),slowPoll=deferred();h.entryQueue.push(slowPoll.promise);
  h.poll();await h.settle();
  assert.equal(count(),before+1,'the first periodic DB read must start');
  h.poll();await h.settle();
  assert.equal(count(),before+1,'a second ordinary poll must not duplicate an unresolved DB read');
  h.db.entries.set(race(4).id,entries(4,'manual-supersedes-slow-poll',true));
  let manualDone=false;const manual=h.output.refreshAll().then(()=>{manualDone=true;});
  await h.settle();
  assert.equal(count(),before+2,'forced manual refresh must start its own fresh DB read');
  assert.equal(manualDone,true);assert.equal(h.state.entries[0].tag,'manual-supersedes-slow-poll');
  await manual;
  slowPoll.resolve(entries(4,'late-old-poll',true));await h.settle();
  assert.equal(h.state.entries.length,6);
  assert.equal(h.state.entries[0].tag,'manual-supersedes-slow-poll','the old poll cannot roll back the forced refresh');
});
