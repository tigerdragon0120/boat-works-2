// V7+：多因子研究モデル。ソースは締切前に封印済みのV7FeatureSnapshotのみ。
// 未校正の順位スコアであり、勝率・的中確率・BUY推奨として扱わない。
// 既存V7の予想/買い目/判定は一切変更しない。
import {utcMs} from "./v7FeatureObservation.js";

export const FACTOR_REVISION="V7_FACTOR_CANDIDATE_1";
const features={
  national_win_rate:"national_win_rate",national_2rate:"national_2rate",national_3rate:"national_3rate",
  local_2rate:"local_2rate",local_3rate:"local_3rate",
  motor_2rate:"motor_2rate",motor_3rate:"motor_3rate",
  boat_2rate:"boat_2rate",boat_3rate:"boat_3rate",
  section:"section.last_three_points",exhibition_time:"exhibition_time",
  exhibition_st:"exhibition_st",qualifying_rank:"qualifying_rank"
};
// Heuristic coefficients are hypotheses for prospective comparison, not trained effects.
// Different matrices ensure women's races are evaluated independently of men's heuristics.
const OPEN={
  PRE:{national_win_rate:0.13,national_2rate:0.11,national_3rate:0.10,local_2rate:0.06,local_3rate:0.05,motor_2rate:0.18,motor_3rate:0.08,boat_2rate:0.07,boat_3rate:0.04,section:0.12,qualifying_rank:0.06},
  FINAL:{national_win_rate:0.08,national_2rate:0.08,national_3rate:0.07,local_2rate:0.04,local_3rate:0.04,motor_2rate:0.14,motor_3rate:0.06,boat_2rate:0.05,boat_3rate:0.04,section:0.09,exhibition_time:0.15,exhibition_st:0.12,qualifying_rank:0.04}
};
const WOMENS={
  PRE:{national_win_rate:0.11,national_2rate:0.09,national_3rate:0.10,local_2rate:0.06,local_3rate:0.06,motor_2rate:0.12,motor_3rate:0.06,boat_2rate:0.05,boat_3rate:0.04,section:0.23,qualifying_rank:0.08},
  FINAL:{national_win_rate:0.06,national_2rate:0.06,national_3rate:0.07,local_2rate:0.04,local_3rate:0.05,motor_2rate:0.09,motor_3rate:0.05,boat_2rate:0.04,boat_3rate:0.04,section:0.17,exhibition_time:0.20,exhibition_st:0.13,qualifying_rank:0.10}
};
const round=n=>Number.isFinite(n)?Math.round(n*10000)/10000:null;
const valueAt=(row,path)=>path.split(".").reduce((v,k)=>v?.[k],row);
const good=(value)=>typeof value==="number"&&Number.isFinite(value);
const validCombo=key=>/^[1-6]-[1-6]-[1-6]$/.test(String(key))&&new Set(key.split("-")).size===3;
const sorted=(arr,score)=>[...arr].sort((a,b)=>score(b)-score(a)||a.boat_number-b.boat_number);

function normalizedFeature(boats,key){
  const path=features[key];
  const values=boats.map(b=>valueAt(b,path));
  // Official qualifying rank is ONLY applicable when all 6 entries have an official rank.
  if(values.some(v=>!good(v)))return null;
  const lo=Math.min(...values),hi=Math.max(...values);
  if(lo===hi)return boats.map(()=>0.5);
  return values.map(v=>{
    const position=(v-lo)/(hi-lo);
    // lower ST/ exhibition time / official ranking is better.
    return ["exhibition_time","exhibition_st","qualifying_rank"].includes(key)?1-position:position;
  });
}

export function factorWeights(model,stage,phase,seriesDay){
  const matrix=model==="WOMENS"?WOMENS:OPEN;
  const base={...(stage==="PRE"?matrix.PRE:matrix.FINAL)};
  // Phase-conditional heuristics: use official qualifying positions only when present.
  if(phase==="SEMIFINAL"||phase==="FINAL"){
    base.section=(base.section||0)*1.25;
    base.motor_2rate=(base.motor_2rate||0)*1.2;
  }
  if(phase==="QUALIFYING"&&seriesDay===4){
    base.section=(base.section||0)*1.35;
    base.qualifying_rank=(base.qualifying_rank||0)*1.3;
  }
  if(phase==="QUALIFYING"&&seriesDay===5){
    base.qualifying_rank=(base.qualifying_rank||0)*1.5;
  }
  return base;
}

function combosFor(boats,scores){
  const byBoat=new Map(boats.map((b,i)=>[b.boat_number,scores[i]]));
  const combos=[];
  // Relative rankings only. No claim of calibrated probabilities.
  for(const a of boats)for(const b of boats)for(const c of boats){
    if(a.boat_number===b.boat_number||b.boat_number===c.boat_number||a.boat_number===c.boat_number)continue;
    const sa=byBoat.get(a.boat_number),sb=byBoat.get(b.boat_number),sc=byBoat.get(c.boat_number);
    const course=a.exhibition_course||a.boat_number;
    const coursePrior=course===1?0.035:course===2?0.012:0;
    const score=0.52*sa+0.30*sb+0.18*sc+coursePrior;
    combos.push({combination:`${a.boat_number}-${b.boat_number}-${c.boat_number}`,score:round(score)});
  }
  combos.sort((a,b)=>b.score-a.score||a.combination.localeCompare(b.combination));
  return combos;
}

