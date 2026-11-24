// V8-only forecast and observation pipeline; shared modules rebundled.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {runV8ReplayForecasts} from '../../shared/v8ReplayCapture.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  let options:any={};
  try{options=await req.json()}catch{}
  try{return Response.json(await runV8ReplayForecasts(client,options));}
  catch(error:any){console.error('[V8_REPLAY]',String(error?.message||error).slice(0,160));return Response.json({ok:false,error:'REPLAY_READ_OR_SAVE_FAILED',details:String(error?.message||error).slice(0,120)},{status:503});}
}