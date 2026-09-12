import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { runAndSavePrediction, getSettings } from '../../shared/predictionService.js';

// テスト用: 指定race_idのFINAL予想を強制再生成
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

    // プロファイル・ローリング統計一括取得
    const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
    const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
    const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
    const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

    const race = await sr.Race.get(raceId);
    if (!race) return Response.json({ error: 'race not found' }, { status: 404 });

    const entries = await sr.RaceEntry.filter({ race_id: raceId }, 'boat_number', 6);
    if (entries.length < 6) return Response.json({ error: 'insufficient entries', count: entries.length }, { status: 400 });

    // OddsSnapshot取得
    const snapshots = await sr.OddsSnapshot.filter({ race_id: raceId }, '-captured_at', 1).catch(() => []);
    const oddsMap = snapshots?.[0]?.odds_map || {};

    const result = await runAndSavePrediction(base44, race, entries, settings, 'FINAL', oddsMap, profileByReg, rollingByReg);

    return Response.json({
      ok: true,
      race_id: raceId,
      race_key: race.race_key,
      result: {
        predictionId: result.predictionId,
        skipped: result.skipped,
        reason: result.reason,
        exhibition_status: result.exhibition_status,
        ready_count: result.ready_count,
        active_count: result.active_count,
        odds_mapping_error: result.odds_mapping_error,
        missing_odds: result.missing_odds,
      },
    });
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}