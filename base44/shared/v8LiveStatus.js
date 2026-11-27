// Durable status for the existing independent V8 forecast job. It never changes
// predictions, and a handled partial run is not represented as a successful run.
import {readV8Rows,jstDate} from './v8Repository.js';
import {utcMs} from './v7FeatureObservation.js';

export const LIVE_STATUS_NAME='v8_live_generation';
export const LIVE_JOB_STATUS_REVISION='V8_LIVE_JOB_STATUS_1';
const networkCodes=new Set(['ERR_NETWORK','ECONNRESET','ECONNABORTED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
const bugKinds=new Set(['TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError']);
const safeKind=error=>['Error','AxiosError','TypeError','RangeError','ReferenceError','SyntaxError','URIError','EvalError','AbortError','TimeoutError'].includes(error?.name)?error.name:'UnknownError';
const count=value=>Number.isInteger(value)&&value>=0?value:0;
const safeCode=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)?value:'UNKNOWN';

export async function confirmLiveLockHeld(client,key){
  // The legacy lock helper also returns null on DB/write failures. A handled
  // overlap is only known when an actual unexpired lease can still be read.
  const rows=await readV8Rows(client.asServiceRole.entities.ProcessLock,{lock_key:key,status:'active'},
    {budget:Date.now()+4000,maxPages:2,fields:['id','lock_key','status','expires_at']});
  return rows.some(row=>row.lock_key===key&&row.status==='active'&&utcMs(row.expires_at)>Date.now());
}

export function classifyLiveFailure(error,phase){
  const value=error?.http_status??error?.response?.status??error?.status;
  const status=typeof value==='number'?value:typeof value==='string'&&/^\d{3}$/.test(value)?Number(value):null;
  const http_status=Number.isInteger(status)&&status>=100&&status<=599?status:null;
  const base={phase:safeCode(phase),kind:safeKind(error),http_status,retryable:false};
  if(bugKinds.has(error?.name)||phase==='BUILD_FORECAST')return {...base,code:'IMPLEMENTATION_ERROR'};
  if(http_status===401||http_status===403)return {...base,code:'ACCESS_DENIED'};
  // readV8Rows supplies this only for an observed transport failure. Generic
  // INCOMPLETE_READ messages can also mean SDK/data errors and are not guessed.
  if(error?.retryable_read===true)return {...base,code:http_status===429?'RATE_LIMIT_BACKOFF':'SOURCE_READ_TRANSIENT',retryable:true};
  if(http_status===429||http_status===408||(http_status>=500&&http_status<=599))
    return {...base,code:http_status===429?'RATE_LIMIT_BACKOFF':'SOURCE_REQUEST_TRANSIENT',retryable:true};
  if(networkCodes.has(error?.code)||['AbortError','TimeoutError'].includes(error?.name))
    return {...base,code:'SOURCE_TRANSPORT_TRANSIENT',retryable:true};
  if(phase==='SAVE_FORECAST'&&error?.message==='SAVE_NOT_CONFIRMED')
    return {...base,code:'SAVE_NOT_CONFIRMED',retryable:true};
  return {...base,code:http_status?'SOURCE_REQUEST_REJECTED':'UNEXPECTED_FAILURE'};
}

export function liveJobSummary(result){
  const work=result?.v8||result||{};
  const resultStatus=['COMPLETE','PARTIAL','FAILED'].includes(result?.result_status)?result.result_status
    :['COMPLETE','PARTIAL','FAILED'].includes(work.result_status)?work.result_status:'FAILED';
  const pending=(Array.isArray(work.pending)?work.pending:[]).slice(0,50).map(row=>({
    race_key:typeof row?.race_key==='string'&&/^\d{4}-\d{2}-\d{2}_\d{2}_\d{2}$/.test(row.race_key)?row.race_key:null,
    stage:['DAY_BEFORE','PRE','FINAL'].includes(row?.stage)?row.stage:null,
    phase:safeCode(row?.phase),code:safeCode(row?.code),retryable:row?.retryable===true,
  }));
  const rawFatal=result?.fatal||work.fatal;
  const fatal=rawFatal?{phase:safeCode(rawFatal.phase),code:safeCode(rawFatal.code),kind:safeKind({name:rawFatal.kind}),
    http_status:Number.isInteger(rawFatal.http_status)&&rawFatal.http_status>=100&&rawFatal.http_status<=599?rawFatal.http_status:null}:null;
  const at=value=>utcMs(value)==null?null:new Date(utcMs(value)).toISOString();
  return {revision:LIVE_JOB_STATUS_REVISION,started_at:at(result?.started_at||work.started_at),
    completed_at:at(result?.completed_at||work.completed_at)||new Date().toISOString(),
    worker_completed:result?.worker_completed===true||work.worker_completed===true,result_status:resultStatus,
    created:count(work.created),existing:count(work.existing),attempted:count(work.attempted),
    pending_count:count(work.pending_count),retry_pending_count:count(work.retry_pending_count),
    reason_counts:Object.fromEntries(Object.entries(work.reason_counts||{}).filter(([key,value])=>safeCode(key)===key&&count(value)>0)),
    pending,pending_truncated:work.pending_truncated===true||count(work.pending_count)>pending.length,
    next_retry_policy:'NEXT_SCHEDULED_RUN',fatal};
}

export async function persistLiveStatus(client,result){
  const work=result?.v8||result||{};
  // An overlapping invocation must not erase the currently running job's last
  // PARTIAL/FAILED status just because it could not acquire the existing lock.
  if(result?.skipped==='locked'||work.skipped==='locked')return {...result,worker_completed:false,result_status:'SKIPPED',status_persisted:false};
  if(['INVALID_LIVE_DATE','INVALID_RACE_KEYS'].includes(result?.error||work.error))
    return {...result,ok:false,worker_completed:false,result_status:'REJECTED',status_persisted:false};
  const job=liveJobSummary(result),entity=client?.asServiceRole?.entities?.AutoUpdateStatus;
  try{
    if(!entity?.filter||!entity?.create||!entity?.update)throw new Error('STATUS_ENTITY_UNAVAILABLE');
    const rows=await readV8Rows(entity,{name:LIVE_STATUS_NAME},{budget:Date.now()+5000,maxPages:2,
      fields:['id','name','last_updated','job_summary.started_at']});
    if(rows.length>1)throw new Error('STATUS_IDENTITY_AMBIGUOUS');
    const old=rows[0];
    if(old&&utcMs(old.job_summary?.started_at)>utcMs(job.started_at))throw new Error('STATUS_NEWER_RUN_PRESENT');
    const doc={name:LIVE_STATUS_NAME,target_date:result?.race_date||work.today||jstDate(),
      status:job.result_status==='COMPLETE'?'success':job.result_status==='PARTIAL'?'partial':'error',
      current_step:'v8_live_generation',last_updated:new Date().toISOString(),
      error_count:count(work.errors)+(job.fatal&&count(work.errors)===0?1:0),
      errors:[...(job.fatal?[job.fatal.phase+': '+job.fatal.code]:[]),
        ...job.pending.map(row=>[row.race_key,row.stage,row.phase,row.code].filter(Boolean).join(' / '))].slice(0,20),
      logs:[`予想保存 ${job.created}件 / 保存済み ${job.existing}件 / 未完了 ${job.pending_count}件 / 再試行待ち ${job.retry_pending_count}件`],
      job_summary:job};
    const saved=old?await entity.update(old.id,doc):await entity.create(doc);
    if(!saved?.id)throw new Error('STATUS_SAVE_NOT_CONFIRMED');
    return {...result,result_status:job.result_status,worker_completed:job.worker_completed,status_persisted:true};
  }catch(error){
    console.error('[V8_LIVE_STATUS_FAILURE]',JSON.stringify({phase:'SAVE_JOB_STATUS',kind:safeKind(error)}));
    return {...result,ok:false,result_status:'FAILED',worker_completed:job.worker_completed,status_persisted:false,
      work_result_status:job.result_status,error:'LIVE_STATUS_SAVE_FAILED',
      fatal:{phase:'SAVE_JOB_STATUS',code:'STATUS_SAVE_FAILED',kind:safeKind(error),http_status:null}};
  }
}

export function liveResponseStatus(result){
  const work=result?.v8||result||{};
  if(['INVALID_LIVE_DATE','INVALID_RACE_KEYS'].includes(result?.error||work.error))return 400;
  if(result?.result_status==='SKIPPED'&&(result.skipped==='locked'||work.skipped==='locked'))return 200;
  if(result?.worker_completed===true&&result?.status_persisted===true&&['COMPLETE','PARTIAL'].includes(result.result_status))return 200;
  return 503;
}
