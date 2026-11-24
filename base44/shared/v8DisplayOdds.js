// Display-only market quotes. Forecasts, buy decisions and settlement stay immutable.
import {utcMs} from './v7FeatureObservation.js';

const ticketValid=value=>typeof value==='string'&&/^[1-6]-[1-6]-[1-6]$/.test(value)&&new Set(value.split('-')).size===3;
const quoteValue=value=>{
  if(typeof value!=='number'&&typeof value!=='string')return null;
  if(typeof value==='string'&&!value.trim())return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>=1&&number<=1000000?number:null;
};

export function selectDisplayOddsSnapshot(rows,race,now=Date.now()) {
  const deadline=utcMs(race?.deadline);
  if(!Array.isArray(rows)||!race?.id||deadline==null||!Number.isFinite(now))return null;
  const eligible=rows.filter(row=>{
    const captured=utcMs(row?.captured_at),stored=utcMs(row?.created_date);
    return typeof row?.id==='string'&&row.id&&row.race_id===race.id
      &&['EARLY','PRE','FINAL'].includes(row.stage)
      &&captured!=null&&stored!=null&&captured<=now&&stored<=now&&stored>=captured
      &&captured<deadline&&stored<deadline
      &&row.odds_map&&typeof row.odds_map==='object'&&!Array.isArray(row.odds_map);
  }).sort((a,b)=>utcMs(b.captured_at)-utcMs(a.captured_at)||utcMs(b.created_date)-utcMs(a.created_date)||String(a.id).localeCompare(String(b.id)));
  const latest=eligible[0];
  if(!latest)return null;
  // A partial latest snapshot remains partial; never mix prices from older snapshots.
  const oddsMap=Object.fromEntries(Object.entries(latest.odds_map)
    .filter(([key,value])=>ticketValid(key)&&quoteValue(value)!=null)
    .map(([key,value])=>[key,quoteValue(value)]));
  return {id:latest.id,race_id:race.id,stage:latest.stage,captured_at:latest.captured_at,
    created_date:latest.created_date,odds_map:oddsMap};
}
