import {readV8Rows} from './v8Repository.js';
import {fetchLatestRacerDataset} from './latestRacerOfficialSource.js';
import {LATEST_RACER_STATE_KEY,RACER_PAGE_SIZE,readLatestRacerState,racerDataHash,racerDatasetMetadata,assembleRacerDataset,latestRacerSyncView,nextRacerCheck} from './latestRacerStore.js';

const iso=()=>new Date().toISOString();
const ordered=(rows)=>rows.sort((a,b)=>String(a.created_date||'').localeCompare(String(b.created_date||''))||String(a.id).localeCompare(String(b.id)));
const termOrder=term=>{const m=/^(\d{4})_(FIRST|SECOND)$/.exec(term||'');return m?Number(m[1])*2+(m[2]==='SECOND'?1:0):-1;};

// Failed reads cannot be interpreted as an empty lock/ledger and lead to duplicate writes.
async function lockSync(sr,budget){
  const key='OFFICIAL_LATEST_RACER_STATS',now=Date.now();
  const active=await readV8Rows(sr.ProcessLock,{lock_key:key,status:'active'},{budget,maxPages:3});
  if(active.some(r=>Date.parse(r.expires_at)>now))return null;
  const lock=await sr.ProcessLock.create({lock_key:key,owner:'syncLatestRacerStats_'+crypto.randomUUID(),acquired_at:iso(),expires_at:new Date(now+110000).toISOString(),status:'active'});
  if(!lock?.id)throw new Error('RACER_LOCK_SAVE_UNCONFIRMED');
  const candidates=ordered((await readV8Rows(sr.ProcessLock,{lock_key:key,status:'active'},{budget,maxPages:3})).filter(r=>Date.parse(r.expires_at)>Date.now()));
  if(candidates[0]?.id!==lock.id){await sr.ProcessLock.update(lock.id,{status:'released'});return null;}
  return lock.id;
}

