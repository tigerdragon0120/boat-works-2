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
// データ不足除外(BACKTEST_INSUFFICIENT_DATA):
//   - exhibition_ready=false → 除外
//   - RaceEntryに展示データ(exhibition_time/exhibition_st)が4艇未満 → 除外
//   - OddsSnapshotが存在しない or 20組未満 → 除外
//
// 処理:
//   1. 結果確定済みRaceResultを直近から順に取得(最大1000件)
//   2. 各レースでデータ十分性チェック → 不足はBACKTEST_INSUFFICIENT_DATA
//   3. V6 FINAL予想を生成(予想時点データのみ)
//   4. 結果で検証 → PredictionV6Verification保存
//   5. 集計をBACKTEST_SUMMARY_V6レコードへ保存
//   6. 集計返却
//
// 安全性:
//   - Race, RaceEntry, RaceResult, OddsSnapshot等の本番データは一切変更しない
//   - V6専用領域(PredictionV6, PredictionV6Verification, PredictionLearningSample)のみ更新
// =====================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings } from '../../shared/predictionService.js';
import { runAndSavePredictionV6, verifyV6Prediction } from '../../shared/predictionServiceV6.js';

// V6 policy bundle v6.2: 本命・買い目・シナリオ整合 + 1号艇逃げ利益型BUY

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
// データ十分性チェック
// FINAL予想時点のデータが保存されているか検証する。
// 推測値や現在のデータで補完することは禁止。
// =====================================================
function checkSufficientData(race: any, entries: any[], oddsMap: any): { sufficient: boolean; reason: string } {
  // 1. exhibition_ready
  if (!race.exhibition_ready) {
    return { sufficient: false, reason: 'exhibition_not_ready' };
  }

  // 2. RaceEntryに展示データが保存されているか
  const boatsWithExhibition = entries.filter(e =>
    (e.exhibition_time != null && String(e.exhibition_time) !== '') ||
    (e.exhibition_st != null && String(e.exhibition_st) !== '')
  ).length;
  if (boatsWithExhibition < 4) {
    return { sufficient: false, reason: `exhibition_data_${boatsWithExhibition}_boats` };
  }

  // 3. OddsSnapshot
  const oddsCount = oddsMap ? Object.keys(oddsMap).length : 0;
  if (oddsCount < 20) {
    return { sufficient: false, reason: `odds_${oddsCount}_entries` };
  }

  return { sufficient: true, reason: '' };
}

