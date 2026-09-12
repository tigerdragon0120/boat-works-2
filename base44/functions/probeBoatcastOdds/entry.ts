import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FETCH_TIMEOUT_MS = 10000;

async function fetchOnce(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 200) {
      const text = await res.text();
      return { ok: true, status: 200, text };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, error: e.message };
  }
}

// BOATCAST 3連単オッズを正規化
// データ形式:
//   Line 0: "data=" (ヘッダー)
//   Line 1: ステータスコード ("1"=available, "0"/"2"=waiting, "3"=cancelled)
//   Lines 2-7: 各艇(1-6)の行
//     フィールド: [選手名, odds1...odds20, withdrawal_flag1...5]
//
// oddsの順序(1着=艇iの場合):
//   2着=2: 3着=3,4,5,6
//   2着=3: 3着=2,4,5,6
//   2着=4: 3着=2,3,5,6
//   2着=5: 3着=2,3,4,6
//   2着=6: 3着=2,3,4,5
function normalizeOd3(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  if (lines.length < 7) return { ok: false, error: `insufficient lines: ${lines.length}` };

  const status = lines[0].trim();
  const racerLines = lines.slice(1, 7);

  const odds = [];
  for (let first = 1; first <= 6; first++) {
    const parts = racerLines[first - 1].split('\t');
    const racerName = parts[0]?.trim() || '';
    // parts[1]〜parts[20] = 20通りのオッズ
    // parts[21]〜parts[25] = 欠場フラグ
    const withdrawalFlags = parts.slice(21, 26).map(f => f === '1');

    let idx = 1; // parts[1]から開始
    for (let second = 1; second <= 6; second++) {
      if (second === first) continue;
      for (let third = 1; third <= 6; third++) {
        if (third === first || third === second) continue;
        const oddsVal = parseFloat(parts[idx]);
        const combination = `${first}-${second}-${third}`;
        odds.push({
          combination,
          first,
          second,
          third,
          odds: Number.isFinite(oddsVal) && oddsVal > 0 ? oddsVal : null,
          is_withdraw: withdrawalFlags[second - 1] || withdrawalFlags[third - 1],
        });
        idx++;
      }
    }
  }

  return {
    ok: true,
    race_date: metadata?.race_date || null,
    venue_code: metadata?.venue_code || null,
    race_number: metadata?.race_number || null,
    odds_type: 'TRIFECTA',
    status,
    odds,
    source: 'BOATCAST',
    fetched_at: new Date().toISOString(),
    count: odds.length,
  };
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const venueCode = String(body.venue_code || '20').padStart(2, '0');
    const raceDate = String(body.race_date || '2026-09-12').replace(/-/g, '');
    const raceNumber = Number(body.race_number || 10);
    const rn = String(raceNumber).padStart(2, '0');

    let httpCount = 0;
    const results = {};

    // bc_kakutei_od3 = 確定オッズ, bc_smt_od3 = リアルタイム
    const candidates = [
      { label: 'kakutei_od3', url: `https://race.boatcast.jp/txt/${venueCode}/bc_kakutei_od3_${raceDate}_${venueCode}_${rn}.txt` },
      { label: 'smt_od3', url: `https://race.boatcast.jp/txt/${venueCode}/bc_smt_od3_${raceDate}_${venueCode}_${rn}.txt` },
    ];

    for (const c of candidates) {
      httpCount++;
      const res = await fetchOnce(c.url);
      if (res.ok) {
        const normalized = normalizeOd3(res.text, {
          race_date: body.race_date || '2026-09-12',
          venue_code: venueCode,
          race_number: raceNumber,
        });
        results[c.label] = {
          url: c.url,
          status: 200,
          raw_length: res.text.length,
          raw_first_line: res.text.split('\n')[0],
          normalized: normalized.ok ? {
            odds_type: normalized.odds_type,
            status: normalized.status,
            count: normalized.count,
            fetched_at: normalized.fetched_at,
            first_5: normalized.odds.slice(0, 5),
            last_5: normalized.odds.slice(-5),
            sample_combos: ['1-2-3','1-3-4','2-1-3','3-1-2','4-5-6','6-5-4'].map(k =>
              normalized.odds.find(o => o.combination === k)
            ),
          } : { error: normalized.error },
        };
      } else {
        results[c.label] = { url: c.url, status: res.status, error: res.error };
      }
      await new Promise(r => setTimeout(r, 300));
    }

    return Response.json({
      ok: true,
      venue_code: venueCode,
      race_date: raceDate,
      race_number: raceNumber,
      http_access_count: httpCount,
      results,
    });
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}