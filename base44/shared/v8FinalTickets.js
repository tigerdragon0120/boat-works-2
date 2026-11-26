// Rule-based final selection. Model comparison ranks are not calibrated
// probabilities or expected returns; prices never alter the ranking itself.
import {validateVenueProfile} from './v8VenueProfileSource.js';
import {roleAdjustedBoatScore} from './v8RacerParameters.js';

export const FINAL_SELECTION_REVISION='V8_FINAL_SELECTION_1';
export const VENUE_EVIDENCE_REVISION='V8_VENUE_EVIDENCE_1';
export const FINAL_BUY_POLICY_REVISION='V8_RULE_BUY_1';
export const VENUE_COMPARISON_WEIGHT=.15;
export const FINAL_SELECTION_SCORE_WINDOW=4;
const METHODS={ESCAPE:'逃げ',SASHI:'差し',MAKURI:'まくり',MAKURISASHI:'まくり差し'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const round=value=>finite(value)?Math.round(value*1000)/1000:null;
const clamp=value=>Math.max(0,Math.min(100,value));
const validBoat=value=>Number.isInteger(value)&&value>=1&&value<=6;
const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
const time=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;
  const text=value.replace(/(\.\d{3})\d+/,'$1');
  const at=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)?text:text+'Z');
  return Number.isFinite(at)?at:null;
};
const courseOf=(boat,stage,complete)=>stage==='FINAL'&&complete?boat.observed_course:boat.expected_course;
const mix=(score,prior)=>finite(score)&&finite(prior)?score*(1-VENUE_COMPARISON_WEIGHT)+prior*VENUE_COMPARISON_WEIGHT:score;
const hash=value=>{
  let out=2166136261;for(const char of JSON.stringify(value)){out^=char.charCodeAt(0);out=Math.imul(out,16777619);}
  return (out>>>0).toString(16).padStart(8,'0');
};
const validBaseline=(baseline,race,now)=>{
  const generated=time(baseline?.generated_at),created=time(baseline?.created_date),deadline=time(race?.deadline),at=time(now);
  return !!baseline?.id&&baseline.race_id===race?.id&&baseline.race_key===race?.race_key&&baseline.race_date===race?.race_date
    &&['PRE','DAY_BEFORE'].includes(baseline.stage)&&baseline.record_mode!=='REPLAY'
    &&generated!==null&&created!==null&&deadline!==null&&at!==null&&generated<=at&&created<=at
    &&generated<deadline-60000&&created<deadline-60000;
};

export function buildVenueEvidence({race,venueProfile=null,stage,now,baseline=null,replay=false,exhibitionComplete=false}={}){
  const current=replay?null:validateVenueProfile(venueProfile,{venueCode:race?.venue_code,raceDate:race?.race_date,asOf:now});
  const canReuse=!replay&&stage==='FINAL'&&validBaseline(baseline,race,now)
    &&baseline.venue_evidence?.revision===VENUE_EVIDENCE_REVISION;
  const previous=canReuse?validateVenueProfile(baseline.venue_evidence.profile,
    {venueCode:race?.venue_code,raceDate:race?.race_date,asOf:baseline.generated_at}):null;
  const profile=previous||current,basis=previous?'BASELINE_SNAPSHOT':current?'CURRENT_SNAPSHOT':'UNAVAILABLE';
  const first=profile?.courses?.['1']?.first_rate;
  const outer=Object.values(profile?.courses||{}).filter(row=>row.course!==1).map(row=>row.first_rate);
  const inside=finite(first)&&outer.length===5&&outer.every(finite)&&first>=50&&first-Math.max(...outer)>=20;
  const changed=!!(previous&&current&&(previous.snapshot_id!==current.snapshot_id||previous.content_hash!==current.content_hash));
  const note=stage!=='FINAL'?null:previous
    ?changed?'場の資料は更新されていますが、展示前後の比較には事前保存と同じ資料を使用しています。':'場の資料は事前保存と同じです。'
    :current?'事前保存に場の資料がないため、今回保存済みの資料を追加しています。資料追加と展示の変化を区別します。':null;
  return {revision:VENUE_EVIDENCE_REVISION,status:profile?'READY':'UNAVAILABLE',profile,source_basis:basis,
    baseline_id:previous?baseline.id:null,baseline_profile_reused:!!previous,current_profile_changed:changed,change_note:note,
    used:false,course_basis:'ACTUAL_ENTRY_COURSE',selection_course_basis:stage==='FINAL'&&exhibitionComplete?'EXHIBITION_CONFIRMED':'EXPECTED',
    inside_favored:inside,inside_first_rate:finite(first)?first:null,sample_size:null,sample_size_status:'NOT_PUBLISHED',
    score_type:'UNCALIBRATED_COMPARISON_RULE',weight:VENUE_COMPARISON_WEIGHT};
}

