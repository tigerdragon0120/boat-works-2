// Official stadium statistics: actual entry courses, not boat numbers.
// The official table publishes frequencies but no sample counts or publication time.
import {dateValid,jstDate} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

export const VENUE_PROFILE_REVISION='V8_VENUE_PROFILE_1';
export const VENUE_PROFILE_PARSER_REVISION='BOATRACE_STADIUM_PARSER_1';
export const VENUE_PROFILE_SOURCE='BOATRACE_STADIUM';
export const VENUE_METHODS=['逃げ','まくり','差し','まくり差し','抜き','恵まれ'];
const FINISH_KEYS=['first_rate','second_rate','third_rate','fourth_rate','fifth_rate','sixth_rate'];
const VENUES=['桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑','津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島','宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'];
const fail=reason=>({ok:false,reason});
const bounded=value=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
const sum=values=>values.every(value=>typeof value==='number')?Math.round(values.reduce((total,value)=>total+value,0)*1000)/1000:null;
const dateString=(year,month,day)=>new Date(Date.UTC(year,month,day)).toISOString().slice(0,10);
const clone=value=>JSON.parse(JSON.stringify(value));

export function canonicalVenueCode(value){
  const raw=String(value??'').trim();
  return /^\d{1,2}$/.test(raw)&&Number(raw)>=1&&Number(raw)<=24?raw.padStart(2,'0'):null;
}
export const officialVenueProfileUrl=code=>'https://www.boatrace.jp/owpc/pc/data/stadium?jcd='+canonicalVenueCode(code);
export const venueProfileSnapshotKey=(code,periodEnd)=>VENUE_PROFILE_REVISION+':'+canonicalVenueCode(code)+':'+periodEnd;
export const venueRefreshKey=(code,periodEnd)=>VENUE_PROFILE_REVISION+':REFRESH:'+canonicalVenueCode(code)+':'+periodEnd;
export function expectedVenuePeriodEnd(asOf){
  const at=utcMs(asOf);if(at==null)return null;
  const [year,month]=jstDate(0,at).split('-').map(Number);return dateString(year,month-1,0);
}
function validPeriod(start,end){
  if(!dateValid(start)||!dateValid(end)||start>end)return false;
  const [year,month]=end.split('-').map(Number);
  return end===dateString(year,month,0)&&start===dateString(year,month-3,1);
}

