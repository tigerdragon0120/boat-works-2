import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { runAndSavePrediction, getSettings } from '../../shared/predictionService.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Base44 Entity APIのRate limit(429)を指数バックオフで吸収
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message || e?.response?.data?.error || e || '');
      const isRateLimit = /rate\s*limit|too many requests|429/i.test(msg);
      if (!isRateLimit || attempt === maxRetries) throw e;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      await sleep(delay + Math.floor(Math.random() * 500));
    }
  }
  throw lastError;
}

// top_oddsが未設定のFINAL予想をOddsSnapshotから再生成する。
// OddsSnapshot(120組)があるレースのみ対象。
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const sr = base44.asServiceRole.entities;
    const settings = await getSettings(base44);

    // プロファイル・ローリング統計を一括取得(全レース分1回だけ)
    const profiles = await withRetry(() => sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000));
    const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
    const rolling = await withRetry(() => sr.RacerRollingStats.filter({}, '-calculated_at', 5000));
    const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

    // 全FINAL予想を取得
    const allFinals = await withRetry(() => sr.RacePrediction.filter({ stage: 'FINAL' }, '-computed_at', 500));
    // top_oddsが未設定のものを抽出
    const broken = allFinals.filter((p: any) => p.top_odds == null || p.top_odds === 0);

    const results: any[] = [];
    let regenerated = 0, skipped = 0, errors = 0;

    for (const pred of broken) {
      try {
        // OddsSnapshot確認
        const snapshots = await withRetry(() => sr.OddsSnapshot.filter({ race_id: pred.race_id }, '-captured_at', 1));
        const oddsMap = snapshots?.[0]?.odds_map || {};
        const oddsCount = Object.keys(oddsMap).length;

        if (oddsCount < 120) {
          results.push({ race_key: pred.race_key, status: 'no_odds', odds_count: oddsCount });
          skipped++;
          continue;
        }

        // Race取得
        const race = await withRetry(() => sr.Race.get(pred.race_id));
        if (!race) {
          results.push({ race_key: pred.race_key, status: 'no_race' });
          skipped++;
          continue;
        }

        // 6艇取得
        const entries = await withRetry(() => sr.RaceEntry.filter({ race_id: pred.race_id }, 'boat_number', 6));
        if (entries.length < 6) {
          results.push({ race_key: pred.race_key, status: 'insufficient_entries', entry_count: entries.length });
          skipped++;
          continue;
        }

        // FINAL再生成(OddsSnapshotの実オッズを使用)
        // runAndSavePrediction内でOddsSnapshotが最優先で使用されるため、
        // oddsMap引数は空でもOddsSnapshotから補完されるが、
        // 明示的に渡すことで確実に実オッズが使われる。
        await runAndSavePrediction(base44, race, entries, settings, 'FINAL', oddsMap, profileByReg, rollingByReg);
        regenerated++;
        results.push({ race_key: pred.race_key, status: 'regenerated', odds_count: oddsCount });
      } catch (e: any) {
        errors++;
        results.push({ race_key: pred.race_key, status: 'error', error: e.message });
      }
      // DB APIレート制限回避
      await sleep(500);
    }

    return Response.json({
      ok: errors === 0,
      total_broken: broken.length,
      regenerated,
      skipped,
      errors,
      results,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}