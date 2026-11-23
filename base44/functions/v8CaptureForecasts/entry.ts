// Backward-compatible standalone entry; scheduled consolidation calls the same shared runner.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {runV8LiveCapture} from '../../shared/v8LiveCapture.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  const summary=await runV8LiveCapture(client);
  return Response.json(summary,{status:summary.ok?200:503});
}
