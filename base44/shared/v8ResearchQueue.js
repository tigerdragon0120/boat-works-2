// Keep unfinished dates until every race reaches a terminal verification state.
import {dateValid,groupBy} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

export function selectResearchDay(rows,today,requestedDate=null){
  if(!dateValid(today)||requestedDate&&!dateValid(requestedDate))throw new Error('INVALID_RESEARCH_DATE');
  const groups=groupBy(rows,'race_date');
  if([...groups.values()].some(group=>group.length!==1))throw new Error('AMBIGUOUS_RESEARCH_DAY');
  const eligible=rows.filter(row=>dateValid(row.race_date)&&row.race_date<=today&&(requestedDate?row.race_date===requestedDate:row.race_date===today||row.status!=='COMPLETE'));
  return eligible.sort((a,b)=>(utcMs(a.last_attempt_at)||0)-(utcMs(b.last_attempt_at)||0)||a.race_date.localeCompare(b.race_date))[0]||null;
}

export function researchDayComplete(coverage,races){
  if(!Array.isArray(races)||!races.length||coverage?.expected_races!==races.length||coverage.pending_races!==0)return false;
  if([...groupBy(races,'race_key').values()].some(group=>group.length!==1))return false;
  return Number(coverage.verified_races||0)+Number(coverage.excluded_races||0)+Number(coverage.cancelled_races||0)===races.length;
}
