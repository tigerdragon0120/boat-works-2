// Shared read/selection rules for V8. No late records or silent truncated ledgers.
import {fetchAllPaged} from './pagedFetch.js';
import {utcMs} from './v7FeatureObservation.js';

export const jstDate = (offset=0, now=Date.now()) => new Date(now+offset*86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
export const dateValid = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export async function readV8Rows(entity,query,{budget=Date.now()+25000,maxPages=40,sort='-created_date'}={}) {
  // Match the deployed cursor contract used by existing successful collectors.
  // Arrays and incomplete pages are never interpreted as a complete ledger.
  const page=await fetchAllPaged((q,options)=>entity.filter(q,options),query,
    {pageSize:200,maxPages,sort,deadlineMs:budget});
  if(!page.complete)throw new Error('INCOMPLETE_READ:'+String(page.error||'unknown'));
  return page.rows;
}
export function groupBy(rows,key) {
  const map=new Map();
  for(const row of rows||[]){const value=typeof key==='function'?key(row):row?.[key];if(value==null)continue;const group=map.get(value)||[];group.push(row);map.set(value,group);}
  return map;
}
export const chronological=(a,b)=>(utcMs(a.generated_at||a.recorded_at)||0)-(utcMs(b.generated_at||b.recorded_at)||0)||(utcMs(a.created_date)||0)-(utcMs(b.created_date)||0)||String(a.id).localeCompare(String(b.id));
export function eligibleForecast(row,now=Date.now()){
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
export function latestForecasts(rows){
  const out=new Map();
  for(const row of [...rows].sort(chronological))out.set(row.race_key+':'+row.stage,row);
  return [...out.values()];
}
export function firstBuyForecasts(rows){
  const out=new Map();
  for(const row of [...rows].sort(chronological))if(row.stage==='FINAL'&&row.decision?.status==='BUY'&&!out.has(row.race_key))out.set(row.race_key,row);
  return [...out.values()];
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