export function buildFactorCandidate(snapshot,recordedAt){
  const now=utcMs(recordedAt),deadline=utcMs(snapshot?.deadline),observed=utcMs(snapshot?.observed_at),created=utcMs(snapshot?.created_date);
  if(!snapshot?.id||!snapshot?.race_key||!["PRE","FINAL","LOCK"].includes(snapshot.snapshot_stage)||
    !["OPEN","WOMENS"].includes(snapshot.gender_model)||!Array.isArray(snapshot.boats)||
    snapshot.boats.length!==6||now==null||observed==null||created==null||deadline==null||
    now>=deadline-60000||created>=deadline-60000||observed>=deadline-60000)
    return {ok:false,reason:"INVALID_OR_LATE_SNAPSHOT"};
  const stage=snapshot.snapshot_stage;
  const model=snapshot.gender_model;
  const boats=[...snapshot.boats].sort((a,b)=>a.boat_number-b.boat_number);
  if(new Set(boats.map(b=>b.boat_number)).size!==6||boats.some(b=>!Number.isInteger(b.boat_number)||b.boat_number<1||b.boat_number>6))
    return {ok:false,reason:"INVALID_BOATS"};
  const weights=factorWeights(model,stage,snapshot.phase,snapshot.series_day);
  const normalized=new Map();
  for(const key of Object.keys(weights)){
    if(key==="qualifying_rank"&&snapshot.qualifying_rank_complete!==true)continue;
    if(["exhibition_time","exhibition_st"].includes(key)&&stage==="PRE")continue;
    const perBoat=normalizedFeature(boats,key);
    if(perBoat)normalized.set(key,perBoat);
  }
  const observedFeatures=[...normalized.keys()];
  const missing=Object.keys(weights).filter(key=>!normalized.has(key));
  const usedWeights=Object.fromEntries(observedFeatures.map(k=>[k,weights[k]]));
  const divisor=Object.values(usedWeights).reduce((a,b)=>a+b,0);
  const boatFactors=boats.map((b,i)=>{
    const contributions=Object.fromEntries(observedFeatures.map(k=>[k,round(normalized.get(k)[i]*weights[k])]));
    const score=divisor?Object.values(contributions).reduce((a,b)=>a+b,0)/divisor:null;
    return {boat_number:b.boat_number,score:round(score),contributions,source:{
      motor_2rate:b.motor_2rate??null,motor_3rate:b.motor_3rate??null,
      section_points:b.section?.last_three_points??null,qualifying_rank:b.qualifying_rank??null,
      exhibition_time:b.exhibition_time??null,exhibition_st:b.exhibition_st??null
    }};
  });
  const adequate=observedFeatures.length>=5&&divisor>=0.35;
  const rankings=adequate?combosFor(boats,boatFactors.map(b=>b.score)):[];
  const tickets=rankings.slice(0,8).map(r=>r.combination);
  const baseTop=stage==="PRE"?snapshot.pre_top_combination:snapshot.final_top_combination;
  const baseTickets=Array.isArray(snapshot.market?.selected_tickets)?
    snapshot.market.selected_tickets.filter(validCombo).slice(0,8):[];
  // Weather and wind are recorded for future venue-specific calibration, not assigned arbitrary strength.
  // Guessing qualifying pressure from 4th/5th day or static "win" rates is forbidden.
  return {ok:true,record:{
    candidate_key:FACTOR_REVISION+":"+snapshot.race_key+":"+stage,revision:FACTOR_REVISION,
    race_id:snapshot.race_id,race_key:snapshot.race_key,race_date:snapshot.race_date,
    venue_code:snapshot.venue_code,race_number:snapshot.race_number,stage,model,phase:snapshot.phase,
    source_snapshot_id:snapshot.id,source_snapshot_key:snapshot.snapshot_key,
    source_observed_at:snapshot.observed_at,deadline:snapshot.deadline,decided_at:recordedAt,
    baseline_prediction_hash:snapshot.prediction_hash||undefined,
    baseline_top:baseTop||undefined,factor_top:rankings[0]?.combination||undefined,
    baseline_tickets:baseTickets,factor_tickets:tickets,
    rankings:rankings.slice(0,12),boat_factors:boatFactors,weights:usedWeights,observed_features:observedFeatures,
    missing:[...missing,...(snapshot.missing||[]).filter(s=>/WEATHER|QUALIFYING|SERIES_DAY/.test(s))],
    diff_from_baseline:!!baseTop&&!!rankings[0]&&baseTop!==rankings[0].combination,
    confidence_label:adequate?"未校正・順位のみ":"不足・判定不可",
    buy_judgment:"RESEARCH_ONLY",status:adequate?"CANDIDATE":"INSUFFICIENT",
    provenance:{
      source:"V7FeatureSnapshot",source_created_date:snapshot.created_date,
      data_after_observation_excluded:true,wind_effect:"NOT_CALIBRATED",venue_effect:"NOT_CALIBRATED",
      qualifying_rule:"OFFICIAL_RANK_REQUIRED",weights:"HEURISTIC_UNTRAINED"
    }
  }};
}
