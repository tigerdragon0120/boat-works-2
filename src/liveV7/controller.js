import {winningDividend,selectFinalResult} from './resultInput.js';
import {buildSnapshot,fingerprintInput} from './snapshot.js';
import {v7Trial,V7_TRIAL_REVISION} from './engine.js';
import {researchCandidate} from './researchCandidate.js';
import {digest,raceKey,timeMs} from '../lib/uiReadGuard.js';
import {createDurableStorage} from './durableStorage.js';
export const STORAGE_PREFIX='BOAT_LIVE_V7_READONLY_V1:';
const copy=v=>structuredClone(v);
// Minimum meaningful exhibition evidence for a provisional ranking (not final-quality evidence).
function hasPartialExhibition(entries){
 const active=(entries||[]).filter(e=>!e.is_absent&&!e.is_scratched);
 if(active.length!==6)return false;
 const usable=active.filter(e=>Number(e.exhibition_time)>0 && Number.isFinite(Number(e.exhibition_time)) &&
   e.exhibition_st!=null && Number.isFinite(Number(e.exhibition_st)) &&
   Number.isInteger(Number(e.exhibition_course)) && Number(e.exhibition_course)>=1 && Number(e.exhibition_course)<=6);
 return usable.length>=3 && new Set(usable.map(e=>Number(e.exhibition_course))).size===usable.length;
}

