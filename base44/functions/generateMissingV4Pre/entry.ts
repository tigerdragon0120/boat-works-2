import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings } from '../../shared/predictionService.js';
import { runAndSavePredictionV4 } from '../../shared/predictionServiceV4.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
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

// =====================================================
// V4 PRE不足分一括生成
//
// 当日Raceが存在する全レースについて、PredictionV4 PRE COMPLETEDを保証。
// 出走表データが揃った時点で展示・オッズを待たずにV4 PREを生成。
// 既存の正常なPredictionV4は変更しない。重複は禁止。
// =====================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = String(body.race_date || '').trim();
    const batchSize = Math.max(1, Math.min(80, Number(body.batch_size || 50)));
    if (!raceDate) return Response.json({ ok: false, error: 'race_date is required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;

    // 全Race取得
    const races = await withRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_number', 500));
    if (!races || !races.length) {
      return Response.json({ ok: true, race_date: raceDate, total_races: 0, message: '対象Raceなし' });
    }

    // race_key単位で正規化(重複Race統合)
    const raceByKey = new Map<string, any>();
    for (const r of races) {
      const key = String(r.race_key || '');
      if (!key) continue;
      const prev = raceByKey.get(key);
      if (!prev || String(r.updated_date || '') > String(prev.updated_date || '')) raceByKey.set(key, r);
    }
    const raceList = [...raceByKey.values()];

    // 既存V4 PRE確認(重複防止)
    const v4Pres = await withRetry(() => sr.PredictionV4.filter({ stage: 'PRE', prediction_version: 'v4' }, '-computed_at', 2000));
    const existingPreKeys = new Set<string>();
    const duplicatePreKeys = new Set<string>();
    for (const p of v4Pres || []) {
      if (p.race_key && String(p.race_key).startsWith(raceDate)) {
        if (existingPreKeys.has(String(p.race_key))) {
          duplicatePreKeys.add(String(p.race_key));
        }
        existingPreKeys.add(String(p.race_key));
      }
    }

    // プロファイル・ローリング統計一括取得
    const [profiles, rolling, settings] = await Promise.all([
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);
    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    // V4 PRE未生成のレースを抽出
    const preCandidates = raceList.filter(r => !existingPreKeys.has(r.race_key));
    const preBatch = preCandidates.slice(0, batchSize);

    const summary: any = {
      race_date: raceDate,
      total_races: raceList.length,
      pre_existing: raceList.length - preCandidates.length,
      pre_missing: preCandidates.length,
      pre_generated: 0,
      pre_skipped: 0,
      pre_errors: 0,
      duplicate_pre_count: duplicatePreKeys.size,
      errors: [] as string[],
    };

    for (const race of preBatch) {
      try {
        // RaceEntry取得(出走表データ)
        const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length !== 6) {
          summary.pre_skipped++;
          summary.errors.push(`${race.race_key}: RaceEntry ${six.length}/6`);
          continue;
        }

        // V4 PRE生成(展示・オッズなし、事前情報のみ)
        const result = await withRetry(() => runAndSavePredictionV4(base44, race, six, settings, 'PRE', {}, profileByReg, rollingByReg));
        if (result?.skipped) {
          summary.pre_skipped++;
          summary.errors.push(`${race.race_key}: ${result.reason || 'skipped'}`);
        } else {
          summary.pre_generated++;
        }
        await sleep(200);
      } catch (e: any) {
        summary.pre_errors++;
        summary.errors.push(`${race.race_key}: PRE ${e?.message || e}`);
      }
    }

    summary.pre_remaining = Math.max(0, preCandidates.length - preBatch.length);
    summary.completed = summary.pre_remaining === 0 && summary.pre_errors === 0;

    return Response.json({ ok: true, ...summary });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}