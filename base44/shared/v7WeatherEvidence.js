// Official weather parser: only explicit textual values and their own displayed timestamp.
// Never translate "most recent race weather" into this race's measured conditions.
const num = x => x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const directions = ["北北東","東北東","東南東","南南東","南南西","西南西","西北西","北北西","北東","南東","南西","北西","北","南","東","西"];
const textFromHtml=html=>String(html||"")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style[^>]*>[\s\S]*?<\/style>/gi," ")
  .replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/\s+/g," ").trim();
export function parseWeatherEvidence(html,kind,raceDate){
  if(!["PRE_REFERENCE","RESULT_ACTUAL"].includes(kind))return {ok:false,reason:"BAD_KIND"};
  const raw=textFromHtml(html);
  // Official page uses icon CSS classes instead of written compass directions.
  // Keep the raw code; do not assign an unverified compass bearing.
  const weatherBlock=String(html||'').match(/<div\s+class=["']weather1["'][\s\S]{0,3500}/i)?.[0]||'';
  const iconRaw=weatherBlock.match(/is-windDirection[\s\S]{0,220}?is-wind(\d{1,2})\b/i)?.[1]||null;
  const iconValue=iconRaw!=null?Number(iconRaw):null;
  const windIconCode=Number.isInteger(iconValue)&&iconValue>=1&&iconValue<=16?iconValue:null;
  const refRace=raw.match(/水面気象情報\s*(\d{1,2})\s*R時点/)?.[1]||null;
  // Weather is read only from the explicit weather block, not unrelated weather text in ads.
  const head=raw.indexOf("水面気象情報");
  let text=head>=0?raw.slice(head,head+750):"";
  if(kind==="RESULT_ACTUAL"&&!text){
    const candidates=[raw.indexOf("水面気象"),raw.indexOf("気象状況")].filter(n=>n>=0);
    if(candidates.length)text=raw.slice(Math.min(...candidates),Math.min(...candidates)+650);
  }
  if(!text)return {ok:false,reason:"WEATHER_SECTION_NOT_FOUND"};
  const speed=num(text.match(/風速\s*([\d.]+)\s*m/i)?.[1]);
  const wave=num(text.match(/波高\s*([\d.]+)\s*cm/i)?.[1]);
  const water=num(text.match(/水温\s*([\d.]+)\s*℃/)?.[1]);
  const air=num(text.match(/気温\s*([\d.]+)\s*℃/)?.[1]);
  const weatherRaw=text.match(/(?:天候\s*)?(晴(?:れ)?|曇(?:り)?|雨|雪|霧)/)?.[1]||null;
  const weather=weatherRaw==="晴"?"晴れ":weatherRaw==="曇"?"曇り":weatherRaw;
  // Direction must be explicit in text. Icon image names alone are never decoded by guessing.
  const directionPattern=directions.join("|");
  const match=text.match(new RegExp("風向\\s*("+directionPattern+")(?=\\s|の風|$)"))||
    text.match(new RegExp("("+directionPattern+")の風"));
  const windDir=match?.[1]||null;
  const t=text.match(/([01]?\d|2[0-3]):([0-5]\d)\s*現在/);
  let displayedAt=null;
  if(t&&/^\d{4}-\d{2}-\d{2}$/.test(raceDate)){
    const dateTime=new Date(raceDate+"T"+String(t[1]).padStart(2,"0")+":"+t[2]+":00+09:00");
    if(Number.isFinite(dateTime.getTime())) displayedAt=dateTime.toISOString();
  }
  const missing=[];
  if(speed==null)missing.push("WIND_SPEED_MISSING");
  if(!windDir)missing.push("WIND_DIRECTION_MISSING");
  if(!displayedAt&&kind==="PRE_REFERENCE")missing.push("DISPLAYED_TIME_MISSING");
  if(!weather)missing.push("WEATHER_MISSING");
  return {ok:true,wind_speed:speed,wind_dir:windDir,wind_icon_code:windIconCode,
    reference_race_number:refRace!=null?Number(refRace):null,weather,wave_height:wave,
    water_temp:water,air_temp:air,source_display_time:displayedAt,missing};
}
export function weatherBucket(speed){
  if(speed==null||!Number.isFinite(Number(speed)))return null;
  return speed<3?"0-2m":speed<5?"3-4m":speed<8?"5-7m":"8m+";
}
export function weatherObservation({race,kind,parsed,observedAt,resultTrifecta=null,sourceUrl=""}){
  const deadline=Date.parse(String(race?.deadline||""));
  const observed=Date.parse(observedAt);
  if(!parsed?.ok||!Number.isFinite(deadline)||!Number.isFinite(observed)||!race?.id||!race.race_key)return null;
  const before=kind==="PRE_REFERENCE";
  if(before&&observed>=deadline-60000)return null;
  if(!before&&observed<=deadline)return null;
  const display=parsed.source_display_time?Date.parse(parsed.source_display_time):null;
  const age=display!=null?Math.round((observed-display)/60000):null;
  const stale=before&&(age==null||age<0||age>60);
  const hasWind=parsed.wind_speed!=null&&(parsed.wind_dir!=null||parsed.wind_icon_code!=null);
  const quality=hasWind&&!stale?"COMPLETE":"PARTIAL";
  const result= !before&&/^[1-6]-[1-6]-[1-6]$/.test(String(resultTrifecta||""))?resultTrifecta:null;
  return {
    observation_key:kind+":"+race.race_key+(before?":"+(deadline-observed>10*60000?"EARLY":"LATE"):""),
    race_id:race.id,race_key:race.race_key,race_date:race.race_date,
    venue_code:String(race.venue_code||""),race_number:Number(race.race_number||0),
    kind,source_page:sourceUrl,observed_at:observedAt,
    ...(parsed.source_display_time?{source_display_time:parsed.source_display_time}:{}),
    deadline:race.deadline,weather:parsed.weather||undefined,wind_dir:parsed.wind_dir||undefined,
    wind_icon_code:parsed.wind_icon_code??undefined,
    reference_race_number:parsed.reference_race_number??undefined,
    wind_speed:parsed.wind_speed??undefined,wave_height:parsed.wave_height??undefined,
    water_temp:parsed.water_temp??undefined,air_temp:parsed.air_temp??undefined,
    source_scope:before?"LATEST_AVAILABLE_RACE_REFERENCE":"RESULT_PAGE_OWN_RACE",
    ...(age!=null?{source_age_minutes:age}:{}),quality,
    missing:[...parsed.missing,...(stale?["REFERENCE_TIMESTAMP_UNVERIFIED_OR_STALE"]:[])],
    ...(result?{first_boat_win:result.startsWith("1-"),result_trifecta:result}:{}),
    provenance:{read_time:observedAt,official_url:sourceUrl,kind,
      result_attested:!!result,estimates_used:false,wind_class:"NOT_MAPPED",
      wind_raw_icon:parsed.wind_icon_code??null,reference_race_number:parsed.reference_race_number??null}
  };
}