export class LiveV7Controller{
 constructor({reader,model=V7_TRIAL_REVISION,predict=/** @type {(snapshot: any, stage: string) => any} */ (v7Trial),compare=researchCandidate,waitForResult=false,storage=null,namespace,clock=()=>new Date().toISOString(),hidden=()=>false,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),readTimeoutMs=15000,deadlineTimer=(fn,ms)=>setTimeout(fn,ms),clearDeadlineTimer=id=>clearTimeout(id)}){
  if(!namespace)throw Error('保存環境の識別が必要です');
  this.reader=reader;this.model=model;this.predict=predict;this.compare=compare;this.waitForResult=waitForResult;this.pendingReads=new Map();this.readTimeoutMs=readTimeoutMs;this.deadlineTimer=deadlineTimer;this.clearDeadlineTimer=clearDeadlineTimer;this.storage=storage;this.storageKey=STORAGE_PREFIX+namespace;this.durable=createDurableStorage(storage,this.storageKey);this.saveChain=Promise.resolve();this.clock=clock;this.hidden=hidden;this.setTimer=setTimer;this.clearTimer=clearTimer;this.races=new Map();this.records=new Map();this.first=new Map();this.resultHistory=new Map();this.conflicts=new Set();this.listeners=new Set();this.inflight=new Map();this.watchers=new Map();this.storageError=null;this.restoreFailure=null;this.quarantined=[];this.restored=false;this.restorePromise=null;this.resultEnrichment=new Map();this.resultAttempts=new Map();this.resultErrors=new Map();this.sourceChecks=new Map();this.resultMonitorError=null;this.resultMonitorStopped=false;this.resultMonitorInflight=null;
 }
 subscribe(fn){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 emit(){for(const fn of this.listeners)fn();}
 async restore(){if(!this.restorePromise)this.restorePromise=this.restoreStored();return this.restorePromise;}
 async restoreStored(){this.restored=true;try{
  const saved=await this.durable.read();this.quarantined=saved.quarantined||[];
  for(const r of saved.records||[]){if(r.hash!==await digest(r.payload)||r.id!==r.hash||r.payload.model!==this.model){this.quarantined.push(r);continue;}this.records.set(r.id,r);}
  for(const [key,id] of saved.first||[]){const r=this.records.get(id);if(r&&key===JSON.stringify([r.payload.race_key,r.payload.stage]))this.first.set(key,id);}
  for(const row of saved.results||[])this.resultHistory.set(row.key,row.value);
  this.conflicts=new Set(saved.conflicts||[]);this.resultEnrichment=new Map(saved.resultEnrichment||[]);this.sourceChecks=new Map(saved.sourceChecks||[]);
 }catch(e){this.restoreFailure='ローカル履歴の読込失敗：'+e.message;this.storageError=this.restoreFailure;}this.emit();}
 persist(){
  if(this.restoreFailure){this.storageError=this.restoreFailure+"。元の保存内容を保持し、上書きを停止しています";return Promise.resolve();}
  const snapshot={records:[...this.records.values()],first:[...this.first],results:[...this.resultHistory].map(([key,value])=>({key,value})),conflicts:[...this.conflicts],resultEnrichment:[...this.resultEnrichment],sourceChecks:[...this.sourceChecks],quarantined:this.quarantined};
  // Serialize updates, so a slow compression/write cannot overwrite a newer revision.
  const task=this.saveChain.catch(()=>{}).then(async()=>{
   try{await this.durable.write(snapshot);this.storageError=null;}
   catch(e){this.storageError='端末内へのV7履歴保存に失敗しました：'+e.message;}
  });
  this.saveChain=task;
  return task;
 }
 get(id){return this.races.get(id)||{status:'WAITING',stages:{},error:null};}
 async refresh(id){if(this.inflight.has(id))return this.inflight.get(id);const promise=this.readAndGenerate(id).finally(()=>this.inflight.delete(id));this.inflight.set(id,promise);return promise;}
 async readBounded(id,read=this.reader){
  if(this.pendingReads.has(id))throw Error('前回の通信が未完了です。重複リクエストを保留しています');
  const request=Promise.resolve().then(()=>read(id));this.pendingReads.set(id,request);
  void request.finally(()=>{if(this.pendingReads.get(id)===request)this.pendingReads.delete(id);}).catch(()=>{});
  let timer;try{return await Promise.race([request,new Promise((_,reject)=>{timer=this.deadlineTimer(()=>reject(Error('通信がタイムアウトしました。保存済み表示は前回分です')),this.readTimeoutMs);})]);}finally{if(timer!=null)this.clearDeadlineTimer(timer);}
 }
 async readAndGenerate(id){await this.restore();try{
  const data=await this.readBounded(id);if(data.race?.id!==id)throw Error('レースID不一致');const now=this.clock(),key=raceKey(data.race.race_key),deadline=timeMs(data.race.deadline),state={status:'READY',stages:{},race:copy(data.race),entries:copy(data.entries),result:copy(data.result),error:null,lastRead:now,quality:copy(data.quality||null),closed:deadline==null?false:timeMs(now)>=deadline||['finished','cancelled'].includes(data.race.status)};
  this.sourceChecks.set(id,{race_key:key,read_at:now,quality:copy(data.quality||null),error:null});
  const old=this.get(id);this.observeResult(key,data.result,data.race,now);
  for(const stage of ['PRE','FINAL']){
   const identity=JSON.stringify([key,stage]),prior=old.stages?.[stage];
   if(deadline==null||timeMs(now)==null||timeMs(now)>=deadline||['finished','cancelled'].includes(data.race.status)){
    // On reload after the deadline, display the latest immutable pre-deadline
    // revision, not the first (outdated-odds) record.
    const historical=[...this.records.values()].filter(r=>r.payload?.race_key===key&&r.payload?.stage===stage&&
      timeMs(r.payload.generated_at)!=null&&timeMs(r.payload.generated_at)<deadline).sort((a,b)=>timeMs(b.payload.generated_at)-timeMs(a.payload.generated_at));
    const frozen=prior?.record||historical[0]||this.records.get(this.first.get(identity));
    state.stages[stage]=frozen?{status:'READY',record:frozen,closed:true}:{status:'UNAVAILABLE',reason:deadline==null?'締切時刻不明。生成しません':'締切後・終了済み。事後生成しません'};continue;
   }
   if(data.race.saved_input_status==='STALE'){state.stages[stage]={status:'UNAVAILABLE',reason:'保存済み出走表の有効期限切れ'};continue;}
   if(stage==='FINAL'&&!hasPartialExhibition(data.entries)){state.stages[stage]={status:'UNAVAILABLE',reason:'展示データの取得待ち'};continue;}
   try{
    const snapshot=buildSnapshot({...data,observedAt:now},stage),inputHash=await digest(fingerprintInput(snapshot));
    if(prior?.record?.payload.input_hash===inputHash){state.stages[stage]=prior;continue;}
    // Reuse identical immutable revision after reload, including its original observed time.
    const cached=[...this.records.values()].find(r=>r.payload.race_key===key&&r.payload.stage===stage&&r.payload.input_hash===inputHash);
    if(cached){state.stages[stage]={status:'READY',record:cached};continue;}
    const output=this.predict(snapshot,stage);if(output.status!=='READY'){state.stages[stage]=output;continue;}
    let candidateOutput=null;
    let candidateError=null;
    try{candidateOutput=this.compare?.(snapshot,stage,output)??null;}
    catch(e){candidateError='改善候補の計算に失敗しました：'+e.message;}
    const generatedAt=this.clock();if(timeMs(generatedAt)==null||timeMs(generatedAt)>=deadline){state.stages[stage]={status:'UNAVAILABLE',reason:'計算中に締切を超過。保存しません'};continue;}
    const payload={model:this.model,race_key:key,race:copy(snapshot.race),stage,input_hash:inputHash,snapshot,output,candidateOutput,candidateError,observed_at:now,generated_at:generatedAt,deadline:data.race.deadline,formal_eligible:false};
    const hash=await digest(payload),record={id:hash,hash,payload};const savedAt=timeMs(this.clock());if(savedAt==null||savedAt>=deadline){state.stages[stage]={status:"UNAVAILABLE",reason:"記録処理中に締切を超過。保存しません"};continue;}this.records.set(hash,record);
    if(!this.first.has(identity)&&!this.quarantined.some(r=>r.payload?.race_key===key&&r.payload?.stage===stage))this.first.set(identity,hash);
    state.stages[stage]={status:'READY',record};
   }catch(e){state.stages[stage]={status:'UNAVAILABLE',reason:e.message};}
  }
  this.races.set(id,state);await this.persist();this.emit();return state;
 }catch(e){const status=e.status||e.response?.status,previous=this.get(id);const state={...previous,status:'ERROR',error:status===401||status===403?'認証・権限エラー。自動再試行を停止しました':e.message,halted:status===401||status===403,retryAfter:status===429?60000:30000};this.races.set(id,state);this.sourceChecks.set(id,{...(this.sourceChecks.get(id)||{}),attempt_at:this.clock(),error:state.error});await this.persist();this.emit();return state;}}
 observeResult(key,result,race,now){
  if(!result)return;
  if(result.race_id!==race.id||(result.race_key&&raceKey(result.race_key)!==key))return;
  if(!result.is_finished&&result.result_status!=='RESULT_FINAL')return;
  if(!/^[1-6]-[1-6]-[1-6]$/.test(result.result_trifecta)||new Set(result.result_trifecta.split('-')).size!==3)return;
  const deadline=timeMs(race.deadline);if(deadline==null||timeMs(now)<deadline)return;
  const at=result.finished_at||result.updated_date||now;if(timeMs(at)==null||timeMs(at)>timeMs(now)||timeMs(at)<deadline)return;
  const payout=winningDividend(result);
  const value={combination:result.result_trifecta,payout:payout,deadline:race.deadline};
  const prior=this.resultHistory.get(key);if(!prior)this.resultHistory.set(key,value);else if(prior.combination!==value.combination||prior.deadline!==value.deadline)this.conflicts.add(key);else {const previousPayout=this.resultEnrichment.get(key)??prior.payout;if(previousPayout!=null&&value.payout!=null&&previousPayout!==value.payout)this.conflicts.add(key);else if(previousPayout==null&&value.payout!=null)this.resultEnrichment.set(key,value.payout);}
 }
 watch(id){const existing=this.watchers.get(id);if(existing){existing.refs++;return()=>this.unwatch(id);}const w={refs:1,timer:null,stopped:false};this.watchers.set(id,w);
  const tick=async()=>{if(w.stopped)return;if(!this.hidden())await this.refresh(id);if(w.stopped)return;const state=this.get(id);if(state.halted||(state.closed&&(!this.waitForResult||winningDividend(state.result)!=null||state.race?.status==='cancelled')))return;w.timer=this.setTimer(tick,state.retryAfter||30000);};void tick();return()=>this.unwatch(id);
 }
 unwatch(id){const w=this.watchers.get(id);if(!w||--w.refs>0)return;w.stopped=true;if(w.timer!=null)this.clearTimer(w.timer);this.watchers.delete(id);}
 async pollResults(readResults){
  if(this.resultMonitorStopped)return;
  if(this.resultMonitorInflight)return this.resultMonitorInflight;
  const task=(async()=>{await this.restore();const now=this.clock(),byRace=new Map();
   for(const id of this.first.values()){const p=this.records.get(id)?.payload;if(p&&timeMs(p.deadline)<=timeMs(now))byRace.set(p.race_key,p.race);}
   const due=[...byRace].filter(([key])=>!this.conflicts.has(key)&&(this.resultHistory.get(key)?.payout==null&&this.resultEnrichment.get(key)==null)&&timeMs(now)-(this.resultAttempts.get(key)||0)>=60000).sort((a,b)=>(this.resultAttempts.get(a[0])||0)-(this.resultAttempts.get(b[0])||0)).slice(0,8);
   for(const [key,race] of due){this.resultAttempts.set(key,timeMs(now));try{
    const rows=await this.readBounded("result:"+race.id,()=>readResults(race));const final=selectFinalResult(rows,race.id);this.resultErrors.delete(key);
    if(final)this.observeResult(key,final,race,this.clock());

   }catch(e){this.resultErrors.set(key,'V7結果取得失敗：'+e.message);if(String(e.message||e).includes('競合'))this.conflicts.add(key);const status=e.status||e.response?.status;if(status===401||status===403)this.resultMonitorStopped=true;if(status===401||status===403||status===429)break;}
   }this.resultMonitorError=[...this.resultErrors.values()].join(" / ")||null;await this.persist();this.emit();
  })().finally(()=>{this.resultMonitorInflight=null;});this.resultMonitorInflight=task;return task;
 }
 export(){return {schema:'BOAT_LIVE_V7_ARCHIVE_V1',records:[...this.records.values()],first:[...this.first],results:[...this.resultHistory],conflicts:[...this.conflicts],resultEnrichment:[...this.resultEnrichment],sourceChecks:[...this.sourceChecks],quarantined:this.quarantined};}
}
export function summarizeLocal(controller,stage,{womenOnly=false}={}){
 const rows=[];for(const [key,id] of controller.first){const record=controller.records.get(id),p=record?.payload;if(!p||p.stage!==stage||key!==JSON.stringify([p.race_key,stage])||controller.conflicts.has(p.race_key))continue;
  if(womenOnly&&!(p.race.is_womens===true||/女子|レディース|ヴィーナス/i.test(p.race.series_name||'')))continue;
  const original=controller.resultHistory.get(p.race_key),result=original?{...original,payout:controller.resultEnrichment.get(p.race_key)??original.payout}:null;if(!result||result.deadline!==p.deadline||timeMs(p.generated_at)==null||timeMs(p.generated_at)>=timeMs(p.deadline))continue;
  const actual=result.combination.split('-'),ranks=p.output.marginals.map(m=>Object.entries(m).sort((a,b)=>b[1]-a[1]||+a[0]-+b[0])[0][0]);const hit=p.output.tickets.includes(result.combination);
  rows.push({id,rankHits:ranks.map((b,i)=>b===actual[i]),hit,tickets:p.output.tickets.length,payout:result.payout==null?null:hit?result.payout:0});
 }
 const n=rows.length,investment=rows.reduce((s,r)=>s+r.tickets*100,0),payout=rows.some(r=>r.payout==null)?null:rows.reduce((s,r)=>s+r.payout,0);
 return {n,rankAccuracy:[0,1,2].map(i=>n?rows.filter(r=>r.rankHits[i]).length/n:null),hits:rows.filter(r=>r.hit).length,hitRate:n?rows.filter(r=>r.hit).length/n:null,hypotheticalInvestment:investment,hypotheticalPayout:payout,hypotheticalRecovery:investment&&payout!=null?payout/investment:null,buy:0,formalCount:0,rows};
}