export async function venueProfileHash(value){
  const stable=input=>Array.isArray(input)?input.map(stable):input&&typeof input==='object'
    ?Object.fromEntries(Object.keys(input).sort().map(key=>[key,stable(input[key])])):input;
  const data=typeof value==='string'?value:JSON.stringify(stable(value));
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function venueProfileContent(profile){
  return Object.fromEntries(['revision','parser_revision','venue_code','venue_name','source','source_url',
    'period_start','period_end','course_basis','method_basis','sample_size','sample_size_status','published_at',
    'courses','frame_to_course','data_quality','missing_fields'].map(key=>[key,profile[key]]));
}

function text(html){
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&')
    .replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number)))
    .normalize('NFKC').replace(/[\s\u3000]+/g,'').trim();
}
function percentage(raw){
  const value=text(raw);
  if(!value||['-','―','—','–'].includes(value))return {ok:true,value:null};
  if(!/^\d{1,3}(?:\.\d+)?$/.test(value))return {ok:false};
  const n=Number(value);return n>=0&&n<=100?{ok:true,value:n}:{ok:false};
}
function sectionTable(section,marker){
  const index=section.indexOf(marker);if(index<0)return null;
  const tail=section.slice(index),match=/<table\b[^>]*>[\s\S]*?<\/table>/i.exec(tail);
  if(!match)return null;
  const remainder=tail.slice(match.index+match[0].length),nextTable=remainder.search(/<table\b/i);
  // Never borrow the next table's period if this table loses its own label.
  const after=nextTable<0?remainder:remainder.slice(0,nextTable);
  const period=/集計期間[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*[～〜~－-]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(text(after));
  if(!period)return null;
  const start=[period[1],period[2].padStart(2,'0'),period[3].padStart(2,'0')].join('-');
  const end=[period[4],period[5].padStart(2,'0'),period[6].padStart(2,'0')].join('-');
  const headers=[...match[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(item=>text(item[1]));
  const rows=[...match[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(item=>[...item[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell=>cell[1])).filter(cells=>cells.length);
  return {headers,rows,period_start:start,period_end:end};
}

export async function parseOfficialVenueProfile(html,{venueCode,sourceUrl=officialVenueProfileUrl(venueCode),fetchedAt,now=fetchedAt}={}){
  const code=canonicalVenueCode(venueCode),at=utcMs(now),fetched=utcMs(fetchedAt);
  if(!code||typeof html!=='string'||html.length>500000||sourceUrl!==officialVenueProfileUrl(code)
    ||at==null||fetched==null||fetched>at)return fail('VENUE_SOURCE_IDENTITY_OR_TIME_INVALID');
  const heading=/<span\b[^>]*class=["'][^"']*\bheading1_mainLabel\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if(!heading||text(heading[1])!==VENUES[Number(code)-1]+'ボートレース場')return fail('VENUE_NAME_MISMATCH');
  const start=html.indexOf('最近3ヶ月のデータ'),end=html.indexOf('季節別データ',start);
  if(start<0||end<0)return fail('RECENT_VENUE_SECTION_MISSING');
  const recent=html.slice(start,end),courseTable=sectionTable(recent,'コース別入着率＆決まり手'),frameTable=sectionTable(recent,'枠番別コース取得率');
  if(!courseTable||!frameTable||courseTable.rows.length!==6||frameTable.rows.length!==6)return fail('VENUE_TABLE_INCOMPLETE');
  const expectedHeaders=['コース','1着','2着','3着','4着','5着','6着','コース別決まり手','逃げ','捲り','差し','捲り差し','抜き','恵まれ'];
  if(JSON.stringify(courseTable.headers)!==JSON.stringify(expectedHeaders)
    ||JSON.stringify(frameTable.headers)!==JSON.stringify(['枠','1コース','2コース','3コース','4コース','5コース','6コース']))return fail('VENUE_HEADERS_CHANGED');
  const periodStart=courseTable.period_start,periodEnd=courseTable.period_end;
  if(!validPeriod(periodStart,periodEnd)||periodStart!==frameTable.period_start||periodEnd!==frameTable.period_end
    ||periodEnd>=jstDate(0,at)||periodEnd>=jstDate(0,fetched))return fail('VENUE_PERIOD_INVALID');
  const courses={},frameToCourse={},missing=[];
  for(let index=0;index<6;index++){
    const number=index+1,cells=courseTable.rows[index],frame=frameTable.rows[index];
    if(cells.length!==13||frame.length!==7||text(cells[0])!==String(number)||text(frame[0])!==String(number))return fail('VENUE_COURSE_IDENTITY_INVALID');
    const values=cells.slice(1).map(percentage),frameValues=frame.slice(1).map(percentage);
    if(values.some(value=>!value.ok)||frameValues.some(value=>!value.ok))return fail('VENUE_RATE_INVALID');
    const finishes=values.slice(0,6).map(value=>value.value),methods=values.slice(6).map(value=>value.value),transitions=frameValues.map(value=>value.value);
    if([finishes,methods,transitions].some(rates=>sum(rates)>100.6))return fail('VENUE_RATE_TOTAL_INVALID');
    const course={course:number,sample_size:null,...Object.fromEntries(FINISH_KEYS.map((key,i)=>[key,finishes[i]])),
      top2_rate:sum(finishes.slice(0,2)),top3_rate:sum(finishes.slice(0,3)),avg_st:null,avg_st_rank:null,
      winning_methods:Object.fromEntries(VENUE_METHODS.map((method,i)=>[method,methods[i]]))};
    courses[String(number)]=course;frameToCourse[String(number)]=Object.fromEntries(transitions.map((value,i)=>[String(i+1),value]));
    FINISH_KEYS.forEach(key=>{if(course[key]===null)missing.push('courses.'+number+'.'+key);});
    VENUE_METHODS.forEach(method=>{if(course.winning_methods[method]===null)missing.push('courses.'+number+'.winning_methods.'+method);});
    transitions.forEach((value,i)=>{if(value===null)missing.push('frame_to_course.'+number+'.'+(i+1));});
  }
  if(!Object.values(courses).some(course=>course.first_rate!==null))return fail('VENUE_RATES_NOT_PUBLISHED');
  const profile={revision:VENUE_PROFILE_REVISION,parser_revision:VENUE_PROFILE_PARSER_REVISION,status:'READY',
    venue_code:code,venue_name:VENUES[Number(code)-1],source:VENUE_PROFILE_SOURCE,source_url:sourceUrl,
    fetched_at:new Date(fetched).toISOString(),published_at:null,period_start:periodStart,period_end:periodEnd,
    course_basis:'ACTUAL_ENTRY_COURSE',method_basis:'AMONG_COURSE_WINNERS',sample_size:null,sample_size_status:'NOT_PUBLISHED',
    courses,frame_to_course:frameToCourse,data_quality:missing.length?'PARTIAL':'COMPLETE',missing_fields:missing};
  profile.content_hash=await venueProfileHash(venueProfileContent(profile));
  profile.source_hash=await venueProfileHash(html);
  return {ok:true,profile};
}

/** Synchronous engine boundary: replay cannot relabel a newly fetched venue source. */
export function validateVenueProfile(profile,{venueCode,raceDate,asOf}={}){
  const code=canonicalVenueCode(venueCode),at=utcMs(asOf),fetched=utcMs(profile?.fetched_at),available=utcMs(profile?.available_at);
  if(!code||at==null||!dateValid(raceDate)||profile?.revision!==VENUE_PROFILE_REVISION||profile.parser_revision!==VENUE_PROFILE_PARSER_REVISION
    ||profile.status!=='READY'||profile.source!==VENUE_PROFILE_SOURCE||profile.venue_code!==code||profile.source_url!==officialVenueProfileUrl(code)
    ||profile.venue_name!==VENUES[Number(code)-1]||!profile.snapshot_id||profile.snapshot_key!==venueProfileSnapshotKey(code,profile.period_end)
    ||!/^[a-f0-9]{64}$/.test(profile.content_hash||'')||!/^[a-f0-9]{64}$/.test(profile.source_hash||'')
    ||fetched==null||available==null||fetched>available||available>at
    ||!validPeriod(profile.period_start,profile.period_end)||profile.period_end>=raceDate||profile.period_end>=jstDate(0,at)
    ||profile.period_end>=jstDate(0,fetched)||profile.course_basis!=='ACTUAL_ENTRY_COURSE'||profile.method_basis!=='AMONG_COURSE_WINNERS'
    ||profile.sample_size!==null||profile.sample_size_status!=='NOT_PUBLISHED'||profile.published_at!==null)return null;
  const courses={},frames={};
  for(let number=1;number<=6;number++){
    const row=profile.courses?.[String(number)],frame=profile.frame_to_course?.[String(number)];
    if(!row||row.course!==number||row.sample_size!==null||row.avg_st!==null||row.avg_st_rank!==null||!frame)return null;
    const finishes=FINISH_KEYS.map(key=>row[key]),methods=VENUE_METHODS.map(key=>row.winning_methods?.[key]),transitions=Array.from({length:6},(_,i)=>frame[String(i+1)]);
    if([...finishes,...methods,...transitions].some(value=>!bounded(value))||[finishes,methods,transitions].some(values=>sum(values)>100.6)
      ||row.top2_rate!==sum(finishes.slice(0,2))||row.top3_rate!==sum(finishes.slice(0,3)))return null;
    courses[String(number)]=clone(row);frames[String(number)]=clone(frame);
  }
  if(!Object.values(courses).some(row=>row.first_rate!==null))return null;
  return {...clone(profile),courses,frame_to_course:frames};
}
