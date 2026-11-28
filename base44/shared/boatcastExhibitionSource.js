// The existing public BOATCAST TKZ/STT pair is an independent source of standard
// exhibition observations. Never fill either source from old local measurements.
import {fetchBoatcastText} from './boatcastClient.js';
import {buildCommittedExhibitionKey} from './exhibitionInputKey.js';

const MAX_AGE_MS=5*60*1000;
const MAX_PAIR_SKEW_MS=15000;
const knownNetworkCodes=new Set(['ERR_NETWORK','ECONNRESET','ECONNABORTED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
const bugs=new Set(['TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError']);
const present=value=>value!=null&&String(value).trim()!=='';
const name=value=>typeof value==='string'?value.normalize('NFKC').replace(/[\s\u3000]/g,''):'';
// The legacy official-card parser stores the adjacent branch/birthplace pair
// in player_name (e.g. 坪内実大阪/大阪). Recognize only that complete, terminal
// pair on the saved roster. Source names still require exact full-name equality.
const prefectures='北海道 青森 岩手 宮城 秋田 山形 福島 茨城 栃木 群馬 埼玉 千葉 東京 神奈川 新潟 富山 石川 福井 山梨 長野 岐阜 静岡 愛知 三重 滋賀 京都 大阪 兵庫 奈良 和歌山 鳥取 島根 岡山 広島 山口 徳島 香川 愛媛 高知 福岡 佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄'.split(' ');
const prefectureNames=new Map(prefectures.flatMap(value=>[[value,value],
  [value==='北海道'?value:value+({東京:'都',京都:'府',大阪:'府'}[value]||'県'),value]]));
const prefecturePattern=[...prefectureNames.keys()].sort((a,b)=>b.length-a.length).join('|');
const pairedLocation=new RegExp('^([^/]+?)('+prefecturePattern+')/('+prefecturePattern+')$');
function rosterName(value,row){
  if(!value)return null;
  const pair=value.match(pairedLocation);
  if(!pair)return value.includes('/')?null:value;
  const [,pure,branch,birthplace]=pair;
  if(pure.length<2)return null;
  // When separately recorded, the location fields must confirm the suffix.
  if(present(row.branch_name)&&prefectureNames.get(name(row.branch_name))!==prefectureNames.get(branch))return null;
  if(present(row.birthplace)&&prefectureNames.get(name(row.birthplace))!==prefectureNames.get(birthplace))return null;
  return pure;
}
const number=value=>typeof value==='number'?Number.isFinite(value)?value:null
  :typeof value==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())?Number(value):null;
const integer=(value,min,max)=>{const n=number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null;};
const fail=(reason,extra={})=>({ok:false,reason,...extra});
const sameNumber=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-9;
const sourceTime=value=>typeof value==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;

function identify(race,entries){
  const venue=integer(race?.venue_code,1,24),raceNumber=integer(race?.race_number,1,12),date=race?.race_date;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
    ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||venue==null||raceNumber==null
    ||typeof race.id!=='string'||!race.id)return null;
  const venueCode=String(venue).padStart(2,'0'),key=`${date}_${venueCode}_${String(raceNumber).padStart(2,'0')}`;
  if(race.race_key!==key||!Array.isArray(entries)||entries.length!==6)return null;
  const byBoat=new Map(),registrations=new Set(),names=new Set(),ids=new Set();
  for(const row of entries){
    const boat=integer(row?.boat_number,1,6),regs=[row?.registration_number,row?.register_number].filter(present).map(x=>String(x).trim());
    const aliases=[row?.player_name,row?.racer_name].filter(present).map(name),registered=regs[0],racerName=rosterName(aliases[0],row);
    if(boat==null||byBoat.has(boat)||!regs.length||regs.some(x=>!/^\d{4}$/.test(x))||new Set(regs).size!==1
      ||registrations.has(registered)||!aliases.length||!racerName||new Set(aliases).size!==1||names.has(racerName)
      ||typeof row.id!=='string'||!row.id||ids.has(row.id)||row.race_id!==race.id||row.race_key!==key
      ||(present(row.race_date)&&row.race_date!==date)
      ||['is_absent','is_scratched'].some(k=>row[k]!=null&&typeof row[k]!=='boolean'))return null;
    byBoat.set(boat,{registration:registered,name:racerName});registrations.add(registered);names.add(racerName);ids.add(row.id);
  }
  return {date,venueCode,raceNumber,key,byBoat};
}

