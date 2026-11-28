// The public BOATCAST live page reads this daily schedule before rendering
// DeadlineTimeAll (1R..12R). Contract observed in /assets/js/main.js.
// This helper updates existing Race schedules, never saved forecasts/results.
import {dateValid,jstDate,readV8Rows} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';
import {buildUrl,fetchHtml,parseDeadlineTimes} from './boatraceOfficialParser.js';
import {normalizeOfficialIndexDisruptions} from './officialRaceIndexSchedule.js';

const BASE='https://race.boatcast.jp/api_txt/getHoldingList2_';
const MAX_BYTES=128*1024;
const MAX_AGE_MS=5*60000;
const ACTIVE=new Set(['scheduled','pre','final']);
const CLOSED=new Set(['締切','確定','中止']);
const DISRUPTIONS=new Map([['中止','CANCELLED'],['途中中止','CANCELLED'],['順延','POSTPONED']]);
const runtimeFetch=(url,options)=>fetch(url,options);
const venue=value=>typeof value==='string'&&/^(?:0[1-9]|1\d|2[0-4])$/.test(value)?value:null;
const clock=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)?value:null;
const httpStatus=error=>Number(error?.http_status??error?.response?.status??error?.status)||null;
const nowIso=()=>new Date().toISOString();
async function saveWithinBudget(write,deadlineMs){
  const remaining=deadlineMs-Date.now();
  if(remaining<=0)throw Object.assign(new Error('Schedule write budget exhausted'),{code:'SCHEDULE_SAVE_TIMEOUT'});
  let timer;
  try{
    return await Promise.race([Promise.resolve().then(write),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(new Error('Schedule write timed out'),{code:'SCHEDULE_SAVE_TIMEOUT'})),remaining);
    })]);
  }finally{clearTimeout(timer);}
}

export const officialDeadlineUrl=date=>dateValid(date)?BASE+date.replaceAll('-','')+'.json':null;
const cardUrl=(date,code)=>buildUrl('racelist',date,code,1);
const scheduleMaps=()=>({deadlines:new Map(),disruptions:new Map()});

// Only the selected day's tab is authoritative. A series can include an older
// postponed day while today's races are running normally.
function cardDayDisruption(html,date){
  const tabs=[...html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)].filter(match=>{
    const classes=match[1].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]?.split(/\s+/)||[];
    return classes.includes('is-active2')&&/\bclass\s*=\s*["'][^"']*\btab2_inner\b/i.test(match[2]);
  }).map(match=>match[2].replace(/<[^>]+>/g,' ').replaceAll('&nbsp;',' ').normalize('NFKC').replace(/\s+/g,' ').trim())
    .map(text=>text.match(/^(\d{1,2})月(\d{1,2})日\s*(.*)$/)).filter(Boolean);
  if(tabs.length>1)return {ok:false};
  if(!tabs.length)return {ok:true,reason:null};
  const tab=tabs[0],month=Number(date.slice(5,7)),day=Number(date.slice(8,10));
  if(Number(tab[1])!==month||Number(tab[2])!==day)return {ok:false};
  // A day tab can establish all-day cancellation/postponement only. Partial
  // cancellations require per-race evidence such as BOATCAST CancelStatusAll.
  return {ok:true,reason:['中止','順延'].includes(tab[3])?tab[3]:null};
}

