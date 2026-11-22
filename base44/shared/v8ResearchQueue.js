// Keep unfinished dates until every race reaches a terminal verification state.
import {dateValid,groupBy} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

// Discover only dates with actual Race records. Registration is additive: an
// unfinished older date stays in the durable queue after this window moves on.
export function researchWindowDates(today,requestedDate=null){
  if(!dateValid(today)||requestedDate&&(!dateValid(requestedDate)||requestedDate>today))throw new Error('INVALID_RESEARCH_DATE');
  const midnight=Date.parse(today+'T00:00:00Z');
  return [...new Set([...Array.from({length:7},(_,index)=>new Date(midnight-index*86400000).toISOString().slice(0,10)),...(requestedDate?[requestedDate]:[])])];
}
export function researchBootstrapDates(races,queue,today,requestedDate=null){
  const allowed=new Set(researchWindowDates(today,requestedDate));
  const existing=new Set((queue||[]).map(row=>row.race_date));
  const present=new Set((races||[]).map(row=>row.race_date).filter(date=>dateValid(date)&&allowed.has(date)&&date<=today));
  return [...present].filter(date=>!existing.has(date)).sort((a,b)=>Number(b===today)-Number(a===today)||b.localeCompare(a));
}

export function selectResearchDay(rows,today,requestedDate=null){
  if(!dateValid(today)||requestedDate&&!dateValid(requestedDate))throw new Error('INVALID_RESEARCH_DATE');
  const groups=groupBy(rows,'race_date');
  if([...groups.values()].some(group=>group.length!==1))throw new Error('AMBIGUOUS_RESEARCH_DAY');
  const eligible=rows.filter(row=>dateValid(row.race_date)&&row.race_date<=today&&(requestedDate?row.race_date===requestedDate:row.race_date===today||row.status!=='COMPLETE'));
  const leastRecentlyAttempted=(a,b)=>(utcMs(a.last_attempt_at)||0)-(utcMs(b.last_attempt_at)||0)||a.race_date.localeCompare(b.race_date);
  if(requestedDate)return eligible.sort(leastRecentlyAttempted)[0]||null;
  const current=eligible.find(row=>row.race_date===today),backlog=eligible.filter(row=>row.race_date!==today).sort(leastRecentlyAttempted);
  if(!current)return backlog[0]||null;
  if(!backlog.length)return current;
  const currentAttempt=utcMs(current.last_attempt_at)||0;
  const mostRecentBacklog=Math.max(0,...rows.filter(row=>dateValid(row.race_date)&&row.race_date<today).map(row=>utcMs(row.last_attempt_at)||0));
  // Give today the first turn, then alternate a current-day turn with the
  // least-recently-attempted historical day. Completed historical days drop out.
  return currentAttempt===0||mostRecentBacklog>currentAttempt?current:backlog[0];
}

export function researchDayComplete(coverage,races){
  if(!Array.isArray(races)||!races.length||coverage?.expected_races!==races.length||coverage.pending_races!==0)return false;
  if([...groupBy(races,'race_key').values()].some(group=>group.length!==1))return false;
  return Number(coverage.verified_races||0)+Number(coverage.excluded_races||0)+Number(coverage.cancelled_races||0)===races.length;
}