export function venueEvidenceKey(value){
  const profile=(value?.venue_evidence||value)?.profile;
  return profile?'VENUE_'+hash([profile.venue_code,profile.snapshot_id,profile.snapshot_key,profile.content_hash,profile.available_at]):'NO_VENUE';
}

/** Use the course first-place rate once, combined with its conditional method mix.
 * Winning-method percentages describe course winners, not all races. */
export function applyVenueToScenarios({scenarios=[],boats=[],venueEvidence,stage,exhibitionComplete=false}={}){
  return scenarios.map(scenario=>{
    const boat=boats.find(row=>row.boat_number===scenario.leader),course=boat?courseOf(boat,stage,exhibitionComplete):null;
    const row=venueEvidence?.profile?.courses?.[String(course)],first=row?.first_rate,methodRate=row?.winning_methods?.[METHODS[scenario.method]];
    const prior=finite(first)&&finite(methodRate)?first*methodRate/100:null;
    const updated=mix(scenario.score,prior),used=finite(prior);
    if(used)venueEvidence.used=true;
    return {...scenario,score:round(clamp(updated)),score_without_venue:scenario.score,
      venue_adjustment:round(updated-scenario.score),venue_prior_score:round(prior),
      venue_evidence:{used,snapshot_id:used?venueEvidence.profile.snapshot_id:null,course,first_rate:finite(first)?first:null,
        method:METHODS[scenario.method]||null,method_rate:finite(methodRate)?methodRate:null,method_basis:'AMONG_COURSE_WINNERS',
        prior_score:round(prior),weight:used?VENUE_COMPARISON_WEIGHT:0}};
  }).sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key));
}

function reverseSupport(boat,inside,stage,complete){
  if(!inside||boat.boat_number===inside.boat_number)return [];
  const out=[],mine=boat.racer_parameters,theirs=inside.racer_parameters;
  const historic=finite(mine?.adjusted?.first_rate)&&finite(theirs?.adjusted?.first_rate)
    &&mine.sample_size>=10&&theirs.sample_size>=10?mine.adjusted.first_rate-theirs.adjusted.first_rate:null;
  if(finite(historic)&&historic>=8)out.push({key:'HISTORICAL_COURSE_FIRST_EDGE',label:'今回コースの長期1着実績が内艇を上回る',value:round(historic),threshold:8,unit:'POINTS'});
  if(stage==='FINAL'&&complete){
    const validStart=row=>finite(row.exhibition_st)&&row.exhibition_st>=0&&!row.exhibition_flying&&!row.exhibition_late;
    const start=validStart(boat)&&validStart(inside)?inside.exhibition_st-boat.exhibition_st:null;
    if(finite(start)&&start>=.04-1e-9)out.push({key:'EXHIBITION_START_EDGE',label:'内艇との展示ST差を確認（本番STではない）',value:round(start),threshold:.04,unit:'SECONDS'});
    const sum=finite(boat.sum_speed_score)&&finite(inside.sum_speed_score)?boat.sum_speed_score-inside.sum_speed_score:null;
    const speed=finite(boat.exhibition_time)&&finite(inside.exhibition_time)?inside.exhibition_time-boat.exhibition_time:null;
    if(finite(sum)&&sum>=15)out.push({key:'EXHIBITION_SPEED_EDGE',label:'展示の足評価が内艇を上回る',value:round(sum),threshold:15,unit:'SCORE_POINTS'});
    else if(finite(speed)&&speed>=.06-1e-9)out.push({key:'EXHIBITION_SPEED_EDGE',label:'内艇より展示タイムが速い',value:round(speed),threshold:.06,unit:'SECONDS'});
  }
  return out;
}

