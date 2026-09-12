import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { getBoatcastDiagnostics, clearBoatcastCache, BOATCAST_DATA_TYPES, UPDATE_POLICIES } from '../../shared/boatcastClient.js';

// BOATCAST取得基盤の診断情報を返す(管理者・開発確認用)
// ?action=clear_cache でキャッシュクリア

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    if (url.searchParams.get('action') === 'clear_cache') {
      const cleared = clearBoatcastCache();
      return Response.json({
        ok: true,
        ...cleared,
        diagnostics: getBoatcastDiagnostics(),
        data_types: BOATCAST_DATA_TYPES,
        update_policies: UPDATE_POLICIES,
      });
    }

    return Response.json({
      ok: true,
      diagnostics: getBoatcastDiagnostics(),
      data_types: BOATCAST_DATA_TYPES,
      update_policies: UPDATE_POLICIES,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}