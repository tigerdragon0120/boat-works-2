// Settlement never reads a result into the forecast engine. Append-only independent ledger.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {acquireLock,releaseLock} from '../../shared/concurrencyLock.js';
import {jstDate,readV8Rows,canonicalForecasts,latestForecasts,firstBuyForecasts,groupBy} from '../../shared/v8Repository.js';
import {settleForecast,settleExternal} from '../../shared/v8Settlement.js';
import {utcMs} from '../../shared/v7FeatureObservation.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const sr=client.asServiceRole.entities,started=Date.now(),dates=[jstDate(),jstDate(-1),jstDate(-2)];
  const summary:any={ok:true,created:0,held:0,existing:0,errors:0,reasons:{}};let lock:any=null;
  const hold=(reason:string)=>{summary.held++;summary.reasons[reason]=(summary.reasons[reason]||0)+1;};
  try{
    lock=await acquireLock(client,'V8_FORECAST_VERIFY','v8VerifyForecasts',120000);
    if(!lock)return Response.json({...summary,skipped:'locked'});
    const query={race_date:{$in:dates}},budget=Date.now()+30000;
    const [allForecasts,external,existing]=await Promise.all([
      readV8Rows(sr.V8RaceForecast,query,{budget,maxPages:70}),
      readV8Rows(sr.V8ExternalPrediction,query,{budget,maxPages:20}),
      readV8Rows(sr.V8ForecastVerification,query,{budget,maxPages:70})
    ]);
    const source=canonicalForecasts(allForecasts);
    const selected=new Map([...latestForecasts(source.rows),...firstBuyForecasts(source.rows)].map(r=>[r.id,{kind:'FORECAST',row:r}]));
    const externalGroups=groupBy(external,'record_key');
    for(const records of externalGroups.values())if(records.length===1&&records[0].verification_eligible===true)selected.set(records[0].id,{kind:'EXTERNAL',row:records[0]});
    const done=new Set(existing.map(v=>v.source_kind+':'+(v.forecast_id||v.external_id)));
    const waiting=[...selected.values()].filter(s=>utcMs(s.row.deadline)<Date.now()-60000&&!done.has(s.kind+':'+s.row.id));
    const groups=groupBy(waiting,s=>s.row.race_id),keys=new Set(existing.map(v=>v.verification_key));
    for(const [raceId,items] of groups){
      if(summary.created>=120||Date.now()-started>80000)break;
      try{
        const readBudget=Date.now()+12000;
        const [race,results,proof]=await Promise.all([
          sr.Race.get(raceId),
          readV8Rows(sr.RaceResult,{race_id:raceId},{budget:readBudget,maxPages:3}),
          readV8Rows(sr.ResultProvenance,{race_id:raceId,evidence_type:'LIVE'},{budget:readBudget,maxPages:3})
        ]);
        if(race?.status==='cancelled'){hold('CANCELLED');continue;}
        const validResults=results.filter(r=>(r.is_finished||r.result_status==='RESULT_FINAL')&&/^[1-6]-[1-6]-[1-6]$/.test(String(r.result_trifecta||'')));
        const outcomes=new Set(validResults.map(r=>r.result_trifecta+':'+r.payout));
        if(outcomes.size!==1){hold(outcomes.size?'RESULT_CONFLICT':'RESULT_PENDING');continue;}
        const eligible=validResults.map(r=>({result:r,evidence:proof.filter(p=>p.result_id===r.id&&p.result_trifecta===r.result_trifecta&&p.source===r.source)})).filter(x=>x.evidence.length===1);
        if(eligible.length!==1){hold(eligible.length?'RESULT_EVIDENCE_AMBIGUOUS':'RESULT_EVIDENCE_MISSING');continue;}
        const {result,evidence}=eligible[0];
        for(const item of items){
          const output=item.kind==='FORECAST'?settleForecast({forecast:item.row,result:results,provenance:evidence[0],now:new Date().toISOString()}):settleExternal({external:item.row,result:results,provenance:evidence[0],now:new Date().toISOString()});
          if(!output.ok){hold(output.reason||'SETTLEMENT_HELD');continue;}
          if(keys.has(output.record.verification_key)){summary.existing++;continue;}
          const found=await sr.V8ForecastVerification.filter({verification_key:output.record.verification_key},'-created_date',2);
          if(!Array.isArray(found))throw new Error('KEY_READ_INVALID');
          if(found.length){summary.existing++;continue;}
          const record=await sr.V8ForecastVerification.create(output.record);
          if(!record?.id)throw new Error('SAVE_NOT_CONFIRMED');
          keys.add(output.record.verification_key);summary.created++;
        }
      }catch(error:any){summary.errors++;console.error('[V8_VERIFY]',raceId,String(error?.message||error).slice(0,130));}
    }
    return Response.json({...summary,remaining_sources:waiting.length,completed_at:new Date().toISOString()});
  }catch(error:any){console.error('[V8_VERIFY] fatal',String(error?.message||error).slice(0,150));return Response.json({ok:false,error:'VERIFICATION_INCOMPLETE'},{status:503});}
  finally{if(lock)await releaseLock(client,lock).catch(()=>{});}
}
