import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { detectScratchedBoats } from '../../shared/scratchDetector.js';
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
// BOATCAST欠場同期: 欠場艇を検知しDBへ反映
//
// 処理フロー:
//   1. BOATCAST(STR3/STT/TKZ)から欠場艇を検知
//   2. Race.scratched_boats, RaceEntry.is_scratched/is_absentを更新
//   3. 締切前の場合: 古いFINAL予想を削除し再生成(欠場艇を含む買い目を残さない)
//   4. 締切後の場合: 予想は変更せず、検証時の返還対象として記録
//
// 呼び出し:
//   POST { race_date: "2026-09-15", race_key?: "2026-09-15_04_08" }
//   race_key省略時は全レースを対象
// =====================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceDate = String(body.race_date || '').trim();
    const targetRaceKey = String(body.race_key || '').trim();
    const regenerateFinal = body.regenerate_final !== false; // デフォルトtrue

    if (!raceDate) return Response.json({ ok: false, error: 'race_date is required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;

    // 対象レース取得
    const races = await withRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_number', 500));
    if (!races || !races.length) {
      return Response.json({ ok: true, race_date: raceDate, total_races: 0, message: '対象Raceなし' });
    }

    // race_key単位で正規化(重複排除)
    const raceByKey = new Map<string, any>();
    for (const r of races) {
      const key = String(r.race_key || '');
      if (!key) continue;
      const prev = raceByKey.get(key);
      if (!prev || String(r.updated_date || '') > String(prev.updated_date || '')) raceByKey.set(key, r);
    }

    let raceList = [...raceByKey.values()];
    if (targetRaceKey) {
      raceList = raceList.filter(r => r.race_key === targetRaceKey);
    }

    // プロファイル・ローリング統計一括取得(FINAL再生成用)
    const [profiles, rolling, settings] = await Promise.all([
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);
    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    // OddsSnapshot一括取得(FINAL再生成用)
    const oddsSnapshots = await withRetry(() => sr.OddsSnapshot.filter({ stage: 'FINAL' }, '-captured_at', 2000)).catch(() => []);
    const raceIdToKey = new Map<string, string>();
    for (const r of raceList) raceIdToKey.set(r.id, r.race_key);
    const oddsByKey = new Map<string, any>();
    for (const o of oddsSnapshots || []) {
      const rk = raceIdToKey.get(o.race_id);
      if (rk && o.odds_map && !oddsByKey.has(rk)) oddsByKey.set(rk, o.odds_map);
    }

    const now = new Date();
    const summary: any = {
      ok: true,
      race_date: raceDate,
      target_race_key: targetRaceKey || 'ALL',
      total_races: raceList.length,
      checked: 0,
      scratched_detected: 0,
      db_updated: 0,
      entries_updated: 0,
      final_regenerated: 0,
      final_skipped_post_deadline: 0,
      pre_regenerated: 0,
      no_change: 0,
      errors: [] as string[],
      details: [] as any[],
    };

    for (const race of raceList) {
      try {
        summary.checked++;
        const venueCode = String(race.venue_code || '');
        const raceNumber = Number(race.race_number);

        // BOATCASTから欠場検知
        const detection = await withRetry(() => detectScratchedBoats(venueCode, raceDate, raceNumber));
        const detectedScratched = detection.scratched_boats || [];
        const dbScratched = race.scratched_boats || [];

        // 差分判定
        const detectedSet = new Set(detectedScratched);
        const dbSet = new Set(dbScratched);
        const needsUpdate = detectedScratched.length > 0 || dbScratched.length > 0;

        const detail: any = {
          race_key: race.race_key,
          venue_code: venueCode,
          race_number: raceNumber,
          boatcast_scratched: detectedScratched,
          db_scratched: dbScratched,
          sources: detection.sources,
          reliable: detection.reliable,
        };

        if (detectedScratched.length > 0) {
          summary.scratched_detected++;
        }

        // DB更新が必要な場合
        if (needsUpdate) {
          // Race.scratched_boats更新
          const newScratchedBoats = [...new Set([...detectedScratched, ...dbScratched])].sort((a, b) => a - b);
          const raceChanged = JSON.stringify(newScratchedBoats) !== JSON.stringify(dbScratched);

          if (raceChanged) {
            await withRetry(() => sr.Race.update(race.id, {
              scratched_boats: newScratchedBoats,
            }));
            summary.db_updated++;
            detail.race_updated = true;
          }

          // RaceEntry更新
          const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
          for (const entry of entries || []) {
            const isScratched = detectedSet.has(entry.boat_number) || dbSet.has(entry.boat_number);
            if (entry.is_scratched !== isScratched || entry.is_absent !== isScratched) {
              await withRetry(() => sr.RaceEntry.update(entry.id, {
                is_scratched: isScratched,
                is_absent: isScratched,
              }));
              summary.entries_updated++;
            }
          }
          detail.entries_updated = true;
        } else {
          summary.no_change++;
        }

        // 欠場艇あり かつ 結果未確定の場合: PRE再生成(欠場艇を除外した買い目へ更新)
        const deadline = race.deadline ? new Date(race.deadline) : null;
        const isPreDeadline = deadline ? now < deadline : false;
        const isFinished = race.status === 'finished';

        if (detectedScratched.length > 0 && !isFinished) {
          try {
            // RaceEntry再取得(欠場反映済み)
            const preEntries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
            const preByBoat = new Map<number, any>();
            for (const e of preEntries || []) {
              const bn = Number(e.boat_number);
              if (bn >= 1 && bn <= 6 && !preByBoat.has(bn)) preByBoat.set(bn, e);
            }
            const preSix = [...preByBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));

            if (preSix.length >= 5) {
              // RacerLaneRecentStats取得
              const preLaneRecent = await sr.RacerLaneRecentStats.filter(
                { race_id: race.id }, '-updated_at', 5000
              ).catch(() => []);
              const preLaneByKey = new Map();
              for (const x of preLaneRecent || []) {
                const key = `${String(x.registration_number)}_${Number(x.lane)}`;
                if (!preLaneByKey.has(key)) preLaneByKey.set(key, x);
              }

              const preEntriesWithProfiles = preSix.map((e: any) => {
                const reg = String(e.registration_number || e.register_number || '').trim();
                const laneKey = `${reg}_${Number(e.boat_number)}`;
                return {
                  ...e,
                  _profile: reg ? profileByReg.get(reg) || null : null,
                  _rollingStats: reg ? rollingByReg.get(reg) || null : null,
                  _laneRecent: reg ? preLaneByKey.get(laneKey) || null : null,
                };
              });

              const preRaceForEngine = { ...race, scratched_boats: newScratchedBoats };

              const preResult = await withRetry(() => runAndSavePredictionV4(
                base44, preRaceForEngine, preEntriesWithProfiles, settings, 'PRE', {}, profileByReg, rollingByReg
              ));

              if (!preResult.skipped) {
                summary.pre_regenerated++;
                detail.pre_regenerated = true;
                detail.pre_ticket_count = preResult.result?.selected_trifectas?.length || 0;
                // 欠場艇を含む買い目が0件であることを確認
                const preTickets = preResult.result?.selected_trifectas || [];
                const preTicketsWithScratched = preTickets.filter((combo: string) => {
                  const boats = combo.split('-').map(Number);
                  return boats.some(b => newScratchedBoats.includes(b));
                });
                detail.pre_tickets_with_scratched = preTicketsWithScratched.length;
              }
            }
          } catch (e: any) {
            summary.errors.push(`${race.race_key}: PRE再生成エラー ${e?.message || e}`);
          }
        }

        // 締切前で欠場艇ありの場合: FINAL再生成
        if (detectedScratched.length > 0 && regenerateFinal) {
          if (isPreDeadline) {
            // 締切前: 古いFINAL削除 → 再生成
            try {
              // 古いV4 FINAL取得
              const oldFinals = await withRetry(() => sr.PredictionV4.filter(
                { race_id: race.id, stage: 'FINAL', prediction_version: 'v4' }, '-computed_at', 5
              ));

              // RaceEntry再取得(欠場反映済み)
              const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
              const byBoat = new Map<number, any>();
              for (const e of entries || []) {
                const bn = Number(e.boat_number);
                if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
              }
              const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));

              if (six.length >= 5) { // 5艇以上必要
                const savedOdds = oddsByKey.get(race.race_key) || {};

                // RacerLaneRecentStats取得
                const laneRecentRows = await sr.RacerLaneRecentStats.filter(
                  { race_id: race.id }, '-updated_at', 5000
                ).catch(() => []);
                const laneRecentByKey = new Map();
                for (const x of laneRecentRows || []) {
                  const key = `${String(x.registration_number)}_${Number(x.lane)}`;
                  if (!laneRecentByKey.has(key)) laneRecentByKey.set(key, x);
                }

                const entriesWithProfiles = six.map((e: any) => {
                  const reg = String(e.registration_number || e.register_number || '').trim();
                  const laneKey = `${reg}_${Number(e.boat_number)}`;
                  return {
                    ...e,
                    _profile: reg ? profileByReg.get(reg) || null : null,
                    _rollingStats: reg ? rollingByReg.get(reg) || null : null,
                    _laneRecent: reg ? laneRecentByKey.get(laneKey) || null : null,
                  };
                });

                // 欠場艇を除外したRaceオブジェクト(エンジン内でフィルタ)
                const raceForEngine = { ...race, scratched_boats: newScratchedBoats };

                const result = await withRetry(() => runAndSavePredictionV4(
                  base44, raceForEngine, entriesWithProfiles, settings, 'FINAL', savedOdds, profileByReg, rollingByReg
                ));

                if (!result.skipped) {
                  summary.final_regenerated++;
                  detail.final_regenerated = true;
                  detail.final_ticket_count = result.result?.selected_trifectas?.length || 0;
                  // 欠場艇を含む買い目が0件であることを確認
                  const selectedTickets = result.result?.selected_trifectas || [];
                  const ticketsWithScratched = selectedTickets.filter((combo: string) => {
                    const boats = combo.split('-').map(Number);
                    return boats.some(b => newScratchedBoats.includes(b));
                  });
                  detail.final_tickets_with_scratched = ticketsWithScratched.length;
                }
              } else {
                summary.errors.push(`${race.race_key}: RaceEntry ${six.length}/6 (欠場艇除外後)`);
              }
            } catch (e: any) {
              summary.errors.push(`${race.race_key}: FINAL再生成エラー ${e?.message || e}`);
            }
          } else {
            // 締切後: 予想は変更せず、返還対象として記録
            summary.final_skipped_post_deadline++;
            detail.final_regenerated = false;
            detail.post_deadline = true;
            detail.refund_eligible = true;
          }
        }

        summary.details.push(detail);
        await sleep(300); // レート制限対策
      } catch (e: any) {
        summary.errors.push(`${race.race_key}: ${e?.message || e}`);
      }
    }

    summary.completed = summary.errors.length === 0;
    return Response.json(summary);
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}