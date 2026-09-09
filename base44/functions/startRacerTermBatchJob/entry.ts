import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const str = (v:any) => v == null ? '' : String(v).trim();

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    const clean = items.map((x:any, i:number) => ({
      file_name: str(x.file_name),
      payload_url: str(x.payload_url),
      order_index: i,
      total_records: Number(x.total_records || 0),
    })).filter((x:any) => x.file_name && x.payload_url && x.total_records > 0);
    if (!clean.length) return Response.json({ error: 'valid items required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;
    const batchId = `rtbatch_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    await sr.RacerTermImportJob.create({
      batch_id: batchId,
      status: 'queued',
      total_files: clean.length,
      current_index: 0,
      current_file: '',
      completed_files: 0,
      failed_files: 0,
      started_at: now,
      last_error: '',
    });

    await sr.RacerTermImportItem.bulkCreate(clean.map((x:any) => ({
      batch_id: batchId,
      file_name: x.file_name,
      payload_url: x.payload_url,
      order_index: x.order_index,
      status: 'queued',
      offset: 0,
      total_records: x.total_records,
      created_count: 0,
      updated_count: 0,
      error_count: 0,
      attempt_count: 0,
      last_attempt_at: '',
      message: '',
    })));

    return Response.json({ ok: true, batch_id: batchId, total_files: clean.length });
  } catch (e:any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
