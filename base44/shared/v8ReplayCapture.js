// Fill missing PRE/FINAL research records for closed races. No result is ever
// read into this worker; settlement is a separate append-only operation.
import {acquireLock,releaseLock} from './concurrencyLock.js';
import {selectV7RaceEntries} from './v7RaceEntrySelector.js';
import {utcMs} from './v7FeatureObservation.js';
import {buildReplayForecast,REPLAY_REVISION} from './v8ReplayForecast.js';
import {jstDate,dateValid,readV8Rows,groupBy,chronological,canonicalForecasts,canonicalReplayForecasts} from './v8Repository.js';

                                                                                                    
export async function runV8ReplayForecasts(client    ,options              ={}){
  const sr=client.asServiceRole.entities,started=Date.now();
  const dates=options.date?[options.date]:options.dates||[jstDate(),jstDate(-1),jstDate(-2)];
  if(!Array.isArray(dates)||!dates.length||dates.length>7||dates.some(date=>!dateValid(date)||date>jstDate()))throw new Error('INVALID_REPLAY_DATES');
  const maxRaces=Math.max(1,Math.min(48,Math.trunc(Number(options.max_races)||24)));
  const budget=started+Math.max(1000,Math.min(75000,Number(options.budgetMs)||45000));
  const summary    ={ok:true,revision:REPLAY_REVISION,dates,races:0,processed:0,created:0,pre:0,final:0,existing:0,held:0,errors:0,reasons:{}};
  const hold=(reason       )=>{summary.held++;summary.reasons[reason]=(summary.reasons[reason]||0)+1;};
  let lock    =null;
  try{
    lock=await acquireLock(client,'V8_REPLAY_FORECASTS','v8ReplayForecasts',120000);
    if(!lock)return {...summary,skipped:'locked'};
    const [races,prior]=await Promise.all([
      readV8Rows(sr.Race,{race_date:{$in:dates}},{budget,maxPages:12}),
      readV8Rows(sr.V8RaceForecast,{race_date:{$in:dates}},{budget,maxPages:70})
    ]);
    const unique=[...groupBy(races,'race_key').values()].filter(group=>group.length===1).map(group=>group[0]);
    const closed=unique.filter(race=>race.status!=='cancelled'&&utcMs(race.deadline)!=null&&utcMs(race.deadline)<=Date.now());
    const live=canonicalForecasts(prior),replay=canonicalReplayForecasts(prior);
    const rows=[...live.rows,...replay.rows],byRace=groupBy(rows,'race_id');
    const saved=new Set(prior.map(row=>row.forecast_key));
    const coversPre=(records      )=>records.some(row=>['PRE','DAY_BEFORE'].includes(row.stage)&&row.research_tickets?.length);
    const coversFinal=(records      )=>records.some(row=>row.stage==='FINAL'&&row.exhibition_complete===true&&row.research_tickets?.length);
    const todo=closed.filter(race=>{const records=byRace.get(race.id)||[];return !coversPre(records)||!coversFinal(records);})
      // Newer race dates first, but a previous incomplete race never blocks a
      // different race once its attempted batch has been processed.
      .sort((a,b)=>String(b.race_date).localeCompare(String(a.race_date))||utcMs(a.deadline)-utcMs(b.deadline));
    summary.races=closed.length;summary.pending=todo.length;
    // Reserve batch input reads for work this run can actually process.
    const cursor=todo.length?Math.max(0,Math.trunc(Number(options.cursor)||0))%todo.length:0;
    const ordered=[...todo.slice(cursor),...todo.slice(0,cursor)];
    const chosen=ordered.slice(0,maxRaces);
    summary.cursor=cursor;
    const entries=chosen.length?await readV8Rows(sr.RaceEntry,{race_id:{$in:chosen.map(race=>race.id)}},{budget,maxPages:12}):[];
    const entriesByRace=groupBy(entries,'race_id');
    for(const race of chosen){
      if(Date.now()>=budget)break;
      summary.processed++;
      const selected=selectV7RaceEntries(entriesByRace.get(race.id)||[],race);
      if(selected.reason){hold(selected.reason);continue;}
      const records=byRace.get(race.id)||[];
      let baseline=records.filter(row=>['DAY_BEFORE','PRE'].includes(row.stage))
        .sort((a,b)=>Number(a.record_mode==='REPLAY')-Number(b.record_mode==='REPLAY')||Number(a.stage!=='DAY_BEFORE')-Number(b.stage!=='DAY_BEFORE')||chronological(a,b))[0]||null;
      const archived=baseline||records.filter(row=>row.record_mode!=='REPLAY'&&row.stage==='FINAL').sort(chronological)[0]||null;
      for(const stage of ['PRE','FINAL']){
        if(Date.now()>=budget)break;
        if(stage==='PRE'?coversPre(records):coversFinal(records)){summary.existing++;continue;}
        const key=REPLAY_REVISION+':'+race.race_key+':'+stage;
        if(saved.has(key)){hold('REPLAY_KEY_REQUIRES_REVIEW');continue;}
        const built=buildReplayForecast({race,entries:selected.entries,stage,now:new Date().toISOString(),baseline,archived:baseline||archived});
        if(!built.ok){hold(built.reason||'REPLAY_BUILD_HELD');continue;}
        try{
          // A dedicated workflow lock and the complete ledger avoid ordinary
          // repeat inserts; readers hold any rare competing duplicate keys.
          const record=await sr.V8RaceForecast.create(built.record);
          if(!record?.id)throw new Error('REPLAY_SAVE_NOT_CONFIRMED');
          saved.add(key);records.push(record);byRace.set(race.id,records);
          if(stage==='PRE')baseline=record;
          summary.created++;summary[stage==='PRE'?'pre':'final']++;
        }catch(error    ){summary.errors++;hold('REPLAY_SAVE_FAILED');console.error('[V8_REPLAY_SAVE]',race.race_key,String(error?.message||error).slice(0,120));}
      }
    }
    summary.next_cursor=todo.length?(cursor+summary.processed)%todo.length:0;
    summary.pending_remaining=closed.filter(race=>{const records=byRace.get(race.id)||[];return !coversPre(records)||!coversFinal(records);}).length;
    summary.ok=summary.errors===0;
    return {...summary,completed_at:new Date().toISOString(),duration_ms:Date.now()-started};
  }finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}

