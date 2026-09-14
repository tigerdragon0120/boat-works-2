import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings } from '../../shared/predictionService.js';
import { runAndSavePredictionV4, verifyV4Prediction } from '../../shared/predictionServiceV4.js';

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
// V4検証基盤修復 + 過補正修正済みFINAL再生成
//
// 保存済みデータのみ使用(展示・OD3・結果は新規取得しない)
//
// Step 1: V4 FINAL削除 + Verification削除(対象日付)
// Step 2: V4 FINAL再生成(保存済みRaceEntry/OddsSnapshot使用)
// Step 3: Verification新規作成(全R、RaceResultで照合)
// Step 4: メトリクス集計・報告
// =====================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = String(body.race_date || '').trim();
    const batchSize = Math.max(1, Math.min(30, Number(body.batch_size || 30)));
    const step = String(body.step || 'all'); // 'delete' | 'final' | 'verify' | 'report' | 'all'
    if (!raceDate) return Response.json({ ok: false, error: 'race_date is required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;

    // 全Race取得
    const races = await withRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_number', 500));
    if (!races || !races.length) {
      return Response.json({ ok: true, race_date: raceDate, total_races: 0, message: '対象Raceなし' });
    }

    // race_key単位で正規化
    const raceByKey = new Map<string, any>();
    for (const r of races) {
      const key = String(r.race_key || '');
      if (!key) continue;
      const prev = raceByKey.get(key);
      if (!prev || String(r.updated_date || '') > String(prev.updated_date || '')) raceByKey.set(key, r);
    }
    const raceList = [...raceByKey.values()];

    const summary: any = {
      race_date: raceDate,
      total_races: raceList.length,
      step,
      deleted_final: 0,
      deleted_verification: 0,
      final_generated: 0,
      final_skipped: 0,
      final_errors: 0,
      verify_created: 0,
      verify_skipped: 0,
      verify_errors: 0,
      errors: [] as string[],
    };

    // =====================================================
    // Step 1: V4 FINAL + Verification削除
    // =====================================================
    if (step === 'delete' || step === 'all') {
      // V4 FINAL削除
      const v4Finals = await withRetry(() => sr.PredictionV4.filter({ stage: 'FINAL', prediction_version: 'v4' }, '-computed_at', 2000));
      const finalToDelete = (v4Finals || []).filter((p: any) => p.race_key && String(p.race_key).startsWith(raceDate));
      for (const p of finalToDelete) {
        try {
          await withRetry(() => sr.PredictionV4.delete(p.id));
          summary.deleted_final++;
          await sleep(50);
        } catch (e: any) {
          summary.errors.push(`delete FINAL ${p.id}: ${e?.message || e}`);
        }
      }

      // V4 Verification削除
      const v4Verifs = await withRetry(() => sr.PredictionV4Verification.list('-verified_at', 2000));
      const verifToDelete = (v4Verifs || []).filter((v: any) => v.race_key && String(v.race_key).startsWith(raceDate));
      for (const v of verifToDelete) {
        try {
          await withRetry(() => sr.PredictionV4Verification.delete(v.id));
          summary.deleted_verification++;
          await sleep(50);
        } catch (e: any) {
          summary.errors.push(`delete VERIFY ${v.id}: ${e?.message || e}`);
        }
      }
    }

    // =====================================================
    // Step 2: V4 FINAL再生成
    // 保存済みRaceEntry展示データ + OddsSnapshot使用
    // =====================================================
    if (step === 'final' || step === 'all') {
      // プロファイル・ローリング統計一括取得
      const [profiles, rolling, settings] = await Promise.all([
        sr.RacerPerformanceProfile.filter({}, '-updated-at', 5000).catch(() => []),
        sr.RacerRollingStats.filter({}, '-calculated-at', 5000).catch(() => []),
        getSettings(base44),
      ]);
      const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
      const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

      // OddsSnapshot一括取得
      const oddsSnapshots = await withRetry(() => sr.OddsSnapshot.filter({ stage: 'FINAL' }, '-captured_at', 2000));
      const raceIdToKey = new Map<string, string>();
      for (const r of raceList) raceIdToKey.set(r.id, r.race_key);
      const oddsByKey = new Map<string, any>();
      for (const o of oddsSnapshots || []) {
        const rk = raceIdToKey.get(o.race_id);
        if (rk && String(rk).startsWith(raceDate) && o.odds_map) {
          if (!oddsByKey.has(rk)) oddsByKey.set(rk, o.odds_map);
        }
      }

      // V4 FINAL既存確認(削除後に再確認)
      const existingFinals = await withRetry(() => sr.PredictionV4.filter({ stage: 'FINAL', prediction_version: 'v4' }, '-computed_at', 2000));
      const existingFinalKeys = new Set<string>();
      for (const p of existingFinals || []) {
        if (p.race_key && String(p.race_key).startsWith(raceDate)) existingFinalKeys.add(String(p.race_key));
      }

      const finalCandidates = raceList.filter(r =>
        r.exhibition_ready === true && !existingFinalKeys.has(r.race_key)
      );

      const finalBatch = finalCandidates.slice(0, batchSize);

      for (const race of finalBatch) {
        try {
          const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
          const byBoat = new Map<number, any>();
          for (const e of entries || []) {
            const bn = Number(e.boat_number);
            if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
          }
          const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
          if (six.length !== 6) {
            summary.final_skipped++;
            summary.errors.push(`${race.race_key}: RaceEntry ${six.length}/6`);
            continue;
          }

          const savedOdds = oddsByKey.get(race.race_key) || {};
          await withRetry(() => runAndSavePredictionV4(base44, race, six, settings, 'FINAL', savedOdds, profileByReg, rollingByReg));
          summary.final_generated++;
          await sleep(400);
        } catch (e: any) {
          summary.final_errors++;
          summary.errors.push(`${race.race_key}: FINAL ${e?.message || e}`);
        }
      }
      summary.final_remaining = Math.max(0, finalCandidates.length - finalBatch.length);
    }

    // =====================================================
    // Step 3: Verification作成(全R)
    // RaceResultの確定結果で照合
    // =====================================================
    if (step === 'verify' || step === 'all') {
      // 既存V4 Verification確認
      const existingVerifs = await withRetry(() => sr.PredictionV4Verification.list('-verified_at', 2000));
      const existingVerifKeys = new Set<string>();
      for (const v of existingVerifs || []) {
        if (v.race_key && String(v.race_key).startsWith(raceDate)) existingVerifKeys.add(String(v.race_key));
      }

      // RaceResult一括取得
      const results = await withRetry(() => sr.RaceResult.filter({}, '-finished_at', 2000));
      const resultByRaceId = new Map<string, any>();
      for (const r of results || []) {
        if (r.race_id && r.result_trifecta) resultByRaceId.set(r.race_id, r);
      }

      const verifyCandidates = raceList.filter(r => !existingVerifKeys.has(r.race_key));
      const verifyBatch = verifyCandidates.slice(0, batchSize * 2);

      for (const race of verifyBatch) {
        try {
          const result = resultByRaceId.get(race.id);
          if (!result || !result.result_trifecta) {
            summary.verify_skipped++;
            continue;
          }
          await withRetry(() => verifyV4Prediction(base44, race, result));
          summary.verify_created++;
          await sleep(200);
        } catch (e: any) {
          summary.verify_errors++;
          summary.errors.push(`${race.race_key}: VERIFY ${e?.message || e}`);
        }
      }
      summary.verify_remaining = Math.max(0, verifyCandidates.length - verifyBatch.length);
    }

    // =====================================================
    // Step 4: メトリクス集計
    // =====================================================
    if (step === 'report' || step === 'all') {
      const metrics = await computeV4Metrics(base44, raceDate, raceList);
      summary.metrics = metrics;
    }

    summary.completed = (summary.final_remaining === 0 || summary.final_remaining === undefined) &&
                        (summary.verify_remaining === 0 || summary.verify_remaining === undefined) &&
                        summary.errors.length === 0;

    return Response.json({ ok: true, ...summary });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

// =====================================================
// V4メトリクス集計
// =====================================================
async function computeV4Metrics(base44: any, raceDate: string, raceList: any[]) {
  const sr = base44.asServiceRole.entities;
  const dateKeys = new Set(raceList.map(r => r.race_key));

  const [v4Finals, v4Verifs] = await Promise.all([
    sr.PredictionV4.filter({ stage: 'FINAL', prediction_version: 'v4' }, '-computed_at', 2000).catch(() => []),
    sr.PredictionV4Verification.list('-verified_at', 2000).catch(() => []),
  ]);

  const todayFinals = (v4Finals || []).filter((p: any) => p.race_key && dateKeys.has(p.race_key));
  const todayVerifs = (v4Verifs || []).filter((v: any) => v.race_key && dateKeys.has(v.race_key));

  // 重複チェック
  const verifByKey = new Map<string, number>();
  for (const v of todayVerifs) {
    const k = String(v.race_key || '');
    verifByKey.set(k, (verifByKey.get(k) || 0) + 1);
  }
  const duplicateCount = [...verifByKey.values()].filter(c => c > 1).reduce((s, c) => s + c - 1, 0);

  // null judgment
  const nullJudgmentCount = todayVerifs.filter((v: any) => v.v4_final_judgment == null).length;

  // BUY集計
  const v4Buys = todayVerifs.filter((v: any) => v.v4_final_judgment === 'BUY');
  const v4Hits = v4Buys.filter((v: any) => v.v4_recommended_hit);
  const v4Invest = v4Buys.reduce((s: number, v: any) => s + (v.v4_investment || 0), 0);
  const v4Return = v4Buys.filter((v: any) => v.v4_recommended_hit).reduce((s: number, v: any) => s + (v.v4_payout || 0), 0);
  const v4HitRate = v4Buys.length > 0 ? Math.round(v4Hits.length / v4Buys.length * 1000) / 10 : 0;
  const v4Recovery = v4Invest > 0 ? Math.round(v4Return / v4Invest * 100) : 0;

  // 艇番別本命数
  const honmeiCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const p of todayFinals) {
    const hb = Number(p.honmei_boat || 0);
    if (hb >= 1 && hb <= 6) honmeiCounts[hb]++;
  }
  const totalFinals = todayFinals.length || 1;
  const v4_1_honmei_rate = Math.round(honmeiCounts[1] / totalFinals * 1000) / 10;
  const v4_56_honmei_rate = Math.round((honmeiCounts[5] + honmeiCounts[6]) / totalFinals * 1000) / 10;

  return {
    v4_final_count: todayFinals.length,
    v4_verification_count: todayVerifs.length,
    verification_duplicates: duplicateCount,
    verification_null_judgment: nullJudgmentCount,
    v4_buy_count: v4Buys.length,
    v4_hit_count: v4Hits.length,
    v4_hit_rate: v4HitRate,
    v4_investment: v4Invest,
    v4_payout: v4Return,
    v4_recovery_rate: v4Recovery,
    honmei_counts: honmeiCounts,
    v4_1_honmei_rate: v4_1_honmei_rate,
    v4_56_honmei_rate: v4_56_honmei_rate,
  };
}