function parseStart(value,flag){
  const text=String(value??'').trim().toUpperCase(),mark=String(flag??'').trim().toUpperCase();
  if(!['','F','L'].includes(mark))return null;
  if(text==='L'||mark==='L')return (['','L'].includes(text)&&['','L'].includes(mark))?{unsupported:true}:null;
  const explicitF=/^F(?:0)?\.\d+$/.test(text),n=number(explicitF?text.slice(1):text);
  if(n==null||n < -1||n>1)return null;
  const flying=explicitF||mark==='F'||n<0||Object.is(n,-0);
  // The existing RaceEntry schema stores numeric ST/raw ST. A normal zero must
  // never stand in for observed F.00 or L; retain the old data and report a gap.
  if(flying&&n===0)return {unsupported:true};
  return {value:flying?-Math.abs(n):n,flying};
}

function parsePair(tkzText,sttText,identity,race){
  const lines=text=>typeof text==='string'?text.replace(/^\uFEFF/,'').split('\n').map(line=>line.replace(/\r$/,'')).filter(line=>line.trim()):[];
  const tkz=lines(tkzText),stt=lines(sttText);
  if(tkz.length!==9||stt.length!==8||tkz[0]!=='data='||stt[0]!=='data='||tkz[1]!=='1'||stt[1]!=='1')return fail('SOURCE_FORMAT_OR_ROSTER_INCOMPLETE');
  const times=new Map(),starts=new Map(),courses=new Set(),rows=[];
  for(let index=0;index<6;index++){
    const boat=index+1,fields=tkz[index+2].split('\t'),roster=identity.byBoat.get(boat),time=number(fields[1]);
    if(fields.length<7||name(fields[0])!==roster.name||time==null||time<4||time>10)return fail('SOURCE_TIME_OR_NAME_MISMATCH');
    times.set(boat,{time,tilt:number(String(fields[6]??'').replace(/\s/g,''))});
  }
  const startFields=tkz[8].split('\t');
  if(startFields.length<18||startFields.slice(18).some(present))return fail('SOURCE_START_LIST_INCOMPLETE');
  for(let index=0;index<18;index+=3){
    const boat=integer(startFields[index],1,6),start=parseStart(startFields[index+1],startFields[index+2]);
    if(boat==null||starts.has(boat)||!start)return fail('SOURCE_START_LIST_INCOMPLETE');
    if(start.unsupported)return fail('SOURCE_START_FLAG_UNREPRESENTABLE');
    starts.set(boat,start);
  }
  const seen=new Set();
  for(const line of stt.slice(2)){
    const fields=line.split('\t'),boat=integer(fields[1],1,6),course=integer(fields[0],1,6),roster=identity.byBoat.get(boat);
    // STT column 4 (zero based) is the observed start. Column 3 is NOT used.
    const start=parseStart(fields[4],fields[5]),paired=starts.get(boat);
    if(fields.length<6||boat==null||course==null||seen.has(boat)||courses.has(course)||!roster||name(fields[2])!==roster.name
      ||!start||!paired)return fail('SOURCE_COURSE_START_OR_NAME_MISMATCH');
    if(start.unsupported)return fail('SOURCE_START_FLAG_UNREPRESENTABLE');
    if(start.flying!==paired.flying||!sameNumber(start.value,paired.value))return fail('SOURCE_START_PAIR_CONFLICT');
    const observed=times.get(boat),row={boat_number:boat,registration_number:roster.registration,
      race_id:race.id,race_key:identity.key,race_date:identity.date,exhibition_time:observed.time,
      exhibition_st:start.value,exhibition_st_raw:start.value,exhibition_course:course};
    if(observed.tilt!=null)row.tilt=observed.tilt;
    rows.push(row);seen.add(boat);courses.add(course);
  }
  rows.sort((a,b)=>a.boat_number-b.boat_number);
  if(!buildCommittedExhibitionKey(race,rows))return fail('SOURCE_EXHIBITION_NOT_COMPLETE');
  return {ok:true,data:{entries:rows,real_exhibition_count:6,active_boat_count:6,scratched_boats:[]}};
}

