// Recover observable official inputs after a race closes. Prediction generation is separate.
import {fetchHtml,parseBeforeInfo,parseResult,buildUrl} from './boatraceOfficialParser.js';
import {readV8Rows,groupBy} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';
import {isSavedExhibitionComplete} from './liveInputPriority.js';
import {buildProvenanceDoc,isValidTrifecta} from './resultProvenance.js';
import {hasCompleteResultDetails} from './v8ResultDetails.js';

const finalResult=row=>row&&(row.result_status==='RESULT_FINAL'||row.is_finished===true)&&isValidTrifecta(row.result_trifecta)&&Number(row.payout)>0;
const hasProof=(row,proof)=>proof.some(p=>p.evidence_type==='LIVE'&&p.result_id===row.id&&p.result_trifecta===row.result_trifecta&&p.source===row.source&&utcMs(p.fetched_at)!=null);
const uniqueRows=rows=>[...groupBy(rows,'boat_number').values()].every(group=>group.length===1);
const changed=(a,b)=>b!=null&&b!==''&&(a==null||a===''||String(a)!==String(b));
const safeError=e=>String(e?.message||'INPUT_RECOVERY_FAILED').split('\n')[0].replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/[a-f0-9]{64,}/gi,'[redacted]').slice(0,160);
const sourceUnavailable=(reason,response)=>{
  const status=response?.status;
  const message=String(response?.error?.message||response?.error||(status?`HTTP ${status}`:'FETCH_FAILED'))
    .replace(/(https?:\/\/)[^/\s@]+@/gi,'$1[redacted]@')
    .replace(/([?&][^=\s]+)=([^&\s)]+)/g,'$1=[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
  return Object.assign(new Error(reason),{
    source_http_status:Number.isInteger(status)&&(status===0||status>=100&&status<=599)?status:null,
    source_error:safeError({message})
  });
};
const recoveryFailure=(race,phase,error)=>({race_key:race.race_key,phase,reason:safeError(error),
  ...(Object.prototype.hasOwnProperty.call(error||{},'source_http_status')
    ?{source_http_status:error.source_http_status,source_error:error.source_error}:{})});

export function selectResearchRecoveryWork({races,entriesByRace,resultsByRace,proofByRace,now=Date.now(),cursor=0,maxRaces=6}){
  const candidates=[];
  for(const race of races){
    const deadline=utcMs(race.deadline);
    if(deadline==null||deadline>now||race.status==='cancelled')continue;
    const entries=entriesByRace.get(race.id)||[],results=resultsByRace.get(race.id)||[],proof=proofByRace.get(race.id)||[];
    const exhibition=!isSavedExhibitionComplete(entries,race.scratched_boats||[]);
    const result=now>=deadline+300000&&!results.some(r=>finalResult(r)&&hasProof(r,proof)&&hasCompleteResultDetails(r,race));
    if(exhibition||result)candidates.push({race,exhibition,result});
  }
  candidates.sort((a,b)=>(utcMs(a.race.deadline)||0)-(utcMs(b.race.deadline)||0)||String(a.race.id).localeCompare(String(b.race.id)));
  if(!candidates.length)return {work:[],nextCursor:0,total:0};
  const start=Math.max(0,Number(cursor)||0)%candidates.length;
  const rotated=[...candidates.slice(start),...candidates.slice(0,start)];
  const work=rotated.slice(0,Math.max(1,Math.min(48,maxRaces)));
  return {work,nextCursor:(start+work.length)%candidates.length,total:candidates.length};
}

