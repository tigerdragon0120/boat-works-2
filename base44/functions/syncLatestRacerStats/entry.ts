import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {runLatestRacerSync} from '../../shared/latestRacerSync.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me();}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const body=await req.json().catch(()=>({}));
  const result=await runLatestRacerSync(client,{force:body.force===true,scheduled:body.scheduled===true});
  return Response.json(result,{status:result.ok?200:502});
}
