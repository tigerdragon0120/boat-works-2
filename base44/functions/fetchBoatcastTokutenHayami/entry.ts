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
      const rank=Number(bc.rank);
      // 18位を準優ボーダーの基準順位として、同じ開催の現在18位得点率を基準値にする。
      // 早見の1〜6着シナリオと比較して「何着が必要か」を推定する。
      const sortedRates = normalized.racers
        .filter(x => Number.isFinite(Number(x.rank)) && Number.isFinite(Number(x.point_rate)))
        .sort((a,b)=>Number(a.rank)-Number(b.rank));
      const borderRacer = sortedRates.find(x => Number(x.rank) >= 18) || sortedRates[sortedRates.length-1];
      const borderRate = Number(borderRacer?.point_rate);
      const scenarios=[fs.first,fs.second,fs.third,fs.fourth,fs.fifth,fs.sixth].map(Number);
      let needFinish=null;
      if (Number.isFinite(borderRate)) {
        for(let i=5;i>=0;i--) if(Number.isFinite(scenarios[i]) && scenarios[i]>=borderRate) { needFinish=i+1; break; }
      }
      const safeEven6th = needFinish===6;
      const mustWin = needFinish===1;
      const eliminatedLike = Number.isFinite(borderRate) && (!Number.isFinite(scenarios[0]) || scenarios[0] < borderRate);
      let status='通常', scenarioLabel='通常', scenarioScore=35;
      if (eliminatedLike) { status='厳しい'; scenarioLabel='1着でもボーダー未満'; scenarioScore=15; }
      else if (safeEven6th) { status='安全圏'; scenarioLabel='6着でも準優圏目安'; scenarioScore=10; }
      else if (needFinish===5 || needFinish===4) { status='準優圏'; scenarioLabel=`${needFinish}着以内で準優圏目安`; scenarioScore=45; }
      else if (needFinish===3) { status='ボーダー'; scenarioLabel='3着以内が目安'; scenarioScore=70; }
      else if (needFinish===2) { status='勝負がけ'; scenarioLabel='2着以内が目安'; scenarioScore=90; }
      else if (needFinish===1) { status='勝負がけ'; scenarioLabel='1着が必要'; scenarioScore=100; }
      else if (Number.isFinite(rank)) {
        if(rank<=6){status='上位安全圏';scenarioLabel='上位安全圏';scenarioScore=20;}
        else if(rank<=12){status='準優圏';scenarioLabel='準優圏';scenarioScore=40;}
        else if(rank<=18){status='ボーダー';scenarioLabel='ボーダー';scenarioScore=75;}
        else {status='勝負がけ';scenarioLabel='勝負がけ';scenarioScore=70;}
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
        qualifying_need_finish:needFinish,
        qualifying_scenario_label:scenarioLabel,
        qualifying_scenario_score:scenarioScore,
        qualifying_safe_even_6th:safeEven6th,
        qualifying_must_win:mustWin,
        qualifying_eliminated_like:eliminatedLike,
        rank_pressure_score:scenarioScore,
        gamble_level:scenarioScore
      });
      updated++;
    }
  }
  return Response.json({ok:true,source:'BOATCAST',venue_code:venueCode,race_date:raceDate,racers:normalized.racers.length,matched,updated});
}
