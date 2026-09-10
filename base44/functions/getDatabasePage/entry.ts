import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

async function oneTerm(sr:any, termKey:string) {
  const out:any[]=[]; const limit=500;
  for(let skip=0; skip<=10000; skip+=limit){
    const rows=await sr.RacerTermStats.filter({term_key:termKey},'registration_number',limit,skip);
    if(!rows?.length) break; out.push(...rows); if(rows.length<limit) break;
  }
  // 過去の再取込で同じ登録番号が複数あるため、1選手1件へ正規化
  const byReg=new Map<string,any>();
  for(const r of out){const reg=String(r.registration_number||'').trim();if(!reg)continue;const prev=byReg.get(reg);const rt=String(r.updated_date||r.imported_at||r.created_date||'');const pt=String(prev?.updated_date||prev?.imported_at||prev?.created_date||'');if(!prev||rt>=pt)byReg.set(reg,r);}
  return [...byReg.values()].sort((a,b)=>Number(a.registration_number||0)-Number(b.registration_number||0));
}

export default async function(req:Request){
 const base44=createClientFromRequest(req);
 try{
  await base44.auth.me(); const sr=base44.asServiceRole.entities; const body=await req.json().catch(()=>({}));
  const latest=await sr.RacerTermStats.filter({},'-term_key',1,0);
  const latestTerm=String(latest?.[0]?.term_key||'');
  const mode=body.mode||'summary';
  if(mode==='summary'){
    if(!latestTerm)return Response.json({ok:true,latest_term:'',profile_count:0,latest_term_count:0});
    const current=await oneTerm(sr,latestTerm);
    return Response.json({ok:true,latest_term:latestTerm,profile_count:current.length,latest_term_count:current.length});
  }
  const termKey=String(body.term_key||latestTerm); const q=String(body.q||'').trim().toLowerCase(); const page=Math.max(1,Number(body.page||1)); const pageSize=Math.min(200,Math.max(20,Number(body.page_size||100)));
  // プロフィールも最新期を正として表示。全期間全件を読む処理は禁止。
  let source=await oneTerm(sr,mode==='profiles'?latestTerm:termKey);
  if(q)source=source.filter((x:any)=>[x.racer_name,x.player_name,x.registration_number,x.branch_name,x.branch,x.player_class,x.grade_class,x.term_key,x.source_file].filter(v=>v!=null).join(' ').toLowerCase().includes(q));
  const total=source.length,start=(page-1)*pageSize;
  return Response.json({ok:true,total,page,page_size:pageSize,term_key:mode==='profiles'?latestTerm:termKey,rows:source.slice(start,start+pageSize)});
 }catch(e:any){return Response.json({ok:false,error:e?.message||String(e)},{status:500});}
}