/** Read only: returns a complete source pair or a reason; never writes entities. */
export async function fetchBoatcastExhibitionSource({race,entries,deadlineMs,timeoutMs=4000,fetcher=fetchBoatcastText,now=()=>Date.now()}){
  const identity=identify(race,entries);
  if(!identity)return fail('SOURCE_ROSTER_UNCONFIRMED');
  if((race.scratched_boats!=null&&(!Array.isArray(race.scratched_boats)||race.scratched_boats.length))
    ||entries.some(row=>row.is_absent||row.is_scratched))return fail('SCRATCHED_ROSTER_REQUIRES_OFFICIAL_SOURCE');
  const started=now(),deadline=Number.isFinite(deadlineMs)?deadlineMs:started+5000;
  if(!Number.isFinite(started)||deadline-started<=100)return fail('SOURCE_TIME_BUDGET');
  const requestTimeout=Math.min(4000,Number.isFinite(timeoutMs)?Math.max(1,timeoutMs):4000,deadline-started-100);
  const options={venueCode:identity.venueCode,raceDate:identity.date,raceNumber:identity.raceNumber,
    timeoutMs:requestTimeout,maxRetries:0,maxCacheAgeMs:60000};
  const results=await Promise.allSettled(['TKZ','STT'].map(dataType=>fetcher({...options,dataType})));
  const responses=[],failures=[];
  for(let index=0;index<results.length;index++){
    const result=results[index];
    if(result.status==='fulfilled'){responses[index]=result.value;continue;}
    const error=result.reason,status=Number(error?.response?.status??error?.status);
    if(bugs.has(error?.name))throw error;
    if(Number.isInteger(status)&&status>=400&&status<=599){failures.push(fail('SOURCE_HTTP_'+status,{http_status:status}));continue;}
    if(knownNetworkCodes.has(error?.code)||['AbortError','TimeoutError'].includes(error?.name)){failures.push(fail('SOURCE_TRANSPORT_UNAVAILABLE'));continue;}
    throw error;
  }
  if(failures.length)return failures[0];
  if(now()>deadline)return fail('SOURCE_TIME_BUDGET');
  const times=[],urls=[];
  for(let index=0;index<responses.length;index++){
    const response=responses[index],dataType=['TKZ','STT'][index];
    if(response?.ok!==true){
      const status=Number(response?.status??response?.metadata?.http_status);
      return fail(Number.isInteger(status)&&status>=400&&status<=599?'SOURCE_HTTP_'+status:'SOURCE_UNAVAILABLE',
        Number.isInteger(status)&&status>=400&&status<=599?{http_status:status}:{});
    }
    const meta=response.metadata,at=sourceTime(meta?.fetched_at);
    const expected=`https://race.boatcast.jp/hp_txt/${identity.venueCode}/bc_j_${dataType.toLowerCase()}_${identity.date.replace(/-/g,'')}_${identity.venueCode}_${String(identity.raceNumber).padStart(2,'0')}.txt`;
    if(meta?.source!=='BOATCAST'||meta?.http_status!==200||meta?.data_type!==dataType||meta?.race_date!==identity.date
      ||meta?.venue_code!==identity.venueCode||Number(meta?.race_number)!==identity.raceNumber||meta?.source_url!==expected)
      return fail('SOURCE_RACE_IDENTITY_MISMATCH');
    if(!Number.isFinite(at)||at>now()||now()-at>MAX_AGE_MS)return fail('SOURCE_TIME_UNCONFIRMED');
    times.push(at);urls.push(expected);
  }
  if(Math.abs(times[0]-times[1])>MAX_PAIR_SKEW_MS)return fail('SOURCE_PAIR_TIME_MISMATCH');
  const source={provider:'BOATCAST',url:urls[0],urls,captured_at:new Date(Math.max(...times)).toISOString(),
    oldest_captured_at:new Date(Math.min(...times)).toISOString(),cache:{TKZ:responses[0].metadata.cache,STT:responses[1].metadata.cache}};
  return {...parsePair(responses[0].text,responses[1].text,identity,race),source};
}
