import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {runLatestRacerSync} from '../../shared/latestRacerSync.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me();}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const body=await req.json().catch(()=>({}));
  const result=await runLatestRacerSync(client,{force:body.force===true,scheduled:body.scheduled===true});
  if(!result.ok)console.warn('[LATEST_RACER_SYNC]',JSON.stringify({error_code:result.error_code,status:result.latest_racer_sync?.status,next_check_at:result.latest_racer_sync?.next_check_at}));
  // The provider's temporary outage is a recorded data failure, not a reason to
  // disable the recurring workflow. Manual callers still receive an HTTP error.
  return Response.json(result,{status:result.ok||body.scheduled===true?200:502});
}