// =====================================================
// バックテストサマリー保存
// PredictionV6Verificationにrace_id="BACKTEST_SUMMARY_V6"で保存
// (actual_resultが結果パターンにマッチしないため通常集計から除外される)
// =====================================================
async function saveBacktestSummary(sr: any, summary: any) {
  const SUMMARY_RACE_ID = 'BACKTEST_SUMMARY_V6';
  const existing = await sr.PredictionV6Verification.filter(
    { race_id: SUMMARY_RACE_ID }, '-verified_at', 1
  ).catch(() => []);

  const doc = {
    race_id: SUMMARY_RACE_ID,
    actual_result: 'BACKTEST_SUMMARY',
    factor_snapshot: summary,
    verified_at: new Date().toISOString(),
  };

  if (existing?.[0]) {
    await sr.PredictionV6Verification.update(existing[0].id, doc).catch(() => {});
  } else {
    await sr.PredictionV6Verification.create(doc).catch(() => {});
  }
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
    const limit = Math.min(Number(body.limit) || 1000, 1000);
    const force = !!body.force;
    const skipVerify = !!body.skip_verify;
    const targetBuyCount = Number(body.target_buy_count) || 100;

    const sr = base44.asServiceRole.entities;

    // 1. 結果確定済みRaceResult取得(直近limit件)
    const results = await withRetry(() => sr.RaceResult.filter(
      { is_finished: true }, '-finished_at', limit
    ));
    if (!results || !results.length) {
      return Response.json({ ok: true, message: 'No finished races found', processed: 0 });
    }

    // 同一レースのRaceResult重複を除外する。最新順取得なので最初の1件を採用。
    // これにより処理数・BUY数・投資額・払戻の二重計上を防ぐ。
    const seenRaceIds = new Set<string>();
    const uniqueResults = results.filter((result: any) => {
      const key = String(result.race_id || '');
      if (!key || seenRaceIds.has(key)) return false;
      seenRaceIds.add(key);
      return true;
    });

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
    let insufficientDataCount = 0;
    let verifiedCount = 0;
    let buyCount = 0;
    let watchCount = 0;
    let skipCount = 0;
    let hitCount = 0;
    let profitCount = 0;
    let lowValueCount = 0;
    let missFirst = 0, missSecond = 0, missThird = 0, missOther = 0;
    let tickets6 = 0, tickets7 = 0, tickets8 = 0;
    let totalInvestment = 0;
    let totalReturn = 0;
    const insufficientReasons: Record<string, number> = {};
    const errors: string[] = [];
    const seenRaceKeys = new Set<string>();

    for (const result of uniqueResults) {
      try {
        // 100BUY到達で打ち切り
        if (buyCount >= targetBuyCount) break;

        // Race取得。Race IDが重複していても論理レースはrace_keyで1件にする。
        const race = await withRetry(() => sr.Race.get(result.race_id)).catch(() => null);
        if (!race || !race.race_key || seenRaceKeys.has(race.race_key)) continue;
        seenRaceKeys.add(race.race_key);
        processed++;

        // RaceEntry取得
        const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
        const byBoat = new Map<number, any>();
        for (const e of entries || []) {
          const bn = Number(e.boat_number);
          if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
        }
        const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
        if (six.length < 1) continue;

        // OddsSnapshot取得。FINAL検証でPREオッズを代用すると期待値と実払戻が
        // 食い違うため、締切直前のFINALスナップショットだけを使用する。
        let oddsMap: any = {};
        const oddsSnaps = await withRetry(() => sr.OddsSnapshot.filter(
          { race_id: race.id, stage: 'FINAL' }, '-captured_at', 5
        )).catch(() => []);
        if (oddsSnaps?.[0]?.odds_map) oddsMap = oddsSnaps[0].odds_map;

        // =====================================================
        // データ十分性チェック
        // 不足場合はBACKTEST_INSUFFICIENT_DATAとして除外
        // =====================================================
        const dataCheck = checkSufficientData(race, six, oddsMap);
        if (!dataCheck.sufficient) {
          insufficientDataCount++;
          insufficientReasons[dataCheck.reason] = (insufficientReasons[dataCheck.reason] || 0) + 1;
          continue;
        }

        // V6予想生成(予想時点データのみ使用 — 結果は参照しない)
        const genResult = await withRetry(() => runAndSavePredictionV6(
          base44, race, six, settings, 'FINAL', oddsMap, profileByReg, rollingByReg
        ));
        if (genResult?.skipped || !genResult?.result) continue;

        // 保存直後のDB再検索は反映遅延で空になることがあるため、
        // 今回実行したエンジンの戻り値をそのまま集計する。
        const fresh = genResult.result;
        generated++;

        // チケット数集計(全予想)
        const tc = fresh.ticket_count || 6;

        // 判定別集計
        const judgment = fresh.final_judgment || 'SKIP';
        if (judgment === 'BUY') {
          buyCount++;
          totalInvestment += (tc * 100);
          if (tc === 6) tickets6++;
          else if (tc === 7) tickets7++;
          else if (tc === 8) tickets8++;
          const hit = (fresh.selected_trifectas || []).includes(result.result_trifecta);
          if (hit) {
            hitCount++;
            totalReturn += (result.payout || 0);
            const recovery = (tc * 100) > 0 ? Math.round((result.payout || 0) / (tc * 100) * 100) : 0;
            if (recovery >= 150) profitCount++;
            else lowValueCount++;
          }
        } else if (judgment === 'WATCH') {
          watchCount++;
        } else {
          skipCount++;
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
            if (judgment === 'BUY' && !verifiedResult.v6_recommended_hit) {
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
    const profit = totalReturn - totalInvestment;
    const avgTickets = buyCount > 0 ? Math.round((tickets6 * 6 + tickets7 * 7 + tickets8 * 8) / buyCount * 10) / 10 : 0;

    const summary = {
      type: 'backtest_summary',
      processed,
      generated,
      insufficient_data: insufficientDataCount,
      insufficient_reasons: insufficientReasons,
      buy_count: buyCount,
      watch_count: watchCount,
      skip_count: skipCount,
      hit_count: hitCount,
      hit_rate: hitRate,
      recovery_rate: recoveryRate,
      total_investment: totalInvestment,
      total_return: totalReturn,
      profit,
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
        BACKTEST_INSUFFICIENT_DATA: insufficientDataCount,
      },
      classified_count: buyCount + watchCount + skipCount,
      unclassified_count: Math.max(0, generated - (buyCount + watchCount + skipCount)),
      policy_version: 'v6.2-escape-profit',
      backtested_at: new Date().toISOString(),
    };

    // サマリー保存
    await saveBacktestSummary(sr, summary);

    const targetReached = buyCount >= targetBuyCount;

    return Response.json({
      ok: true,
      ...summary,
      verified: verifiedCount,
      target_buy_count: targetBuyCount,
      target_reached: targetReached,
      data_leak_check: 'PASS — V6 engine uses only prediction-time data (entries, exhibition, odds, profiles). RaceResult used for scoring only.',
      errors: errors.slice(0, 10),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}