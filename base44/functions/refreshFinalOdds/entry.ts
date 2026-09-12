import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { refreshFinalOdds, getSettings } from '../../shared/predictionService.js';

// ============================================================
// 締切5分前の最終オッズ更新+期待値再計算
// 管理者手動実行用エンドポイント(通常はrunDailyAutoUpdateから呼ばれる)
//
// 処理:
// 1. 対象Raceの締切時刻確認
// 2. BOATCAST OD3取得(第一優先) / LOCAL fallback
// 3. 120通り完全性確認
// 4. 既存FINAL予想のTrifectaPredictionへオッズ反映
// 5. 期待値・BUY/WATCH/SKIP再計算
// 6. FINAL予想自体(確率・買い目)は変更しない
// ============================================================

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const raceId = body.race_id;
    if (!raceId) return Response.json({ error: 'race_id required' }, { status: 400 });

    const settings = await getSettings(base44);
    const sr = base44.asServiceRole.entities;
    const race = await sr.Race.get(raceId).catch(() => null);
    if (!race) return Response.json({ error: 'race not found' }, { status: 404 });

    const result = await refreshFinalOdds(base44, race, settings);

    return Response.json({
      ok: result.refreshed,
      race: {
        race_id: race.id,
        race_key: race.race_key,
        venue_code: race.venue_code,
        race_number: race.race_number,
        race_date: race.race_date,
        deadline: race.deadline,
      },
      ...result,
    });
  } catch (error: any) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}