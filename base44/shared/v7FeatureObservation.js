// V7 feature observation: pure, deterministic snapshot builder.
// No hindsight, no model weights, no synthetic qualifying ranks. Missing values remain null.
// Does NOT change predictions or current BUY logic.
import { selectV7RaceEntries } from "./v7RaceEntrySelector.js";

export const FEATURE_REVISION = "V7_FEATURE_OBSERVATION_1";
const utcMs = (value) => {
  const raw = String(value || "").trim().replace(/(\.\d{3})\d+/, "$1");
  if (!raw) return null;
  const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + "Z";
  const out = Date.parse(normalized);
  return Number.isFinite(out) ? out : null;
};
export { utcMs };

const numeric = (value) => {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const firstValue = (...values) => {
  for (const x of values) if (x !== "" && x != null) return x;
  return null;
};
const mean = (values) => values.length ? values.reduce((s,v)=>s+v,0)/values.length : null;
const round = (n) => n == null || !Number.isFinite(n) ? null : Math.round(n*10000)/10000;
const finishScore = {1:10,2:8,3:6,4:4,5:2,6:1};

function sectionForm(value) {
  if (typeof value !== "string" || !/^[1-6](?:[-, /]+[1-6])*$/.test(value.trim())) return null;
  const finishes=value.split(/[-, /]+/).map(Number);
  return {
    starts:finishes.length, points_mean:round(mean(finishes.map(n=>finishScore[n]))),
    last_three_points:round(mean(finishes.slice(-3).map(n=>finishScore[n]))),
    recent_1st:finishes.filter(n=>n===1).length,
    recent_top2:finishes.filter(n=>n<=2).length,
    recent_top3:finishes.filter(n=>n<=3).length,
    // NOT official qualification points; no penalties / event-specific schedule.
    estimated_only:true
  };
}

export function racePhase(race) {
  const phase=String(firstValue(race?.race_phase,race?.race_type,race?.program_role)||"");
  if (/準優/.test(phase)) return "SEMIFINAL";
  if (/優勝戦/.test(phase)) return "FINAL";
  if (/予選/.test(phase)) return "QUALIFYING";
  if (phase) return "OTHER";
  return "UNKNOWN";
}

function modelOf(race) {
  const title=String(race?.series_name||"");
  const womens=/女子|レディース|ヴィーナス/i.test(title);
  if (race?.is_womens===true) return "WOMENS";
  if (race?.is_womens===false && !womens) return "OPEN";
  return womens ? "WOMENS" : "UNKNOWN";
}
function boatSnapshot(entry) {
  const registration = String(firstValue(entry.register_number,entry.registration_number)||"");
  return {
    boat_number:Number(entry.boat_number),
    registration_number:registration||null,
    player_class:firstValue(entry.player_class,entry.grade_class),
    national_win_rate:numeric(entry.national_win_rate),
    national_2rate:numeric(entry.national_2rate),
    national_3rate:numeric(entry.national_3rate),
    local_win_rate:numeric(entry.local_win_rate),
    local_2rate:numeric(entry.local_2rate),
    local_3rate:numeric(entry.local_3rate),
    motor_number:firstValue(entry.motor_number),
    motor_2rate:numeric(entry.motor_f2_rate),
    motor_3rate:numeric(entry.motor_f3_rate),
    boat_2rate:numeric(entry.boat_f2_rate),
    boat_3rate:numeric(entry.boat_f3_rate),
    exhibition_time:numeric(entry.exhibition_time),
    exhibition_st:numeric(firstValue(entry.exhibition_st_raw,entry.exhibition_st)),
    exhibition_course:numeric(entry.exhibition_course),
    entry_course:numeric(entry.entry_course),
    section:sectionForm(entry.section_finishes),
    section_rank:numeric(entry.series_rank),
    qualifying_rank:numeric(entry.qualifying_rank),
    qualifying_point_rate:numeric(entry.qualifying_point_rate),
    qualifying_status:firstValue(entry.qualifying_status),
    qualifying_need_finish:firstValue(entry.qualifying_need_finish),
    qualifying_must_win:entry.qualifying_must_win===true ? true : entry.qualifying_must_win===false ? false : null,
    // This is the stored source observation time, not inferred "current" value.
    entry_updated_at:entry.updated_date || null,
  };
}

const scoreEdge=(boatrecs,key)=>{
  const sample=boatrecs.map(z=>z[key]).filter(x=>x!=null);
  const base=sample.length>=3?mean(sample):null;
  return {average:round(base),boats:boatrecs.map(z=>({
    boat_number:z.boat_number, value:z[key], edge:base==null||z[key]==null?null:round(z[key]-base)
  }))};
};

function oddsFor(keys, snapshot) {
  const map=snapshot?.odds_map??{};
  return Object.fromEntries(keys.filter(k=>Number.isFinite(Number(map[k]))&&Number(map[k])>0)
    .map(k=>[k,Number(map[k])]));
}
const COMBO=/^[1-6]-[1-6]-[1-6]$/;
function selectEight(prediction) {
  const tickets=prediction?.plans?.hit_8?.tickets;
  return Array.isArray(tickets)&&tickets.length===8&&new Set(tickets).size===8
    && tickets.every(t=>COMBO.test(t)&&new Set(t.split("-")).size===3)?tickets:[];
}

export function buildV7FeatureObservation({race,entries=[],odds=[],pre=null,final=null,stage,observedAt}) {
  const now=utcMs(observedAt);
  const deadline=utcMs(race?.deadline);
  if (!race?.id || !race?.race_key || now==null || deadline==null || now>=deadline-60000) {
    return {ok:false,reason:"invalid_race_or_late"};
  }
  if (!["PRE","FINAL","LOCK"].includes(stage)) return {ok:false,reason:"invalid_stage"};
  const prePred=pre && utcMs(pre.created_date)!=null && utcMs(pre.created_date)<=now ? pre:null;
  const finalPred=final && utcMs(final.created_date)!=null && utcMs(final.created_date)<=now ? final:null;
  const chosen=stage==="PRE" ? prePred : finalPred;
  const missing=[];
  const validEntries=entries.filter(e=>utcMs(e.updated_date || e.created_date)!=null && utcMs(e.updated_date || e.created_date)<=now);
  const result=selectV7RaceEntries(validEntries,race);
  if(result.reason)missing.push("ENTRIES_"+result.reason.toUpperCase());
  const boats=result.entries.map(boatSnapshot);
  const expectedFields=[
    "national_win_rate","national_2rate","national_3rate","motor_2rate","motor_3rate",
    "boat_2rate","boat_3rate","local_2rate","local_3rate"
  ];
  for(const field of expectedFields)if(boats.length!==6||boats.some(b=>b[field]==null))missing.push(field.toUpperCase()+"_INCOMPLETE");

  const type=racePhase(race),gender=modelOf(race);
  if(type==="UNKNOWN")missing.push("PHASE_UNKNOWN");
  if(gender==="UNKNOWN")missing.push("GENDER_UNKNOWN");
  const seriesDay=numeric(race.series_day);
  if(seriesDay==null)missing.push("SERIES_DAY_MISSING");
  if(boats.length!==6||boats.some(b=>b.qualifying_rank==null||b.qualifying_point_rate==null)) {
    missing.push("OFFICIAL_QUALIFYING_RANK_MISSING");
  }
  const weather={
    weather:race.weather || null,
    wind_dir:race.wind_dir||null,
    wind_speed:numeric(race.wind_speed),
    wave_height:numeric(race.wave_height),
    water_temp:numeric(race.water_temp),
    air_temp:numeric(race.air_temp),
  };
  const weatherComplete=!!weather.weather&&!!weather.wind_dir&&weather.wind_speed!=null;
  if(!weatherComplete)missing.push("WEATHER_OR_WIND_MISSING");
  if(!chosen)missing.push("PREDICTION_"+stage+"_NOT_YET_AVAILABLE");
  // Odds are allowed only if captured before this observation, before deadline,
  // and marked as their actual capture stage. No post-race "final odds" backfill.
  const histories=odds.filter(z=>z?.race_id===race.id &&
    ["EARLY","PRE","FINAL"].includes(z.stage) && utcMs(z.captured_at)!=null &&
    utcMs(z.captured_at)<=now && utcMs(z.captured_at)<deadline-60000
  ).sort((a,b)=>utcMs(a.captured_at)-utcMs(b.captured_at));
  const old=histories.find(z=>z.stage==="EARLY"||z.stage==="PRE")||histories[0]||null;
  const fresh=[...histories].reverse().find(z=>z.stage==="FINAL")||null;
  const current=stage==="PRE"?(old||fresh):(fresh||old);
  const tickets=selectEight(chosen);
  const earliestOdds=oddsFor(tickets,old);
  const latestOdds=oddsFor(tickets,current);
  const comparable=tickets.filter(k=>earliestOdds[k]!=null&&latestOdds[k]!=null);
  const changes=comparable.map(k=>({
    ticket:k,early:earliestOdds[k],later:latestOdds[k],
    change_pct:round(100*(latestOdds[k]-earliestOdds[k])/earliestOdds[k])
  }));
  const snapshotOdds={
    source_early_id:old?.id||null,source_early_at:old?.captured_at||null,
    source_latest_id:current?.id||null,source_latest_at:current?.captured_at||null,
    latest_stage:current?.stage||null,
    selected_tickets:tickets,
    old_quotes:earliestOdds,latest_quotes:latestOdds,changes,
    changed_ticket_count:changes.filter(x=>Math.abs(x.change_pct)>0.001).length,
    comparable_count:comparable.length,
    average_odds_change_pct:round(mean(changes.map(x=>x.change_pct))),
    minimum_selected_odds:tickets.length===8&&tickets.every(t=>latestOdds[t]!=null)
      ?round(Math.min(...tickets.map(t=>latestOdds[t]))):null,
    // Odds are not probabilities. The inverse-sum is a market-implied composite quote only.
    composite_odds:tickets.length===8&&tickets.every(t=>latestOdds[t]!=null)
      ?round(1/tickets.reduce((s,t)=>s+1/latestOdds[t],0)):null,
  };
  if(tickets.length===8&&Object.keys(latestOdds).length<8)missing.push("SELECTED_ODDS_INCOMPLETE");
  const topChanged=!!prePred&&!!finalPred&&prePred.top_combination&&finalPred.top_combination
    ?prePred.top_combination!==finalPred.top_combination:null;
  const signals={
    national_2rate:scoreEdge(boats,"national_2rate"),
    national_3rate:scoreEdge(boats,"national_3rate"),
    motor_2rate:scoreEdge(boats,"motor_2rate"),
    motor_3rate:scoreEdge(boats,"motor_3rate"),
    boat_2rate:scoreEdge(boats,"boat_2rate"),
    boat_3rate:scoreEdge(boats,"boat_3rate"),
    section_points:scoreEdge(boats.map(b=>({boat_number:b.boat_number, section_points:b.section?.points_mean??null})),"section_points"),
    qualifying_pressure:boats.filter(b=>b.qualifying_must_win===true).map(b=>b.boat_number),
    // Do not infer 4th/5th day status or cut line from section score alone.
    qualification_estimate:"NOT_AVAILABLE_WITHOUT_OFFICIAL_RANK_AND_RULES",
    wind_classification:"RAW_DIRECTION_ONLY",
    pre_top:prePred?.top_combination||null,final_top:finalPred?.top_combination||null,
    top_changed:topChanged,
  };
  return {
    ok:true,record:{
      snapshot_key:FEATURE_REVISION+":"+race.race_key+":"+stage,
      schema_version:FEATURE_REVISION,race_id:race.id,race_key:race.race_key,
      race_date:race.race_date,venue_code:String(race.venue_code??""),
      race_number:Number(race.race_number||0),snapshot_stage:stage,
      phase:type,series_day:seriesDay??undefined,
      race_type:race.race_type||undefined,series_name:race.series_name||undefined,
      gender_model:gender,observed_at:observedAt,deadline:race.deadline,
      prediction_id:chosen?.id||undefined,prediction_hash:chosen?.record_hash||undefined,
      prediction_stage:chosen?.stage||undefined,
      prediction_created_at:chosen?.created_date
        ?new Date(utcMs(chosen.created_date)).toISOString():undefined,
      current_judgment:chosen?.plans?.hit_8?.judgment||undefined,
      pre_top_combination:prePred?.top_combination||undefined,
      final_top_combination:finalPred?.top_combination||undefined,
      ...(topChanged!=null?{top_changed:topChanged}:{}),
      ...Object.fromEntries(Object.entries(weather).filter(([,value])=>value!=null)),
      weather_complete:weatherComplete,
      qualifying_rank_complete:boats.length===6&&boats.every(b=>b.qualifying_rank!=null&&b.qualifying_point_rate!=null),
      boats,market:snapshotOdds,signals,missing,
      provenance:{
        source:"BASE44_RACE_RACEENTRY_ODDSSNAPSHOT_PREDICTIONV7",
        captured_at:observedAt,
        entry_ids:result.entries.map(z=>z.id),latest_odds_id:current?.id||null,
        earliest_odds_id:old?.id||null,
        race_updated_at:race.updated_date||null,
        prediction_hash:chosen?.record_hash||null,
        data_after_observation_excluded:true,
      },
      status:missing.length?"PARTIAL":"CAPTURED",
    },
  };
}
