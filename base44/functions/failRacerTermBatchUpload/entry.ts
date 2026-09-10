import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const str = (v:any) => v == null ? '' : String(v).trim();

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json();
    const batchId = str(body.batch_id);
    const fileName = str(body.file_name);
    const message = str(body.message) || 'アップロード失敗';
    if (!batchId || !fileName) return Response.json({ error: 'batch_id, file_name required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;
    const items = await sr.RacerTermImportItem.filter({ batch_id: batchId, file_name: fileName }, 'order_index', 5);
    const item = items?.[0];
    if (!item) return Response.json({ error: 'item not found' }, { status: 404 });

    await sr.RacerTermImportItem.update(item.id, {
      status: 'failed',
      error_count: Number(item.error_count || 0) + 1,
      message: `UPLOAD_FAILED: ${message}`,
    });

    return Response.json({ ok: true });
  } catch (e:any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}