// Compatible admin endpoint; the shared runner is also used by the consolidated research schedule.
import {createClientFromRequest} from "npm:@base44/sdk@0.8.60";
import {runV7CaptureFeatures} from "../../shared/v7FeatureCaptureRunner.js";

export default async function(req:Request):Promise<Response>{
  const client=createClientFromRequest(req);
  let user:any=null;
  try{user=await client.auth.me()}catch{}
  if(!user)return Response.json({ok:false,error:"Unauthorized"},{status:401});
  if(user.role!=="admin")return Response.json({ok:false,error:"Forbidden"},{status:403});
  const body=await req.json().catch(()=>({}));
  return runV7CaptureFeatures(client,{dryRun:body?.dry_run===true});
}