export async function runLatestRacerSync(client,{force=false,scheduled=false,budgetMs=75000,fetchDataset=fetchLatestRacerDataset}={}){
  const sr=client.asServiceRole.entities,started=Date.now(),budget=started+Math.min(85000,Math.max(1000,budgetMs));
  let lock=null,state=null,initialActiveKey='';
  const persist=async patch=>{const saved=await sr.RacerStatsSync.update(state.id,patch);if(!saved?.id)throw new Error('RACER_SYNC_SAVE_UNCONFIRMED');state={...state,...patch,...saved};};
  try{
    lock=await lockSync(sr,budget);
    if(!lock)return {ok:true,skipped:'locked',message:'最新成績を確認中です'};
    state=await readLatestRacerState(sr,{budget});
    if(!state){
      const created=await sr.RacerStatsSync.create({state_key:LATEST_RACER_STATE_KEY,enabled:scheduled,status:'idle',pending_count:0,imported_count:0});
      if(!created?.id)throw new Error('RACER_SYNC_CREATE_UNCONFIRMED');
      state=await readLatestRacerState(sr,{budget});
      if(!state?.id)throw new Error('RACER_SYNC_STATE_MISSING');
    }
    initialActiveKey=state.active_dataset_key||'';
    if(!force&&!scheduled&&state.status==='ready'&&Date.parse(state.next_check_at)>started)return {ok:true,skipped:'not_due',latest_racer_sync:latestRacerSyncView(state)};
    await persist({status:'checking',last_checked_at:iso(),error_message:'',...(scheduled?{enabled:true}:{})});
    const payload=await fetchDataset({budget:Math.min(budget-12000,Date.now()+30000),previousChecksum:state.active_metadata?.checksum});
    if(termOrder(payload.source.term_key)<termOrder(state.active_metadata?.term_key))throw new Error('公式最新期が保存済みの期より古いため更新を保留しました');
    const datasetKey=payload.source.term_key+':'+payload.checksum;
    if(state.active_dataset_key===datasetKey){
      await persist({status:'ready',last_success_at:iso(),next_check_at:nextRacerCheck(),pending_count:0,imported_count:payload.record_count,error_message:'',unchanged:true,pending_dataset_key:''});
      return {ok:true,unchanged:true,latest_racer_sync:latestRacerSyncView(state),duration_ms:Date.now()-started};
    }
    const records=payload.records.map(r=>({...r,source_file:payload.source.file_name})).sort((a,b)=>Number(a.registration_number)-Number(b.registration_number));
    const recordsHash=await racerDataHash(records),pageCount=Math.ceil(records.length/RACER_PAGE_SIZE);
    const candidates=await readV8Rows(sr.RacerStatsDataset,{dataset_key:datasetKey},{budget,maxPages:2});
    let dataset=ordered(candidates)[0];
    if(dataset&&(dataset.records_hash!==recordsHash||dataset.record_count!==records.length))throw new Error('RACER_DATASET_MANIFEST_CONFLICT');
    if(!dataset){
      dataset=await sr.RacerStatsDataset.create({dataset_key:datasetKey,term_key:payload.source.term_key,source_url:payload.source.url,source_index_url:payload.source.index_url,source_file:payload.source.file_name,checksum:payload.checksum,records_hash:recordsHash,record_count:records.length,page_count:pageCount,first_seen_at:payload.fetched_at,status:'staging',term_start_date:payload.term_start_date,term_end_date:payload.term_end_date});
      if(!dataset?.id)throw new Error('RACER_DATASET_SAVE_UNCONFIRMED');
    }
    const pages=await readV8Rows(sr.RacerStatsPage,{dataset_key:datasetKey},{budget,maxPages:2,sort:'page_index'});
    const existing=new Map();
    for(const page of pages){
      if(!Number.isInteger(page.page_index)||page.page_index<0||page.page_index>=pageCount)throw new Error('RACER_DATASET_PAGE_INVALID');
      const expected=await racerDataHash(records.slice(page.page_index*RACER_PAGE_SIZE,(page.page_index+1)*RACER_PAGE_SIZE));
      if(page.content_hash!==expected||await racerDataHash(page.records)!==expected)throw new Error('RACER_DATASET_PAGE_CONFLICT');
      existing.set(page.page_index,page);
    }
    let imported=[...existing.values()].reduce((sum,p)=>sum+p.record_count,0);
    await persist({status:'importing',pending_dataset_key:datasetKey,pending_count:records.length-imported,imported_count:imported,unchanged:false});
    for(let index=0;index<pageCount;index++){
      if(existing.has(index))continue;
      if(Date.now()+10000>=budget){
        await persist({status:'idle',pending_count:records.length-imported,imported_count:imported,next_check_at:nextRacerCheck()});
        return {ok:true,complete:false,latest_racer_sync:latestRacerSyncView(state),duration_ms:Date.now()-started};
      }
      const part=records.slice(index*RACER_PAGE_SIZE,(index+1)*RACER_PAGE_SIZE);
      const page=await sr.RacerStatsPage.create({dataset_key:datasetKey,page_index:index,record_count:part.length,records:part,content_hash:await racerDataHash(part)});
      if(!page?.id)throw new Error('RACER_DATASET_PAGE_SAVE_UNCONFIRMED');
      existing.set(index,page);imported+=part.length;
      // Persist a bounded progress checkpoint; next run always rereads the actual pages.
      if(index%4===3)await persist({pending_count:records.length-imported,imported_count:imported});
    }
    const savedPages=await readV8Rows(sr.RacerStatsPage,{dataset_key:datasetKey},{budget,maxPages:2,sort:'page_index'});
    await assembleRacerDataset(dataset,savedPages);
    const activated=dataset.activated_at||iso();
    const ready=await sr.RacerStatsDataset.update(dataset.id,{status:'ready',activated_at:activated});
    if(!ready?.id)throw new Error('RACER_DATASET_ACTIVATION_UNCONFIRMED');
    dataset={...dataset,...ready,status:'ready',activated_at:activated};
    // A delayed worker may have outlived its lease while awaiting an SDK write.
    // It must not roll back a snapshot already installed by a newer worker.
    const [leases,currentState]=await Promise.all([
      readV8Rows(sr.ProcessLock,{lock_key:'OFFICIAL_LATEST_RACER_STATS',status:'active'},{budget,maxPages:3}),
      readLatestRacerState(sr,{budget}),
    ]);
    const owner=ordered(leases.filter(r=>Date.parse(r.expires_at)>Date.now()))[0];
    if(owner?.id!==lock||Date.now()>=budget)throw new Error('RACER_SYNC_LEASE_EXPIRED');
    if(currentState?.id!==state.id||!['',initialActiveKey,datasetKey].includes(currentState.active_dataset_key||'')||termOrder(currentState.active_metadata?.term_key)>termOrder(dataset.term_key))throw new Error('RACER_SYNC_NEWER_DATASET_ACTIVE');
    // The active pointer is the last write, after all persisted pages pass integrity checks.
    await persist({status:'ready',active_dataset_key:datasetKey,active_metadata:racerDatasetMetadata(dataset),last_success_at:iso(),next_check_at:nextRacerCheck(),pending_count:0,imported_count:records.length,pending_dataset_key:'',error_message:'',unchanged:false});
    return {ok:true,complete:true,unchanged:false,latest_racer_sync:latestRacerSyncView(state),duration_ms:Date.now()-started};
  }catch(error){
    const reason=String(error?.message||'最新成績の取得に失敗しました').split('\n')[0].replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,180);
    const phase=reason.includes('INDEX_HTTP')?'配布一覧':reason.includes('ARCHIVE_HTTP')?'配布ファイル':'公式サイト';
    const friendly=/HTTP_403/.test(reason)?`${phase}が今回の接続を拒否しました（HTTP 403）。保存済みの成績を維持し、次回の自動確認で再試行します。`
      :/HTTP_429/.test(reason)?'公式サイトのアクセス制限中です。保存済みの成績を維持し、次回の自動確認で再試行します。'
      :/BUDGET|abort|timed?out/i.test(reason)?'公式データの確認が時間内に完了しませんでした。保存済みの成績を維持し、次回確認で再開します。':reason;
    if(state?.id&&!['RACER_SYNC_LEASE_EXPIRED','RACER_SYNC_NEWER_DATASET_ACTIVE'].includes(reason)){
      try{await persist({status:'error',error_message:friendly,next_check_at:nextRacerCheck()});}catch{}
    }
    return {ok:false,error:friendly,error_code:reason,latest_racer_sync:latestRacerSyncView(state),duration_ms:Date.now()-started};
  }finally{if(lock){try{await sr.ProcessLock.update(lock,{status:'released'});}catch{}}}
}