export function buildFinalTicketSelection({boats=[],scenarios=[],venueEvidence,stage,exhibitionComplete=false,replay=false}={}){
  const out={revision:FINAL_SELECTION_REVISION,status:replay?'REPLAY':'WAIT',stage,rank_label:'モデル推定順位',
    score_type:'UNCALIBRATED_TICKET_SCORE',probability_calibrated:false,tickets:[],ticket_count:0,ranked_tickets:[],
    candidate_count:0,eligible_candidate_count:0,selection_reason:'買い目を組み立てるための入力を待っています',selection_code:'INPUTS_INCOMPLETE',
    nearby_candidate_count:0,head_boats:[],role_evidence:[],gate_checks:[],
    venue_evidence:{status:venueEvidence?.status||'UNAVAILABLE',source_basis:venueEvidence?.source_basis||'UNAVAILABLE',
      snapshot_id:venueEvidence?.profile?.snapshot_id||null,inside_favored:venueEvidence?.inside_favored===true,
      inside_first_rate:venueEvidence?.inside_first_rate??null,course_basis:'ACTUAL_ENTRY_COURSE'},
    odds:{},odds_snapshot_id:null,odds_captured_at:null,composite_odds:null,price_checked:false,valid_until:null,
    policy_revision:FINAL_BUY_POLICY_REVISION,research_only:true,
    policy:{min_tickets:6,max_tickets:12,score_window:FINAL_SELECTION_SCORE_WINDOW,max_head_boats:2,nearby_head_score_window:3,
      reverse_min_support:2,inside_min_first_rate:50,inside_min_course_margin:20,history_min_course_starts:10,
      historical_first_rate_edge:8,exhibition_st_edge_seconds:.04,exhibition_time_edge_seconds:.06,exhibition_sum_score_edge:15,
      venue_weight:VENUE_COMPARISON_WEIGHT,odds_max_age_ms:300000,cutoff_ms:60000,composite_odds_min_exclusive:1}};
  if(replay)return out;
  const active=boats.filter(row=>row.active!==false&&!row.is_absent&&!row.is_scratched);
  if(active.length!==6||new Set(active.map(row=>row.boat_number)).size!==6
    ||active.some(row=>!validBoat(row.boat_number)||!finite(row.score)||!validBoat(courseOf(row,stage,exhibitionComplete)))
    ||new Set(active.map(row=>courseOf(row,stage,exhibitionComplete))).size!==6||!scenarios.length
    ||scenarios.some(row=>!validBoat(row.leader)||!finite(row.score)||row.score<0||row.score>100
      ||!METHODS[row.method]||row.key!==row.leader+'_'+row.method))return out;
  const byHead=new Map();for(const scenario of scenarios)if(!byHead.has(scenario.leader))byHead.set(scenario.leader,scenario);
  if(active.some(row=>!byHead.has(row.boat_number)))return out;
  const ordered=[...active].sort((a,b)=>courseOf(a,stage,exhibitionComplete)-courseOf(b,stage,exhibitionComplete));
  const inside=ordered[0],insideFavored=venueEvidence?.inside_favored===true;
  const strong=[...active].sort((a,b)=>b.score-a.score).slice(0,3).map(row=>row.boat_number);
  const roles=active.map(boat=>{
    const course=courseOf(boat,stage,exhibitionComplete),prior=venueEvidence?.profile?.courses?.[String(course)];
    const support=reverseSupport(boat,inside,stage,exhibitionComplete);
    const eligible=!insideFavored||boat.boat_number===inside.boat_number||support.length>=2;
    const role=insideFavored&&boat.boat_number===inside.boat_number?'INSIDE_AXIS':eligible?'WIN_CANDIDATE'
      :strong.includes(boat.boat_number)?'FOLLOWER_FOCUS':'SUPPORT_CANDIDATE';
    const second=mix(roleAdjustedBoatScore(boat,2),prior?.second_rate),third=mix(roleAdjustedBoatScore(boat,3),prior?.third_rate);
    const reasons=role==='INSIDE_AXIS'?['この場の1コース優位と今回の内側進入を1着側で評価']
      :!eligible?['外艇の強さは2・3着側で評価。逆転頭に必要な複数の裏付けは未成立']
        :support.length>=2?support.map(item=>item.label):['選手・展示・場の今回コース実績から1着候補を比較'];
    return {boat_number:boat.boat_number,course,base_score:boat.base_score,first_score:byHead.get(boat.boat_number).score,
      second_score:round(second),third_score:round(third),role,win_eligible:eligible,reverse_support:support,reasons,
      venue_first_rate:prior?.first_rate??null,venue_second_rate:prior?.second_rate??null,venue_third_rate:prior?.third_rate??null,
      venue_method_rate:byHead.get(boat.boat_number).venue_evidence?.method_rate??null,
      venue_first_used:byHead.get(boat.boat_number).venue_evidence?.used===true};
  });
  out.role_evidence=roles;
  const roleByBoat=new Map(roles.map(row=>[row.boat_number,row])),candidates=[];
  for(const first of active)for(const second of active)for(const third of active){
    if(new Set([first.boat_number,second.boat_number,third.boat_number]).size!==3)continue;
    out.candidate_count++;
    const a=roleByBoat.get(first.boat_number),b=roleByBoat.get(second.boat_number),c=roleByBoat.get(third.boat_number);
    if(!a.win_eligible)continue;
    const scenario=byHead.get(first.boat_number),benefit=scenario.beneficiaries?.includes(second.boat_number)?2:0;
    const score=a.first_score*.58+b.second_score*.27+c.third_score*.15+benefit;
    candidates.push({ticket:[first.boat_number,second.boat_number,third.boat_number].join('-'),score:round(score),
      scenario_key:scenario.key,method:scenario.method,components:{first:a.first_score,second:b.second_score,third:c.third_score,following_support:benefit},
      reasons:[a.reasons[0],second.boat_number+'号艇を2着、'+third.boat_number+'号艇を3着側の評価で組み合わせ']});
  }
  candidates.sort((a,b)=>b.score-a.score||a.ticket.localeCompare(b.ticket));
  out.eligible_candidate_count=candidates.length;
  if(candidates.length<6)return out;
  const nearby=candidates.filter(row=>row.score>=candidates[0].score-FINAL_SELECTION_SCORE_WINDOW).length;
  const count=Math.min(12,Math.max(6,nearby));
  out.ranked_tickets=candidates.slice(0,count).map((row,index)=>({...row,rank:index+1}));
  out.tickets=out.ranked_tickets.map(row=>row.ticket);out.ticket_count=count;
  out.nearby_candidate_count=nearby;out.head_boats=[...new Set(out.tickets.map(ticket=>Number(ticket[0])))];
  out.status='WATCH';out.selection_code=nearby>12?'TOO_MANY_NEARBY':nearby<=6?'TIGHT_TOP_SET':'NEARBY_CONTENDERS';
  out.selection_reason=nearby>12?'近い評価の組合せが12点を超えるため、上位12点を候補として保留'
    :nearby<=6?'上位の候補を6点にまとめ、順位順に保存':nearby+'点が上位評価の範囲に入り、順位順に保存';
  const eligibleRoles=roles.filter(row=>row.win_eligible).sort((a,b)=>b.first_score-a.first_score);
  out.nearby_head_count=eligibleRoles.filter(row=>row.first_score>=eligibleRoles[0].first_score-3).length;
  out.unsupported_top_hypothesis=roleByBoat.get(scenarios[0]?.leader)?.win_eligible===false;
  return out;
}

