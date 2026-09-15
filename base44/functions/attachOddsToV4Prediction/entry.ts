// =====================================================
// attachOddsToV4Prediction
//
// 既存のPredictionV4レコードへOD3オッズをアタッチする。
// 予想ロジック(race_probability, selected_trifectas, boat_scores,
// final_judgment等)は一切変更しない。
//
// 変更対象:
//   trifectas[].actual_odds
//   trifectas[].expected_value
//   top_odds, top_expected_value
//   set_expected_recovery, synthetic_odds
//   min_payout, avg_payout, max_payout
//   best_ev_ticket
//   odds_source, odds_fetched_at, odds_combination_count
//   od3_status, od3_debug
//
// 保存後: PredictionV4.get(targetId) で再READ検証。
// UIへ返す場合も同じtargetIdを返す。
// =====================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { resolveProductionOdds } from '../../shared/oddsResolver.js';

function normalizeCombination(combo: any): string | null {
  if (!combo) return null;
  return String(combo)
    .replace(/[０-９]/g, (c: string) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]/g, '')
    .replace(/[－‐–—ー]/g, '-')
    .trim();
}

function normalizeOddsMap(oddsMap: any): Record<string, number> {
  if (!oddsMap || typeof oddsMap !== 'object') return {};
  const normalized: Record<string, number> = {};
  for (const [key, val] of Object.entries(oddsMap)) {
    const norm = normalizeCombination(key);
    if (norm && val != null && Number(val) > 0) normalized[norm] = Number(val);
  }
  return normalized;
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const predictionId = String(body.prediction_id || '').trim();
    const raceId = String(body.race_id || '').trim();
    const stage = String(body.stage || 'PRE').toUpperCase() === 'PRE' ? 'PRE' : 'FINAL';

    if (!predictionId && !raceId) {
      return Response.json({ ok: false, error: 'prediction_id or race_id is required' }, { status: 400 });
    }

    const sr = base44.asServiceRole.entities;

    // =====================================================
    // STEP 1: PredictionV4取得(prediction_id優先、次にrace_id+stage)
    // =====================================================
    let pred: any;
    if (predictionId) {
      pred = await sr.PredictionV4.get(predictionId).catch(() => null);
    } else {
      const list = await sr.PredictionV4.filter(
        { race_id: raceId, stage, prediction_version: 'v4' }, '-computed_at', 1
      ).catch(() => []);
      pred = list?.[0];
    }

    if (!pred) {
      return Response.json({ ok: false, reason: 'PREDICTION_NOT_FOUND' });
    }

    const targetId = pred.id;

    // =====================================================
    // STEP 2: 既にオッズがある場合はそのまま返す(冪等性)
    // =====================================================
    const trifectas = pred.trifectas || [];
    const existingOddsCount = trifectas.filter((t: any) => t.actual_odds != null).length;
    if (existingOddsCount >= 120) {
      return Response.json({
        ok: true,
        already_has_odds: true,
        prediction_id: targetId,
        odds_count: existingOddsCount,
      });
    }

    // =====================================================
    // STEP 3: Race取得・締切チェック
    // =====================================================
    const race = await sr.Race.get(pred.race_id).catch(() => null);
    if (!race) {
      return Response.json({ ok: false, reason: 'RACE_NOT_FOUND', prediction_id: targetId });
    }

    const deadlineMs = race.deadline ? new Date(race.deadline).getTime() : 0;
    const preDeadline = deadlineMs > 0 && deadlineMs > Date.now();
    if (!preDeadline) {
      return Response.json({ ok: false, reason: 'PAST_DEADLINE', prediction_id: targetId });
    }

    // =====================================================
    // STEP 4: OD3取得(BOATCAST優先、LOCAL fallback)
    // =====================================================
    const resolved = await resolveProductionOdds(race, base44);
    if (!resolved.odds_map || Object.keys(resolved.odds_map).length === 0) {
      return Response.json({ ok: false, reason: 'OD3_FETCH_FAILED', prediction_id: targetId });
    }

    const normalizedOdds = normalizeOddsMap(resolved.odds_map);
    if (Object.keys(normalizedOdds).length === 0) {
      return Response.json({ ok: false, reason: 'OD3_NO_VALID_ODDS', prediction_id: targetId });
    }

    // =====================================================
    // STEP 5: trifectasへオッズ・EV付与
    // race_probabilityは変更しない。actual_odds/expected_valueのみ。
    // =====================================================
    const updatedTrifectas = trifectas.map((t: any) => {
      const odds = normalizedOdds[normalizeCombination(t.combination)];
      if (odds != null && odds > 0) {
        const prob = t.race_probability ?? t.probability ?? 0;
        const ev = Math.round(prob * odds * 10) / 10;
        return { ...t, actual_odds: odds, expected_value: ev };
      }
      return t;
    });

    // =====================================================
    // STEP 6: 派生フィールド計算(選定買い目ベース)
    // =====================================================
    const selectedSet = new Set(pred.selected_trifectas || []);
    const selectedTris = updatedTrifectas.filter((t: any) =>
      selectedSet.has(t.combination) && t.actual_odds != null
    );
    const ticketCount = pred.ticket_count || selectedTris.length || 0;

    // set_expected_recovery = sum(prob * odds) / ticket_count (平均EV% = 期待回収率)
    const setExpectedRecovery = ticketCount > 0
      ? Math.round(selectedTris.reduce((sum: number, t: any) =>
          sum + (t.race_probability ?? 0) * t.actual_odds, 0) / ticketCount * 10) / 10
      : null;

    // synthetic_odds = ticket_count / sum(1/odds) (調和平均ベース合成オッズ)
    const validOddsList = selectedTris.map((t: any) => t.actual_odds).filter((o: number) => o > 0);
    const syntheticOdds = validOddsList.length > 0
      ? Math.round(ticketCount / validOddsList.reduce((sum: number, o: number) => sum + 1 / o, 0) * 10) / 10
      : null;

    // min/avg/max payout (100円あたり)
    const payouts = validOddsList.map((o: number) => Math.round(o * 100));
    const minPayout = payouts.length ? Math.min(...payouts) : null;
    const maxPayout = payouts.length ? Math.max(...payouts) : null;
    const avgPayout = payouts.length
      ? Math.round(payouts.reduce((a: number, b: number) => a + b, 0) / payouts.length)
      : null;

    // best_ev_ticket (選定内で最高EV)
    const bestEv = selectedTris.length > 0
      ? selectedTris.reduce((best: any, t: any) =>
          (t.expected_value > (best?.expected_value ?? -Infinity) ? t : best), selectedTris[0])
      : null;

    // top_odds, top_expected_value (top_trifectaのオッズ・EV)
    const topCombo = pred.top_trifecta;
    const topTri = topCombo
      ? updatedTrifectas.find((t: any) =>
          normalizeCombination(t.combination) === normalizeCombination(topCombo))
      : null;
    const topOdds = topTri?.actual_odds ?? null;
    const topExpectedValue = topTri?.expected_value ?? null;

    // =====================================================
    // STEP 7: 保存(同じtargetIdへ)
    // =====================================================
    const updateDoc = {
      trifectas: updatedTrifectas,
      odds_source: resolved.source,
      odds_fetched_at: resolved.fetched_at,
      odds_combination_count: Object.keys(normalizedOdds).length,
      od3_status: 'PARSED',
      top_odds: topOdds,
      top_expected_value: topExpectedValue,
      set_expected_recovery: setExpectedRecovery,
      synthetic_odds: syntheticOdds,
      min_payout: minPayout,
      avg_payout: avgPayout,
      max_payout: maxPayout,
      best_ev_ticket: bestEv?.combination ?? null,
      od3_debug: {
        ...(pred.od3_debug || {}),
        od3_requested: true,
        od3_source: resolved.source,
        od3_raw_received: Object.keys(normalizedOdds).length > 0,
        od3_parse_count: Object.keys(normalizedOdds).length,
        od3_valid_count: Object.keys(normalizedOdds).length,
        od3_match_count: updatedTrifectas.filter((t: any) => t.actual_odds != null).length,
        od3_selected_match_count: selectedTris.length,
        od3_error: null,
      },
    };

    await sr.PredictionV4.update(targetId, updateDoc).catch((e: any) => {
      console.error('[attachOdds] save failed:', e.message);
    });

    // =====================================================
    // STEP 8: 再READ検証(同じtargetId)
    // =====================================================
    const reRead = await sr.PredictionV4.get(targetId).catch(() => null);
    if (reRead) {
      const postSaveTrifectas = reRead.trifectas || [];
      const postSaveOddsCount = postSaveTrifectas.filter((t: any) => t.actual_odds != null).length;
      const postSaveSelected = reRead.selected_trifectas || [];
      const postSaveSelectedWithOdds = postSaveSelected.filter((c: string) => {
        const t = postSaveTrifectas.find((x: any) => x.combination === c);
        return t?.actual_odds != null;
      }).length;
      const postSaveSelectedWithEv = postSaveSelected.filter((c: string) => {
        const t = postSaveTrifectas.find((x: any) => x.combination === c);
        return t?.expected_value != null;
      }).length;

      console.warn(`[attachOdds POST_SAVE] prediction_id=${targetId}`, JSON.stringify({
        post_save_odds_count: postSaveOddsCount,
        post_save_selected_with_odds: postSaveSelectedWithOdds,
        post_save_selected_with_ev: postSaveSelectedWithEv,
        ticket_count: reRead.ticket_count,
      }));

      return Response.json({
        ok: true,
        prediction_id: targetId,
        odds_count: postSaveOddsCount,
        selected_with_odds: postSaveSelectedWithOdds,
        selected_with_ev: postSaveSelectedWithEv,
        post_save_odds_count: postSaveOddsCount,
        post_save_selected_with_odds: postSaveSelectedWithOdds,
        post_save_selected_with_ev: postSaveSelectedWithEv,
      });
    }

    return Response.json({ ok: true, prediction_id: targetId });
  } catch (e: any) {
    console.error('[attachOddsToV4Prediction] error:', e?.message || String(e));
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}