export function normalizeOfficialCardDeadlines(html,{date,venueCode,source,now=Date.now()}={}){
  const fail=reason=>({ok:false,reason,...scheduleMaps()});
  if(!dateValid(date)||date!==jstDate(0,now)||!venue(venueCode))return fail('SCHEDULE_CARD_IDENTITY_INVALID');
  const fetched=utcMs(source?.fetched_at);
  if(source?.provider!=='BOATRACE'||source.url!==cardUrl(date,venueCode)||source.http_status!==200
    ||source.race_date!==date||source.venue_code!==venueCode||source.request_race_number!==1
    ||fetched==null||fetched>now||now-fetched>MAX_AGE_MS)return fail('SCHEDULE_CARD_SOURCE_INVALID');
  if(typeof html!=='string'||html.length>512*1024)return fail('SCHEDULE_CARD_PAYLOAD_INVALID');
  html=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const labels=[...html.matchAll(/<td\b[^>]*>\s*締切予定時刻\s*<\/td>/gi)];
  const marker=labels.length===1?html.indexOf('締切予定時刻',labels[0].index):-1;
  const start=html.lastIndexOf('<table',marker),end=html.indexOf('</table>',marker);
  if(marker<0||start<0||end<marker)return fail('SCHEDULE_CARD_SLOTS_INVALID');
  const table=html.slice(start,end+8),headers=[...table.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi)];
  if(headers.length!==1)return fail('SCHEDULE_CARD_IDENTITY_INVALID');
  const header=headers[0][1];
  const links=[...header.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match=>match[1].replaceAll('&amp;','&'));
  if(links.length!==12)return fail('SCHEDULE_CARD_IDENTITY_INVALID');
  for(let index=0;index<12;index++){
    let url;try{url=new URL(links[index],'https://boatrace.jp');}catch{return fail('SCHEDULE_CARD_IDENTITY_INVALID');}
    if(url.origin!=='https://boatrace.jp'||url.pathname!=='/owpc/pc/race/racelist'||[...url.searchParams].length!==3
      ||url.searchParams.get('hd')!==date.replaceAll('-','')||url.searchParams.get('jcd')!==venueCode
      ||url.searchParams.get('rno')!==String(index+1))return fail('SCHEDULE_CARD_IDENTITY_INVALID');
  }
  const mark=table.indexOf('締切予定時刻'),row=table.slice(table.lastIndexOf('<tr',mark),table.indexOf('</tr>',mark));
  const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match=>match[1].replace(/<[^>]+>/g,'').replaceAll('&nbsp;',' ').normalize('NFKC').trim());
  const parsed=parseDeadlineTimes(table);
  if(cells.length!==13||cells[0]!=='締切予定時刻'||parsed.length!==12)return fail('SCHEDULE_CARD_SLOTS_INVALID');
  const selectedDay=cardDayDisruption(html,date);
  if(!selectedDay.ok)return fail('SCHEDULE_CARD_IDENTITY_INVALID');
  const {deadlines,disruptions}=scheduleMaps();let previous=-1;
  for(let index=0;index<12;index++){
    const time=cells[index+1].padStart(5,'0');
    const raceNumber=index+1,key=`${date}_${venueCode}_${String(raceNumber).padStart(2,'0')}`;
    if(selectedDay.reason){
      disruptions.set(key,{race_key:key,venue_code:venueCode,race_number:raceNumber,
        schedule_status:DISRUPTIONS.get(selectedDay.reason),reason:selectedDay.reason,source});
      continue;
    }
    // Retain the position of an explicitly closed cell. Unexplained blanks are
    // still rejected rather than shifting or inventing another race's time.
    if(!clock(time)){
      if(CLOSED.has(cells[index+1]))continue;
      return fail('SCHEDULE_CARD_SLOTS_INVALID');
    }
    if(time!==parsed[index])return fail('SCHEDULE_CARD_SLOTS_INVALID');
    const deadline=`${date}T${time}:00+09:00`,at=Date.parse(deadline);
    if(at<=previous)return fail('SCHEDULE_TIME_ORDER_INVALID');previous=at;
    if(at<=now)continue;
    deadlines.set(key,{race_key:key,venue_code:venueCode,race_number:raceNumber,deadline,source});
  }
  return {ok:true,reason:null,deadlines,disruptions};
}

