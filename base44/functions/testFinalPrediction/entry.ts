import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { runAndSavePrediction, getSettings } from '../../shared/predictionService.js';

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceId = body.race_id;
    if (!raceId) return Response.json({ error: 'race_id required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;
    const settings = await getSettings(base44);

    const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
    const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
    const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
    const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

    const race = await sr.Race.get(raceId);
    const entries = await sr.RaceEntry.filter({ race_id: raceId }, 'boat_number', 6);
    const snapshots = await sr.OddsSnapshot.filter({ race_id: raceId }, '-captured_at', 1).catch(() => []);
    const oddsMap = snapshots?.[0]?.odds_map || {};

    const result = await runAndSavePrediction(base44, race, entries, settings, 'FINAL', oddsMap, profileByReg, rollingByReg);
    return Response.json({ ok: true, result });
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}