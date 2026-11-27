// Shared read/selection rules for V8. No late records or silent truncated ledgers.
import {fetchAllPaged} from './pagedFetch.js';
import {utcMs} from './v7FeatureObservation.js';

// Reuse ICU's formatter: verification checks dates for every immutable row,
// and constructing thousands of identical formatters retains substantial memory.
const jstDateFormatter = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'});
export const jstDate = (offset=0, now=Date.now()) => {
  const date=new Date(now+offset*86400000);
  return Number.isFinite(date.getTime())?jstDateFormatter.format(date):'Invalid Date';
};
export const dateValid = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const READ_PAGE_TIMEOUT_MS=10000;
const retryBackoff=[200,500];
const readHttpStatus=error=>{
  const raw=error?.response?.status??error?.http_status??error?.status??error?.statusCode;
  const status=typeof raw==='number'?raw:typeof raw==='string'&&/^\d{3}$/.test(raw)?Number(raw):null;
  return Number.isInteger(status)&&status>=100&&status<=599?status:null;
};
const transientReadError=(error,status)=>status!=null?status===429||(status>=500&&status<=599):
  ['ERR_NETWORK','ECONNRESET','ECONNABORTED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error?.code)
  ||/network|connection|timed?\s*out|timeout|fetch failed|failed to fetch|socket|\bdns\b/i.test(String(error?.message||''));
const retryAfterMs=error=>{
  const headers=error?.response?.headers??error?.headers;
  let value=null;
  try{value=typeof headers?.get==='function'?headers.get('retry-after'):headers?.['retry-after']??headers?.['Retry-After'];}catch{}
  if(typeof value==='number')return Number.isFinite(value)&&value>=0?value*1000:null;
  if(typeof value!=='string'||!value.trim())return null;
  if(/^\d+(?:\.\d+)?$/.test(value.trim()))return Number(value)*1000;
  const at=Date.parse(value);
  return Number.isFinite(at)?Math.max(0,at-Date.now()):null;
};
export async function readV8Rows(entity,query,{budget=Date.now()+25000,maxPages=40,sort='-created_date',fields}={}) {
  // Match the deployed cursor contract used by existing successful collectors.
  // Arrays and incomplete pages are never interpreted as a complete ledger.
  let stopped=false,lastHttpStatus=null,lastTransient=false,retryBudgetExhausted=false;
  const fetchPage=async(q,options)=>{
    lastTransient=false;
    const pageDeadline=Math.min(budget,Date.now()+READ_PAGE_TIMEOUT_MS);
    for(let attempt=0;attempt<3;attempt++){
      if(stopped||Date.now()>=pageDeadline){retryBudgetExhausted=true;throw new Error('READ_RETRY_BUDGET');}
      lastHttpStatus=null;lastTransient=false;
      try{
        const result=await entity.filter(q,{...options,...(fields==null?{}:{fields})});
        if(stopped||Date.now()>=pageDeadline){retryBudgetExhausted=true;throw new Error('READ_RETRY_BUDGET');}
        // Only the paging helper validates response shapes, IDs and continuations.
        // A malformed successful response must not be retried or masked.
        return result;
      }catch(error){
        lastHttpStatus=readHttpStatus(error);
        lastTransient=transientReadError(error,lastHttpStatus);
        if(stopped||attempt===2||!lastTransient)throw new Error('READ_ATTEMPT_FAILED');
        const delay=Math.max(retryBackoff[attempt],retryAfterMs(error)??0);
        if(!Number.isFinite(delay)||Date.now()+delay>=pageDeadline){retryBudgetExhausted=true;throw new Error('READ_RETRY_BUDGET');}
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
    throw new Error('READ_ATTEMPT_FAILED');
  };
  const page=await fetchAllPaged(fetchPage,query,
    {pageSize:200,maxPages,sort,deadlineMs:budget,pageTimeoutMs:READ_PAGE_TIMEOUT_MS});
  stopped=true;
  if(!page.complete){
    const failure=retryBudgetExhausted?'retry_budget_exhausted':String(page.error||'unknown');
    const error=new Error('INCOMPLETE_READ:'+failure);
    if(lastHttpStatus!=null)error.http_status=lastHttpStatus;
    // A caller may defer an individual race after a confirmed transport failure.
    // Never carry an earlier recovered transport error into malformed page data.
    error.retryable_read=lastTransient&&['page_read_failed_or_timed_out','retry_budget_exhausted'].includes(failure);
    throw error;
  }
  return page.rows;
}
export function groupBy(rows,key) {
  const map=new Map();
  for(const row of rows||[]){const value=typeof key==='function'?key(row):row?.[key];if(value==null)continue;const group=map.get(value)||[];group.push(row);map.set(value,group);}
  return map;
}
export const chronological=(a,b)=>(utcMs(a.generated_at||a.recorded_at)||0)-(utcMs(b.generated_at||b.recorded_at)||0)||(utcMs(a.created_date)||0)-(utcMs(b.created_date)||0)||String(a.id).localeCompare(String(b.id));
export function eligibleForecast(row,now=Date.now()){
  if(row?.record_mode!=null&&row.record_mode!=='LIVE')return false;
  const deadline=utcMs(row?.deadline),created=utcMs(row?.created_date),generated=utcMs(row?.generated_at);
  if(!row?.id||!row?.race_id||!row?.race_key||!dateValid(row.race_date)||!['DAY_BEFORE','PRE','FINAL'].includes(row.stage)||deadline==null||created==null||generated==null||created>now||generated>now||created<generated||created>=deadline-60000||generated>=deadline-60000)return false;
  const offset=row.stage==='DAY_BEFORE'?1:0;
  return jstDate(offset,generated)===row.race_date&&jstDate(offset,created)===row.race_date;
}
// Ambiguous logical keys are held, never picked by their eventual result.
export function canonicalForecasts(rows,now=Date.now()){
  const valid=[],conflicts=[];
  for(const [key,group] of groupBy(rows,'forecast_key')){
    if(!key||group.length!==1){conflicts.push(key);continue;}
    if(eligibleForecast(group[0],now))valid.push(group[0]);
  }
  return {rows:valid,conflicts};
}
// A saved partial hypothesis is history, not a completed exhibition stage.
export const isCompleteFinalForecast=row=>row?.stage==='FINAL'&&row.exhibition_complete===true
  &&Array.isArray(row.research_tickets)&&row.research_tickets.length>0;
export function latestForecasts(rows){
  const out=new Map();
  for(const row of [...rows].sort(chronological))out.set(row.race_key+':'+row.stage,row);
  return [...out.values()];
}
export function firstBuyForecasts(rows){
  const out=new Map();
  for(const row of [...rows].sort(chronological))if((row.record_mode==null||row.record_mode==='LIVE')&&row.stage==='FINAL'&&row.decision?.status==='BUY'&&!out.has(row.race_key))out.set(row.race_key,row);
  return [...out.values()];
}
// Retrospective research is a separate ledger. Real observation/save times are
// retained, and no reconstructed row can become a published BUY.
export function eligibleReplayForecast(row,now=Date.now()){
  if(row?.record_mode!=='REPLAY'||!row.id||!row.race_id||!row.race_key||!dateValid(row.race_date)||!['PRE','FINAL'].includes(row.stage))return false;
  const deadline=utcMs(row.deadline),generated=utcMs(row.generated_at),created=utcMs(row.created_date),input=utcMs(row.input_as_of);
  if(deadline==null||generated==null||created==null||generated<deadline||created<generated||generated>now||created>now||jstDate(0,deadline)!==row.race_date)return false;
  if(row.input_as_of!=null&&(input==null||input>generated))return false;
  if(row.provenance?.result_excluded!==true||row.provenance?.reconstruction!==true||row.provenance?.input_fields_whitelisted!==true||row.decision?.status==='BUY')return false;
  if(row.stage==='FINAL'&&row.exhibition_complete!==true)return false;
  return true;
}
export function canonicalReplayForecasts(rows,now=Date.now()){
  const valid=[],conflicts=[];
  for(const [key,group] of groupBy((rows||[]).filter(row=>row.record_mode==='REPLAY'),'forecast_key')){
    if(!key||group.length!==1){conflicts.push(key);continue;}
    if(eligibleReplayForecast(group[0],now))valid.push(group[0]);
  }
  return {rows:valid,conflicts};
}
// One row per race keeps acquisition, prediction and settlement gaps visible.
// Consumers choose the live stage when present and a replay only as its fallback.
export function buildRaceProgress({races,forecasts=[],replayForecasts=[],verifications=[],replayVerifications=[],results=[],now=Date.now()}){
  const liveAll=canonicalForecasts(forecasts,now).rows,replayAll=canonicalReplayForecasts(replayForecasts,now).rows;
  const completedStages=rows=>rows.filter(row=>row.stage!=='FINAL'||isCompleteFinalForecast(row));
  const live=latestForecasts(completedStages(liveAll)),replay=latestForecasts(completedStages(replayAll)),byId=new Map([...liveAll,...replayAll].map(row=>[row.id,row]));
  const liveByRace=groupBy(live,'race_id'),replayByRace=groupBy(replay,'race_id'),resultsByRace=groupBy(results,'race_id');
  const verified=new Map();
  const uniqueVerifications=[...groupBy([...verifications,...replayVerifications],'verification_key').values()].filter(group=>group.length===1).map(group=>group[0]);
  for(const [key,group] of groupBy(uniqueVerifications,row=>row.source_kind+':'+row.forecast_id))if(group.length===1&&['SETTLED','EXCLUDED_REFUND'].includes(group[0].status))verified.set(key,group[0]);
  const rows=(races||[]).map(race=>{
    const matchesRace=row=>row.race_id===race.id&&row.race_key===race.race_key&&utcMs(row.deadline)===utcMs(race.deadline);
    const liveRows=(liveByRace.get(race.id)||[]).filter(matchesRace),replays=(replayByRace.get(race.id)||[]).filter(matchesRace);
    const byStage=(rows,stage)=>rows.find(row=>row.stage===stage);
    const final=byStage(liveRows,'FINAL')||byStage(replays,'FINAL')||null;
    const linkedCandidate=byId.get(final?.comparison?.baseline_id),linked=linkedCandidate&&matchesRace(linkedCandidate)&&['DAY_BEFORE','PRE'].includes(linkedCandidate.stage)?linkedCandidate:null;
    const pre=(linked&&linked.record_mode!=='REPLAY'?linked:null)||byStage(liveRows,'DAY_BEFORE')||byStage(liveRows,'PRE')||linked||byStage(replays,'PRE')||null;
    const stageInfo=row=>row?{state:'SAVED',record_mode:row.record_mode==='REPLAY'?'REPLAY':'LIVE',forecast_id:row.id,stage:row.stage}:{state:'PENDING',record_mode:null,forecast_id:null};
    const settlement=row=>{if(!row)return null;const item=verified.get((row.record_mode==='REPLAY'?'REPLAY':'FORECAST')+':'+row.id);return item?.race_id===race.id&&item?.race_key===race.race_key?item:null;};
    const before=settlement(pre),after=settlement(final),complete=!!before&&!!after;
    const exhibition=race.exhibition_ready===true||final?.exhibition_complete===true;
    const resultAvailable=(resultsByRace.get(race.id)||[]).some(row=>row.is_finished===true||row.result_status==='RESULT_FINAL');
    const missing=[];
    if(!pre)missing.push('PRE_MISSING');
    if(!exhibition)missing.push('EXHIBITION_MISSING');
    if(!final)missing.push('FINAL_MISSING');
    if(!before)missing.push('PRE_VERIFICATION_MISSING');
    if(!after)missing.push('FINAL_VERIFICATION_MISSING');
    const status=race.status==='cancelled'?'CANCELLED':complete?(before.status==='EXCLUDED_REFUND'||after.status==='EXCLUDED_REFUND'?'RESULT_EXCLUDED':'VERIFIED'):!pre?'PRE_PENDING':!exhibition?'EXHIBITION_PENDING':!final?'FINAL_PENDING':resultAvailable?'VERIFICATION_PENDING':'RESULT_PENDING';
    return {race_id:race.id,race_key:race.race_key,status,pre:stageInfo(pre),exhibition:{state:exhibition?'READY':'PENDING'},final:stageInfo(final),verification:{state:complete?'COMPLETE':before||after?'PARTIAL':'PENDING',pre_settled:!!before,final_settled:!!after,pre_status:before?.status||null,final_status:after?.status||null},missing:status==='CANCELLED'?[]:missing};
  });
  const active=rows.filter(row=>row.status!=='CANCELLED');
  return {rows,coverage:{
    expected_races:rows.length,pre_available_count:active.filter(row=>row.pre.state==='SAVED').length,
    final_available_count:active.filter(row=>row.final.state==='SAVED').length,exhibition_ready_count:active.filter(row=>row.exhibition.state==='READY').length,
    verified_races:rows.filter(row=>row.status==='VERIFIED').length,excluded_races:rows.filter(row=>row.status==='RESULT_EXCLUDED').length,cancelled_races:rows.length-active.length,
    fully_completed_races:active.filter(row=>row.verification.state==='COMPLETE').length,pending_races:rows.filter(row=>!['VERIFIED','RESULT_EXCLUDED','CANCELLED'].includes(row.status)).length,
    replay_pre_count:active.filter(row=>row.pre.record_mode==='REPLAY').length,replay_final_count:active.filter(row=>row.final.record_mode==='REPLAY').length,
    pending_pre_count:active.filter(row=>row.pre.state!=='SAVED').length,pending_exhibition_count:active.filter(row=>row.exhibition.state!=='READY').length,
    pending_final_count:active.filter(row=>row.final.state!=='SAVED').length,pending_verification_count:active.filter(row=>row.verification.state!=='COMPLETE').length,
  }};
}
export function currentDecision(row,race,now=Date.now()){
  if(!row||!eligibleForecast(row,now))return 'WAIT';
  if(race&&(row.race_id!==race.id||row.race_key!==race.race_key||utcMs(row.deadline)!==utcMs(race.deadline)))return 'WAIT';
  const deadline=utcMs(race?.deadline||row.deadline);
  if(deadline==null||now>=deadline-60000||['finished','cancelled'].includes(race?.status))return 'CLOSED';
  // Preserve a valid pre-race candidate for the UI's exhibition-waiting state.
  // A malformed pre-race BUY can never bypass the FINAL-only price checks.
  if(row.stage!=='FINAL')return ['WATCH','SKIP'].includes(row.decision?.status)?row.decision.status:'WAIT';
  if(row.decision?.status!=='BUY')return row.decision?.status||'WAIT';
  const validUntil=utcMs(row.decision.valid_until),priceAt=utcMs(row.decision.odds_captured_at);
  return validUntil!=null&&priceAt!=null&&priceAt<=now&&now<validUntil&&now-priceAt<300000?'BUY':'WAIT';
}
export function publicRow(row){
  if(!row)return row;
  const {created_by,created_by_id,recorded_by_id,...safe}=row;
  return safe;
}
