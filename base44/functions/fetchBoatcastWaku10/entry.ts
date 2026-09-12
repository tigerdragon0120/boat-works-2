import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// インメモリキャッシュ(30分TTL) — 同一レースの連続取得を防止
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function toHalfWidth(s: string): string {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const venueCode = String(body.venue_code || '').padStart(2, '0');
    const raceDate = String(body.race_date || '').replace(/-/g, '');
    const raceNumber = Number(body.race_number);

    if (!venueCode || !raceDate || !raceNumber) {
      return Response.json({ ok: false, error: 'venue_code, race_date, race_number required' }, { status: 400 });
    }

    const cacheKey = `${venueCode}_${raceDate}_${raceNumber}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      return Response.json({ ok: true, racers: cached.data, source: 'cache' });
    }

    const raceNumStr = String(raceNumber).padStart(2, '0');
    const url = `https://race.boatcast.jp/hp_txt/${venueCode}/bc_j_waku10_${raceDate}_${venueCode}_${raceNumStr}.txt`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return Response.json({ ok: false, error: `HTTP ${res.status}`, url }, { status: 502 });
    }

    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
    const racerLines = lines.slice(1); // "1\t0" ヘッダーをスキップ

    const racers = racerLines.map((line: string, idx: number) => {
      const parts = line.split('\t');
      const name = parts[0].replace(/[\s　]/g, '');
      const winRate = parseFloat(parts[1]);
      const avgSt = parseFloat(parts[2]);
      const stRank = parseFloat(parts[3]);

      const pastData = parts.slice(4);
      const past10: any[] = [];
      for (let i = 0; i < pastData.length; i += 3) {
        const finishRaw = toHalfWidth(pastData[i] || '').trim();
        const courseRaw = toHalfWidth(pastData[i + 1] || '').trim();
        const code = (pastData[i + 2] || '').trim();
        past10.push({ finish: finishRaw, course: courseRaw, code });
      }

      return { lane: idx + 1, name, winRate, avgSt, stRank, past10 };
    });

    cache.set(cacheKey, { at: Date.now(), data: racers });
    return Response.json({ ok: true, racers, source: 'fetch' });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}