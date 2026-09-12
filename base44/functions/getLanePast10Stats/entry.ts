import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const sleep = (ms:number) => new Promise(r => setTimeout(r, ms));
const num = (v:any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n:number) => Math.round(n * 10) / 10;
const round3 = (n:number) => Math.round(n * 1000) / 1000;

async function retry<T>(fn:()=>Promise<T>, max=5):Promise<T> {
  let last:any;
  for (let i=0;i<=max;i++) {
    try { return await fn(); } catch(e:any) {
      last=e;
      const msg=String(e?.message || e || '');
      if (!/rate\s*limit|429|too many requests/i.test(msg) || i===max) throw e;
      await sleep(Math.min(10000, 800 * 2 ** i));
    }
  }
  throw last;
}

function calcStartOrder(target:any, peers:any[]) {
  const valid = (peers || [])
    .filter((p:any) => !p.is_absent && !p.is_disqualified && num(p.st) != null)
    .sort((a:any,b:any) => Number(a.st) - Number(b.st));
  const idx = valid.findIndex((p:any) => p.id === target.id || (
    String(p.registration_number) === String(target.registration_number) && Number(p.boat_number) === Number(target.boat_number)
  ));
  return idx >= 0 ? idx + 1 : null;
}

export default async function(req:Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ok:false,error:'Unauthorized'},{status:401});
    const body = await req.json().catch(()=>({}));
    const requested = Array.isArray(body.entries) ? body.entries.slice(0,6) : [];
    const sr = base44.asServiceRole.entities;
    const by_key:any = {};

    for (const item of requested) {
      const reg = String(item.registration_number || '').trim();
      const lane = Number(item.lane);
      if (!/^\d{4}$/.test(reg) || lane < 1 || lane > 6) continue;

      const allHist:any[] = await retry(() => sr.RacerRaceHistory.filter({registration_number:reg}, '-race_date', 300)).catch(()=>[]);
      const sameLane = (allHist || [])
        .filter((h:any) => Number(h.boat_number) === lane && !h.is_absent && !h.is_disqualified)
        .slice(0,10);

      const recent10:any[] = [];
      for (const h of sameLane) {
        let startOrder = num(h.start_order);
        if (startOrder == null && h.race_date && h.venue_code && h.race_number) {
          const peers:any[] = await retry(() => sr.RacerRaceHistory.filter({
            race_date:h.race_date, venue_code:h.venue_code, race_number:h.race_number
          }, 'boat_number', 10)).catch(()=>[]);
          startOrder = calcStartOrder(h, peers);
          if (startOrder != null && h.id) {
            await sr.RacerRaceHistory.update(h.id,{start_order:startOrder}).catch(()=>{});
          }
        }
        recent10.push({
          id:h.id, race_date:h.race_date, venue_code:h.venue_code, race_number:h.race_number,
          boat_number:Number(h.boat_number), course:num(h.course), finish_order:num(h.finish_order),
          st:num(h.st), start_order:startOrder
        });
        await sleep(40);
      }

      const finished = recent10.filter((h:any)=>h.finish_order>=1 && h.finish_order<=6);
      const stVals = recent10.map((h:any)=>num(h.st)).filter((v:any)=>v!=null);
      const soVals = recent10.map((h:any)=>num(h.start_order)).filter((v:any)=>v!=null);
      const stats:any = {
        registration_number:reg,
        lane,
        sample_count:recent10.length,
        win_rate:finished.length ? round1(finished.filter((h:any)=>h.finish_order===1).length / finished.length * 100) : null,
        top2_rate:finished.length ? round1(finished.filter((h:any)=>h.finish_order<=2).length / finished.length * 100) : null,
        top3_rate:finished.length ? round1(finished.filter((h:any)=>h.finish_order<=3).length / finished.length * 100) : null,
        avg_st:stVals.length ? round3(stVals.reduce((a:number,b:number)=>a+b,0)/stVals.length) : null,
        avg_start_order:soVals.length ? round1(soVals.reduce((a:number,b:number)=>a+b,0)/soVals.length) : null,
        recent10,
        updated_at:new Date().toISOString(),
      };

      const old = await sr.RacerLaneRecentStats.filter({registration_number:reg,lane}, '-updated_at', 1).catch(()=>[]);
      if (old?.[0]) await sr.RacerLaneRecentStats.update(old[0].id,stats).catch(()=>{});
      else await sr.RacerLaneRecentStats.create(stats).catch(()=>{});
      by_key[`${reg}_${lane}`] = stats;
      await sleep(120);
    }

    return Response.json({ok:true,by_key});
  } catch(e:any) {
    return Response.json({ok:false,error:e.message},{status:500});
  }
}
