import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { computeLanePast10Stats } from '../../shared/lanePast10Engine.js';

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body.entries) ? body.entries.slice(0, 6) : [];
    const raceDate = body.race_date || null;
    const raceContext = {
      race_id: body.race_id || null,
      venue_code: body.venue_code || null,
      race_number: body.race_number || null,
    };
    const sr = base44.asServiceRole.entities;

    const { by_key, logs } = await computeLanePast10Stats(sr, requested, raceDate, raceContext);

    for (const log of logs) console.log(log);

    return Response.json({ ok: true, by_key });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}