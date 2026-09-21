import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fetchBoatcastText } from '../../shared/boatcastClient.js';

function toHalfWidth(s: string): string {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// waku10テキスト解析(本関数固有の処理)
function parseWaku10(text: string) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() && l.trim() !== 'data=');
  const racerLines = lines.slice(1, 7); // "1\t0" ヘッダーを除き、1〜6号艇だけを読む

  return racerLines.map((line: string, idx: number) => {
    const lane = idx + 1;
    const parts = line.split('\t');
    const name = String(parts[0] || '').replace(/[\s　]/g, '');
    const parsedWinRate = Number.parseFloat(toHalfWidth(parts[1] || ''));
    const parsedAvgSt = Number.parseFloat(toHalfWidth(parts[2] || ''));
    const parsedStRank = Number.parseFloat(toHalfWidth(parts[3] || ''));

    // 1走につき「着順・進入・区分」の3列。必ず直近10走だけを返す。
    // 進入の空欄は枠なり進入なので、対象枠番で補完する。
    const pastData = parts.slice(4);
    const past10 = Array.from({ length: 10 }, (_, i) => {
      const offset = i * 3;
      const finish = toHalfWidth(pastData[offset] || '').trim();
      const rawCourse = toHalfWidth(pastData[offset + 1] || '').trim();
      const code = String(pastData[offset + 2] || '').trim();
      return { finish, course: rawCourse || String(lane), code, course_inferred: !rawCourse };
    });

    return {
      lane,
      name,
      winRate: Number.isFinite(parsedWinRate) ? parsedWinRate : null,
      avgSt: Number.isFinite(parsedAvgSt) ? parsedAvgSt : null,
      stRank: Number.isFinite(parsedStRank) ? parsedStRank : null,
      past10,
    };
  }).filter((r) => r.name);
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
    const complete = racers.length === 6 && racers.every((r) => r.past10.length === 10);
    if (!complete) {
      return Response.json({
        ok: false,
        error: `WAKU10 parse incomplete: racers=${racers.length}`,
        racers,
        metadata: result.metadata,
      }, { status: 502 });
    }
    return Response.json({ ok: true, racers, metadata: result.metadata });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}