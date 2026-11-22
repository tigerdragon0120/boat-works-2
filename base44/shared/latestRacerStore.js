// Complete, immutable official snapshots. Readers never see a partially imported period.
import {readV8Rows} from './v8Repository.js';

export const LATEST_RACER_STATE_KEY='official_latest';
export const LATEST_RACER_SCHEDULE='毎日 6:20・12:20・18:20（日本時間）';
export const RACER_PAGE_SIZE=100;
const readyCache=new Map();
const chronological=(a,b)=>String(a.created_date||'').localeCompare(String(b.created_date||''))||String(a.id).localeCompare(String(b.id));

export function nextRacerCheck(now=Date.now()){
  const jst=new Date(now+9*3600000),day=jst.toISOString().slice(0,10);
  for(const hour of [6,12,18]){const at=Date.parse(`${day}T${String(hour).padStart(2,'0')}:20:00+09:00`);if(at>now)return new Date(at).toISOString();}
  const tomorrow=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  return new Date(`${tomorrow}T06:20:00+09:00`).toISOString();
}

export async function racerDataHash(value){
  // Stable key ordering also tolerates database serializers reordering object fields.
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
  const bytes=new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
}

export async function readLatestRacerState(sr,{budget=Date.now()+12000}={}){
  const rows=await readV8Rows(sr.RacerStatsSync,{state_key:LATEST_RACER_STATE_KEY},{budget,maxPages:2});
  // Consistent canonical row if a first-run create raced. Never select an incomplete import.
  return rows.sort(chronological)[0]||null;
}

export function racerDatasetMetadata(row){
  if(!row)return null;
  return Object.fromEntries(['dataset_key','term_key','source_url','source_file','source_index_url','first_seen_at','activated_at','checksum','records_hash','record_count','page_count','term_start_date','term_end_date'].map(k=>[k,row[k]]));
}

export async function assembleRacerDataset(dataset,pages){
  if(!dataset||!Number.isInteger(dataset.record_count)||dataset.record_count<1||!Number.isInteger(dataset.page_count)||dataset.page_count<1)throw new Error('RACER_DATASET_MANIFEST_INVALID');
  const byPage=new Map();
  for(const page of pages){
    if(page.dataset_key!==dataset.dataset_key||!Number.isInteger(page.page_index)||page.page_index<0||page.page_index>=dataset.page_count||!Array.isArray(page.records)||page.record_count!==page.records.length)throw new Error('RACER_DATASET_PAGE_INVALID');
    const hash=await racerDataHash(page.records);
    if(hash!==page.content_hash)throw new Error('RACER_DATASET_PAGE_HASH_MISMATCH');
    const old=byPage.get(page.page_index);
    if(old&&old.content_hash!==hash)throw new Error('RACER_DATASET_PAGE_CONFLICT');
    byPage.set(page.page_index,page);
  }
  if(byPage.size!==dataset.page_count)throw new Error('RACER_DATASET_INCOMPLETE');
  const records=[...byPage.values()].sort((a,b)=>a.page_index-b.page_index).flatMap(page=>page.records);
  if(records.length!==dataset.record_count||new Set(records.map(r=>String(r.registration_number))).size!==records.length)throw new Error('RACER_DATASET_COUNT_MISMATCH');
  if(records.some(r=>r.term_key!==dataset.term_key||r.term_start_date!==dataset.term_start_date||r.term_end_date!==dataset.term_end_date))throw new Error('RACER_DATASET_PERIOD_MISMATCH');
  if(await racerDataHash(records)!==dataset.records_hash)throw new Error('RACER_DATASET_HASH_MISMATCH');
  return records;
}

export async function loadLatestRacerDataset(sr,{budget=Date.now()+15000,state:providedState}={}){
  const state=providedState===undefined?await readLatestRacerState(sr,{budget}):providedState;
  if(!state?.active_dataset_key)return null;
  const rows=await readV8Rows(sr.RacerStatsDataset,{dataset_key:state.active_dataset_key,status:'ready'},{budget,maxPages:2});
  const dataset=rows.sort(chronological)[0];
  if(!dataset)throw new Error('ACTIVE_RACER_DATASET_MISSING');
  const cached=readyCache.get(dataset.dataset_key);
  if(cached&&cached.hash===dataset.records_hash&&cached.until>Date.now())return {records:cached.records,metadata:racerDatasetMetadata(dataset)};
  const pages=await readV8Rows(sr.RacerStatsPage,{dataset_key:dataset.dataset_key},{budget,maxPages:2,sort:'page_index'});
  const records=await assembleRacerDataset(dataset,pages);
  readyCache.clear();readyCache.set(dataset.dataset_key,{hash:dataset.records_hash,records,until:Date.now()+15*60000});
  return {records,metadata:racerDatasetMetadata(dataset)};
}

export function latestRacerSyncView(state,metadata=null){
  const m=metadata||state?.active_metadata||{};
  return {
    enabled:state?.enabled===true,status:state?.status||'idle',latest_term:m.term_key||'',record_count:m.record_count||0,
    source_file:m.source_file||'',source_url:m.source_url||'',last_checked_at:state?.last_checked_at||null,
    last_success_at:state?.last_success_at||null,next_check_at:state?.next_check_at||null,
    error_message:state?.error_message||'',calculation_start:m.term_start_date||null,calculation_end:m.term_end_date||null,
    prediction_connected:true,pending_count:Math.max(0,Number(state?.pending_count||0)),imported_count:Number(state?.imported_count||0),
    schedule_label:state?.enabled?LATEST_RACER_SCHEDULE:'',dataset_key:m.dataset_key||'',unchanged:state?.unchanged===true,
  };
}
