import {dashboardReadErrorState} from './v8ReadErrors.js';

const MINUTE=60000;

function deadlineMs(value) {
  if (typeof value!=='string' || !value.trim()) return null;
  let text=value.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) text+='Z';
  const parsed=Date.parse(text);
  return Number.isFinite(parsed)?parsed:null;
}

// Keep live alerts fresh; completed views still check occasionally for corrections.
// A past date alone never stops polling while the server repairs missing stages.
export function dashboardPollInterval(parameters={},data=null,error=null,now=Date.now()) {
  if (error) return dashboardReadErrorState(error).retryable ? MINUTE : Infinity;
  if (!data) return MINUTE;
  if (parameters.mode==='verification') return 5*MINUTE;
  const today=new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
  const selectedDate=parameters.race_date || data.race_date;
  const races=Array.isArray(data.races)?data.races:[];
  const currentDay=!selectedDate || selectedDate===today;
  if (currentDay && (!races.length || races.some(race=>{
    if (['finished','cancelled'].includes(race.status)) return false;
    const deadline=deadlineMs(race.deadline);
    return deadline==null || deadline>now;
  }))) return MINUTE;
  const coverage=data.coverage;
  const complete=Number.isInteger(coverage?.expected_races) && coverage.expected_races>0 && coverage.pending_races===0;
  return complete?15*MINUTE:5*MINUTE;
}
