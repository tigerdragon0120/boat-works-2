import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";

function parseRaceKey(key) {
  const parts = String(key || "").split("_");
  if (parts.length < 3) return null;
  const raceNumberRaw = parts.pop();
  const venueCode = parts.pop();
  const raceDate = parts.join("_");
  const raceNumber = Number(raceNumberRaw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate) || !venueCode || !Number.isFinite(raceNumber)) return null;
  return { race_date: raceDate, venue_code: String(venueCode).padStart(2, "0"), race_number: raceNumber };
}

async function mapBatches(items, size, worker) {
  let done = 0;
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(batch.map(async (x) => { await worker(x); done++; }));
  }
  return done;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const sr = base44.asServiceRole.entities;
    const body = await req.json().catch(() => ({}));
    const targetDate = body.race_date || null;
    const maxRows = Math.min(Number(body.max_rows || 5000), 10000);
    const pageSize = 500;
    const rows = [];
    for (let skip = 0; skip < maxRows; skip += pageSize) {
      const batch = await sr.RaceEntry.filter(targetDate ? { race_date: targetDate } : {}, "-updated_date", pageSize, skip).catch(() => []);
      rows.push(...batch);
      if (batch.length < pageSize) break;
    }

    const raceCache = new Map();
    let repaired = 0, relinked = 0, invalid = 0, alreadyOk = 0;
    await mapBatches(rows, 20, async (e) => {
      const parsed = parseRaceKey(e.race_key);
      if (!parsed) { invalid++; return; }
      const needsFields = !e.race_date || !e.venue_code || e.race_number == null;
      let canonicalRace = raceCache.get(e.race_key);
      if (canonicalRace === undefined) {
        const rs = await sr.Race.filter({ race_key: e.race_key }, "-updated_date", 1).catch(() => []);
        canonicalRace = rs?.[0] || null;
        raceCache.set(e.race_key, canonicalRace);
      }
      const needsRelink = canonicalRace && e.race_id !== canonicalRace.id;
      if (!needsFields && !needsRelink) { alreadyOk++; return; }
      const patch = {
        race_date: parsed.race_date,
        venue_code: parsed.venue_code,
        race_number: parsed.race_number,
      };
      if (canonicalRace) patch.race_id = canonicalRace.id;
      await sr.RaceEntry.update(e.id, patch);
      if (needsFields) repaired++;
      if (needsRelink) relinked++;
    });

    return Response.json({ status: "success", scanned: rows.length, repaired, relinked, already_ok: alreadyOk, invalid, target_date: targetDate });
  } catch (e) {
    return Response.json({ status: "error", message: e?.message || String(e) }, { status: 500 });
  }
}
