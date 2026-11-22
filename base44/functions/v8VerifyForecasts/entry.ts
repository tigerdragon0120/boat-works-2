import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {runV8VerifyForecasts} from '../../shared/v8VerificationRunner.js';

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);let user:any=null,body:any={};
  try{user=await client.auth.me()}catch{}
  if(user?.role!=='admin')return Response.json({ok:false,error:'Forbidden'},{status:403});
  try{body=await req.json()}catch{}
  try{return Response.json(await runV8VerifyForecasts(client,{dates:body?.race_date?[body.race_date]:undefined}));}
  catch(error:any){console.error('[V8_VERIFY]',String(error?.message||error).slice(0,150));return Response.json({ok:false,error:'VERIFICATION_INCOMPLETE'},{status:503});}
}
