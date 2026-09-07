import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function jstDate() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let body: any = {};
    try { body = await req.json(); } catch {}
    const date = body.date || jstDate();

    const races = await base44.asServiceRole.entities.Race.filter({ race_date: date }, 'venue_code', 500).catch(() => []);
    const byVenue = new Map<string, any[]>();
    for (const r of races) {
      const v = String(r.venue_code || '').padStart(2, '0');
      if (!v) continue;
      if (!byVenue.has(v)) byVenue.set(v, []);
      byVenue.get(v)!.push(r);
    }

    // 既知の当日開催場を優先し、Race不足またはPRE未完の場だけ再同期する。
    // 1回2場までに制限してBase44のDB APIレート制限を避ける。
    const candidates = [...byVenue.entries()]
      .map(([venue, list]) => ({ venue, race_count: list.length, pre_count: list.filter(r => r.has_pre === true).length }))
      .filter(x => x.race_count < 12 || x.pre_count < 12)
      .sort((a, b) => (a.race_count - b.race_count) || (a.pre_count - b.pre_count) || a.venue.localeCompare(b.venue));

    const targets = candidates.slice(0, 2);
    const results: any[] = [];
    for (const t of targets) {
      try {
        const res = await base44.asServiceRole.functions.invoke('syncFromBoatWorks', {
          mode: 'api',
          date,
          venue_code: t.venue,
        });
        results.push({ venue_code: t.venue, before: t, result: res?.data || res || null });
      } catch (e: any) {
        results.push({ venue_code: t.venue, before: t, error: e?.message || String(e) });
      }
    }

    const afterRaces = await base44.asServiceRole.entities.Race.filter({ race_date: date }, 'venue_code', 500).catch(() => []);
    const summary: Record<string, any> = {};
    for (const r of afterRaces) {
      const v = String(r.venue_code || '').padStart(2, '0');
      summary[v] ||= { races: 0, pre: 0 };
      summary[v].races++;
      if (r.has_pre === true) summary[v].pre++;
    }

    return Response.json({ status: 'success', date, targets, results, summary });
  } catch (error: any) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}
