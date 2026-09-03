import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

async function all(entity, sort = '-updated_date', max = 50000) {
  const out = [];
  let skip = 0;
  const limit = 500;
  while (out.length < max) {
    const rows = await entity.filter({}, sort, limit, skip).catch(() => []);
    if (!rows?.length) break;
    out.push(...rows);
    if (rows.length < limit) break;
    skip += limit;
  }
  return out.slice(0, max);
}

const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const pct = (a, b) => b ? round1(a / b * 100) : null;

async function chunkedBulkCreate(entity, docs, size = 80) {
  if (!docs.length) return;
  for (let i = 0; i < docs.length; i += size) {
    await entity.bulkCreate(docs.slice(i, i + size));
  }
}

async function setDbStatus(sr, patch) {
  const rows = await sr.DatabaseStatus.filter({ name: 'default' }, '-updated_date', 1).catch(() => []);
  const doc = { name: 'default', ...patch };
  return rows?.[0] ? sr.DatabaseStatus.update(rows[0].id, doc) : sr.DatabaseStatus.create(doc);
}

function computeFinish(res, boatNumber) {
  if (!res) return null;
  const order = Array.isArray(res.finish_order) ? res.finish_order.map(Number) : String(res.result_trifecta || '').split('-').map(Number);
  const idx = order.findIndex(n => n === Number(boatNumber));
  return idx >= 0 ? idx + 1 : null;
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  let user = null;
  try { user = await base44.auth.me(); } catch {}
  if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const sr = base44.asServiceRole.entities;
  const now = new Date().toISOString();

  await setDbStatus(sr, { status: 'running', updated_at: now, message: 'DB再構築中…' });

  try {
    const [races, results, verifs] = await Promise.all([
      all(sr.Race, 'race_date', 50000),
      all(sr.RaceResult, '-finished_at', 50000),
      all(sr.PredictionVerification, '-verified_at', 50000)
    ]);

    const raceById = new Map(races.map(r => [r.id, r]));
    const resultByRace = new Map(results.map(r => [r.race_id, r]));
    const verifByRace = new Map(verifs.map(v => [v.race_id, v]));

    // Race DB
    const raceDocs = races.map(r => {
      const res = resultByRace.get(r.id);
      const v = verifByRace.get(r.id);
      const winner = Array.isArray(res?.finish_order) ? Number(res.finish_order[0]) : Number(String(res?.result_trifecta || '').split('-')[0]);
      return {
        race_id: r.id, race_key: r.race_key || '', race_date: r.race_date,
        venue_code: r.venue_code || '', venue_name: r.venue_name || r.venue || '', race_number: r.race_number,
        grade: r.grade || '', race_type: r.race_type || r.race_phase || '', series_day: r.series_day ?? null,
        weather: r.weather || '', wind_speed: r.wind_speed ?? null, wave_height: r.wave_height ?? null,
        result_trifecta: res?.result_trifecta || '', payout: res?.payout ?? null,
        winner_boat: Number.isFinite(winner) ? winner : null,
        pre_prediction: v?.pre_prediction || '', final_prediction: v?.final_prediction || '',
        pre_hit: !!v?.pre_hit, final_hit: !!v?.final_hit, recommended_hit: !!v?.recommended_hit,
        recovery_rate: v?.recovery_rate ?? null, prediction_grade: r.prediction_grade || '', final_judgment: r.final_judgment || '', updated_at: now,
      };
    });

    // Aggregation maps
    const racerAgg = new Map();
    const motorAgg = new Map();
    const racerVenueAgg = new Map();

    // Stream entries page by page to avoid holding all in memory
    let skip = 0;
    const entryBatch = 500;
    while (true) {
      const batch = await sr.RaceEntry.filter({}, '-updated_date', entryBatch, skip).catch(() => []);
      if (!batch?.length) break;
      for (const e of batch) {
        const race = raceById.get(e.race_id);
        if (!race) continue;
        const reg = String(e.registration_number || e.register_number || '').trim();
        if (!reg) continue;
        const res = resultByRace.get(e.race_id);
        const finish = computeFinish(res, e.boat_number);

        // Racer aggregate
        if (!racerAgg.has(reg)) racerAgg.set(reg, { latest: e, latestRace: race, finishes: [], samples: 0, wins: 0, top2: 0, top3: 0 });
        const a = racerAgg.get(reg);
        if (String(race.race_date || '') >= String(a.latestRace?.race_date || '')) { a.latest = e; a.latestRace = race; }
        if (finish) { a.samples++; a.finishes.push({ date: race.race_date, n: finish }); if (finish === 1) a.wins++; if (finish <= 2) a.top2++; if (finish <= 3) a.top3++; }

        // Motor aggregate
        const motorNo = Number(e.motor_number);
        if (Number.isFinite(motorNo) && race.venue_code) {
          const mk = `${race.venue_code}_${motorNo}`;
          if (!motorAgg.has(mk)) motorAgg.set(mk, { venue_code: race.venue_code, motor_number: motorNo, latest: e, finishes: [], samples: 0, wins: 0, top2: 0, top3: 0 });
          const m = motorAgg.get(mk); m.latest = e;
          if (finish) { m.samples++; m.finishes.push({ date: race.race_date, n: finish }); if (finish === 1) m.wins++; if (finish <= 2) m.top2++; if (finish <= 3) m.top3++; }
        }

        // RacerVenue aggregate
        if (race.venue_code) {
          const rvk = `${reg}_${race.venue_code}`;
          if (!racerVenueAgg.has(rvk)) racerVenueAgg.set(rvk, {
            registration_number: reg, racer_name: e.player_name || e.racer_name || '',
            venue_code: race.venue_code, venue_name: race.venue_name || race.venue || '',
            finishes: [], samples: 0, wins: 0, top2: 0, top3: 0, stSum: 0, stCount: 0
          });
          const rv = racerVenueAgg.get(rvk);
          if (finish) { rv.samples++; rv.finishes.push({ date: race.race_date, n: finish }); if (finish === 1) rv.wins++; if (finish <= 2) rv.top2++; if (finish <= 3) rv.top3++; }
          if (e.avg_st != null) { rv.stSum += Number(e.avg_st); rv.stCount++; }
        }
      }
      if (batch.length < entryBatch) break;
      skip += entryBatch;
    }

    const racerDocs = [...racerAgg.entries()].map(([reg, a]) => {
      const fs = a.finishes.sort((x,y) => String(y.date).localeCompare(String(x.date))).map(x => x.n);
      const e = a.latest || {}; const r = a.latestRace || {};
      return {
        registration_number: reg, racer_name: e.player_name || e.racer_name || '', grade_class: e.player_class || e.grade_class || '',
        branch: e.branch || '', age: e.age ?? null,
        photo_url: e.player_photo || `https://www.boatrace.jp/racerphoto/${reg}.jpg`, latest_race_date: r.race_date || null, latest_venue_code: r.venue_code || '',
        national_win_rate: e.national_win_rate ?? null, national_2rate: e.national_2rate ?? e.national_f2_rate ?? null,
        national_3rate: e.national_3rate ?? e.national_f3_rate ?? null, avg_st: e.avg_st ?? null, f_count: e.f_count ?? 0, l_count: e.l_count ?? 0,
        sample_races: a.samples, win_count: a.wins, top2_count: a.top2, top3_count: a.top3,
        win_rate_actual: pct(a.wins, a.samples), top2_rate_actual: pct(a.top2, a.samples), top3_rate_actual: pct(a.top3, a.samples),
        avg_finish: a.samples ? round1(a.finishes.reduce((s,x)=>s+x.n,0)/a.samples) : null, recent_finish_history: fs.slice(0,10), updated_at: now,
      };
    });

    const motorDocs = [...motorAgg.values()].map(m => {
      const fs = m.finishes.sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(x=>x.n);
      return {
        venue_code:m.venue_code, motor_number:m.motor_number, sample_races:m.samples, win_count:m.wins, top2_count:m.top2, top3_count:m.top3,
        win_rate:pct(m.wins,m.samples), top2_rate:pct(m.top2,m.samples), top3_rate:pct(m.top3,m.samples),
        avg_finish:m.samples ? round1(m.finishes.reduce((s,x)=>s+x.n,0)/m.samples) : null,
        latest_2rate:m.latest?.motor_2rate ?? m.latest?.motor_f2_rate ?? null, latest_3rate:m.latest?.motor_3rate ?? m.latest?.motor_f3_rate ?? null,
        recent_finish_history:fs.slice(0,10), updated_at:now,
      };
    });

    const racerVenueDocs = [...racerVenueAgg.values()].map(a => {
      const fs = a.finishes.sort((x,y) => String(y.date).localeCompare(String(x.date))).map(x => x.n);
      return {
        registration_number: a.registration_number, racer_name: a.racer_name,
        venue_code: a.venue_code, venue_name: a.venue_name,
        sample_races: a.samples, win_count: a.wins, top2_count: a.top2, top3_count: a.top3,
        win_rate: pct(a.wins, a.samples), top2_rate: pct(a.top2, a.samples), top3_rate: pct(a.top3, a.samples),
        avg_finish: a.samples ? round1(a.finishes.reduce((s,x)=>s+x.n,0)/a.samples) : null,
        avg_st: a.stCount ? round1(a.stSum / a.stCount) : null,
        recent_finish_history: fs.slice(0, 10), updated_at: now,
      };
    });

    // Venue DB
    const venueAgg = new Map();
    for (const r of races) {
      if (!r.venue_code) continue;
      if (!venueAgg.has(r.venue_code)) venueAgg.set(r.venue_code,{ code:r.venue_code,name:r.venue_name||r.venue||'', samples:0,wins:[0,0,0,0,0,0],payouts:[],high:0,preN:0,preHit:0,finN:0,finHit:0,buyN:0,buyHit:0,investment:0,returnYen:0 });
      const a=venueAgg.get(r.venue_code), res=resultByRace.get(r.id), v=verifByRace.get(r.id);
      if (res?.result_trifecta) { a.samples++; const w=Number(String(res.result_trifecta).split('-')[0]); if(w>=1&&w<=6)a.wins[w-1]++; if(Number.isFinite(Number(res.payout))){a.payouts.push(Number(res.payout)); if(Number(res.payout)>=10000)a.high++;} }
      if(v){ if(v.pre_prediction){a.preN++; if(v.pre_hit)a.preHit++;} if(v.final_prediction){a.finN++; if(v.final_hit)a.finHit++;} if((v.investment||0)>0){a.buyN++; if(v.recommended_hit)a.buyHit++; a.investment+=Number(v.investment||0); if(v.recommended_hit)a.returnYen+=Number(v.payout||0);} }
    }
    const venueDocs=[...venueAgg.values()].map(a=>({ venue_code:a.code,venue_name:a.name,sample_races:a.samples,
      boat1_win_rate:pct(a.wins[0],a.samples),boat2_win_rate:pct(a.wins[1],a.samples),boat3_win_rate:pct(a.wins[2],a.samples),boat4_win_rate:pct(a.wins[3],a.samples),boat5_win_rate:pct(a.wins[4],a.samples),boat6_win_rate:pct(a.wins[5],a.samples),
      avg_payout:a.payouts.length?round1(a.payouts.reduce((x,y)=>x+y,0)/a.payouts.length):null,high_payout_rate:pct(a.high,a.samples),pre_hit_rate:pct(a.preHit,a.preN),final_hit_rate:pct(a.finHit,a.finN),buy_hit_rate:pct(a.buyHit,a.buyN),recovery_rate:a.investment?round1(a.returnYen/a.investment*100):null,updated_at:now }));

    // Rebuild derived DBs only. Source entities (Race/RaceEntry/RaceResult) are never touched.
    await Promise.all([
      sr.RacerDatabase.deleteMany({}),
      sr.MotorDatabase.deleteMany({}),
      sr.VenueDatabase.deleteMany({}),
      sr.RaceDatabase.deleteMany({}),
      sr.RacerVenueDatabase.deleteMany({})
    ]);
    await chunkedBulkCreate(sr.RacerDatabase, racerDocs, 80);
    await chunkedBulkCreate(sr.MotorDatabase, motorDocs, 80);
    await chunkedBulkCreate(sr.VenueDatabase, venueDocs, 80);
    await chunkedBulkCreate(sr.RaceDatabase, raceDocs, 80);
    await chunkedBulkCreate(sr.RacerVenueDatabase, racerVenueDocs, 80);

    // Stats for DatabaseStatus
    const resultCount = results.filter(r => r.result_trifecta).length;
    const resultCoverageRate = races.length ? pct(resultCount, races.length) : null;
    const sortedDates = races.map(r => r.race_date).filter(Boolean).sort();
    const oldestRaceDate = sortedDates[0] || null;
    const newestRaceDate = sortedDates[sortedDates.length - 1] || null;

    const stats = {
      status: 'success', updated_at: now,
      racers: racerDocs.length, racer_venues: racerVenueDocs.length,
      motors: motorDocs.length, venues: venueDocs.length, races: raceDocs.length,
      oldest_race_date: oldestRaceDate, newest_race_date: newestRaceDate,
      result_count: resultCount, result_coverage_rate: resultCoverageRate,
      message: `再構築完了: 選手${racerDocs.length} / 選手×場${racerVenueDocs.length} / モーター${motorDocs.length} / 場${venueDocs.length} / レース${raceDocs.length}`
    };
    await setDbStatus(sr, stats);

    return Response.json({ status: 'success', ...stats });
  } catch(error) {
    await setDbStatus(sr, { status: 'failed', updated_at: now, message: error?.message || String(error) }).catch(()=>{});
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}