const validTicket=ticket=>typeof ticket==='string'&&/^[1-6]-[1-6]-[1-6]$/.test(ticket)&&new Set(ticket.split('-')).size===3;
export function validFinalTickets(tickets){
  return Array.isArray(tickets)&&tickets.length>=6&&tickets.length<=12&&new Set(tickets).size===tickets.length&&tickets.every(validTicket);
}

// New PRE records already distinguish the leading scenario from the heads in
// the final candidate set. Compare the saved candidate set, validating its
// redundant head metadata against the actual tickets; only legacy records
// without that selection may fall back to their leading scenario.
function baselineHeadEvidence(baseline){
  const plan=baseline?.final_selection;
  if(plan!=null){
    if(plan.revision!==FINAL_SELECTION_REVISION||plan.stage!==baseline.stage||!validFinalTickets(plan.tickets))
      return {basis:'INVALID_FINAL_SELECTION',heads:[]};
    const heads=[...new Set(plan.tickets.map(ticket=>Number(ticket.split('-')[0])))].sort((a,b)=>a-b);
    if(!Array.isArray(plan.head_boats)||plan.head_boats.length!==heads.length||!plan.head_boats.every(validBoat)
      ||new Set(plan.head_boats).size!==heads.length||!heads.every(number=>plan.head_boats.includes(number)))
      return {basis:'INVALID_FINAL_SELECTION',heads:[]};
    return {basis:'SAVED_FINAL_SELECTION',heads};
  }
  const version=Number(/^V8_FORECAST_(\d+)(?:_|$)/.exec(baseline?.revision||'')?.[1]);
  if(version>=6)return {basis:'INVALID_FINAL_SELECTION',heads:[]};
  const head=Number(String(baseline?.top_scenario_key||'').split('_')[0]);
  return {basis:'LEGACY_TOP_SCENARIO',heads:validBoat(head)?[head]:[]};
}

