// BOATCAST WAKU10 is a frame-number sample, not an actual-course career table.
// Keep the published averages separate from rates calculated from known starts.
import {dateValid} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

export const RECENT_LANE_REVISION='V8_RECENT_LANE_1';
export const RECENT_LANE_PARSER_REVISION='BOATCAST_WAKU10_PARSER_1';
export const RECENT_LANE_SOURCE='BOATCAST_WAKU10';
export const RECENT_LANE_DENOMINATOR='KNOWN_STARTS_EXCLUDING_ABSENT';
// Official finish points: ordinary first 10 + SG 2 + championship first 1 = 13.
// https://www.boatrace.jp/owpc/pc/extra/enjoy/guide/jiten/17/y_164.html
// Published WAKU10 averages can exceed 10; retain the source value without clipping.
export const RECENT_LANE_MAX_WINNING_RATE=13;
const PREFECTURES='北海道|青森(?:県)?|岩手(?:県)?|宮城(?:県)?|秋田(?:県)?|山形(?:県)?|福島(?:県)?|茨城(?:県)?|栃木(?:県)?|群馬(?:県)?|埼玉(?:県)?|千葉(?:県)?|東京(?:都)?|神奈川(?:県)?|新潟(?:県)?|富山(?:県)?|石川(?:県)?|福井(?:県)?|山梨(?:県)?|長野(?:県)?|岐阜(?:県)?|静岡(?:県)?|愛知(?:県)?|三重(?:県)?|滋賀(?:県)?|京都(?:府)?|大阪(?:府)?|兵庫(?:県)?|奈良(?:県)?|和歌山(?:県)?|鳥取(?:県)?|島根(?:県)?|岡山(?:県)?|広島(?:県)?|山口(?:県)?|徳島(?:県)?|香川(?:県)?|愛媛(?:県)?|高知(?:県)?|福岡(?:県)?|佐賀(?:県)?|長崎(?:県)?|熊本(?:県)?|大分(?:県)?|宮崎(?:県)?|鹿児島(?:県)?|沖縄(?:県)?';
const pairedPrefectureSuffix=new RegExp('(?:[・/／:：])?[（(【\\[]?(?:'+PREFECTURES+')[／/](?:'+PREFECTURES+')[）)】\\]]?$');
const prefectureSuffix=new RegExp('(?:[・/／:：])?[（(【\\[]?(?:'+PREFECTURES+')[）)】\\]]?$');
const half=value=>String(value??'').normalize('NFKC').trim();
const round=value=>Math.round(value*1000)/1000;
const lane=value=>Number.isInteger(Number(value))&&Number(value)>=1&&Number(value)<=6?Number(value):null;
const fail=reason=>({ok:false,reason});
const points={1:10,2:8,3:6,4:4,5:2,6:1};
const ABSENT=new Set(['欠','欠場','K','K0','K1']);
const SPECIAL=new Set(['F','F0','F1','L','L0','L1','S','S0','S1','S2','失','失格','転','転覆','沈','沈没','落','落水','妨','妨害','不','不完走','エ']);

export function normalizeRecentLaneName(value){
  const name=half(value).replace(/[\s\u3000]/g,'');
  // Official cards append branch/birthplace together, e.g. 香川颯太滋賀/京都.
  // Remove that recognized pair once; do not then strip a prefecture-like part of the name.
  const paired=name.replace(pairedPrefectureSuffix,'');
  const without=paired!==name?paired:name.replace(prefectureSuffix,'');
  return without.length>=2?without:name;
}

export function classifyRecentLaneFinish(value){
  const raw=half(value).toUpperCase();
  if(!raw||['-','―','—','–'].includes(raw))return {kind:'EMPTY',finish_order:null,finish_status:null};
  if(/^[1-6]$/.test(raw))return {kind:'NORMAL',finish_order:Number(raw),finish_status:null};
  if(ABSENT.has(raw))return {kind:'ABSENT',finish_order:null,finish_status:raw};
  if(SPECIAL.has(raw))return {kind:'SPECIAL',finish_order:null,finish_status:raw};
  return {kind:'UNKNOWN',finish_order:null,finish_status:raw};
}

