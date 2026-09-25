import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { fetchBoatcastText } from '../../shared/boatcastClient.js';
import { normalizeTokutenHayami } from '../../shared/boatcastNormalizer.js';

export default async function handler(req) {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const raceDate = body.race_date;
  const venueCode = String(body.venue_code || '').padStart(2,'0');
  const raceNumber = Number(body.race_number || 1);
  if (!raceDate || !venueCode) return Response.json({ok:false,error:'race_date and venue_code required'},{status:400});

  const fetched = await fetchBoatcastText({venueCode, raceDate, raceNumber, dataType:'TOKUTEN_HAYAMI'});
  if (!fetched?.ok || !fetched?.text) return Response.json({ok:false,source:'BOATCAST',status:fetched?.status,error:fetched?.error||'no data'},{status:200});

  const normalized = normalizeTokutenHayami(fetched.text,{venue_code:venueCode,race_date:raceDate,race_number:raceNumber,fetched_at:new Date().toISOString()});
  const races = await base44.asServiceRole.entities.Race.filter({race_date:raceDate,venue_code:venueCode});
  let updated=0, matched=0;
  for (const r of races) {
    const entries = await base44.asServiceRole.entities.RaceEntry.filter({race_id:r.id});
    for (const e of entries) {
      const reg=String(e.registration_number||e.register_number||'');
      const bc=normalized.racers.find(x=>String(x.registration_number||'')===reg);
      if (!bc) continue;
      matched++;
      const fs=bc.finish_scenarios||{};
      let status='通常';
      const rank=Number(bc.rank);
      if (Number.isFinite(rank)) {
        if (rank<=6) status='上位安全圏';
        else if (rank<=12) status='準優圏';
        else if (rank<=18) status='ボーダー';
        else status='勝負がけ';
      }
      await base44.asServiceRole.entities.RaceEntry.update(e.id,{
        qualifying_rank:bc.rank,
        qualifying_point_rate:bc.point_rate,
        point_rate:bc.point_rate,
        series_rank:bc.rank,
        point_rate_if_1st:fs.first,
        point_rate_if_2nd:fs.second,
        point_rate_if_3rd:fs.third,
        point_rate_if_4th:fs.fourth,
        point_rate_if_5th:fs.fifth,
        point_rate_if_6th:fs.sixth,
        next_race_number: bc._raw_latest_section_race ? Number(bc._raw_latest_section_race) || null : null,
        qualifying_status:status,
        rank_pressure_score: rank<=6?20:rank<=12?40:rank<=18?80:70,
        gamble_level: rank<=6?25:rank<=12?45:rank<=18?90:75
      });
      updated++;
    }
  }
  return Response.json({ok:true,source:'BOATCAST',venue_code:venueCode,race_date:raceDate,racers:normalized.racers.length,matched,updated});
}
