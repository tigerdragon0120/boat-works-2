// The official daily index is the fallback source for an explicit all-day or
// numbered partial cancellation. A missing time or a closed sale is not proof.
import {buildUrl} from './boatraceOfficialParser.js';
import {dateValid,jstDate} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

const MAX_AGE_MS=5*60000;
const MAX_HTML_LENGTH=512*1024;
const ORIGIN='https://boatrace.jp';
const VENUE=/^(?:0[1-9]|1\d|2[0-4])$/;
const attribute=(tag,name)=>tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*["\']([^"\']*)["\']','i'))?.[1]??null;
const hasClass=(tag,name)=>(attribute(tag,'class')||'').split(/\s+/).includes(name);
const decode=value=>value.replace(/&(?:amp|nbsp);/gi,entity=>entity.toLowerCase()==='&amp;'?'&':' ')
  .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(entity,hex,decimal)=>{
    const code=parseInt(hex||decimal,hex?16:10);
    return code>0&&code<=0x10ffff?String.fromCodePoint(code):entity;
  });
const text=value=>decode(value.replace(/<[^>]*>/g,' ')).normalize('NFKC').replace(/\s+/g,'').trim();
const asUrl=value=>{try{return new URL(decode(value),ORIGIN);}catch{return null;}};

function explicitDisruption(value){
  if(value==='中止')return {first:1,schedule_status:'CANCELLED',reason:'中止'};
  if(value==='中止順延'||value==='順延')return {first:1,schedule_status:'POSTPONED',reason:'順延'};
  const partial=value.match(/^([1-9]|1[0-2])R以降中止$/);
  if(partial)return {first:Number(partial[1]),schedule_status:'CANCELLED',reason:'途中中止'};
  // A range cannot be guessed from "途中中止", an unknown phrase or a plan.
  return /中止|順延/.test(value)?false:null;
}

export function normalizeOfficialIndexDisruptions(html,{date,source,now=Date.now()}={}){
  const fail=reason=>({ok:false,reason,disruptions:new Map()});
  if(!Number.isFinite(now)||!dateValid(date)||date!==jstDate(0,now))return fail('SCHEDULE_INDEX_DATE_INVALID');
  if(source?.provider!=='BOATRACE'||source.url!==buildUrl('index',date,'',0)
    ||source.http_status!==200||source.race_date!==date)return fail('SCHEDULE_INDEX_SOURCE_INVALID');
  const fetched=utcMs(source.fetched_at);
  if(fetched==null||fetched>now||now-fetched>MAX_AGE_MS||jstDate(0,fetched)!==date)return fail('SCHEDULE_INDEX_OBSERVATION_TIME_INVALID');
  if(typeof html!=='string'||!html.trim()||html.length>MAX_HTML_LENGTH)return fail('SCHEDULE_INDEX_PAYLOAD_INVALID');
  const document=html.replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const headings=[...document.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)]
    .filter(match=>hasClass(match[1],'title2_mainLabel'));
  const expectedHeading=`${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日のレース情報`;
  if(headings.length!==1||text(headings[0][2])!==expectedHeading)return fail('SCHEDULE_INDEX_IDENTITY_INVALID');
  const tables=[...document.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .filter(match=>/text_place1_/.test(match[1]));
  if(tables.length!==1||tables[0].index<headings[0].index||/<table\b/i.test(tables[0][1]))return fail('SCHEDULE_INDEX_IDENTITY_INVALID');
  const table=tables[0][1],headers=[...table.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi)];
  if(headers.length!==1||!text(headers[0][1]).includes('進行状況/締切予定時刻/投票'))return fail('SCHEDULE_INDEX_IDENTITY_INVALID');
  const bodies=[...table.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)];
  if(!bodies.length||bodies.length>24||bodies.length!==(table.match(/<tbody\b/gi)||[]).length
    ||bodies.length!==(table.match(/<\/tbody\s*>/gi)||[]).length)return fail('SCHEDULE_INDEX_VENUE_AMBIGUOUS');
  const venues=new Set(),disruptions=new Map(),day=date.replaceAll('-','');
  for(const body of bodies){
    const images=[...body[1].matchAll(/<img\b([^>]*)>/gi)]
      .map(match=>attribute(match[1],'src')).filter(src=>src!=null&&/text_place1_/.test(src));
    if(images.length!==1)return fail('SCHEDULE_INDEX_VENUE_AMBIGUOUS');
    const image=asUrl(images[0]),code=image?.pathname.match(/^\/static_extra\/pc\/images\/text_place1_(\d{2})\.png$/)?.[1];
    if(!code||!VENUE.test(code)||image.origin!==ORIGIN||image.search||image.hash||venues.has(code))return fail('SCHEDULE_INDEX_VENUE_AMBIGUOUS');
    venues.add(code);
    const links=[...body[1].matchAll(/<a\b([^>]*)>/gi)].map(match=>attribute(match[1],'href'))
      .filter(value=>value!=null).map(asUrl).filter(Boolean);
    const identityLinks=links.filter(url=>url.pathname==='/owpc/pc/race/raceindex');
    if(identityLinks.length!==1)return fail('SCHEDULE_INDEX_IDENTITY_INVALID');
    const identity=identityLinks[0];
    if(identity.origin!==ORIGIN||identity.hash||[...identity.searchParams].length!==2
      ||identity.searchParams.get('hd')!==day||identity.searchParams.get('jcd')!==code)return fail('SCHEDULE_INDEX_IDENTITY_INVALID');
    // Other race links within this same venue must not contradict its day/code.
    if(links.some(url=>url.pathname.startsWith('/owpc/pc/race/')
      &&(url.searchParams.has('hd')||url.searchParams.has('jcd'))
      &&(url.origin!==ORIGIN||url.searchParams.getAll('hd').length!==1||url.searchParams.getAll('jcd').length!==1
        ||url.searchParams.get('hd')!==day||url.searchParams.get('jcd')!==code)))return fail('SCHEDULE_INDEX_IDENTITY_INVALID');
    const notices=[...body[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
      .filter(match=>hasClass(match[1],'is-attentionColor1')).map(match=>text(match[2]));
    if(notices.length>1)return fail('SCHEDULE_INDEX_DISRUPTION_AMBIGUOUS');
    if(!notices.length)continue;
    const disruption=explicitDisruption(notices[0]);
    if(disruption===false)return fail('SCHEDULE_INDEX_DISRUPTION_AMBIGUOUS');
    if(!disruption)continue;
    for(let raceNumber=disruption.first;raceNumber<=12;raceNumber++){
      const key=`${date}_${code}_${String(raceNumber).padStart(2,'0')}`;
      disruptions.set(key,{race_key:key,venue_code:code,race_number:raceNumber,
        schedule_status:disruption.schedule_status,reason:disruption.reason,schedule_reason:notices[0],source});
    }
  }
  return {ok:true,reason:null,disruptions};
}
