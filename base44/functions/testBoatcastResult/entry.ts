import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { resolveRaceResult } from '../../shared/resultResolver.js';
import { upsertBoatcastResultAndVerify } from '../../shared/predictionService.js';

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const sr = base44.asServiceRole.entities;

    const body = await req.json().catch(() => ({}));
    const { race_date = '2026-09-12', venue_code = '20', race_number = 10 } = body;

    const races = await sr.Race.filter({ race_date, venue_code }, 'race_number', 20).catch(() => []);
    const race = races.find((r: any) => r.race_number === race_number);
    if (!race) return Response.json({ error: 'race not found' });

    // resolveRaceResultを呼び出し
    const boatcastResult = await resolveRaceResult(race);

    // result.boatsの中身を確認
    const result = boatcastResult.result;
    const boats = result?.boats || [];

    // RaceEntry取得
    const raceEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
    const entryByBoat = new Map(raceEntries.map((e: any) => [e.boat_number, e]));

    const debugBoats = boats.map((b: any) => ({
      boat_number: b.boat_number,
      finish_order: b.finish_order,
      course: b.course,
      st: b.st,
      matched_entry: entryByBoat.get(b.boat_number) ? {
        reg: entryByBoat.get(b.boat_number).registration_number,
        name: entryByBoat.get(b.boat_number).player_name,
      } : null,
    }));

    return Response.json({
      source: boatcastResult.source,
      result_trifecta: result?.result_trifecta,
      boats_count: boats.length,
      entries_count: raceEntries.length,
      entry_boat_numbers: raceEntries.map((e: any) => e.boat_number),
      debug_boats: debugBoats,
    });
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}