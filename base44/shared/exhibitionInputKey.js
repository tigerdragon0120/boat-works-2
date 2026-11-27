// A value-equivalence marker for one completely persisted exhibition collection.
// Unchanged boats retain older updated_date values; timestamps are deliberately
// excluded. This is not a signature or a replacement for source/as-of validation.
import {isSavedExhibitionComplete} from './liveInputPriority.js';

export const EXHIBITION_INPUT_KEY_REVISION='EXHIBITION_INPUT_1';
const present=value=>value!=null&&!(typeof value==='string'&&!value.trim());
const number=value=>{
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()))return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
};
const integer=(value,min,max)=>{
  const n=number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null;
};
const registration=entry=>{
  const values=[entry?.registration_number,entry?.register_number].filter(present).map(value=>String(value).trim());
  return values.length&&values.every(value=>/^\d{4}$/.test(value))&&new Set(values).size===1?values[0]:null;
};
const observedStart=entry=>{
  const raw=present(entry.exhibition_st_raw)?entry.exhibition_st_raw:entry.exhibition_st;
  if(typeof raw==='string'){
    const text=raw.trim();
    if(/^L$/i.test(text))return {value:null,flag:'L'};
    if(/^F(?:0)?\.\d+$/i.test(text))return {value:-Number(text.slice(1)),flag:'F'};
  }
  const value=number(raw);
  return value!=null&&value>=-1&&value<=1?{value,flag:value<0?'F':null}:null;
};
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
  &&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

/**
 * Return a canonical JSON string, or null when identity/active input is incomplete.
 * Callers must confirm source identity and every necessary write before committing
 * this key on Race. Incoming missing values must never be filled from saved values.
 * Source rows may omit race metadata; any supplied race metadata must match.
 * All six boat/registration identities are required. Absent boats are represented
 * by their identity and absence only: their old times are not active input.
 * raw ST has the same priority as V8; F.03, F0.03 and -.03 are equivalent, while
 * F.00 remains distinct from a normal zero. L is an observed start (not BUY-ready).
 */
export function buildCommittedExhibitionKey(race,entries){
  const venue=integer(race?.venue_code,1,24),raceNumber=integer(race?.race_number,1,12);
  if(typeof race?.id!=='string'||!race.id||!validDate(race.race_date)||venue==null||raceNumber==null)return null;
  const raceKey=race.race_date+'_'+String(venue).padStart(2,'0')+'_'+String(raceNumber).padStart(2,'0');
  if(race.race_key!==raceKey||!Array.isArray(entries)||entries.length!==6)return null;
  const scratched=race.scratched_boats??[];
  if(!Array.isArray(scratched)||scratched.some(value=>integer(value,1,6)==null))return null;
  const absent=new Set(scratched.map(Number)),byBoat=new Map(),registrations=new Set();
  for(const entry of entries){
    const boat=integer(entry?.boat_number,1,6),reg=registration(entry);
    if(boat==null||reg==null||byBoat.has(boat)||registrations.has(reg))return null;
    if(['race_id','race_key','race_date'].some(key=>present(entry[key])&&entry[key]!==({race_id:race.id,race_key:raceKey,race_date:race.race_date})[key]))return null;
    if(['is_absent','is_scratched'].some(key=>entry[key]!=null&&typeof entry[key]!=='boolean'))return null;
    if(entry.is_absent===true||entry.is_scratched===true)absent.add(boat);
    byBoat.set(boat,{entry,reg});registrations.add(reg);
  }
  if(!isSavedExhibitionComplete(entries,[...absent]))return null;
  const boats=[];
  for(let boat=1;boat<=6;boat++){
    const row=byBoat.get(boat);if(!row)return null;
    if(absent.has(boat)){boats.push([boat,row.reg,null,null,null,true]);continue;}
    const time=number(row.entry.exhibition_time),start=observedStart(row.entry),course=integer(row.entry.exhibition_course,1,6);
    if(time==null||time<4||time>10||!start||course==null)return null;
    boats.push([boat,row.reg,time,[start.value,start.flag],course,false]);
  }
  return JSON.stringify({revision:EXHIBITION_INPUT_KEY_REVISION,race:[race.id,raceKey,race.race_date,String(venue).padStart(2,'0'),raceNumber],boats});
}
