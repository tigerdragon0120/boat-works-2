// Immutable, administrator-only transcription for private research. No provider scraping.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.60';
import {acquireLock, releaseLock} from '../../shared/concurrencyLock.js';
import {buildExternalPrediction} from '../../shared/v8ExternalEvidence.js';

const rowsOf = (value: any) => Array.isArray(value) ? value : value?.items;

export default async function(req: Request): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ok: false, error: 'METHOD_NOT_ALLOWED'}, {status: 405});
  const client = createClientFromRequest(req);
  let user: any = null;
  try { user = await client.auth.me(); } catch { user = null; }
  if (!user) return Response.json({ok: false, error: 'Unauthorized'}, {status: 401});
  if (user.role !== 'admin') return Response.json({ok: false, error: 'Forbidden'}, {status: 403});
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ok: false, error: 'INVALID_JSON'}, {status: 400}); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ok: false, error: 'INVALID_INPUT'}, {status: 400});
  const items = Array.isArray(body.items) ? body.items : [body];
  if (!items.length || items.length > 30 || items.some((x: any) => !x || typeof x !== 'object' || Array.isArray(x) || typeof x.race_id !== 'string'))
    return Response.json({ok: false, error: 'INVALID_BATCH'}, {status: 400});
  const sr = client.asServiceRole.entities;
  const summary: any = {ok: true, created: 0, duplicates: 0, records: []};
  const date = new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'});
  const budgetDeadline = Date.now() + 85000;
  let lock: any = null;
  try {
    lock = await acquireLock(client, 'V8_EXTERNAL_' + date, 'v8RecordExternalPrediction', 120000);
    if (!lock) return Response.json({ok: false, error: 'IMPORT_BUSY_RETRY'}, {status: 409});
    const cache = new Map<string, {race: any; entries: any[]}>();
    const checked: any[] = [];
    // Validate all input before any create, so a typo does not partially import a batch.
    for (let index = 0; index < items.length; index++) {
      if (Date.now() >= budgetDeadline) return Response.json({...summary, ok: false, error: 'IMPORT_TIME_BUDGET_RETRY_SAFE'}, {status: 503});
      const input = items[index];
      if (!cache.has(input.race_id)) {
        let race: any;
        try { race = await sr.Race.get(input.race_id); } catch {
          return Response.json({ok: false, error: 'RACE_NOT_READABLE', index}, {status: 400});
        }
        if (!race?.id) return Response.json({ok: false, error: 'RACE_NOT_FOUND', index}, {status: 400});
        const hasPre = items.some((x: any) => x.race_id === input.race_id && x.stage === 'PRE');
        let entries: any[] = [];
        if (hasPre) {
          const response = await sr.RaceEntry.filter({race_id: race.id}, '-updated_date', 40);
          const rows = rowsOf(response);
          if (!Array.isArray(rows) || rows.length >= 40 || response?.has_more === true)
            return Response.json({ok: false, error: 'ENTRY_READ_INCOMPLETE', index}, {status: 503});
          entries = rows;
        }
        cache.set(input.race_id, {race, entries});
      }
      const context = cache.get(input.race_id)!;
      const output = await buildExternalPrediction({input, ...context, now: new Date().toISOString(), recordedBy: user.id});
      if (!output.ok) return Response.json({ok: false, error: output.reason, index}, {status: 400});
      checked.push({input, context});
    }
    for (const {input, context} of checked) {
      if (Date.now() >= budgetDeadline) return Response.json({...summary, ok: false, error: 'IMPORT_TIME_BUDGET_RETRY_SAFE'}, {status: 503});
      // Re-evaluate the time gate immediately before persistence; never back-date a late input.
      const output = await buildExternalPrediction({input, ...context, now: new Date().toISOString(), recordedBy: user.id});
      if (!output.ok) return Response.json({...summary, ok: false, error: output.reason}, {status: 400});
      const existingResponse = await sr.V8ExternalPrediction.filter({record_key: output.record.record_key}, '-created_date', 2);
      const existing = rowsOf(existingResponse);
      if (!Array.isArray(existing)) return Response.json({...summary, ok: false, error: 'EVIDENCE_READ_FAILED'}, {status: 503});
      if (existing.length > 1) return Response.json({...summary, ok: false, error: 'DUPLICATE_EVIDENCE_KEY'}, {status: 409});
      if (existing.length === 1) {
        summary.duplicates++;
        summary.records.push(existing[0]);
        continue;
      }
      const saved = await sr.V8ExternalPrediction.create(output.record);
      if (!saved?.id) return Response.json({...summary, ok: false, error: 'EVIDENCE_SAVE_UNCONFIRMED'}, {status: 503});
      summary.created++;
      summary.records.push(saved);
    }
    return Response.json(summary);
  } catch (error: any) {
    console.error('[V8_EXTERNAL] import_failed', String(error?.message || error).slice(0, 140));
    return Response.json({...summary, ok: false, error: 'EXTERNAL_IMPORT_FAILED_RETRY_SAFE'}, {status: 503});
  } finally {
    if (lock) await releaseLock(client, lock).catch(() => {});
  }
}
