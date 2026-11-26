import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {dateValid,readV8Rows} from '../../shared/v8Repository.js';
import {loadRecentLaneSnapshots,ensureRecentLaneSnapshot,recentLaneSnapshotResponse} from '../../shared/v8RecentLaneStore.js';

// The table and scheduled V8 capture use the same durable observation.
// Anonymous readers can inspect it but cannot trigger acquisition.
export default async function(req:Request){
  try{
    const client=createClientFromRequest(req),sr=client.asServiceRole.entities,budget=Date.now()+12000;
    let user=null;
    try{user=await client.auth.me();}catch{}
    const body=await req.json().catch(()=>({}));
    const rawDate=String(body.race_date||''),raceDate=/^\d{8}$/.test(rawDate)
      ?rawDate.slice(0,4)+'-'+rawDate.slice(4,6)+'-'+rawDate.slice(6,8):rawDate;
    const venueCode=String(body.venue_code??'').padStart(2,'0'),raceNumber=Number(body.race_number);
    if(!dateValid(raceDate)||!/^\d{2}$/.test(venueCode)||Number(venueCode)<1||Number(venueCode)>24
      ||!Number.isInteger(raceNumber)||raceNumber<1||raceNumber>12)return Response.json({ok:false,status:'INVALID',reason:'RACE_IDENTITY_INVALID',rows:[]},{status:400});
    const raceKey=raceDate+'_'+venueCode+'_'+String(raceNumber).padStart(2,'0');
    if(body.race_key!=null&&body.race_key!==raceKey)return Response.json({ok:false,status:'INVALID',reason:'RACE_IDENTITY_MISMATCH',rows:[]},{status:400});
    const races=await readV8Rows(sr.Race,body.race_id?{id:String(body.race_id)}:{race_key:raceKey},{budget,maxPages:2});
    if(races.length!==1||races[0].race_key!==raceKey||races[0].race_date!==raceDate
      ||String(races[0].venue_code).padStart(2,'0')!==venueCode||Number(races[0].race_number)!==raceNumber)
      return Response.json({ok:false,status:'INVALID',reason:'SAVED_RACE_NOT_UNIQUE',rows:[]},{status:404});
    const race=races[0];
    const [entries,loaded]=await Promise.all([
      readV8Rows(sr.RaceEntry,{race_id:race.id},{budget,maxPages:2}),
      loadRecentLaneSnapshots(sr,{raceIds:[race.id],budget}),
    ]);
    if(loaded.status!=='READY')return Response.json({ok:false,status:loaded.status,reason:loaded.reason,rows:[]});
    const result=await ensureRecentLaneSnapshot(client,{race,entries,cached:loaded.byRaceId.get(race.id)||[],
      now:new Date().toISOString(),budget,allowFetch:!!user});
    return Response.json(recentLaneSnapshotResponse(result));
  }catch{
    return Response.json({ok:false,status:'READ_FAILED',reason:'RECENT_LANE_REQUEST_FAILED',rows:[]},{status:503});
  }
}
