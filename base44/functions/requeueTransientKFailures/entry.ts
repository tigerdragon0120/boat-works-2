import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const str = (v:any) => v == null ? '' : String(v).trim();
const isTransient = (v:any) => /\b524\b|\b502\b|\b503\b|\b504\b|timeout|timed out|cloudflare|origin web server|econnreset|econnrefused|network error|socket hang up|temporarily unavailable/i.test(str(v));

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const sr = base44.asServiceRole.entities;
    const failed = await sr.KBatchImportItem.filter({ status: 'failed' }, '-updated_date', 500);
    const candidates:any[] = [];
    const seen = new Set<string>();

    for (const item of failed || []) {
      const msg = str(item.message);
      if (!isTransient(msg) || /AUTO_REPAIR_EXHAUSTED/i.test(msg)) continue;
      const fileName = str(item.file_name);
      const payloadUrl = str(item.payload_url);
      if (!fileName || !payloadUrl || seen.has(fileName)) continue;

      // 同じファイルが後続ログで正常完了しているなら再取込不要。
      const logs = await sr.DataImportLog.filter({ file_name: fileName }, '-imported_at', 10).catch(() => []);
      const itemTime = new Date(item.updated_date || item.created_date || 0).getTime();
      const laterSuccess = (logs || []).find((x:any) => x.status === 'success' && new Date(x.updated_date || x.imported_at || 0).getTime() >= itemTime);
      if (laterSuccess) {
        await sr.KBatchImportItem.update(item.id, {
          status: 'success',
          error_count: 0,
          message: '後続の取込ログで正常保存を確認済み',
        });
        continue;
      }

      seen.add(fileName);
      candidates.push({ file_name: fileName, payload_url: payloadUrl });
    }

    if (!candidates.length) return Response.json({ ok: true, created: false, batch_id: '', total_files: 0 });

    const batchId = `krepair_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    await sr.KBatchImportJob.create({
      batch_id: batchId,
      status: 'queued',
      total_files: candidates.length,
      current_index: 0,
      current_file: '',
      completed_files: 0,
      failed_files: 0,
      started_at: now,
      last_error: '',
    });

    await sr.KBatchImportItem.bulkCreate(candidates.map((x:any, i:number) => ({
      batch_id: batchId,
      file_name: x.file_name,
      payload_url: x.payload_url,
      order_index: i,
      status: 'queued',
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      error_count: 0,
      history_verified: 0,
      history_target: 0,
      rejected_corrupt: 0,
      attempt_count: 0,
      last_attempt_at: '',
      message: '通信失敗分の自動補修待ち',
    })));

    return Response.json({ ok: true, created: true, batch_id: batchId, total_files: candidates.length, files: candidates.map(x => x.file_name) });
  } catch (e:any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
