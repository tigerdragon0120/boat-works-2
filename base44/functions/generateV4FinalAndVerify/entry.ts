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
// V4 FINAL生成 + Verification作成
//
// 保存済みデータのみ使用(展示・OD3・結果は新規取得しない)
// V4ロジックは一切変更しない
//
// Phase 1: V4 FINAL生成(exhibition_ready=trueのレースのみ)
//   - RaceEntryの保存済み展示データを使用
//   - OddsSnapshotの保存済みOD3を使用
//   - BOATCAST新規取得なし
//   - 結果データ(RaceResult)は予想生成へ使わない
//
// Phase 2: V4 Verification作成(全168R)
//   - RaceResultの確定結果を使用(検証目的のみ)
//   - verifyV4Predictionで照合
// =====================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = String(body.race_date || '').trim();
    const batchSize = Math.max(1, Math.min(20, Number(body.batch_size || 20)));
    const phase = String(body.phase || 'all'); // 'final' | 'verify' | 'all'
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

    // プロファイル・ローリング統計一括取得
    const [profiles, rolling, settings] = await Promise.all([
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);
    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    const summary: any = {
      race_date: raceDate,
      total_races: raceList.length,
      phase,
      final_generated: 0,
      final_skipped: 0,
      final_errors: 0,
      verify_created: 0,
      verify_skipped: 0,
      verify_errors: 0,
      errors: [] as string[],
    };

    // =====================================================
    // Phase 1: V4 FINAL生成
    // 展示データあり(exhibition_ready=true)のレースのみ
    // 保存済みOddsSnapshotを使用(BOATCAST新規取得なし)
    // =====================================================
    if (phase === 'final' || phase === 'all') {
      // V4 FINAL既存確認
      const v4Finals = await withRetry(() => sr.PredictionV4.filter({ stage: 'FINAL', prediction_version: 'v4' }, '-computed_at', 2000));
      const existingFinalKeys = new Set<string>();
      for (const p of v4Finals || []) {
        if (p.race_key && String(p.race_key).startsWith(raceDate)) existingFinalKeys.add(String(p.race_key));
      }

      // OddsSnapshot一括取得(FINAL stage)
      const oddsSnapshots = await withRetry(() => sr.OddsSnapshot.filter({ stage: 'FINAL' }, '-captured_at', 2000));
      const oddsByRaceKey = new Map<string, any>();
      for (const o of oddsSnapshots || []) {
        if (o.race_id) {
          // race_id → race_key変換が必要なので後で処理
        }
      }

      // race_id → race_key マップ構築
      const raceIdToKey = new Map<string, string>();
      for (const r of raceList) {
        raceIdToKey.set(r.id, r.race_key);
      }

      // OddsSnapshotをrace_key単位で索引
      const oddsByKey = new Map<string, any>();
      for (const o of oddsSnapshots || []) {
        const rk = raceIdToKey.get(o.race_id);
        if (rk && String(rk).startsWith(raceDate) && o.odds_map) {
          if (!oddsByKey.has(rk)) oddsByKey.set(rk, o.odds_map);
        }
      }

      const finalCandidates = raceList.filter(r =>
        r.exhibition_ready === true && !existingFinalKeys.has(r.race_key)
      );

      const finalBatch = finalCandidates.slice(0, batchSize);

      for (const race of finalBatch) {
        try {
          // RaceEntry取得(保存済み展示データを使用)
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

          // 保存済みOddsSnapshotを使用(BOATCAST新規取得なし)
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
    // Phase 2: V4 Verification作成
    // 全168Rについて、確定結果と照合
    // 結果データは検証目的のみ(予想生成には使わない)
    // =====================================================
    if (phase === 'verify' || phase === 'all') {
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
      const verifyBatch = verifyCandidates.slice(0, batchSize * 2); // Verificationは軽量なので多めに処理

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

    summary.completed = (summary.final_remaining === 0 || summary.final_remaining === undefined) &&
                        (summary.verify_remaining === 0 || summary.verify_remaining === undefined) &&
                        summary.errors.length === 0;

    return Response.json({ ok: true, ...summary });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}