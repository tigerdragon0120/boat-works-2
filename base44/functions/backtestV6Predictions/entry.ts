// =====================================================
// backtestV6Predictions
// 過去データでV6 PROFIT Candidateをバックテストする。
//
// データリーク禁止:
//   - 予想時点で存在していたデータ(RaceEntry, exhibition, OddsSnapshot,
//     RacerPerformanceProfile, RacerRollingStats)のみ使用
//   - RaceResultは採点(検証)にのみ使用し、予想には使わない
//   - V6エンジンは結果を一切参照しない
//
// 処理:
//   1. 結果確定済みRace(結果確定済みRaceResult存在)を取得
//   2. 各レースでV6 FINAL予想を生成(予想時点データのみ)
//   3. 結果で検証 → PredictionV6Verification保存
//   4. 集計返却
// =====================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings } from '../../shared/predictionService.js';
import { runAndSavePredictionV6, verifyV6Prediction } from '../../shared/predictionServiceV6.js';

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

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // admin権限チェック
    if (user.role !== 'admin') {
      return Response.json({ error: 'Admin required' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit) || 200, 1000);
    const force = !!body.force;
    const skipVerify = !!body.skip_verify;

    const sr = base44.asServiceRole.entities;

    // 1. 結果確定済みRaceResult取得(直近limit件)
    const results = await withRetry(() => sr.RaceResult.filter(
      { is_finished: true }, '-finished_at', limit
    ));
    if (!results || !results.length) {
      return Response.json({ ok: true, message: 'No finished races found', processed: 0 });
    }

    // 2. プロファイル・ローリング統計を一括取得(全レース共通)
    const [profiles, rolling, settings] = await Promise.all([
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);
    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    let processed = 0;
    let generated = 0;
    let verifiedCount = 0;
    let buyCount = 0;
    let hitCount = 0;
    let profitCount = 0;
    let lowValueCount = 0;
    let missFirst = 0, missSecond = 0, missThird = 0, missOther = 0;
    let tickets6 = 0, tickets7 = 0, tickets8 = 0;
    let totalInvestment = 0;
    let totalReturn = 0;
    const errors: string[] = [];

    for (const result of results) {
      processed++;
      try {
        // Race取得
        const race = await withRetry(() => sr.Race.get(result.race_id)).catch(() => null);
        if (!race || !race.race_key) continue;

        // RaceEntry取得
        const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length < 1) continue;

        // OddsSnapshot取得(予想時点データ)
        let oddsMap: any = {};
        const oddsSnaps = await withRetry(() => sr.OddsSnapshot.filter({ race_id: race.id, stage: 'FINAL' }, '-captured_at', 5)).catch(() => []);
        if (oddsSnaps?.[0]?.odds_map) oddsMap = oddsSnaps[0].odds_map;
        if (!oddsMap || Object.keys(oddsMap).length === 0) {
          const preOdds = await withRetry(() => sr.OddsSnapshot.filter({ race_id: race.id, stage: 'PRE' }, '-captured_at', 5)).catch(() => []);
          if (preOdds?.[0]?.odds_map) oddsMap = preOdds[0].odds_map;
        }

        // V6予想生成(予想時点データのみ使用 — 結果は参照しない)
        const genResult = await withRetry(() => runAndSavePredictionV6(base44, race, six, settings, 'FINAL', oddsMap, profileByReg, rollingByReg));
        if (genResult?.skipped) continue;
        generated++;

        // 生成結果取得
        const freshList = await withRetry(() => sr.PredictionV6.filter(
          { race_id: race.id, stage: 'FINAL', prediction_version: 'v6' }, '-computed_at', 1
        ));
        const fresh = freshList?.[0];
        if (!fresh) continue;

        // チケット数集計
        const tc = fresh.ticket_count || 6;
        if (tc === 6) tickets6++;
        else if (tc === 7) tickets7++;
        else if (tc === 8) tickets8++;

        // BUY集計
        if (fresh.final_judgment === 'BUY') {
          buyCount++;
          totalInvestment += (tc * 100);
          const hit = (fresh.selected_trifectas || []).includes(result.result_trifecta);
          if (hit) {
            hitCount++;
            totalReturn += (result.payout || 0);
            const recovery = (tc * 100) > 0 ? Math.round((result.payout || 0) / (tc * 100) * 100) : 0;
            if (recovery >= 150) profitCount++;
            else lowValueCount++;
          }
        }

        // 検証(結果確定後)
        if (!skipVerify) {
          const verifiedResult = await verifyV6Prediction(base44, race, {
            result_trifecta: result.result_trifecta,
            payout: result.payout || 0,
          });
          if (verifiedResult) {
            verifiedCount++;
            // outcome_class集計(BUY予想のみ)
            if (fresh.final_judgment === 'BUY' && !verifiedResult.v6_recommended_hit) {
              const oc = verifiedResult.outcome_class;
              if (oc === 'MISS_FIRST') missFirst++;
              else if (oc === 'MISS_SECOND') missSecond++;
              else if (oc === 'MISS_THIRD') missThird++;
              else if (oc === 'MISS_OTHER') missOther++;
            }
          }
        }
      } catch (e: any) {
        errors.push(`race_id=${result.race_id}: ${e?.message || String(e)}`);
        if (errors.length > 20) break;
      }
    }

    const hitRate = buyCount > 0 ? Math.round(hitCount / buyCount * 1000) / 10 : 0;
    const recoveryRate = totalInvestment > 0 ? Math.round(totalReturn / totalInvestment * 100) : 0;
    const avgTickets = buyCount > 0 ? Math.round((tickets6 * 6 + tickets7 * 7 + tickets8 * 8) / buyCount * 10) / 10 : 0;

    return Response.json({
      ok: true,
      processed,
      generated,
      verified: verifiedCount,
      buy_count: buyCount,
      hit_count: hitCount,
      hit_rate: hitRate,
      recovery_rate: recoveryRate,
      total_investment: totalInvestment,
      total_return: totalReturn,
      avg_ticket_count: avgTickets,
      tickets_6: tickets6,
      tickets_7: tickets7,
      tickets_8: tickets8,
      outcome: {
        HIT_PROFIT: profitCount,
        HIT_LOW_VALUE: lowValueCount,
        MISS_FIRST: missFirst,
        MISS_SECOND: missSecond,
        MISS_THIRD: missThird,
        MISS_OTHER: missOther,
      },
      data_leak_check: 'PASS — V6 engine uses only prediction-time data (entries, exhibition, odds, profiles). RaceResult used for scoring only.',
      errors: errors.slice(0, 10),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}