import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FETCH_TIMEOUT_MS = 10000;

async function fetchOnce(url: string) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 200) {
      const text = await res.text();
      return { ok: true as const, status: 200, text, url };
    }
    return { ok: false as const, status: res.status, error: `HTTP ${res.status}`, url };
  } catch (e: any) {
    return { ok: false as const, status: null, error: e.message, url };
  }
}

// BOATCAST 3連単オッズ正規化
// 各艇行: [選手名, odds×20, 欠場フラグ×5]
// odds順序: 2着=2→3着=3,4,5,6 / 2着=3→3着=2,4,5,6 / ...
function normalizeOd3(text: string, metadata: any) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  if (lines.length < 7) return { ok: false, error: `insufficient lines: ${lines.length}` };

  const status = lines[0].trim();
  const racerLines = lines.slice(1, 7);
  const racerNames: string[] = [];
  const odds: any[] = [];

  for (let first = 1; first <= 6; first++) {
    const parts = racerLines[first - 1].split('\t');
    racerNames.push(parts[0]?.trim() || '');
    const withdrawalFlags = parts.slice(21, 26).map(f => f === '1');

    let idx = 1;
    for (let second = 1; second <= 6; second++) {
      if (second === first) continue;
      for (let third = 1; third <= 6; third++) {
        if (third === first || third === second) continue;
        const oddsVal = parseFloat(parts[idx]);
        odds.push({
          combination: `${first}-${second}-${third}`,
          first, second, third,
          odds: Number.isFinite(oddsVal) && oddsVal > 0 ? oddsVal : null,
          is_withdraw: withdrawalFlags[second - 1] || withdrawalFlags[third - 1],
        });
        idx++;
      }
    }
  }

  const combos = odds.map(o => o.combination);
  const uniqueCombos = new Set(combos);
  const dupCount = combos.length - uniqueCombos.size;

  return {
    ok: true as const,
    race_date: metadata?.race_date || null,
    venue_code: metadata?.venue_code || null,
    race_number: metadata?.race_number || null,
    status,
    racer_names: racerNames,
    odds,
    fetched_at: new Date().toISOString(),
    count: odds.length,
    integrity: {
      total: odds.length,
      unique: uniqueCombos.size,
      duplicates: dupCount,
      null_odds: odds.filter(o => o.odds == null).length,
      withdraw: odds.filter(o => o.is_withdraw).length,
      all_valid: dupCount === 0 && odds.length === 120,
    },
  };
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceId = body.race_id;
    const raceNumber = Number(body.race_number || 10);
    const venueCode = String(body.venue_code || '20').padStart(2, '0');
    const raceDate = String(body.race_date || '2026-09-12').replace(/-/g, '');
    const rn = String(raceNumber).padStart(2, '0');

    if (!raceId) return Response.json({ error: 'race_id required' }, { status: 400 });

    let httpCount = 0;

    // 1. BOATCAST確定オッズ取得(失敗時リアルタイムにフォールバック)
    const kakuteiUrl = `https://race.boatcast.jp/txt/${venueCode}/bc_kakutei_od3_${raceDate}_${venueCode}_${rn}.txt`;
    httpCount++;
    let bcRes = await fetchOnce(kakuteiUrl);
    let bcSource = 'kakutei_od3';
    if (!bcRes.ok) {
      const smtUrl = `https://race.boatcast.jp/txt/${venueCode}/bc_smt_od3_${raceDate}_${venueCode}_${rn}.txt`;
      httpCount++;
      bcRes = await fetchOnce(smtUrl);
      bcSource = 'smt_od3';
    }
    if (!bcRes.ok) {
      return Response.json({ error: 'BOATCAST odds fetch failed', detail: bcRes, http_access_count: httpCount }, { status: 500 });
    }

    const bcNorm = normalizeOd3(bcRes.text, {
      race_date: body.race_date || '2026-09-12',
      venue_code: venueCode,
      race_number: raceNumber,
    });
    if (!bcNorm.ok) return Response.json({ error: 'normalize failed', detail: bcNorm.error }, { status: 500 });

    // 2. LOCAL OddsSnapshot取得
    const sr = base44.asServiceRole.entities;
    const snaps = await sr.OddsSnapshot.filter({ race_id: raceId }, '-captured_at', 1).catch(() => []);
    const localSnap = snaps?.[0];
    const localOddsMap: Record<string, number> = localSnap?.odds_map || {};

    // 3. LOCAL出走表(レーサー名確認)
    const entries = await sr.RaceEntry.filter({ race_id: raceId }, 'boat_number', 6).catch(() => []);
    const localRacerNames = entries.map(e => (e.player_name || e.racer_name || '').split('/')[0].trim());

    // 4. 全件比較
    const bcOddsMap: Record<string, number> = {};
    for (const o of bcNorm.odds) bcOddsMap[o.combination] = o.odds;

    const allCombos = new Set([...Object.keys(bcOddsMap), ...Object.keys(localOddsMap)]);
    let match = 0, nearMatch = 0, mismatch = 0, bcOnly = 0, localOnly = 0;
    const comparisons: any[] = [];
    let maxDiff = { combo: '', diff: 0, bc: 0, local: 0 };

    for (const combo of allCombos) {
      const bcO = bcOddsMap[combo];
      const localO = localOddsMap[combo];
      if (bcO != null && localO != null) {
        const diff = Math.abs(bcO - localO);
        const relDiff = diff / Math.max(bcO, localO);
        let category: string;
        if (diff === 0) { match++; category = 'MATCH'; }
        else if (relDiff <= 0.05) { nearMatch++; category = 'NEAR'; }
        else { mismatch++; category = 'MISMATCH'; }
        comparisons.push({ combo, bc: bcO, local: localO, diff: Math.round(diff * 10) / 10, rel: Math.round(relDiff * 1000) / 10, category });
        if (diff > maxDiff.diff) maxDiff = { combo, diff, bc: bcO, local: localO };
      } else if (bcO != null) { bcOnly++; }
      else { localOnly++; }
    }

    // 5. 選定買い目の照合
    const preds = await sr.RacePrediction.filter({ race_id: raceId, stage: 'FINAL' }, '-computed_at', 1).catch(() => []);
    const pred = preds?.[0];
    const ticketComparison: any[] = [];
    if (pred?.id) {
      const trifectas = await sr.TrifectaPrediction.filter({ prediction_id: pred.id, is_selected: true }, 'ticket_rank', 10).catch(() => []);
      for (const t of trifectas) {
        const bcO = bcOddsMap[t.combination];
        const localO = localOddsMap[t.combination];
        ticketComparison.push({
          rank: t.ticket_rank, combo: t.combination, prob: t.probability,
          bc_odds: bcO, local_odds: localO,
          diff: bcO && localO ? Math.round((bcO - localO) * 10) / 10 : null,
          ev_local: localO ? Math.round(t.probability * localO * 10) / 10 : null,
          ev_bc: bcO ? Math.round(t.probability * bcO * 10) / 10 : null,
        });
      }
    }

    // レーサー名照合
    const racerNameMatch = bcNorm.racer_names.map((bcName, i) => {
      const localName = localRacerNames[i] || '';
      const bcClean = bcName.replace(/\s/g, '');
      const localClean = localName.replace(/\s/g, '');
      return { boat: i + 1, boatcast: bcName, local: localName, match: bcClean.includes(localClean) || localClean.includes(bcClean) };
    });

    return Response.json({
      ok: true,
      http_access_count: httpCount,
      race_info: { race_id: raceId, race_number: raceNumber, venue_code: venueCode, race_date: body.race_date || '2026-09-12' },
      boatcast: {
        source: bcSource, url: bcRes.url, status: bcNorm.status, fetched_at: bcNorm.fetched_at,
        count: bcNorm.count, racer_names: bcNorm.racer_names, integrity: bcNorm.integrity,
      },
      local: {
        captured_at: localSnap?.captured_at || null,
        count: Object.keys(localOddsMap).length,
        racer_names: localRacerNames,
      },
      comparison: {
        match, near_match: nearMatch, mismatch, boatcast_only: bcOnly, local_only: localOnly,
        max_diff: maxDiff,
        samples: comparisons.sort((a, b) => (a.bc || 9999) - (b.bc || 9999))
          .filter((_, i) => i < 5 || (i >= 55 && i < 60) || i >= 115).slice(0, 20),
      },
      ticket_comparison: ticketComparison,
      racer_name_match: racerNameMatch,
    });
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}