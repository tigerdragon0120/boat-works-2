import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const str = (v:any) => v == null ? '' : String(v).trim();
const MAX_ATTEMPTS = 4;

function isTransientError(v:any) {
  const msg = String(v?.message || v?.response?.data?.error || v || '');
  return /\b524\b|\b502\b|\b503\b|\b504\b|timeout|timed out|cloudflare|origin web server|econnreset|econnrefused|network error|socket hang up|temporarily unavailable/i.test(msg);
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const { batch_id } = await req.json();
    const batchId = str(batch_id);
    if (!batchId) return Response.json({ error: 'batch_id required' }, { status: 400 });

    const sr = base44.asServiceRole.entities;
    const jobs = await sr.KBatchImportJob.filter({ batch_id: batchId }, '-created_date', 5);
    const job = jobs?.[0];
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });
    if (job.status === 'completed') return Response.json({ ok: true, done: true, job });

    const items = await sr.KBatchImportItem.filter({ batch_id: batchId }, 'order_index', 500);
    const ordered = [...(items || [])].sort((a:any,b:any) => Number(a.order_index||0)-Number(b.order_index||0));
    let item = ordered.find((x:any) => x.status === 'queued');
    if (!item) item = ordered.find((x:any) => x.status === 'processing');

    if (!item) {
      const completed = ordered.filter((x:any) => x.status === 'success').length;
      const failed = ordered.filter((x:any) => x.status === 'failed').length;
      await sr.KBatchImportJob.update(job.id, {
        status: 'completed',
        completed_files: completed,
        failed_files: failed,
        current_index: ordered.length,
        current_file: '',
        finished_at: new Date().toISOString(),
      });
      return Response.json({ ok: true, done: true, completed, failed });
    }

    const attempt = Number(item.attempt_count || 0) + 1;
    await sr.KBatchImportItem.update(item.id, {
      status: 'processing',
      attempt_count: attempt,
      last_attempt_at: new Date().toISOString(),
      message: `サーバー側で取込中（${attempt}/${MAX_ATTEMPTS}）`,
    });
    await sr.KBatchImportJob.update(job.id, {
      status: 'running',
      current_index: Number(item.order_index || 0) + 1,
      current_file: item.file_name,
    });

    try {
      const resp = await fetch(item.payload_url);
      if (!resp.ok) throw new Error(`payload fetch failed: ${resp.status}`);
      const parsedData = await resp.json();
      if (!parsedData || parsedData.type !== 'K') throw new Error('K parsed payload is invalid');

      const saveResp = await base44.asServiceRole.functions.invoke('saveBoatraceData', {
        data_type: 'K',
        parsed_data: parsedData,
        file_name: item.file_name,
        fast_historical_k: true,
      });
      const d = saveResp?.data || {};
      const transient = d.ok === false && isTransientError(d.error || d.message || (d.errorDetails || []).join(' '));
      if (transient) throw new Error(d.error || d.message || 'temporary save error');

      const success = d.ok !== false && Number(d.errors || 0) === 0;
      await sr.KBatchImportItem.update(item.id, {
        status: success ? 'success' : 'failed',
        created_count: Number(d.created || 0),
        updated_count: Number(d.updated || 0),
        skipped_count: Number(d.skipped || 0),
        error_count: Number(d.errors || 0),
        history_verified: Number(d.history_verified || 0),
        history_target: Number(d.history_target || 0),
        rejected_corrupt: Number(d.rejected_corrupt || 0),
        message: d.message || (success ? '完了' : '取込不完全'),
      });
    } catch (e:any) {
      const transient = isTransientError(e);
      if (transient && attempt < MAX_ATTEMPTS) {
        await sr.KBatchImportItem.update(item.id, {
          status: 'queued',
          error_count: 0,
          message: `通信一時障害のため自動再試行します（${attempt}/${MAX_ATTEMPTS}）: ${e?.message || String(e)}`,
        });
      } else {
        await sr.KBatchImportItem.update(item.id, {
          status: 'failed',
          error_count: 1,
          message: `${transient ? 'AUTO_REPAIR_EXHAUSTED: ' : ''}${e?.message || String(e)}`,
        });
      }
    }

    const after = await sr.KBatchImportItem.filter({ batch_id: batchId }, 'order_index', 500);
    const completed = (after || []).filter((x:any) => x.status === 'success').length;
    const failed = (after || []).filter((x:any) => x.status === 'failed').length;
    const pending = (after || []).filter((x:any) => x.status === 'queued' || x.status === 'processing').length;
    const done = pending === 0;

    await sr.KBatchImportJob.update(job.id, {
      status: done ? 'completed' : 'running',
      completed_files: completed,
      failed_files: failed,
      current_file: done ? '' : item.file_name,
      ...(done ? { finished_at: new Date().toISOString() } : {}),
    });

    return Response.json({ ok: true, done, completed, failed, pending, processed_file: item.file_name });
  } catch (e:any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