export function normalizeOfficialDeadlines(payload,{date,source,now=Date.now()}={}){
  const fail=reason=>({ok:false,reason,...scheduleMaps()});
  if(!dateValid(date)||date!==jstDate(0,now))return fail('SCHEDULE_DATE_INVALID');
  const fetched=utcMs(source?.fetched_at),published=source?.published_at==null?null:utcMs(source.published_at);
  if(source?.url!==officialDeadlineUrl(date)||source?.provider!=='BOATCAST'||source.http_status!==200)return fail('SCHEDULE_SOURCE_INVALID');
  if(fetched==null||fetched>now||now-fetched>MAX_AGE_MS||jstDate(0,fetched)!==date)return fail('SCHEDULE_OBSERVATION_TIME_INVALID');
  if(source?.published_at!=null&&(published==null||published>fetched||fetched-published>MAX_AGE_MS))return fail('SCHEDULE_PUBLICATION_TIME_INVALID');
  if(!payload||payload.res_cd!==0||!Array.isArray(payload.return_info)||!payload.return_info.length||payload.return_info.length>24)return fail('SCHEDULE_PAYLOAD_INVALID');
  const {deadlines,disruptions}=scheduleMaps(),venues=new Set();
  for(const row of payload.return_info){
    const code=venue(row?.RaceStudiumNo),times=row?.DeadlineTimeAll,cancelled=row?.CancelStatusAll;
    if(!code||venues.has(code))return fail('SCHEDULE_VENUE_AMBIGUOUS');
    venues.add(code);
    if(!Array.isArray(times)||times.length!==12||!Array.isArray(cancelled)||cancelled.length!==12)return fail('SCHEDULE_RACE_SLOTS_INVALID');
    const ended=row.RecentRace==='99',current=typeof row.RecentRace==='string'&&/^(?:0[1-9]|1[0-2])$/.test(row.RecentRace)?Number(row.RecentRace)-1:null;
    if(ended){
      if(row.DeadlineTime!==''||times.some((value,index)=>clock(value)&&!DISRUPTIONS.has(cancelled[index])))return fail('SCHEDULE_CURRENT_RACE_CONFLICT');
    }else if(current==null||row.DeadlineTime!==times[current]&&!CLOSED.has(row.DeadlineTime))return fail('SCHEDULE_CURRENT_RACE_CONFLICT');
    let previous=-1;
    for(let index=0;index<12;index++){
      const value=times[index],time=clock(value),cancel=cancelled[index];
      if(typeof cancel!=='string'||cancel!==''&&!DISRUPTIONS.has(cancel))return fail('SCHEDULE_CANCEL_STATUS_INVALID');
      if(!time&&!CLOSED.has(value))return fail('SCHEDULE_TIME_AMBIGUOUS');
      const raceNumber=index+1,key=`${date}_${code}_${String(raceNumber).padStart(2,'0')}`;
      // CancelStatusAll overrides DeadlineTimeAll='確定'. The latter is also
      // emitted for cancelled races and cannot prove a completed race result.
      if(cancel){
        disruptions.set(key,{race_key:key,venue_code:code,race_number:raceNumber,schedule_status:DISRUPTIONS.get(cancel),reason:cancel});
        continue;
      }
      if(!time)continue;
      const deadline=`${date}T${time}:00+09:00`,at=Date.parse(deadline);
      // Never repair a deadline from reordered or conflicting race slots.
      if(at<=previous)return fail('SCHEDULE_TIME_ORDER_INVALID');
      previous=at;
      if(at<=now||index===current&&CLOSED.has(row.DeadlineTime))continue;
      deadlines.set(key,{race_key:key,venue_code:code,race_number:raceNumber,deadline});
    }
  }
  return {ok:true,reason:null,deadlines,disruptions};
}

function raceSlot(row,date){
  const code=venue(row?.venue_code),number=row?.race_number;
  if(!row?.id||row.race_date!==date||!code||!Number.isInteger(number)||number<1||number>12)return null;
  return `${date}_${code}_${String(number).padStart(2,'0')}`;
}
const raceIdentity=(row,date)=>row?.race_key===raceSlot(row,date)?row.race_key:null;

