import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings, runAndSavePrediction } from '../../shared/predictionService.js';
import { runAndSavePredictionV2 } from '../../shared/predictionServiceV2.js';
import { runAndSavePredictionV3 } from '../../shared/predictionServiceV3.js';
import { runAndSavePredictionV4 } from '../../shared/predictionServiceV4.js';

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

// =====================================================
// V2/V3 PREギャップ埋め
// 
// V1 PRE済み(has_pre=true)だがV2/V3 PRE未生成のRaceに対し、
// V2/V3 PREのみを生成する。V1は上書きしない。
// V1未生成(has_pre=false)のRaceに対してはrunAndSavePredictionでV1+V2+V3を一括生成。
// 
// 予想ロジック・BOATCAST取得・WAKU10・展示・OD3・結果・払戻は一切変更しない。
// PRE段階では展示データを要求しない(展示前予想のため)。
// =====================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = String(body.race_date || '').trim();
    const batchSize = Math.max(1, Math.min(20, Number(body.batch_size || 12)));
    if (!raceDate) return Response.json({ ok: false, error: 'race_date is required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;

    // 全Race取得(日付指定)
    const races = await withRateLimitRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_number', 500));
    if (!races || !races.length) {
      return Response.json({ ok: true, race_date: raceDate, total_races: 0, message: '対象Raceなし' });
    }

    // race_key単位で正規化(重複Race対策)
    const raceByKey = new Map<string, any>();
    for (const r of races) {
      const key = String(r.race_key || '');
      if (!key) continue;
      const prev = raceByKey.get(key);
      if (!prev || String(r.updated_date || '') > String(prev.updated_date || '')) raceByKey.set(key, r);
    }
    const raceList = [...raceByKey.values()];

    // V2/V3/V4 PRE既存確認
    const [v2Pres, v3Pres, v4Pres, profiles, rolling, settings] = await Promise.all([
      withRateLimitRetry(() => sr.PredictionV2.filter({ stage: 'PRE', prediction_version: 'v2' }, '-computed_at', 1000)),
      withRateLimitRetry(() => sr.PredictionV3.filter({ stage: 'PRE', prediction_version: 'v3' }, '-computed_at', 1000)),
      withRateLimitRetry(() => sr.PredictionV4.filter({ stage: 'PRE', prediction_version: 'v4' }, '-computed_at', 1000)),
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);

    const v2Keys = new Set<string>();
    for (const p of v2Pres || []) {
      if (p.race_key && String(p.race_key).startsWith(raceDate)) v2Keys.add(String(p.race_key));
    }
    const v3Keys = new Set<string>();
    for (const p of v3Pres || []) {
      if (p.race_key && String(p.race_key).startsWith(raceDate)) v3Keys.add(String(p.race_key));
    }
    const v4Keys = new Set<string>();
    for (const p of v4Pres || []) {
      if (p.race_key && String(p.race_key).startsWith(raceDate)) v4Keys.add(String(p.race_key));
    }

    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    // 4つのカテゴリに分類
    const needV1V2V3: any[] = []; // V1未生成→runAndSavePrediction(V1+V2+V3+V4)
    const needV3Only: any[] = []; // V1+V2済み→V3のみ
    const needV2Only: any[] = []; // V1済みV2未生成→V2のみ
    const needV4Only: any[] = []; // V1済みV4未生成→V4のみ

    for (const race of raceList) {
      const key = String(race.race_key);
      const hasV1 = race.has_pre === true;
      const hasV2 = v2Keys.has(key);
      const hasV3 = v3Keys.has(key);
      const hasV4 = v4Keys.has(key);

      if (!hasV1) {
        needV1V2V3.push(race);
      } else {
        if (!hasV2) needV2Only.push(race);
        if (!hasV3) needV3Only.push(race);
        if (!hasV4) needV4Only.push(race);
      }
    }

    const summary = {
      race_date: raceDate,
      total_races: raceList.length,
      v1_v2_v3_needed: needV1V2V3.length,
      v3_only_needed: needV3Only.length,
      v2_only_needed: needV2Only.length,
      v4_only_needed: needV4Only.length,
      v2_already: v2Keys.size,
      v3_already: v3Keys.size,
      v4_already: v4Keys.size,
      v1_generated: 0,
      v2_generated: 0,
      v3_generated: 0,
      v4_generated: 0,
      v3_only_generated: 0,
      v2_only_generated: 0,
      v4_only_generated: 0,
      skipped: 0,
      errors: 0,
      error_details: [] as string[],
      venue_breakdown: {} as Record<string, { total: number; v3_gen: number; v3_skip: number }>,
    };

    const addVenue = (vc: string, gen: boolean) => {
      if (!vc) return;
      if (!summary.venue_breakdown[vc]) summary.venue_breakdown[vc] = { total: 0, v3_gen: 0, v3_skip: 0 };
      summary.venue_breakdown[vc].total++;
      if (gen) summary.venue_breakdown[vc].v3_gen++;
      else summary.venue_breakdown[vc].v3_skip++;
    };

    // =====================================================
    // Phase 1: V1未生成Race → runAndSavePrediction(V1+V2+V3)
    // =====================================================
    const v1Batch = needV1V2V3.slice(0, batchSize);
    for (const race of v1Batch) {
      try {
        const entries = await withRateLimitRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length !== 6) {
          summary.skipped++;
          summary.error_details.push(`${race.race_key}: RaceEntry ${six.length}/6`);
          continue;
        }

        await withRateLimitRetry(() => runAndSavePrediction(base44, race, six, settings, 'PRE', {}, profileByReg, rollingByReg));
        summary.v1_generated++;
        summary.v2_generated++;
        summary.v3_generated++;
        summary.v4_generated++;
        addVenue(race.venue_code, true);
        await sleep(500);
      } catch (e: any) {
        summary.errors++;
        summary.error_details.push(`${race.race_key}: ${e?.message || e}`);
      }
    }

    // =====================================================
    // Phase 2: V1+V2済み・V3未生成Race → V3 PREのみ生成
    // =====================================================
    const v3Batch = needV3Only.slice(0, batchSize);
    for (const race of v3Batch) {
      try {
        const entries = await withRateLimitRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length !== 6) {
          summary.skipped++;
          summary.error_details.push(`${race.race_key}: RaceEntry ${six.length}/6`);
          continue;
        }

        // V3 PREのみ生成(V1/V2は上書きしない)
        await withRateLimitRetry(() => runAndSavePredictionV3(base44, race, six, settings, 'PRE', {}, profileByReg, rollingByReg));
        summary.v3_only_generated++;
        summary.v3_generated++;
        addVenue(race.venue_code, true);
        await sleep(400);
      } catch (e: any) {
        summary.errors++;
        summary.error_details.push(`${race.race_key}: V3 ${e?.message || e}`);
      }
    }

    // =====================================================
    // Phase 3: V1済み・V2未生成Race → V2 PREのみ生成
    // =====================================================
    const v2Batch = needV2Only.slice(0, batchSize);
    for (const race of v2Batch) {
      try {
        const entries = await withRateLimitRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length !== 6) {
          summary.skipped++;
          continue;
        }

        await withRateLimitRetry(() => runAndSavePredictionV2(base44, race, six, settings, 'PRE', {}, profileByReg, rollingByReg));
        summary.v2_only_generated++;
        summary.v2_generated++;
        await sleep(400);
      } catch (e: any) {
        summary.errors++;
        summary.error_details.push(`${race.race_key}: V2 ${e?.message || e}`);
      }
    }

    // =====================================================
    // Phase 4: V1済み・V4未生成Race → V4 PREのみ生成
    // =====================================================
    const v4Batch = needV4Only.slice(0, batchSize);
    for (const race of v4Batch) {
      try {
        const entries = await withRateLimitRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length !== 6) {
          summary.skipped++;
          continue;
        }

        await withRateLimitRetry(() => runAndSavePredictionV4(base44, race, six, settings, 'PRE', {}, profileByReg, rollingByReg));
        summary.v4_only_generated++;
        summary.v4_generated++;
        await sleep(400);
      } catch (e: any) {
        summary.errors++;
        summary.error_details.push(`${race.race_key}: V4 ${e?.message || e}`);
      }
    }

    summary.remaining_v1 = Math.max(0, needV1V2V3.length - v1Batch.length);
    summary.remaining_v3 = Math.max(0, needV3Only.length - v3Batch.length);
    summary.remaining_v2 = Math.max(0, needV2Only.length - v2Batch.length);
    summary.remaining_v4 = Math.max(0, needV4Only.length - v4Batch.length);
    summary.completed = summary.remaining_v1 === 0 && summary.remaining_v3 === 0 && summary.remaining_v2 === 0 && summary.remaining_v4 === 0 && summary.errors === 0;

    return Response.json({ ok: true, ...summary });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}