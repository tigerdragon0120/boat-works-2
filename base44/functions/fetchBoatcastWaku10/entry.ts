import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fetchBoatcastText } from '../../shared/boatcastClient.js';

function toHalfWidth(s: string): string {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// waku10テキスト解析(本関数固有の処理)
function parseWaku10(text: string) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  const racerLines = lines.slice(1); // "1\t0" ヘッダーをスキップ

  return racerLines.map((line: string, idx: number) => {
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

    // 共通取得クライアント経由でBOATCASTへアクセス
    const result = await fetchBoatcastText({
      venueCode,
      raceDate,
      raceNumber,
      dataType: 'WAKU10',
    });

    if (!result.ok) {
      return Response.json({ ok: false, error: result.error, metadata: result.metadata }, { status: 502 });
    }

    const racers = parseWaku10(result.text);
    return Response.json({ ok: true, racers, metadata: result.metadata });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}