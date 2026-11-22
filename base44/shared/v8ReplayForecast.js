// Research reconstruction uses the same hypothesis engine with a strict input whitelist.
// It records the real generation time and never creates a live BUY or pretends to be
// a forecast that was available before the deadline.
import {buildReplayHypothesis, FORECAST_REVISION, forecastTime} from './v8ForecastEngine.js';
import {isSavedExhibitionComplete} from './liveInputPriority.js';

export const REPLAY_REVISION = FORECAST_REVISION + '_REPLAY_1';
const RACE_FIELDS = ['id','race_key','race_date','venue_code','venue_name','race_number','deadline','status','is_womens','scratched_boats','created_date','updated_date'];
const ENTRY_FIELDS = ['id','race_id','race_key','race_date','boat_number','registration_number','register_number','player_name','racer_name','player_class','grade_class','national_win_rate','local_win_rate','national_2rate','national_f2_rate','local_2rate','local_f2_rate','motor_2rate','motor_f2_rate','motor_3rate','motor_f3_rate','motor_number','avg_st','average_st','expected_entry_course','entry_course','is_absent','is_scratched','created_date','updated_date'];
const EXHIBITION_FIELDS = ['exhibition_time','exhibition_st','exhibition_st_raw','exhibition_course'];
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const pick = (row, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(row || {},key)).map(key=>[key,copy(row[key])]));
const reg = row => String(row?.registration_number || row?.register_number || '').trim();

function usableArchive(archive,race,now) {
  if(!archive?.id || archive.race_id!==race.id || archive.race_key!==race.race_key || !Array.isArray(archive.boats))return false;
  const generated=forecastTime(archive.generated_at),created=forecastTime(archive.created_date),deadline=forecastTime(race.deadline);
  if(generated==null||created==null||generated>now||created>now)return false;
  if(archive.record_mode==='REPLAY')return archive.stage==='PRE'&&archive.provenance?.result_excluded===true&&archive.provenance?.reconstruction===true;
  return ['DAY_BEFORE','PRE','FINAL'].includes(archive.stage)&&generated<deadline-60000&&created<deadline-60000;
}

export function replayInputSnapshot({race,entries,stage,now,archived=null}) {
  const raceInput=pick(race,RACE_FIELDS);
  // PRE always means the pre-exhibition feature set, not a falsified earlier date.
  raceInput.exhibition_ready=stage==='FINAL';
  const archiveValid=usableArchive(archived,race,forecastTime(now));
  let archivedCount=0;
  const inputs=(entries||[]).map(entry=>{
    const row=pick(entry,ENTRY_FIELDS);
    const saved=archiveValid?archived.boats.find(boat=>Number(boat.boat_number)===Number(row.boat_number)&&reg(boat)===reg(row)):null;
    if(saved){
      archivedCount++;
      for(const key of ['national_win_rate','local_win_rate','national_2rate','local_2rate','motor_2rate','motor_3rate','motor_number','avg_st','section_points'])row[key]=copy(saved[key]??null);
      // Do not resurrect a result-time course aggregate or derive an expected
      // course from the observed exhibition course.
      row.expected_entry_course=saved.expected_course;
      if(['PRE','DAY_BEFORE'].includes(archived.stage)&&saved.course_win_percent!=null){
        row.course_stats={[String(saved.expected_course)]:{win_percent:saved.course_win_percent,starts:saved.course_sample_size}};
      }
    }
    if(stage==='FINAL')Object.assign(row,pick(entry,EXHIBITION_FIELDS));
    return row;
  });
  return {
    race:raceInput,entries:inputs,archive_id:archiveValid?archived.id:null,
    archived_boats:archivedCount,
    historical_as_of_verified:archiveValid&&archived.record_mode!=='REPLAY'&&archivedCount===inputs.length,
    // Current mutable section/race-result fields are never copied. A section
    // score can only come from an already frozen forecast input above.
    excluded_fields:['result','result_trifecta','finish_order','winning_method','payout','boats_result','f_flag','section_finishes','current_race_result','result_weather','odds','prediction'],
  };
}

export function buildReplayForecast({race,entries=[],stage,now,baseline=null,archived=null}) {
  if(!['PRE','FINAL'].includes(stage))return {ok:false,reason:'REPLAY_STAGE_INVALID'};
  const generated=forecastTime(now),deadline=forecastTime(race?.deadline);
  if(generated!=null&&deadline!=null&&generated<deadline)return {ok:false,reason:'REPLAY_REQUIRES_CLOSED_RACE'};
  if(stage==='FINAL'&&!isSavedExhibitionComplete(entries,race?.scratched_boats||[]))return {ok:false,reason:'EXHIBITION_INCOMPLETE'};
  const snapshot=replayInputSnapshot({race,entries,stage,now,archived:archived||baseline});
  const built=buildReplayHypothesis({race:snapshot.race,entries:snapshot.entries,stage,now,baseline});
  if(!built.ok)return built;
  if(!built.record.research_tickets.length||!built.record.scenarios.length)return {ok:false,reason:'SCORING_INPUTS_INSUFFICIENT'};
  if(stage==='FINAL'&&!built.record.exhibition_complete)return {ok:false,reason:'EXHIBITION_INCOMPLETE'};
  const record={...built.record,
    forecast_key:REPLAY_REVISION+':'+race.race_key+':'+stage,
    revision:REPLAY_REVISION,record_mode:'REPLAY',model_label:'展開仮説 V8・事後検証',
    input_snapshot:snapshot,
    decision:{...built.record.decision,status:'REPLAY',tickets:[],odds:{},valid_until:null,research_only:true},
    provenance:{...built.record.provenance,
      source:'WHITELISTED_RACE_CARD_AND_EXHIBITION',input_revision:REPLAY_REVISION,
      reconstruction:true,result_excluded:true,input_fields_whitelisted:true,
      future_inputs_excluded:false,input_period:'POST_DEADLINE_RECONSTRUCTION',
      observed_inputs_at:built.record.input_as_of,historical_as_of_verified:snapshot.historical_as_of_verified,
      archive_id:snapshot.archive_id,archived_boats:snapshot.archived_boats,
      outcome_fields_used:false,exhibition_used:stage==='FINAL',odds_used:false,
      prospective_performance_eligible:false,
    },
  };
  return {ok:true,record};
}
