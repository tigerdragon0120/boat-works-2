import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';
import { buildRaceKey, mapRace, mapEntry, mapResult } from '../../shared/raceKey.js';
import { upsertRace, upsertEntry } from '../../shared/predictionService.js';

function prevDate(s){ const d=new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); }

async function fetchJson(url,key){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),45000);
  try{
    const r=await fetch(url,{headers:{Authorization:`Bearer ${key}`},signal:c.signal});
    if(!r.ok) throw new Error(`BOAT WORKS API ${r.status}: ${(await r.text().catch(()=>'' )).slice(0,300)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export default async function(req){
  try{
    const base44=createClientFromRequest(req);
    let user=null; try{user=await base44.auth.me();}catch{}
    if(user&&user.role!=='admin') return Response.json({status:'error',message:'管理者権限が必要です'},{status:403});
    const body=await req.json().catch(()=>({}));

    const oldest=(await base44.asServiceRole.entities.Race.filter({},'race_date',1).catch(()=>[]))[0];
    if(!oldest?.race_date) return Response.json({status:'waiting',message:'基準となるRaceがありません'});
    const targetDate=body.date||prevDate(oldest.race_date);

    const base=secrets.get('BOAT_WORKS_API_BASE');
    const key=secrets.get('BOAT_WORKS_API_KEY');
    if(!base||!key) return Response.json({status:'error',message:'BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY 未設定'},{status:500});
    const normalized=String(base).replace(/\/$/,'');
    const endpoint=normalized.includes('exportBoatWorksData')?normalized:`${normalized}/exportBoatWorksData`;

    const manifest=await fetchJson(`${endpoint}?date=${encodeURIComponent(targetDate)}&manifest=1`,key);
    const venues=(manifest.venue_codes||[]).map((x)=>String(x).padStart(2,'0'));
    if(!venues.length||!manifest.race_count){
      return Response.json({status:'waiting_source',target_date:targetDate,race_count:manifest.race_count||0,message:'BOAT WORKS側のフルデータ待ち'});
    }

    let racesSaved=0, entriesSaved=0, resultsSaved=0; const errors=[];
    for(const venueCode of venues){
      try{
        const p=await fetchJson(`${endpoint}?date=${encodeURIComponent(targetDate)}&venue_code=${encodeURIComponent(venueCode)}`,key);
        const seriesMap={};
        for(const s of (p.series||[])){
          const rk=s.race_key||buildRaceKey(s.race_date,s.venue_code,s.race_number);
          const reg=String(s.registration_number||s.register_number||'').trim();
          if(rk&&reg) seriesMap[`${rk}_${reg}`]=s;
        }
        for(const srcRace of (p.races||[])){
          const raceData=mapRace(srcRace);
          const race=await upsertRace(base44,{...raceData,sync_source:'historical_auto'});
          racesSaved++;
          const raceEntries=(p.entries||[]).filter((e)=>(e.race_key||buildRaceKey(e.race_date,e.venue_code,e.race_number))===raceData.race_key);
          for(const e of raceEntries){
            const reg=String(e.registration_number||e.register_number||'').trim();
            await upsertEntry(base44,{...mapEntry(e,seriesMap[`${raceData.race_key}_${reg}`]||{}),race_id:race.id});
            entriesSaved++;
          }
          const srcResult=(p.results||[]).find((r)=>(r.race_key||buildRaceKey(r.race_date,r.venue_code,r.race_number))===raceData.race_key);
          if(srcResult){
            const m=mapResult(srcResult);
            if(m.result_trifecta){
              const old=(await base44.asServiceRole.entities.RaceResult.filter({race_id:race.id},'-finished_at',1).catch(()=>[]))[0];
              const doc={race_id:race.id,race_key:raceData.race_key,result_trifecta:m.result_trifecta,finish_order:m.finish_order||[],payout:m.payout||0,is_finished:true,finished_at:new Date().toISOString()};
              if(old) await base44.asServiceRole.entities.RaceResult.update(old.id,doc); else await base44.asServiceRole.entities.RaceResult.create(doc);
              await base44.asServiceRole.entities.Race.update(race.id,{status:'finished'});
              resultsSaved++;
            }
          }
        }
      }catch(e){errors.push({venue_code:venueCode,message:e?.message||String(e)});}
    }

    let dbRefresh=null;
    try{ const rr=await base44.asServiceRole.functions.invoke('refreshDatabase',{}); dbRefresh=rr?.data||rr; }catch(e){ errors.push({step:'refreshDatabase',message:e?.message||String(e)}); }

    return Response.json({status:errors.length?'partial':'success',target_date:targetDate,venues:venues.length,races_saved:racesSaved,entries_saved:entriesSaved,results_saved:resultsSaved,errors,db_refresh:dbRefresh});
  }catch(error){return Response.json({status:'error',message:error?.message||String(error)},{status:500});}
}
