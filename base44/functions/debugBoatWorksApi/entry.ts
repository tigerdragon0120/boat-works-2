import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const targetDate = body.date || '2026-09-05';
    const venueCode = body.venue_code || '01';

    const base = secrets.get('BOAT_WORKS_API_BASE');
    const key = secrets.get('BOAT_WORKS_API_KEY');
    if (!base || !key) return Response.json({ error: 'API未設定' }, { status: 500 });

    const normalized = String(base).replace(/\/$/, '');
    const endpoint = normalized.includes('exportBoatWorksData') ? normalized : `${normalized}/exportBoatWorksData`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let raw;
    try {
      const res = await fetch(`${endpoint}?date=${encodeURIComponent(targetDate)}&venue_code=${encodeURIComponent(venueCode)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal
      });
      if (!res.ok) {
        return Response.json({ error: `API ${res.status}`, body: (await res.text().catch(() => '')).slice(0, 500) }, { status: 500 });
      }
      raw = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const topKeys = Object.keys(raw || {});
    const counts = {};
    for (const k of topKeys) {
      counts[k] = Array.isArray(raw[k]) ? raw[k].length : (typeof raw[k] === 'object' ? 'object' : raw[k]);
    }

    // 各配列のフィールド名一覧のみ(サンプル値は切り詰める)
    const fieldsOf = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      return Object.keys(arr[0]);
    };
    const sampleOf = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const s = arr[0];
      // 文字列/数値はそのまま、長い配列は最初3件
      const out = {};
      for (const [k, v] of Object.entries(s)) {
        if (Array.isArray(v)) out[k] = v.slice(0, 3);
        else if (typeof v === 'string' && v.length > 50) out[k] = v.slice(0, 50) + '...';
        else out[k] = v;
      }
      return out;
    };

    return Response.json({
      targetDate, venueCode,
      counts,
      resultsFields: fieldsOf(raw.results),
      resultsSample: sampleOf(raw.results),
      entriesFields: fieldsOf(raw.entries),
      seriesFields: fieldsOf(raw.series),
      oddsFields: fieldsOf(raw.odds),
      uichiFields: fieldsOf(raw.uichi_features),
    });
  } catch (error) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
}