export function summarizeRecentLaneHistory(history){
  if(!Array.isArray(history)||history.length>10)return fail('HISTORY_INVALID');
  const counts=[0,0,0,0,0,0];let normal=0,special=0,absent=0,totalPoints=0;
  for(const row of history){
    if(!row||typeof row!=='object')return fail('HISTORY_INVALID');
    const normalValue=row.finish_order;
    if(normalValue!=null&&(!Number.isInteger(normalValue)||normalValue<1||normalValue>6||row.finish_status!=null&&String(row.finish_status).trim()))return fail('FINISH_CONFLICT');
    const finish=classifyRecentLaneFinish(normalValue??row.finish_status);
    if(finish.kind==='EMPTY'||finish.kind==='UNKNOWN')return fail('FINISH_UNKNOWN');
    if(finish.kind==='NORMAL'){normal++;counts[finish.finish_order-1]++;totalPoints+=points[finish.finish_order];}
    else if(finish.kind==='SPECIAL')special++;
    else absent++;
  }
  // F/L/other recognized starts remain in finish-rate denominators; absences do not.
  const sample=normal+special,rate=count=>sample?round(count/sample*100):null;
  return {ok:true,sample_size:sample,normal_sample_size:normal,special_count:special,absent_count:absent,
    first_rate:rate(counts[0]),second_rate:rate(counts[1]),third_rate:rate(counts[2]),
    top2_rate:rate(counts[0]+counts[1]),top3_rate:rate(counts[0]+counts[1]+counts[2]),
    winning_rate:normal?round(totalPoints/normal):null};
}

export async function recentLaneHash(value){
  const stable=input=>Array.isArray(input)?input.map(stable):input&&typeof input==='object'
    ?Object.fromEntries(Object.keys(input).sort().map(key=>[key,stable(input[key])])):input;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable(value))));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function recentLaneSourceUrl(race){
  return 'https://race.boatcast.jp/hp_txt/'+String(race.venue_code).padStart(2,'0')+'/bc_j_waku10_'+race.race_date.replace(/-/g,'')+'_'+String(race.venue_code).padStart(2,'0')+'_'+String(race.race_number).padStart(2,'0')+'.txt';
}

export async function buildRecentLaneIdentity(race,entries,now){
  const at=utcMs(now),venue=String(race?.venue_code??'').padStart(2,'0'),number=Number(race?.race_number);
  if(at==null||!race?.id||!dateValid(race.race_date)||!/^\d{2}$/.test(venue)||Number(venue)<1||Number(venue)>24
    ||!Number.isInteger(number)||number<1||number>12
    ||race.race_key!==race.race_date+'_'+venue+'_'+String(number).padStart(2,'0'))return fail('RACE_IDENTITY_INVALID');
  if(!Array.isArray(entries)||entries.length!==6)return fail('ENTRIES_INCOMPLETE');
  const identity=[];
  for(const entry of entries){
    const boat=lane(entry?.boat_number),reg=String(entry?.registration_number??entry?.register_number??'').trim();
    if(!boat||entry?.race_id!==race.id||!/^\d{4}$/.test(reg)
      ||entry.registration_number!=null&&entry.register_number!=null&&String(entry.registration_number)!==String(entry.register_number)
      ||entry.race_date!=null&&entry.race_date!==race.race_date)return fail('ENTRY_IDENTITY_INVALID');
    for(const key of ['created_date','updated_date'])if(entry[key]!=null&&(utcMs(entry[key])==null||utcMs(entry[key])>at))return fail('ENTRY_TIME_INVALID');
    const names=[entry.player_name,entry.racer_name];
    const profile=entry.v8_racer_profile;
    if(profile?.revision==='V8_RACER_PROFILE_1'&&String(profile.registration_number)===reg
      &&utcMs(profile.source?.available_at)!=null&&utcMs(profile.source.available_at)<=at)names.push(profile.player_name);
    const aliases=[...new Set(names.map(normalizeRecentLaneName).filter(Boolean))];
    if(!aliases.length)return fail('ENTRY_NAME_MISSING');
    identity.push({boat_number:boat,registration_number:reg,normalized_name:aliases[0],aliases});
  }
  identity.sort((a,b)=>a.boat_number-b.boat_number);
  if(new Set(identity.map(row=>row.boat_number)).size!==6||new Set(identity.map(row=>row.registration_number)).size!==6)return fail('ENTRY_IDENTITY_DUPLICATE');
  for(let i=0;i<identity.length;i++)for(let j=i+1;j<identity.length;j++)if(identity[i].aliases.some(name=>identity[j].aliases.includes(name)))return fail('ENTRY_NAME_AMBIGUOUS');
  // The same registered entrants must share one cache key whether official aliases are loaded or not.
  const signature=await recentLaneHash(identity.map(row=>[row.boat_number,row.registration_number]));
  return {ok:true,entry_identity:identity,entrant_signature:signature,
    snapshot_key:RECENT_LANE_REVISION+':'+race.race_key+':'+signature};
}

