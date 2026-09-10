import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function getTodayJST(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
function getTomorrowJST(): string {
  const now = new Date();
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  jst.setDate(jst.getDate() + 1);
  return jst.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole.entities;

    const today = getTodayJST();
    const tomorrow = getTomorrowJST();

    // AutoUpdateStatus読込
    const statusList = await sr.AutoUpdateStatus.filter({ name: 'default' }, '-last_updated', 1).catch(() => []);
    const status = statusList?.[0] || null;

    // DB状態をリアルタイム計算
    const [todayRaces, tomorrowRaces, todayEntries, tomorrowEntries, results, prePreds] = await Promise.all([
      sr.Race.filter({ race_date: today }, 'race_number', 300).catch(() => []),
      sr.Race.filter({ race_date: tomorrow }, 'race_number', 300).catch(() => []),
      sr.RaceEntry.filter({ race_date: today }, 'boat_number', 5000).catch(() => []),
      sr.RaceEntry.filter({ race_date: tomorrow }, 'boat_number', 5000).catch(() => []),
      sr.RaceResult.filter({}, '-finished_at', 500).catch(() => []),
      sr.RacePrediction.filter({ stage: 'PRE' }, '-computed_at', 500).catch(() => []),
    ]);

    const todayVenues = [...new Set(todayRaces.map((r: any) => r.venue_code).filter(Boolean))];
    const tomorrowVenues = [...new Set(tomorrowRaces.map((r: any) => r.venue_code).filter(Boolean))];
    const raceIdsWithResult = new Set(results.map((r: any) => r.race_id));
    const todayResults = todayRaces.filter((r: any) => raceIdsWithResult.has(r.id)).length;
    const preRaceIds = new Set(prePreds.map((p: any) => p.race_id));
    const todayPre = todayRaces.filter((r: any) => preRaceIds.has(r.id)).length;
    const tomorrowPre = tomorrowRaces.filter((r: any) => preRaceIds.has(r.id)).length;
    const exhibitionReady = todayRaces.filter((r: any) => r.exhibition_ready).length;

    // 完全性チェック
    const entryByRace = {};
    for (const e of tomorrowEntries) {
      const key = `${e.venue_code}_${e.race_number}`;
      entryByRace[key] = (entryByRace[key] || 0) + 1;
    }
    const incompleteTomorrow = tomorrowRaces.filter((r: any) => {
      const key = `${r.venue_code}_${r.race_number}`;
      return (entryByRace[key] || 0) < 6;
    }).length;

    return Response.json({
      ok: true,
      today,
      tomorrow,
      jst_time: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      status: status?.status || 'idle',
      last_updated: status?.last_updated || null,
      current_step: status?.current_step || null,
      today_venues: todayVenues.length,
      today_venue_codes: todayVenues,
      today_races: todayRaces.length,
      today_entries: todayEntries.length,
      today_results: todayResults,
      today_pre: todayPre,
      today_exhibition: exhibitionReady,
      tomorrow_venues: tomorrowVenues.length,
      tomorrow_venue_codes: tomorrowVenues,
      tomorrow_races: tomorrowRaces.length,
      tomorrow_entries: tomorrowEntries.length,
      tomorrow_pre: tomorrowPre,
      tomorrow_incomplete: incompleteTomorrow,
      errors: status?.errors || [],
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}