// V8 immutable research evidence. Confirmed result + weather + per-racer finish.
// Never infer actual course from boat number. Historical odds/tide are never fabricated.
import {utcMs,racePhase} from "./v7FeatureObservation.js";
export const V8_EVIDENCE_VERSION="V8_EVIDENCE_1";
const tri=/^[1-6]-[1-6]-[1-6]$/;
const reg=x=>String(x?.registration_number||x?.register_number||"").trim();
const validRank=n=>Number.isInteger(n)&&n>=1&&n<=6;
const validMethod=new Set(["逃げ","差し","まくり","まくり差し","抜き","恵まれ"]);
const num=x=>x==null||x===""?null:Number.isFinite(Number(x))?Number(x):null;
const uniq=rows=>new Set(rows.map(x=>x)).size===rows.length;
export function buildV8Evidence({race,resultRows=[],entries=[],histories=[],weatherRows=[],now}){
  const captured=utcMs(now);
  if(!race?.id||!race?.race_key||captured==null||captured<=utcMs(race.deadline))return {ok:false,reason:"NOT_FINISHED"};
  const finals=(resultRows||[]).filter(r=>r.race_id===race.id&&
    (r.result_status==="RESULT_FINAL"||r.is_finished===true)&&tri.test(String(r.result_trifecta||""))&&
    uniq(String(r.result_trifecta).split("-")));
  const results=new Set(finals.map(r=>String(r.result_trifecta)));
  if(results.size!==1)return {ok:false,reason:"RESULT_MISSING_OR_CONFLICT"};
  const result=finals.find(r=>r.result_trifecta===[...results][0]);
  const resultAt=utcMs(result.finished_at);
  if(resultAt==null||resultAt<=utcMs(race.deadline)||resultAt>captured)return {ok:false,reason:"RESULT_TIME_INVALID"};
  const boats=String(result.result_trifecta).split("-").map(Number);
  const missing=[];
  const uniqueEntries=new Map();
  for(const e of entries||[]){
    if(e.race_id!==race.id||!validRank(Number(e.boat_number)))continue;
    const n=Number(e.boat_number);
    const old=uniqueEntries.get(n);
    if(old&&reg(old)&&reg(e)&&reg(old)!==reg(e))return {ok:false,reason:"ENTRY_IDENTITY_CONFLICT"};
    if(!old||String(e.updated_date||"")>String(old.updated_date||""))uniqueEntries.set(n,e);
  }
  if(uniqueEntries.size!==6)missing.push("ENTRY_INCOMPLETE");
  const histByReg=new Map();
  for(const h of histories||[]){
    const key=reg(h);
    if(!key||h.race_date!==race.race_date||String(h.venue_code).padStart(2,"0")!==String(race.venue_code).padStart(2,"0")||Number(h.race_number)!==Number(race.race_number))continue;
    if(histByReg.has(key))return {ok:false,reason:"HISTORY_DUPLICATE"};
    histByReg.set(key,h);
  }
  const outcomeByBoat=new Map(boats.map((n,i)=>[n,i+1]));
  const boatResults=[];
  for(let n=1;n<=6;n++){
    const e=uniqueEntries.get(n);
    const h=e?histByReg.get(reg(e)):null;
    const rank=num(h?.finish_order);
    const expected=outcomeByBoat.get(n);
    if(rank!=null&&expected!=null&&rank!==expected)return {ok:false,reason:"FINISH_CONFLICT"};
    const winner=boats[0]===n;
    const method=winner&&validMethod.has(String(h?.winning_method||""))?h.winning_method:null;
    boatResults.push({boat_number:n,registration_number:e?reg(e):null,
      finish:expected??(validRank(rank)?rank:null),
      finish_source:expected?"TRIFECTA":validRank(rank)?"RACER_HISTORY":"UNKNOWN",
      win:winner,top2:boats.slice(0,2).includes(n),top3:boats.includes(n),
      winning_method:method,
      reported_course:validRank(Number(h?.course))?Number(h.course):null,
      course_verified:false,course_source:"UNVERIFIED_HISTORY",
      entry_known:!!e,history_known:!!h});
  }
  const top3ByHist=boatResults.filter(z=>z.finish!=null).length;
  if(top3ByHist<6)missing.push("FINISH_4_6_MISSING");
  const winner=boatResults.find(z=>z.win);
  const winningMethod=winner?.winning_method||(validMethod.has(String(result.winning_method||""))?result.winning_method:null);
  if(!winningMethod)missing.push("WINNING_METHOD_MISSING");
  const eligibleWeather=(weatherRows||[]).filter(w=>w.kind==="RESULT_ACTUAL"&&w.race_id===race.id&&
    w.result_trifecta===result.result_trifecta&&w.quality==="COMPLETE"&&
    utcMs(w.created_date)!=null&&utcMs(w.created_date)<=captured);
  const wind=eligibleWeather.length===1?eligibleWeather[0]:null;
  if(!wind)missing.push(eligibleWeather.length>1?"WEATHER_DUPLICATE":"RACE_WEATHER_MISSING");
  if(!wind?.wind_icon_code&&!wind?.wind_dir)missing.push("WIND_DIRECTION_MISSING");
  missing.push("TIDE_NOT_COLLECTED");
  const model=race.is_womens===true?"WOMENS":/(女子|レディース|ヴィーナス)/i.test(String(race.series_name||""))?"WOMENS":"OPEN";
  return {ok:true,record:{
    evidence_key:V8_EVIDENCE_VERSION+":"+race.race_key,
    race_key:race.race_key,race_id:race.id,race_date:race.race_date,
    venue_code:String(race.venue_code).padStart(2,"0"),race_number:Number(race.race_number),
    model,phase:racePhase(race),result_trifecta:result.result_trifecta,winner_boat:boats[0],
    winner_register:winner?.registration_number||undefined,winning_method:winningMethod||undefined,
    result_finished_at:new Date(resultAt).toISOString(),captured_at:now,
    weather_observation_id:wind?.id||undefined,weather_quality:wind?.quality||"MISSING",
    wind_icon_code:num(wind?.wind_icon_code)??undefined,wind_dir:wind?.wind_dir||undefined,
    wind_speed:num(wind?.wind_speed)??undefined,weather:wind?.weather||undefined,
    wave_height:num(wind?.wave_height)??undefined,
    boat_results:boatResults,data_quality:missing.length?"PARTIAL":"COMPLETE",
    missing,source:{result_id:result.id,weather_id:wind?.id||null,
      provenance:"RACE_RESULT_AND_RACER_HISTORY",course_provenance:"NOT_VERIFIED",
      no_future_data_for_prediction:true}
  }};
}