export async function recoverRaceResearchInputs(client,{date,budgetMs=18000,max_races=6,cursor=0}={}){
  const sr=client.asServiceRole.entities,started=Date.now(),budget=started+Math.max(1000,Math.min(45000,budgetMs));
  const summary={date,exhibition_saved:0,result_saved:0,attempted:0,pending:0,next_cursor:cursor,failures:[]};
  const races=await readV8Rows(sr.Race,{race_date:date},{budget,maxPages:4});
  const duplicateKeys=[...groupBy(races,'race_key').values()].filter(group=>group.length>1);
  if(duplicateKeys.length)throw new Error('AMBIGUOUS_RACE_KEYS');
  const ids=races.map(r=>r.id);
  if(!ids.length)return summary;
  const [entries,results,proof]=await Promise.all([
    readV8Rows(sr.RaceEntry,{race_id:{$in:ids}},{budget,maxPages:15}),
    readV8Rows(sr.RaceResult,{race_id:{$in:ids}},{budget,maxPages:6}),
    readV8Rows(sr.ResultProvenance,{race_id:{$in:ids}},{budget,maxPages:8})
  ]);
  const entriesByRace=groupBy(entries,'race_id'),resultsByRace=groupBy(results,'race_id'),proofByRace=groupBy(proof,'race_id');
  const chosen=selectResearchRecoveryWork({races,entriesByRace,resultsByRace,proofByRace,cursor,maxRaces:max_races});
  summary.pending=chosen.total;
  let processed=0;
  for(const work of chosen.work){
    if(Date.now()>=budget-1000)break;
    const race=work.race;summary.attempted++;processed++;
    try{
      if(work.exhibition){
        const rows=entriesByRace.get(race.id)||[];
        if(!rows.length||!uniqueRows(rows))throw new Error('ENTRY_ROWS_MISSING_OR_AMBIGUOUS');
        const response=await fetchHtml(buildUrl('beforeinfo',date,race.venue_code,race.race_number),0,{timeoutMs:6000,deadlineMs:budget});
        if(!response.ok)throw sourceUnavailable('EXHIBITION_SOURCE_UNAVAILABLE',response);
        const parsed=parseBeforeInfo(response.html);
        if(!parsed.ok||!parsed.data?.entries?.length)throw new Error('EXHIBITION_NOT_PUBLISHED_OR_PARSE_FAILED');
        const byBoat=new Map(rows.map(row=>[Number(row.boat_number),row]));
        for(const incoming of parsed.data.entries){
          const row=byBoat.get(Number(incoming.boat_number));if(!row)continue;
          const update={};
          for(const key of ['exhibition_time','exhibition_st','exhibition_course','tilt'])if(changed(row[key],incoming[key]))update[key]=incoming[key];
          if(changed(row.exhibition_st_raw,incoming.exhibition_st))update.exhibition_st_raw=incoming.exhibition_st;
          if(incoming.is_absent){if(!row.is_absent)update.is_absent=true;if(!row.is_scratched)update.is_scratched=true;}
          if(Object.keys(update).length){
            const saved=await sr.RaceEntry.update(row.id,update);
            if(!saved?.id)throw new Error('EXHIBITION_WRITE_NOT_CONFIRMED');
            Object.assign(row,update);
          }
        }
        const scratched=[...new Set([...(race.scratched_boats||[]),...(parsed.data.scratched_boats||[])].map(Number))].filter(n=>Number.isInteger(n)&&n>=1&&n<=6).sort((a,b)=>a-b);
        const complete=isSavedExhibitionComplete(rows,scratched);
        const raceUpdate={exhibition_ready:complete,scratched_boats:scratched};
        for(const field of ['weather','wind_speed','water_temp','air_temp','wave_height'])if(parsed.data[field]!=null)raceUpdate[field]=parsed.data[field];
        const savedRace=await sr.Race.update(race.id,raceUpdate);
        if(!savedRace?.id)throw new Error('EXHIBITION_RACE_WRITE_NOT_CONFIRMED');
        Object.assign(race,raceUpdate);
        if(complete)summary.exhibition_saved++;
        else summary.failures.push({race_key:race.race_key,phase:'EXHIBITION',reason:'EXHIBITION_INCOMPLETE'});
      }
    }catch(error){summary.failures.push(recoveryFailure(race,'EXHIBITION',error));}
    // Result recovery is independent of a missing/failed exhibition. It never feeds a prediction.
    if(work.result&&Date.now()<budget-1000){
      try{
        const response=await fetchHtml(buildUrl('raceresult',date,race.venue_code,race.race_number),0,{timeoutMs:6000,deadlineMs:budget});
        if(!response.ok)throw sourceUnavailable('RESULT_SOURCE_UNAVAILABLE',response);
        const fetchedAt=new Date().toISOString(),parsed=parseResult(response.html,date,race.venue_code,race.venue_name);
        const input=parsed.data?.venues?.[0]?.results?.[0];
        if(!parsed.ok||!isValidTrifecta(input?.result_trifecta)||!(Number(input.payout)>0))throw new Error('RESULT_NOT_PUBLISHED_OR_PARSE_FAILED');
        const known=(resultsByRace.get(race.id)||[]).find(row=>finalResult(row)&&row.source==='LOCAL');
        const fresh=known?[await sr.RaceResult.get(known.id)]:await readV8Rows(sr.RaceResult,{race_id:race.id},{budget,maxPages:2});
        const existingFinal=fresh.filter(finalResult);
        if(existingFinal.some(row=>row.result_trifecta!==input.result_trifecta||Number(row.payout)!==Number(input.payout)))throw new Error('OFFICIAL_RESULT_CONFLICT');
        let result=existingFinal.find(row=>row.source==='LOCAL');
        const winner=(input.entries||[]).find(row=>Number(row.finish_order)===1);
        const details={finish_order:input.finish_order||[],boats:input.entries||[],winning_method:input.winning_method||winner?.winning_method||null,details_fetched_at:fetchedAt,details_revision:'OFFICIAL_RESULT_TABLE_V1'};
        if(!hasCompleteResultDetails({...input,...details},race))throw new Error('OFFICIAL_RESULT_DETAILS_INCOMPLETE');
        details.details_complete=true;
        if(!result){
          const document={race_id:race.id,result_trifecta:input.result_trifecta,payout:Number(input.payout),payouts:input.payouts||{},...details,is_finished:true,result_status:'RESULT_FINAL',finished_at:fetchedAt,source:'LOCAL'};
          result=await sr.RaceResult.create(document);
          if(!result?.id)throw new Error('RESULT_WRITE_NOT_CONFIRMED');
        }else{
          const saved=await sr.RaceResult.update(result.id,details);
          if(!saved?.id)throw new Error('RESULT_DETAILS_WRITE_NOT_CONFIRMED');
          result={...result,...details};
        }
        const cachedProof=proofByRace.get(race.id)||[];
        const existingProof=hasProof(result,cachedProof)?cachedProof:await readV8Rows(sr.ResultProvenance,{race_id:race.id,evidence_type:'LIVE'},{budget,maxPages:2});
        if(!hasProof(result,existingProof)){
          const document=buildProvenanceDoc(race,result,'boatrace.jp:result-html','LIVE',fetchedAt);
          if(!document)throw new Error('RESULT_PROVENANCE_INVALID');
          const saved=await sr.ResultProvenance.create(document);
          if(!saved?.id)throw new Error('RESULT_PROVENANCE_WRITE_NOT_CONFIRMED');
        }
        if(race.status!=='finished')await sr.Race.update(race.id,{status:'finished'});
        summary.result_saved++;
      }catch(error){summary.failures.push(recoveryFailure(race,'RESULT',error));}
    }
  }
  summary.next_cursor=chosen.total?(Math.max(0,Number(cursor)||0)+processed)%chosen.total:0;
  return {...summary,duration_ms:Date.now()-started};
}