/** BUY means this explicit selection rule passed, not proven positive EV. */
export function decideFinalSelection({race,stage,now,baseline,comparison,complete,odds,meaningful,boats=[],selection,replay=false}={}){
  const out={status:replay?'REPLAY':'WAIT',reasons:[],tickets:validFinalTickets(selection?.tickets)?[...selection.tickets]:[],odds:{},
    source_prediction_id:null,source_judgment:null,price_checked:false,valid_until:null,score_type:'UNCALIBRATED_TICKET_SCORE',
    research_only:true,strategy:FINAL_BUY_POLICY_REVISION,policy_revision:FINAL_BUY_POLICY_REVISION,
    probability_calibrated:false,expected_value_used:false,price_rule:'COMPLETE_FRESH_QUOTES_AND_COMPOSITE_ABOVE_ONE'};
  const gates=[],gate=(key,label,passed,detail,blocking=false)=>gates.push({key,label,passed:!!passed,status:passed?'PASS':blocking?'BLOCK':'HOLD',detail});
  const at=typeof now==='number'?now:time(now),deadline=time(race?.deadline);
  const valid=meaningful&&validFinalTickets(out.tickets);
  gate('INPUTS','選抜に必要な評価',valid,valid?'6〜12点の順位付き候補を保存':'評価項目または買い目が不足');
  gate('FINAL','展示後の判断',stage==='FINAL'&&!replay,replay?'事後再構成はBUY対象外':stage==='FINAL'?'展示後の評価':'展示取得後に判断');
  gate('EXHIBITION','6艇の展示整合',complete,complete?'進入・ST・展示タイムの対応を確認':'展示の未取得または対応の不整合');
  const before=validBaseline(baseline,race,typeof now==='number'?new Date(now).toISOString():now);
  gate('BASELINE','締切前の事前根拠',before,before?'同一レースの保存済み事前予想と比較':'有効な事前予想がない');
  gate('IDENTITY','出走選手の対応',before&&comparison?.entrant_changed!==true,before&&comparison?.entrant_changed!==true?'事前と展示後の選手対応が一致':'比較する選手対応を確認できない');
  const venue=selection?.venue_evidence?.status==='READY'&&selection?.venue_evidence?.snapshot_id;
  const roles=selection?.role_evidence||[],roleMap=new Map(roles.map(row=>[row.boat_number,row]));
  const venueComplete=!!venue&&out.tickets.length>0&&out.tickets.every(ticket=>{
    const [a,b,c]=ticket.split('-').map(Number);
    return roleMap.get(a)?.venue_first_used===true&&finite(roleMap.get(a)?.venue_first_rate)
      &&finite(roleMap.get(b)?.venue_second_rate)&&finite(roleMap.get(c)?.venue_third_rate);
  });
  gate('VENUE','場のコース別根拠',venueComplete,venueComplete?'保存済みの場別1・2・3着実績を限定的に参照':'場の資料が未取得または必要な着順別値が欠測');
  const caution=boats.some(boat=>boat.exhibition_flying||boat.exhibition_late||finite(boat.exhibition_st)&&boat.exhibition_st<0);
  gate('EXHIBITION_CAUTION','展示F/Lの注意',!caution,caution?'展示F/Lがあるため判断保留。本番のF/Lとは区別':'展示F/Lによる注意なし');
  const axis=selection?.head_boats?.length>0&&selection.head_boats.length<=2&&selection.nearby_head_count<=2&&!selection.unsupported_top_hypothesis;
  gate('AXIS','1着軸の絞り込み',axis,axis?'根拠のある1着候補が2艇以内':'1着候補が混在、または外頭の逆転根拠が不足');
  const tight=selection?.nearby_candidate_count>0&&selection.nearby_candidate_count<=12;
  gate('CONCENTRATION','相手の絞り込み',tight,tight?'近い評価の組合せが12点以内':'12点を超える近接候補があり、点数追加では解決しない');
  const baselineHeads=baselineHeadEvidence(baseline);
  const aligned=before&&baselineHeads.heads.length>0&&selection?.head_boats?.length>0
    &&selection.head_boats.every(number=>baselineHeads.heads.includes(number)||(roles.find(row=>row.boat_number===number)?.reverse_support?.length||0)>=2);
  gate('PRE_COMPARISON','事前からの変化の裏付け',aligned,aligned?'事前の軸を維持、または逆転の複数根拠を記録'
    :baselineHeads.basis==='INVALID_FINAL_SELECTION'?'事前の保存候補と1着軸の対応を確認できない':'事前の軸から変わった理由の裏付けが不足');
  Object.assign(gates[gates.length-1],{baseline_basis:baselineHeads.basis,baseline_head_boats:baselineHeads.heads});
  const cutoff=at!==null&&deadline!==null&&at<deadline-60000&&!['finished','cancelled'].includes(race?.status);
  gate('CUTOFF','締切までの有効時間',cutoff,cutoff?'締切1分前より前':'締切またはレース終了',true);
  const quoteAt=time(odds?.captured_at),storedAt=time(odds?.created_date);
  const quoteValid=stage==='FINAL'&&!replay&&odds?.id&&odds.race_id===race?.id&&quoteAt!==null&&storedAt!==null
    &&quoteAt<=at&&storedAt<=at&&quoteAt<deadline-60000&&storedAt<deadline-60000&&at-quoteAt<300000;
  const quotes=quoteValid?Object.fromEntries(out.tickets.map(ticket=>{
    const raw=odds.odds_map?.[ticket],n=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):null;
    return [ticket,finite(n)&&n>=1&&n<=1000000?n:null];
  })):{};
  const allQuotes=!!quoteValid&&out.tickets.length>0&&Object.values(quotes).every(finite);
  const composite=allQuotes?1/Object.values(quotes).reduce((total,value)=>total+1/value,0):null;
  gate('ODDS','全点のオッズと鮮度',allQuotes,allQuotes?'同じ保存時点の全点オッズを確認':'全点の有効な5分以内のオッズが揃っていない');
  gate('COMPOSITE','組合せの合成オッズ',finite(composite)&&composite>1,finite(composite)?'払戻額をそろえる配分の参考倍率 '+composite.toFixed(2)+'倍':'合成オッズを計算できない',allQuotes&&composite<=1);
  if(allQuotes){
    out.odds=quotes;out.odds_snapshot_id=odds.id;out.odds_captured_at=odds.captured_at;out.price_checked=true;
    out.composite_odds=round(composite);out.valid_until=new Date(Math.min(deadline-60000,quoteAt+300000)).toISOString();
  }
  if(replay){out.status='REPLAY';out.tickets=[];out.reasons=['事後再構成は最終BUYの対象外です'];}
  else if(!valid||stage==='FINAL'&&!complete)out.status='WAIT';
  else if(stage!=='FINAL')out.status='WATCH';
  else if(gates.some(row=>row.status==='BLOCK'))out.status='SKIP';
  else if(gates.every(row=>row.passed))out.status='BUY';
  else out.status='WATCH';
  if(!out.reasons.length)out.reasons=out.status==='BUY'
    ?['事前・展示・場の根拠と選抜条件が一致した'+out.tickets.length+'点をBUYとして保存','モデルの比較順位による選抜です。的中確率や期待収益の校正値ではありません']
    :gates.filter(row=>!row.passed).map(row=>row.detail);
  if(selection){
    Object.assign(selection,{status:out.status,gate_checks:gates,odds:clone(out.odds),odds_snapshot_id:out.odds_snapshot_id||null,
      odds_captured_at:out.odds_captured_at||null,composite_odds:out.composite_odds??null,price_checked:out.price_checked,
      valid_until:out.valid_until,reasons:[...out.reasons]});
  }
  return out;
}
