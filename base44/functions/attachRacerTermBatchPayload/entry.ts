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
    const payloadUrl = str(body.payload_url);
    if (!batchId || !fileName || !payloadUrl) {
      return Response.json({ error: 'batch_id, file_name, payload_url required' }, { status: 400 });
    }

    const sr = base44.asServiceRole.entities;
    const items = await sr.RacerTermImportItem.filter({ batch_id: batchId, file_name: fileName }, 'order_index', 5);
    const item = items?.[0];
    if (!item) return Response.json({ error: 'item not found' }, { status: 404 });

    await sr.RacerTermImportItem.update(item.id, {
      payload_url: payloadUrl,
      status: 'queued',
      message: 'アップロード完了・取込待ち',
    });

    const jobs = await sr.RacerTermImportJob.filter({ batch_id: batchId }, '-created_date', 5);
    const job = jobs?.[0];
    if (job && job.status === 'preparing') {
      await sr.RacerTermImportJob.update(job.id, {
        status: 'running',
        current_file: fileName,
      });
    }

    return Response.json({ ok: true });
  } catch (e:any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