function boundedNumber(value,min,max){
  const raw=half(value);
  if(!raw||!/^\d*(?:\.\d+)?$/.test(raw))return null;
  const n=Number(raw);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
}

export function parseBoatcastWaku10(text){
  if(typeof text!=='string')return fail('SOURCE_TEXT_INVALID');
  const lines=text.replace(/\r/g,'').split('\n').filter(line=>line.trim()&&line.trim()!=='data=');
  if(lines.length!==7||!/^\s*\d+\s*\t\s*\d+\s*$/.test(lines[0]))return fail('SOURCE_ROWS_INCOMPLETE');
  const racers=[];
  for(let index=0;index<6;index++){
    const parts=lines[index+1].split('\t'),boat=index+1,name=half(parts[0]);
    if(!name||parts.length<4||parts.length>34&&parts.slice(34).some(value=>value.trim()))return fail('SOURCE_ROW_INVALID');
    const history=[];
    for(let position=0;position<10;position++){
      const offset=4+position*3,finish=classifyRecentLaneFinish(parts[offset]);
      if(finish.kind==='UNKNOWN')return fail('SOURCE_FINISH_UNKNOWN');
      if(finish.kind==='EMPTY')continue;
      const rawCourse=half(parts[offset+1]),course=rawCourse?lane(rawCourse):boat;
      if(rawCourse&&course===null)return fail('SOURCE_COURSE_INVALID');
      history.push({finish_order:finish.finish_order,finish_status:finish.finish_status,course,
        course_inferred:!rawCourse,code:half(parts[offset+2])||null});
    }
    const stats=summarizeRecentLaneHistory(history);
    if(!stats.ok)return stats;
    const {ok,...summary}=stats;
    racers.push({boat_number:boat,source_name:name,normalized_source_name:normalizeRecentLaneName(name),
      ...summary,winning_rate:boundedNumber(parts[1],0,RECENT_LANE_MAX_WINNING_RATE),avg_st:boundedNumber(parts[2],0,1),
      avg_start_order:boundedNumber(parts[3],1,6),history});
  }
  return {ok:true,racers};
}

export async function normalizeRecentLaneSource({text,metadata,race,entries,now,identity=null}){
  const at=utcMs(now),fetched=utcMs(metadata?.fetched_at),url=recentLaneSourceUrl(race);
  if(at==null||fetched==null||fetched>at||metadata?.source!=='BOATCAST'||metadata?.data_type!=='WAKU10'
    ||metadata?.source_url!==url||metadata?.http_status!==200
    ||String(metadata.race_date).replace(/-/g,'')!==race.race_date.replace(/-/g,'')
    ||String(metadata.venue_code).padStart(2,'0')!==String(race.venue_code).padStart(2,'0')
    ||Number(metadata.race_number)!==Number(race.race_number))return fail('SOURCE_METADATA_INVALID');
  const verified=identity||await buildRecentLaneIdentity(race,entries,now);
  if(!verified.ok)return verified;
  const parsed=parseBoatcastWaku10(text);if(!parsed.ok)return parsed;
  if(new Set(parsed.racers.map(row=>row.normalized_source_name)).size!==6)return fail('SOURCE_NAME_AMBIGUOUS');
  const racers=[];
  for(const row of parsed.racers){
    const entry=verified.entry_identity.find(item=>item.boat_number===row.boat_number);
    if(!entry?.aliases.includes(row.normalized_source_name))return fail('SOURCE_NAME_MISMATCH');
    const racer={revision:RECENT_LANE_REVISION,source:RECENT_LANE_SOURCE,status:'READY',
      race_id:race.id,race_key:race.race_key,...row,registration_number:entry.registration_number,
      identity_status:'MATCHED_NAME_AND_ENTRY',denominator_rule:RECENT_LANE_DENOMINATOR};
    racer.row_hash=await recentLaneHash(racer);racers.push(racer);
  }
  return {ok:true,racers,source_url:url,fetched_at:new Date(fetched).toISOString(),
    entrant_signature:verified.entrant_signature,entry_identity:verified.entry_identity,snapshot_key:verified.snapshot_key,
    parser_revision:RECENT_LANE_PARSER_REVISION,denominator_rule:RECENT_LANE_DENOMINATOR,
    content_hash:await recentLaneHash(racers)};
}
