import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {readV8Rows} from '../../shared/v8Repository.js';
import {readLatestRacerState,loadLatestRacerDataset,latestRacerSyncView} from '../../shared/latestRacerStore.js';

const termValid=(term:any)=>typeof term==='string'&&/^\d{4}_(FIRST|SECOND)$/.test(term);
async function oneLegacyTerm(sr:any,termKey:string,budget:number){
  if(!termValid(termKey))return [];
  const rows=await readV8Rows(sr.RacerTermStats,{term_key:termKey},{budget,maxPages:60,sort:'registration_number'});
  const byReg=new Map<string,any>();
  for(const r of rows){const reg=String(r.registration_number||'').trim();if(!reg)continue;const previous=byReg.get(reg);if(!previous||String(r.updated_date||r.imported_at||r.created_date||'')>=String(previous.updated_date||previous.imported_at||previous.created_date||''))byReg.set(reg,r);}
  return [...byReg.values()].sort((a,b)=>Number(a.registration_number)-Number(b.registration_number));
}
async function newestLegacyTerm(sr:any){
  const page=await sr.RacerTermStats.filter({},{sort:'-term_key',limit:1});
  if(!page||!Array.isArray(page.items))throw new Error('期別成績の取得形式を確認できませんでした');
  return String(page.items[0]?.term_key||'');
}
async function knownTerms(sr:any,latestTerm:string,budget:number){
  const [datasets,logs]=await Promise.all([
    readV8Rows(sr.RacerStatsDataset,{status:'ready'},{budget,maxPages:10}),
    readV8Rows(sr.DataImportLog,{import_type:'racer_data'},{budget,maxPages:30}),
  ]);
  return [...new Set([latestTerm,...datasets.map((r:any)=>r.term_key),...logs.flatMap((r:any)=>r.details?.term_keys||[])].filter(termValid))].sort().reverse();
}
export default async function(req:Request){
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me();}catch{}
  if(!user)return Response.json({ok:false,error:'Unauthorized'},{status:401});
  if(user.role!=='admin')return Response.json({ok:false,error:'Forbidden: admin only'},{status:403});
  try{
    const sr=client.asServiceRole.entities,body=await req.json().catch(()=>({})),budget=Date.now()+35000;
    const state=await readLatestRacerState(sr,{budget});
    const active=state?.active_metadata||null;
    const latestTerm=active?.term_key||await newestLegacyTerm(sr);
    const mode=body.mode||'summary';
    if(mode==='summary'){
      const currentCount=state?.active_dataset_key?Number(active?.record_count||0):(await oneLegacyTerm(sr,latestTerm,budget)).length;
      let available=[latestTerm].filter(termValid),catalogError='';
      try{available=await knownTerms(sr,latestTerm,budget);}catch{catalogError='過去期の一覧を取得できませんでした。再読込してください。';}
      return Response.json({ok:true,latest_term:latestTerm,profile_count:currentCount,latest_term_count:currentCount,available_terms:available,term_catalog_error:catalogError,latest_racer_sync:latestRacerSyncView(state)});
    }
    if(!['profiles','terms'].includes(mode))return Response.json({ok:false,error:'Unknown database mode'},{status:400});
    const termKey=mode==='profiles'?latestTerm:String(body.term_key||latestTerm);
    if(termKey&&!termValid(termKey))return Response.json({ok:false,error:'Invalid term'},{status:400});
    let source:any[]=[];
    if(termKey===active?.term_key&&state?.active_dataset_key){
      const dataset=await loadLatestRacerDataset(sr,{state,budget});
      if(!dataset)throw new Error('最新期の成績を読み込めませんでした');
      source=dataset.records.map((r:any)=>({...r,id:dataset.metadata.dataset_key+':'+r.registration_number,imported_at:dataset.metadata.activated_at}));
    }else source=await oneLegacyTerm(sr,termKey,budget);
    const q=String(body.q||'').trim().toLowerCase();
    if(q)source=source.filter((r:any)=>[r.racer_name,r.player_name,r.registration_number,r.branch_name,r.branch,r.player_class,r.grade_class,r.term_key,r.source_file].filter(v=>v!=null).join(' ').toLowerCase().includes(q));
    const page=Math.max(1,Math.floor(Number(body.page)||1)),pageSize=Math.min(200,Math.max(20,Math.floor(Number(body.page_size)||100))),start=(page-1)*pageSize;
    return Response.json({ok:true,total:source.length,page,page_size:pageSize,term_key:termKey,rows:source.slice(start,start+pageSize)});
  }catch(error:any){return Response.json({ok:false,error:String(error?.message||'DB read failed').slice(0,180)},{status:500});}
}
