import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const str = (v:any) => v == null ? '' : String(v).trim();
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 100;

function isTransientError(v:any) {
  const msg = String(v?.message || v?.response?.data?.error || v || '');
  return /\b502\b|\b503\b|\b504\b|\b524\b|timeout|timed out|gateway|cloudflare|econnreset|network error|socket hang up|temporarily unavailable/i.test(msg);
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
    const jobs = await sr.RacerTermImportJob.filter({ batch_id: batchId }, '-created_date', 5);
    const job = jobs?.[0];
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });
    if (job.status === 'completed') return Response.json({ ok: true, done: true, job });

    const items = await sr.RacerTermImportItem.filter({ batch_id: batchId }, 'order_index', 500);
    const ordered = [...(items || [])].sort((a:any,b:any) => Number(a.order_index||0)-Number(b.order_index||0));
    let item = ordered.find((x:any) => x.status === 'queued' || x.status === 'processing');

    if (!item) {
      const completed = ordered.filter((x:any) => x.status === 'success').length;
      const failed = ordered.filter((x:any) => x.status === 'failed').length;
      await sr.RacerTermImportJob.update(job.id, {
        status: 'completed', completed_files: completed, failed_files: failed,
        current_index: ordered.length, current_file: '', finished_at: new Date().toISOString(),
      });
      return Response.json({ ok: true, done: true, completed, failed });
    }

    const attempt = Number(item.attempt_count || 0) + 1;
    await sr.RacerTermImportItem.update(item.id, {
      status: 'processing', attempt_count: attempt, last_attempt_at: new Date().toISOString(),
      message: `サーバー側で取込中 ${Number(item.offset || 0)}/${Number(item.total_records || 0)}（${attempt}/${MAX_ATTEMPTS}）`,
    });
    await sr.RacerTermImportJob.update(job.id, {
      status: 'running', current_index: Number(item.order_index || 0) + 1, current_file: item.file_name,
    });

    try {
      const resp = await fetch(item.payload_url);
      if (!resp.ok) throw new Error(`payload fetch failed: ${resp.status}`);
      const payload = await resp.json();
      const records = Array.isArray(payload?.records) ? payload.records : [];
      const termOverride = payload?.term_override || null;
      if (!records.length) throw new Error('Racer term payload is invalid');

      const offset = Number(item.offset || 0);
      const saveResp = await base44.asServiceRole.functions.invoke('importRacerTermStats', {
        records,
        file_name: item.file_name,
        term_override: termOverride,
        batch_offset: offset,
        batch_size: BATCH_SIZE,
        log_id: item.log_id || null,
      });
      const d = saveResp?.data || {};
      if (d.ok === false) throw new Error(d.error || 'importRacerTermStats failed');

      const nextOffset = d.completed || !d.next_offset ? records.length : Number(d.next_offset);
      const doneFile = nextOffset >= records.length;
      await sr.RacerTermImportItem.update(item.id, {
        status: doneFile ? 'success' : 'queued',
        offset: nextOffset,
        created_count: Number(item.created_count || 0) + Number(d.created || 0),
        updated_count: Number(item.updated_count || 0) + Number(d.updated || 0),
        error_count: Number(item.error_count || 0) + Number(d.errors || 0),
        attempt_count: 0,
        log_id: d.log_id || item.log_id || '',
        message: doneFile ? `完了 ${records.length}/${records.length}` : `継続 ${nextOffset}/${records.length}`,
      });
    } catch (e:any) {
      const transient = isTransientError(e);
      if (transient && attempt < MAX_ATTEMPTS) {
        await sr.RacerTermImportItem.update(item.id, {
          status: 'queued',
          message: `通信一時障害のため自動再試行（${attempt}/${MAX_ATTEMPTS}）: ${e?.message || String(e)}`,
        });
      } else {
        await sr.RacerTermImportItem.update(item.id, {
          status: 'failed', error_count: Number(item.error_count || 0) + 1,
          message: `${transient ? 'AUTO_RETRY_EXHAUSTED: ' : ''}${e?.message || String(e)}`,
        });
      }
    }

    const after = await sr.RacerTermImportItem.filter({ batch_id: batchId }, 'order_index', 500);
    const completed = (after || []).filter((x:any) => x.status === 'success').length;
    const failed = (after || []).filter((x:any) => x.status === 'failed').length;
    const pending = (after || []).filter((x:any) => x.status === 'queued' || x.status === 'processing').length;
    const done = pending === 0;
    await sr.RacerTermImportJob.update(job.id, {
      status: done ? 'completed' : 'running', completed_files: completed, failed_files: failed,
      current_file: done ? '' : item.file_name, ...(done ? { finished_at: new Date().toISOString() } : {}),
    });

    return Response.json({ ok: true, done, completed, failed, pending, processed_file: item.file_name });
  } catch (e:any) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
