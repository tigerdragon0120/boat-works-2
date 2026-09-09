import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings, runAndSavePrediction } from '../../shared/predictionService.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message || e?.response?.data?.error || e || '');
      const limited = /rate\s*limit|too many requests|429/i.test(msg);
      if (!limited || attempt === maxRetries) throw e;
      await sleep(Math.min(8000, 800 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = String(body.race_date || '').trim();
    const batchSize = Math.max(1, Math.min(12, Number(body.batch_size || 6)));
    if (!raceDate) return Response.json({ ok: false, error: 'race_date is required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;
    const [races, predictions, profiles, rolling, settings] = await Promise.all([
      withRateLimitRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_key', 500)),
      withRateLimitRetry(() => sr.RacePrediction.filter({ stage: 'PRE' }, '-computed_at', 1000)),
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);

    // race_key単位で正規化。古い重複Raceがあっても同じレースを二重生成しない。
    const raceByKey = new Map<string, any>();
    for (const r of races || []) {
      const key = String(r.race_key || '');
      if (!key) continue;
      const prev = raceByKey.get(key);
      if (!prev || String(r.updated_date || '') > String(prev.updated_date || '')) raceByKey.set(key, r);
    }
    const raceList = [...raceByKey.values()].sort((a, b) => String(a.race_key).localeCompare(String(b.race_key)));

    const completedKeys = new Set<string>();
    for (const p of predictions || []) {
      if (p.stage !== 'PRE' || p.status !== 'COMPLETED') continue;
      if (p.race_key) completedKeys.add(String(p.race_key));
    }

    const pending = raceList.filter(r => !completedKeys.has(String(r.race_key)));
    const batch = pending.slice(0, batchSize);
    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    let generated = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (const race of batch) {
      try {
        const entries = await withRateLimitRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        // boat_number単位で重複排除
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length !== 6) {
          skipped++;
          errorDetails.push(`${race.race_key}: RaceEntry ${six.length}/6のためスキップ`);
          continue;
        }

        await withRateLimitRetry(() => runAndSavePrediction(base44, race, six, settings, 'PRE', {}, profileByReg, rollingByReg));
        generated++;
        await sleep(450);
      } catch (e: any) {
        errors++;
        errorDetails.push(`${race.race_key}: ${e?.message || e}`);
      }
    }

    // 今回生成分を差し引いた概算。次回呼出時にDBから再判定するため安全。
    const remaining = Math.max(0, pending.length - generated - skipped);
    return Response.json({
      ok: true,
      race_date: raceDate,
      total_races: raceList.length,
      already_completed: raceList.length - pending.length,
      pending_before: pending.length,
      processed: batch.length,
      generated,
      skipped,
      errors,
      remaining,
      completed: remaining === 0 && errors === 0,
      errorDetails: errorDetails.slice(0, 20),
      message: `PRE差分生成: ${generated}件生成 / ${skipped}件スキップ / ${errors}件エラー / 残り約${remaining}件`,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
