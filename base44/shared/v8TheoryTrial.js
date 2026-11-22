// V8 theory research: prospective, independent of current BUY and PredictionV7.
// The "exhibition relative" model is NOT 舟券太郎氏のSUM/シンSUM公式式.
// All scores are uncalibrated ranking heuristics, NOT hit probabilities.
import {utcMs} from './v7FeatureObservation.js';
export const THEORY_REVISION='V8_THEORY_1';
const patterns={
 UICHI_MAIN:['1-2-5','1-2-6','1-3-5','1-3-6','1-4-5','1-4-6'],
 UICHI_URA:['1-5-2','1-5-3','1-5-4','1-6-2','1-6-3','1-6-4'],
 UICHI_NEW_MAIN:['1-3-2','1-4-2','1-5-2','1-6-2'],
 UICHI_NEW_URA:['2-1-3','2-1-4','2-1-5','2-1-6']
};
const round=x=>Math.round(x*10000)/10000;
const valid=k=>/^[1-6]-[1-6]-[1-6]$/.test(String(k))&&new Set(k.split('-')).size===3;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const scale=(arr,reverse=false)=>{
 if(arr.some(x=>!finite(x)))return null;
 const min=Math.min(...arr),max=Math.max(...arr);
 return arr.map(v=>min===max?0.5:reverse?(max-v)/(max-min):(v-min)/(max-min));
};
function scoreBoats(boats,fields){
 const scores=boats.map(()=>0),weights=boats.map(()=>0),used=[];
 for(const [path,weight,reverse] of fields){
  const vals=boats.map(b=>path.split('.').reduce((v,k)=>v?.[k],b));
  const scaled=scale(vals,reverse);
  if(!scaled)continue;
  for(let i=0;i<6;i++){scores[i]+=weight*scaled[i];weights[i]+=weight;}
  used.push(path);
 }
 return {scores:scores.map((v,i)=>weights[i]>0?round(v/weights[i]):null),used};
}
function rankCombos(boats,boatScores){
 const byBoat=Object.fromEntries(boats.map((b,i)=>[b.boat_number,boatScores[i]]));
 const list=[];
 for(let a=1;a<=6;a++)for(let b=1;b<=6;b++)for(let c=1;c<=6;c++){
  if(a===b||a===c||b===c)continue;
  const s=[byBoat[a],byBoat[b],byBoat[c]];
  if(s.some(x=>x==null))continue;
  list.push({combination:`${a}-${b}-${c}`,score:round(.50*s[0]+.31*s[1]+.19*s[2])});
 }
 list.sort((x,y)=>y.score-x.score||x.combination.localeCompare(y.combination));
 return list;
}
const fields=[
 ['national_2rate',.15,false],['national_3rate',.10,false],
 ['local_2rate',.08,false],['motor_2rate',.16,false],
 ['motor_3rate',.08,false],['boat_2rate',.10,false],
 ['section.last_three_points',.15,false],['exhibition_time',.11,true],
 ['exhibition_st',.07,true]
];
function uichiScores(boats,features){
 const rows=rankCombos(boats,features.scores);
 const comboScore=Object.fromEntries(rows.map(r=>[r.combination,r.score]));
 return Object.entries(patterns).map(([key,tickets])=>{
  const validTickets=tickets.every(valid);
  const available=validTickets&&tickets.every(t=>finite(comboScore[t]));
  const score=available?round(tickets.reduce((s,t)=>s+comboScore[t],0)/tickets.length):null;
  return {key,logic:'UICHI_STRUCTURE',label:{
   UICHI_MAIN:'ういち基本型 1-234-56',UICHI_URA:'裏ういち型 1-56-234',
   UICHI_NEW_MAIN:'新ういち型 1-3456-2',UICHI_NEW_URA:'新裏ういち型 2-1-3456'
  }[key],tickets,score,status:available?'READY':'INSUFFICIENT',
   score_type:'UNCALIBRATED_COMPATIBILITY',basis:features.used};
 });
}
function exhibition(boats){
 // Source-verified one-lap time is not in this snapshot, so this is NOT SUM.
 const scored=scoreBoats(boats,[
  ['exhibition_time',.37,true],['exhibition_st',.20,true],
  ['motor_2rate',.20,false],['motor_3rate',.08,false],
  ['section.last_three_points',.15,false]
 ]);
 const adequate=scored.used.includes('exhibition_time')&&
   scored.used.includes('exhibition_st')&&scored.used.length>=3;
 const candidates=adequate?rankCombos(boats,scored.scores):[];
 return {key:'EXHIBITION_RELATIVE',logic:'TARO_PUBLIC_IDEA_INSPIRED',
  label:'舟券太郎参考・展示/スタート相対評価（独自式）',
  status:adequate?'READY':'INSUFFICIENT',tickets:candidates.slice(0,8).map(r=>r.combination),
  top:candidates[0]?.combination||null,score:candidates[0]?.score??null,
  score_type:'UNCALIBRATED_RANKING',basis:scored.used,
  missing:adequate?[]:['ONE_LAP_TIME_OR_EXHIBITION_MISSING'],
  note:'SUM・シンSUM・スリットアラート等の本人公式計算式は未再現'};
}
export function buildTheoryTrial(snapshot,nowText){
 const now=utcMs(nowText),deadline=utcMs(snapshot?.deadline);
 const sourceAt=utcMs(snapshot?.created_date),observedAt=utcMs(snapshot?.observed_at);
 if(!snapshot?.id||!snapshot?.race_id||!snapshot?.race_key||
   !['PRE','FINAL','LOCK'].includes(snapshot.snapshot_stage)||
   !['OPEN','WOMENS'].includes(snapshot.gender_model)||now==null||deadline==null||
   sourceAt==null||observedAt==null||now>=deadline-90000||
   sourceAt>=deadline-60000||observedAt>=deadline-60000||
   sourceAt>now||observedAt>now)return {ok:false,reason:'INVALID_OR_LATE'};
 const boats=[...(snapshot.boats||[])].sort((a,b)=>a.boat_number-b.boat_number);
 if(boats.length!==6||boats.some((b,i)=>b.boat_number!==i+1))return {ok:false,reason:'INVALID_BOATS'};
 const all=scoreBoats(boats,fields);
 const uichi=uichiScores(boats,all);
 const ex=exhibition(boats);
 // Independent all-factor comparator; deliberately no historical results enter this call.
 const f=rankCombos(boats,all.scores);
 const own={key:'V8_ALL_FACTOR',logic:'OWN_MULTIFACTOR',label:'V8独自・選手/モーター/節間統合',
   status:all.used.length>=5?'READY':'INSUFFICIENT',
   tickets:all.used.length>=5?f.slice(0,8).map(x=>x.combination):[],
   top:all.used.length>=5?f[0]?.combination:null,
   score:all.used.length>=5?f[0]?.score:null,
   score_type:'UNCALIBRATED_RANKING',basis:all.used};
 const models=[...uichi,ex,own];
 const baseline=snapshot.market?.selected_tickets;
 const baselineTickets=Array.isArray(baseline)&&baseline.length===8&&baseline.every(valid)?baseline:[];
 return {ok:true,record:{
  trial_key:THEORY_REVISION+':'+snapshot.race_key+':'+snapshot.snapshot_stage,
  revision:THEORY_REVISION,race_key:snapshot.race_key,race_id:snapshot.race_id,
  race_date:snapshot.race_date,venue_code:snapshot.venue_code,
  race_number:snapshot.race_number,stage:snapshot.snapshot_stage,
  gender_model:snapshot.gender_model,phase:snapshot.phase||'UNKNOWN',
  snapshot_key:snapshot.snapshot_key,snapshot_id:snapshot.id,
  source_created_at:snapshot.created_date,generated_at:nowText,
  deadline:snapshot.deadline,models,
  baseline_top:snapshot.snapshot_stage==='PRE'?snapshot.pre_top_combination:snapshot.final_top_combination,
  baseline_tickets:baselineTickets,
  status:models.some(m=>m.status==='READY')?'RESEARCH_READY':'INSUFFICIENT',
  missing:[...new Set(models.flatMap(x=>x.missing||[]))],
  provenance:{source:'V7FeatureSnapshot',no_post_deadline_inputs:true,
   original_v7_unchanged:true,no_buy_action:true,model_weights:'HYPOTHESIS_UNTRAINED',
   taro_official_formula_reproduced:false,odds_used_for_judgment:false}
 }};
}
