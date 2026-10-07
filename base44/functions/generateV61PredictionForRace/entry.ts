// =====================================================
// generateV61PredictionForRace
// V6.1 PROFIT Candidate予想を単一レースで生成する。
// V2〜V6を一切変更しない。V6.1は独立Candidate。
//
// 条件:
//   stage=PRE: RaceEntryが1艇以上あること
//   stage=FINAL: exhibition_ready=true + RaceEntry
//
// 冪等性: race_id+stageにつき1件(COMPLETED存在ならforce時のみ再生成)。
// =====================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getSettings } from '../../shared/predictionService.js';
import { runAndSavePredictionV61 } from '../../shared/predictionServiceV61.js';

const V61_VERSION = 'v6.1';

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

    const body = await req.json().catch(() => ({}));
    const raceId = String(body.race_id || '').trim();
    const stage = String(body.stage || 'FINAL').toUpperCase() === 'PRE' ? 'PRE' : 'FINAL';
    const force = !!body.force;

    if (!raceId) return Response.json({ ok: false, error: 'race_id is required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;

    const race = await withRetry(() => sr.Race.get(raceId));
    if (!race || !race.race_key) {
      return Response.json({ ok: false, error: 'Race not found' }, { status: 404 });
    }

    // 冪等性チェック
    const existing = await withRetry(() => sr.PredictionV6.filter(
      { race_id: raceId, stage, prediction_version: V61_VERSION }, '-computed_at', 5
    ));
    const existingCompleted = (existing || []).find(p => p.status === 'COMPLETED' || !p.status);
    if (existingCompleted && !force) {
      return Response.json({
        ok: true,
        already_exists: true,
        race_key: race.race_key,
        stage,
        prediction_id: existingCompleted.id,
        ticket_count: existingCompleted.ticket_count,
        selected_trifectas: existingCompleted.selected_trifectas || [],
        final_judgment: existingCompleted.final_judgment,
        escape_probability: existingCompleted.escape_probability,
        winning_scenario: existingCompleted.winning_scenario,
      });
    }

    // FINAL条件チェック
    if (stage === 'FINAL' && !race.exhibition_ready) {
      return Response.json({ ok: false, error: 'exhibition_ready is false', race_key: race.race_key }, { status: 400 });
    }

    // RaceEntry取得(艇番ごとに1件)
    const entries = await withRetry(() => sr.RaceEntry.filter({ race_key: race.race_key }, 'boat_number', 20));
    const byBoat = new Map<number, any>();
    for (const e of entries || []) {
      const bn = Number(e.boat_number);
      if (bn >= 1 && bn <= 6 && !byBoat.has(bn)) byBoat.set(bn, e);
    }
    const six = [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
    if (six.length < 1) {
      return Response.json({ ok: false, error: 'RaceEntry not found', race_key: race.race_key }, { status: 400 });
    }

    // プロファイル・ローリング統計・設定
    const [profiles, rolling, settings] = await Promise.all([
      sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []),
      sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []),
      getSettings(base44),
    ]);
    const profileByReg = new Map((profiles || []).map((p: any) => [String(p.registration_number || ''), p]));
    const rollingByReg = new Map((rolling || []).map((r: any) => [String(r.registration_number || ''), r]));

    // OddsSnapshot取得(FINAL時)
    let oddsMap: any = {};
    if (stage === 'FINAL') {
      const oddsSnaps = await withRetry(() => sr.OddsSnapshot.filter({ race_id: raceId, stage: 'FINAL' }, '-captured_at', 5));
      if (oddsSnaps?.[0]?.odds_map) oddsMap = oddsSnaps[0].odds_map;
      if (!oddsMap || Object.keys(oddsMap).length === 0) {
        const preOdds = await withRetry(() => sr.OddsSnapshot.filter({ race_id: raceId, stage: 'PRE' }, '-captured_at', 5));
        if (preOdds?.[0]?.odds_map) oddsMap = preOdds[0].odds_map;
      }
    }

    if (stage === 'FINAL' && Object.keys(oddsMap).length < 100) {
      // FINALは実オッズが揃っていることが前提。オッズ未取得のままCOMPLETEDのFINALを
      // 作ると、買い目がオッズ・期待値なしで表示されてしまう。
      // 締切前のオッズ取得(締切25分前〜)は自動更新処理が行うため、ここでは生成しない。
      return Response.json({
        ok: false,
        error: 'odds_not_available',
        reason: 'FINAL オッズ取得待ち',
        race_key: race.race_key,
        stage,
      });
    }

    const result = await withRetry(() => runAndSavePredictionV61(base44, race, six, settings, stage, oddsMap, profileByReg, rollingByReg));

    if (result?.skipped) {
      return Response.json({ ok: false, error: result.reason || 'V6.1 skipped', race_key: race.race_key }, { status: 500 });
    }

    const freshList = await withRetry(() => sr.PredictionV6.filter(
      { race_id: raceId, stage, prediction_version: V61_VERSION }, '-computed_at', 1
    ));
    const fresh = freshList?.[0] || null;

    return Response.json({
      ok: true,
      already_exists: false,
      race_key: race.race_key,
      stage,
      prediction_id: result?.predictionId,
      ticket_count: fresh?.ticket_count,
      selected_trifectas: fresh?.selected_trifectas || [],
      final_judgment: fresh?.final_judgment,
      escape_probability: fresh?.escape_probability,
      winning_scenario: fresh?.winning_scenario,
      status: fresh?.status,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}