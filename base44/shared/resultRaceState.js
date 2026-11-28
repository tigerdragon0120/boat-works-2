// Finish the dashboard race only after its official result was persisted.
// Failures stay visible to the caller so the collector can retry the repair.
import {isOfficialSource,isValidTrifecta} from './resultEvidenceRules.js';
import {dateValid} from './v8Repository.js';

const ACTIVE=new Set(['scheduled','pre','final']);
const DISRUPTED=new Set(['CANCELLED','POSTPONED']);
const IDENTITY=['id','race_date','venue_code','race_number','race_key'];
const RESULT_IDENTITY=['race_date','venue_code','race_number','race_key'];
const validRace=race=>typeof race?.id==='string'&&!!race.id&&dateValid(race.race_date)
  &&typeof race.venue_code==='string'&&/^(?:0[1-9]|1\d|2[0-4])$/.test(race.venue_code)
  &&Number.isInteger(race.race_number)&&race.race_number>=1&&race.race_number<=12
  &&race.race_key===`${race.race_date}_${race.venue_code}_${String(race.race_number).padStart(2,'0')}`;
const sameRace=(actual,expected)=>validRace(actual)&&IDENTITY.every(key=>actual[key]===expected[key]);
const disrupted=race=>race.status==='cancelled'||DISRUPTED.has(race.schedule_status);
const finalResult=(result,race)=>typeof result?.id==='string'&&!!result.id&&result.race_id===race.id
  &&isOfficialSource(result.source)&&isValidTrifecta(result.result_trifecta)
  &&(result.result_status==='RESULT_FINAL'||result.result_status==null&&result.is_finished===true)
  &&typeof result.payout==='number'&&Number.isFinite(result.payout)&&result.payout>0
  &&RESULT_IDENTITY.every(key=>result[key]==null||result[key]===race[key]);

export async function syncFinishedRace(sr,race,result){
  if(!validRace(race))throw new Error('RACE_FINISH_IDENTITY_INVALID');
  if(!finalResult(result,race))throw new Error('RACE_FINISH_RESULT_INVALID');
  if(disrupted(race))throw new Error('RACE_FINISH_CANCELLED_OR_POSTPONED');
  if(typeof sr?.RaceResult?.get!=='function'||typeof sr?.Race?.get!=='function')throw new Error('RACE_FINISH_READ_UNAVAILABLE');
  const savedResult=await sr.RaceResult.get(result.id);
  if(!finalResult(savedResult,race)||savedResult.id!==result.id
    ||savedResult.source!==result.source||savedResult.result_trifecta!==result.result_trifecta
    ||savedResult.payout!==result.payout)throw new Error('RACE_FINISH_RESULT_NOT_CONFIRMED');
  const fresh=await sr.Race.get(race.id);
  if(!sameRace(fresh,race))throw new Error('RACE_FINISH_IDENTITY_CHANGED');
  if(disrupted(fresh))throw new Error('RACE_FINISH_CANCELLED_OR_POSTPONED');
  if(fresh.status==='finished')return {ok:true,updated:false,race:fresh};
  if(!ACTIVE.has(fresh.status))throw new Error('RACE_FINISH_STATUS_INVALID');
  if(typeof sr.Race.updateMany!=='function')throw new Error('RACE_FINISH_CONDITIONAL_WRITE_UNAVAILABLE');
  const query=Object.fromEntries(IDENTITY.map(key=>[key,fresh[key]]));
  query.status=fresh.status;
  if(fresh.updated_date!=null)query.updated_date=fresh.updated_date;
  if(Object.hasOwn(fresh,'schedule_status'))query.schedule_status=fresh.schedule_status;
  await sr.Race.updateMany(query,{$set:{status:'finished'}});
  // SDK update counters differ by transport. Readback is the success receipt;
  // a competing completion is fine, a cancellation or failed CAS is not.
  const confirmed=await sr.Race.get(race.id);
  if(!sameRace(confirmed,race))throw new Error('RACE_FINISH_IDENTITY_CHANGED');
  if(disrupted(confirmed))throw new Error('RACE_FINISH_CANCELLED_OR_POSTPONED');
  if(confirmed.status!=='finished')throw new Error('RACE_FINISH_SAVE_NOT_CONFIRMED');
  return {ok:true,updated:true,race:confirmed};
}
