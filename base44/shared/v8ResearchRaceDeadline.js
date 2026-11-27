// Historical comparison only. A corrected timetable must not rewrite a frozen
// forecast or make a late input eligible. Live BUY gates keep exact deadlines.
import {CUTOFF_MS,evidenceTime,jstDay} from './v8ExternalEvidence.js';

const fail=reason=>({ok:false,reason});
const integer=(value,max)=>{
  if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))return null;
  const parsed=Number(value);return Number.isInteger(parsed)&&parsed>=1&&parsed<=max?parsed:null;
};

export function validateResearchRace(source,race,kind=source?.record_mode==='REPLAY'?'REPLAY':'FORECAST'){
  if(!source?.race_id||source.race_id!==race?.id||!source.race_key||source.race_key!==race.race_key
    ||!source.race_date||source.race_date!==race.race_date)return fail('RACE_IDENTITY_CHANGED');
  const saved=evidenceTime(source.deadline),current=evidenceTime(race.deadline);
  if(saved==null||current==null)return fail('RACE_DEADLINE_UNAVAILABLE');
  if(jstDay(saved)!==race.race_date||jstDay(current)!==race.race_date)return fail('RACE_IDENTITY_CHANGED');
  const sourceDeadline=Math.min(saved,current),resultDeadline=Math.max(saved,current),changed=saved!==current;
  if(changed){
    // For timetable reconciliation require every component of the logical race,
    // not a lane-only or approximate time match.
    const venue=integer(race.venue_code,24),number=integer(race.race_number,12);
    if(venue==null||number==null||integer(source.venue_code,24)!==venue||integer(source.race_number,12)!==number
      ||race.race_key!==race.race_date+'_'+String(venue).padStart(2,'0')+'_'+String(number).padStart(2,'0'))
      return fail('RACE_IDENTITY_CHANGED');
    const generated=evidenceTime(kind==='EXTERNAL'?source.recorded_at:source.generated_at),created=evidenceTime(source.created_date);
    const input=source.input_as_of==null?null:evidenceTime(source.input_as_of);
    if(generated==null||created==null||created<generated)return fail('SOURCE_TIMESTAMPS_MISSING');
    if(source.input_as_of!=null&&(input==null||input>generated))return fail('INPUT_AFTER_GENERATION');
    if(kind==='REPLAY'){
      if(generated<resultDeadline||created<resultDeadline)return fail('REPLAY_BEFORE_CURRENT_DEADLINE');
    }else if(generated>=sourceDeadline-CUTOFF_MS||created>=sourceDeadline-CUTOFF_MS
      ||input!=null&&input>=sourceDeadline-CUTOFF_MS)return fail('SOURCE_NOT_SAVED_BEFORE_CURRENT_CUTOFF');
  }
  return {ok:true,changed,sourceDeadline,resultDeadline,...(changed?{provenance:{
    revision:'V8_RESEARCH_RACE_DEADLINE_1',basis:'SAME_RACE_EARLIEST_CUTOFF_LATEST_RESULT',
    saved_deadline:source.deadline,current_deadline:race.deadline,
    source_cutoff_at:new Date(sourceDeadline-CUTOFF_MS).toISOString(),
    result_not_before:new Date(resultDeadline).toISOString(),source_kind:kind,
  }}:{})};
}
