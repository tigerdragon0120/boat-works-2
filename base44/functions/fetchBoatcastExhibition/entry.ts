import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fetchBoatcastText } from '../../shared/boatcastClient.js';
import { normalizeTkz, normalizeStartExhibition, normalizeExhibitionData } from '../../shared/boatcastNormalizer.js';

// ============================================================
// BOATCAST直前情報取得(TKZ + STT)
// 展示タイム・展示ST・実進入コース・体重・チルトを取得
// FINAL予想の前に呼ばれ、LOCAL展示データとマージされる
// ============================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const venueCode = String(body.venue_code || '').padStart(2, '0');
    const raceDateRaw = String(body.race_date || '');
    const raceDate = raceDateRaw.replace(/-/g, '');
    const raceNumber = Number(body.race_number);

    if (!venueCode || !raceDate || !raceNumber) {
      return Response.json({
        ok: false,
        error: 'venue_code, race_date, race_number required',
      }, { status: 400 });
    }

    // TKZ + STT並列取得
    const [tkzResult, sttResult] = await Promise.all([
      fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'TKZ' }),
      fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'STT' }),
    ]);

    // 両方取得失敗場合はエラー
    if (!tkzResult.ok && !sttResult.ok) {
      return Response.json({
        ok: false,
        error: 'TKZ and STT fetch failed',
        tkz_error: tkzResult.error,
        stt_error: sttResult.error,
      }, { status: 502 });
    }

    // 正規化(取得できた方のみ)
    let tkzNormalized = null;
    let sttNormalized = null;
    if (tkzResult.ok) {
      tkzNormalized = normalizeTkz(tkzResult.text, tkzResult.metadata);
    }
    if (sttResult.ok) {
      sttNormalized = normalizeStartExhibition(sttResult.text, sttResult.metadata);
    }

    // 統合(片方でも取得できていれば)
    const metadata = {
      race_date: raceDateRaw,
      venue_code: venueCode,
      race_number: raceNumber,
      fetched_at: new Date().toISOString(),
    };
    const exhibitionData = normalizeExhibitionData(tkzNormalized, sttNormalized, metadata);

    return Response.json({
      ok: true,
      exhibition: exhibitionData,
      tkz_ok: tkzResult.ok,
      stt_ok: sttResult.ok,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}