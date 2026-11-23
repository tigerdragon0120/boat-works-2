// Scheduled V7 -> V8 generation without nested backend function invocations.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {runV8LiveGeneration} from '../../shared/v8LiveGeneration.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const body=await req.json().catch(()=>({}));
  const summary:any=await runV8LiveGeneration(client,{race_date:body?.race_date,horizon_minutes:body?.horizon_minutes});
  return Response.json(summary,{status:summary.ok?200:summary.error==='INVALID_LIVE_DATE'?400:503});
}