// A confirmed same-day live correction outranks an older HTML card for the
// rest of that day. Unchanged schedules need no write just to renew this proof.
// Freshness is enforced when the live correction is first accepted above.
export function hasConfirmedOfficialDeadline(race,{date=race?.race_date,now=Date.now()}={}){
  if(!dateValid(date)||date!==jstDate(0,now)||!raceIdentity(race,date))return false;
  const source=race.deadline_source,fetched=utcMs(source?.fetched_at),deadline=utcMs(race.deadline);
  const confirmedUrl=source?.provider==='BOATCAST'?officialDeadlineUrl(date)
    :source?.provider==='BOATRACE'&&source.request_race_number===1?cardUrl(date,race.venue_code):null;
  if(!confirmedUrl||source.url!==confirmedUrl||source.http_status!==200
    ||source.race_date!==date||source.venue_code!==race.venue_code||source.race_number!==race.race_number
    ||deadline==null||utcMs(source.deadline)!==deadline||jstDate(0,deadline)!==date
    ||fetched==null||fetched>now||jstDate(0,fetched)!==date)return false;
  if(source.published_at!=null){
    const published=utcMs(source.published_at);
    if(published==null||published>fetched||fetched-published>MAX_AGE_MS)return false;
  }
  return true;
}

export async function refreshOfficialDeadlines(client,{date,deadlineMs=Date.now()+8000,fetcher=runtimeFetch,htmlFetcher=fetchHtml}={}){
  const source={provider:'BOATCAST',url:officialDeadlineUrl(date),fetched_at:null,http_status:null};
  const result={ok:false,updated:0,deadline_updated:0,disruption_updated:0,checked:0,reason:null,source,updated_keys:[]};
  const stop=reason=>({...result,reason});
  if(!dateValid(date)||date!==jstDate())return stop('SCHEDULE_DATE_INVALID');
  const budget=Math.min(Number.isFinite(deadlineMs)?deadlineMs:Date.now(),Date.now()+8000);
  if(budget<=Date.now())return stop('SCHEDULE_TIME_BUDGET');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(3500,budget-Date.now()));
  let payload,primaryFailure=null,allowFallback=false;
  try{
    const response=await fetcher(source.url,{signal:controller.signal,redirect:'manual',headers:{Accept:'application/json'}});
    source.http_status=Number(response.status)||null;
    source.fetched_at=nowIso();
    if(response.status!==200){
      primaryFailure=`SCHEDULE_HTTP_${source.http_status||0}`;
      allowFallback=[403,404,408,429].includes(response.status)||response.status>=500&&response.status<=599;
    }else{
      if(response.url&&response.url!==source.url)return stop('SCHEDULE_SOURCE_INVALID');
      const declared=Number(response.headers?.get?.('content-length'));
      if(Number.isFinite(declared)&&declared>MAX_BYTES)return stop('SCHEDULE_PAYLOAD_TOO_LARGE');
      const text=await response.text();
      source.fetched_at=nowIso();
      const modified=response.headers?.get?.('last-modified');
      if(modified){
        const at=Date.parse(modified);
        if(!Number.isFinite(at))return stop('SCHEDULE_PUBLICATION_TIME_INVALID');
        source.published_at=new Date(at).toISOString();
      }
      if(text.length>MAX_BYTES)return stop('SCHEDULE_PAYLOAD_TOO_LARGE');
      try{payload=JSON.parse(text);}catch{return stop('SCHEDULE_JSON_INVALID');}
    }
  }catch(error){
    source.fetched_at=nowIso();
    const timedOut=controller.signal.aborted||['AbortError','TimeoutError'].includes(error?.name);
    primaryFailure=timedOut?'SCHEDULE_FETCH_TIMEOUT':'SCHEDULE_FETCH_FAILED';
    allowFallback=timedOut||/fetch failed|failed to fetch|network request failed|networkerror|connection (?:reset|closed|lost)|socket|econnreset|etimedout/i.test(String(error?.message||''));
  }finally{clearTimeout(timer);}
  if(primaryFailure&&!allowFallback)return stop(primaryFailure);
  if(Date.now()>=budget)return stop('SCHEDULE_TIME_BUDGET');
  let normalized=primaryFailure?null:normalizeOfficialDeadlines(payload,{date,source});
  if(normalized&&!normalized.ok)return stop(normalized.reason);
  if(primaryFailure&&budget-Date.now()<1500)return stop(primaryFailure);
  const entity=client?.asServiceRole?.entities?.Race;
  if(!entity?.filter||!entity?.updateMany)return stop('SCHEDULE_RACE_ENTITY_UNAVAILABLE');
  let rows;
  try{
    rows=await readV8Rows(entity,{race_date:date},{budget,maxPages:4,
      fields:['id','race_key','race_date','venue_code','race_number','deadline','status','updated_date','deadline_source','schedule_status','schedule_reason','schedule_source']});
  }catch(error){return stop(httpStatus(error)?`SCHEDULE_READ_HTTP_${httpStatus(error)}`:'SCHEDULE_READ_FAILED');}
  const counts=new Map();
  for(const row of rows)for(const key of new Set([row?.race_key,raceSlot(row,date)].filter(Boolean)))counts.set(key,(counts.get(key)||0)+1);
  let issue=null;
  if(primaryFailure){
    result.primary_failure={reason:primaryFailure,source:{...source}};
    const nearest=new Map(),latest=new Map(),now=Date.now();let observableCount=0;
    for(const row of rows){
      const key=raceIdentity(row,date),at=utcMs(row.deadline);
      if(!key||counts.get(key)!==1||!ACTIVE.has(row.status)&&row.status!=='cancelled')continue;
      observableCount++;
      if(!ACTIVE.has(row.status)||at==null)continue;
      latest.set(row.venue_code,Math.max(latest.get(row.venue_code)??-Infinity,at));
      if(at<now-15*60000||at>now+60*60000)continue;
      const distance=Math.abs(at-now);nearest.set(row.venue_code,Math.min(nearest.get(row.venue_code)??Infinity,distance));
    }
    // Cancelled venues can have every saved deadline in the past. Reserve a
    // small part of the bounded fallback for them instead of starving them
    // behind continuously upcoming races at other venues.
    const overdue=[...latest].filter(([,at])=>at<now-15*60000).sort((a,b)=>a[0].localeCompare(b[0])).map(([code])=>code);
    const offset=overdue.length?Math.floor(now/60000)%overdue.length:0;
    const rotated=[...overdue.slice(offset),...overdue.slice(0,offset)];
    const nearby=[...nearest].sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0])).map(([code])=>code);
    const codes=[...new Set([...rotated.slice(0,Math.min(2,overdue.length)),...nearby,...rotated])].slice(0,7);
    result.fallback={provider:'BOATRACE',attempted:0,accepted:0,failures:[]};
    if(!observableCount)return stop(primaryFailure);
    const fetchDeadline=budget-1250,timeout=Math.min(3000,fetchDeadline-Date.now());
    if(timeout<250)return stop(primaryFailure);
    const requests=[{kind:'index',url:buildUrl('index',date,'00',1)},...codes.map(code=>({kind:'card',code,url:cardUrl(date,code)}))];
    const acquired=await Promise.allSettled(requests.map(async request=>{
      const {url,code}=request;
      const response=await htmlFetcher(url,0,{timeoutMs:timeout,deadlineMs:fetchDeadline});
      const evidence={provider:'BOATRACE',url,http_status:Number(response.status)||null,fetched_at:nowIso(),
        race_date:date,...(request.kind==='card'?{venue_code:code,request_race_number:1}:{})};
      if(!response.ok||response.status!==200)return {ok:false,reason:`SCHEDULE_${request.kind==='index'?'INDEX':'CARD'}_HTTP_${evidence.http_status||0}`,source:evidence};
      if(request.kind==='index')return {deadlines:new Map(),...normalizeOfficialIndexDisruptions(response.html,{date,source:evidence}),source:evidence};
      return {...normalizeOfficialCardDeadlines(response.html,{date,venueCode:code,source:evidence}),source:evidence};
    }));
    result.fallback.attempted=requests.length;normalized={ok:true,...scheduleMaps()};result.sources=[];
    acquired.forEach((settled,index)=>{
      const request=requests[index],value=settled.status==='fulfilled'?settled.value:{ok:false,reason:`SCHEDULE_${request.kind==='index'?'INDEX':'CARD'}_FETCH_FAILED`};
      if(!value.ok){issue=issue||value.reason;result.fallback.failures.push({...(request.code?{venue_code:request.code}:{}),kind:request.kind,reason:value.reason});return;}
      result.fallback.accepted++;result.sources.push(value.source);
      for(const [key,expected] of value.deadlines)normalized.deadlines.set(key,expected);
      for(const [key,expected] of value.disruptions){
        const previous=normalized.disruptions.get(key);
        if(previous&&previous.schedule_status!==expected.schedule_status){
          issue=issue||'SCHEDULE_DISRUPTION_CONFLICT';normalized.disruptions.delete(key);normalized.deadlines.delete(key);continue;
        }
        // Keep the index's explicit range text for a partial cancellation.
        if(!previous)normalized.disruptions.set(key,expected);
      }
    });
    if(!result.fallback.accepted)return stop(issue||primaryFailure);
    result.source=result.sources[0];
  }
  const candidates=[];
  for(const row of rows){
    const key=raceIdentity(row,date);
    if(!key){issue=issue||'SCHEDULE_RACE_IDENTITY_INVALID';continue;}
    if(counts.get(key)!==1){issue=issue||'SCHEDULE_RACE_IDENTITY_AMBIGUOUS';continue;}
    const disruption=normalized.disruptions.get(key),expected=disruption||normalized.deadlines.get(key);
    if(!ACTIVE.has(row.status)&&!(row.status==='cancelled'&&disruption))continue;
    if(!expected)continue;
    result.checked++;
    if(disruption&&row.status==='cancelled'&&row.schedule_status===disruption.schedule_status
      &&row.schedule_reason===(disruption.schedule_reason||disruption.reason))continue;
    const evidenceSource=expected.source||source;
    const oldTime=utcMs(row.deadline),updated=utcMs(row.updated_date),previousSource=Math.max(
      utcMs(row.deadline_source?.fetched_at)??-Infinity,utcMs(row.schedule_source?.fetched_at)??-Infinity);
    if(!disruption&&oldTime==null||updated!=null&&updated>Date.now()||previousSource>utcMs(evidenceSource.fetched_at)
      ||row.status==='cancelled'&&utcMs(row.schedule_source?.fetched_at)!=null&&utcMs(row.schedule_source.fetched_at)>=utcMs(evidenceSource.fetched_at)){
      issue=issue||'SCHEDULE_RACE_TIME_INVALID';continue;
    }
    if(disruption){candidates.push({row,expected,kind:'disruption'});continue;}
    if(oldTime===Date.parse(expected.deadline))continue;
    if(evidenceSource.provider==='BOATRACE'&&hasConfirmedOfficialDeadline(row,{date})
      &&(row.deadline_source.provider==='BOATCAST'||Date.parse(expected.deadline)<oldTime))continue;
    candidates.push({row,expected,kind:'deadline'});
  }
  // Correct the nearest official deadlines first if this short phase runs out
  // of budget. An old deadline may already be in the past and remains eligible.
  candidates.sort((a,b)=>(a.kind==='disruption'?0:1)-(b.kind==='disruption'?0:1)
    ||(Date.parse(a.expected.deadline)||0)-(Date.parse(b.expected.deadline)||0)||a.expected.race_key.localeCompare(b.expected.race_key));
  const attempted=[];
  for(const {row,expected,kind} of candidates){
    if(Date.now()>=budget-750){issue=issue||'SCHEDULE_TIME_BUDGET';break;}
    if(kind==='deadline'&&Date.parse(expected.deadline)<=Date.now())continue;
    const query={id:row.id,race_key:row.race_key,race_date:date,venue_code:row.venue_code,race_number:row.race_number,
      status:row.status,...(Object.hasOwn(row,'deadline')?{deadline:row.deadline}:{}),...(row.updated_date?{updated_date:row.updated_date}:{})};
    const evidence={...(expected.source||source),race_date:date,venue_code:expected.venue_code,race_number:expected.race_number,
      ...(kind==='disruption'?{schedule_status:expected.schedule_status,reason:expected.reason,schedule_reason:expected.schedule_reason||expected.reason}:{deadline:expected.deadline})};
    const attempt={id:row.id,...expected,evidence,kind};attempted.push(attempt);
    try{
      // One conditional write stores the observed schedule and its source.
      // Concurrent completion or deadline corrections cannot be overwritten.
      await saveWithinBudget(()=>entity.updateMany(query,{$set:kind==='disruption'
        ?{status:'cancelled',schedule_status:expected.schedule_status,schedule_reason:expected.schedule_reason||expected.reason,schedule_source:evidence}
        :{deadline:expected.deadline,deadline_source:evidence}}),budget-750);
    }catch(error){
      if(error?.code==='SCHEDULE_SAVE_TIMEOUT'){
        // The SDK cannot abort this CAS. It may finish later; leave it
        // unconfirmed here and let the next bounded refresh reconcile it.
        attempt.unconfirmed=true;issue=issue||'SCHEDULE_SAVE_TIMEOUT';
      }else issue=issue||(httpStatus(error)?`SCHEDULE_SAVE_HTTP_${httpStatus(error)}`:'SCHEDULE_SAVE_FAILED');
      break;
    }
  }
  const verifiable=attempted.filter(row=>!row.unconfirmed);
  if(verifiable.length){
    try{
      const saved=await readV8Rows(entity,{id:{$in:verifiable.map(row=>row.id)}},{budget,maxPages:3,
        fields:['id','race_key','race_date','venue_code','race_number','status','deadline','deadline_source','schedule_status','schedule_reason','schedule_source']});
      for(const expected of verifiable){
        const matches=saved.filter(row=>row.id===expected.id);
        const row=matches[0],confirmed=expected.kind==='disruption'
          ?row?.status==='cancelled'&&row.schedule_status===expected.schedule_status&&row.schedule_reason===(expected.schedule_reason||expected.reason)
            &&row.schedule_source?.url===expected.evidence.url&&row.schedule_source?.fetched_at===expected.evidence.fetched_at
            &&row.schedule_source?.race_date===date&&row.schedule_source?.venue_code===expected.venue_code
            &&row.schedule_source?.race_number===expected.race_number&&row.schedule_source?.schedule_status===expected.schedule_status
          :ACTIVE.has(row?.status)&&row.deadline===expected.deadline&&row.deadline_source?.url===expected.evidence.url
            &&row.deadline_source?.fetched_at===expected.evidence.fetched_at;
        if(matches.length!==1||raceIdentity(row,date)!==expected.race_key||!confirmed){issue=issue||'SCHEDULE_SAVE_NOT_CONFIRMED';continue;}
        result.updated++;result.updated_keys.push(expected.race_key);
        result[expected.kind==='disruption'?'disruption_updated':'deadline_updated']++;
      }
    }catch(error){issue=issue||(httpStatus(error)?`SCHEDULE_VERIFY_HTTP_${httpStatus(error)}`:'SCHEDULE_SAVE_NOT_CONFIRMED');}
  }
  return {...result,ok:issue==null,reason:issue};
}
