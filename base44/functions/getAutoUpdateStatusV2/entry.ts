import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function getTodayJST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function addCalendarDays(ymd: string, days: number): string {
  const [y,m,d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole.entities;
    const today = getTodayJST();
    const tomorrow = addCalendarDays(today, 1);
    const statusList = await sr.AutoUpdateStatus.filter({ name: 'default' }, '-last_updated', 1).catch(() => []);
    const status = statusList?.[0] || null;
    const [todayRaces, tomorrowRaces, todayEntries, tomorrowEntries, results, prePreds] = await Promise.all([
      sr.Race.filter({ race_date: today }, 'race_number', 300).catch(() => []),
      sr.Race.filter({ race_date: tomorrow }, 'race_number', 300).catch(() => []),
      sr.RaceEntry.filter({ race_date: today }, 'boat_number', 5000).catch(() => []),
      sr.RaceEntry.filter({ race_date: tomorrow }, 'boat_number', 5000).catch(() => []),
      sr.RaceResult.filter({}, '-finished_at', 500).catch(() => []),
      sr.RacePrediction.filter({ stage: 'PRE' }, '-computed_at', 1000).catch(() => []),
    ]);
    const todayVenues=[...new Set(todayRaces.map((r:any)=>r.venue_code).filter(Boolean))];
    const tomorrowVenues=[...new Set(tomorrowRaces.map((r:any)=>r.venue_code).filter(Boolean))];
    const resultIds=new Set(results.map((r:any)=>r.race_id));
    const preIds=new Set(prePreds.map((p:any)=>p.race_id));
    const entryByRace:any={};
    for(const e of tomorrowEntries){const k=`${e.venue_code}_${e.race_number}`;entryByRace[k]=(entryByRace[k]||0)+1;}
    const incomplete=tomorrowRaces.filter((r:any)=>(entryByRace[`${r.venue_code}_${r.race_number}`]||0)<6).length;
    return Response.json({ok:true,today,tomorrow,jst_time:new Date().toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo'}),status:status?.status||'idle',last_updated:status?.last_updated||null,current_step:status?.current_step||null,today_venues:todayVenues.length,today_venue_codes:todayVenues,today_races:todayRaces.length,today_entries:todayEntries.length,today_results:todayRaces.filter((r:any)=>resultIds.has(r.id)).length,today_pre:todayRaces.filter((r:any)=>preIds.has(r.id)).length,today_exhibition:todayRaces.filter((r:any)=>r.exhibition_ready).length,tomorrow_venues:tomorrowVenues.length,tomorrow_venue_codes:tomorrowVenues,tomorrow_races:tomorrowRaces.length,tomorrow_entries:tomorrowEntries.length,tomorrow_pre:tomorrowRaces.filter((r:any)=>preIds.has(r.id)).length,tomorrow_incomplete:incomplete,errors:status?.errors||[]});
  } catch(error:any){return Response.json({ok:false,error:error.message},{status:500});}
}
