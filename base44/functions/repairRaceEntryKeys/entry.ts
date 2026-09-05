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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const sr = base44.asServiceRole.entities;
    const body = await req.json().catch(() => ({}));
    const targetDate = body.race_date || null;
    const maxGroups = Math.min(Number(body.max_groups || 24), 60);

    // NULLの行だけ読む。race_key単位でupdateManyするため、6艇を1回の書込みで直せる。
    const query = targetDate
      ? { race_key: { $regex: `^${targetDate}_` }, $or: [{ race_date: null }, { venue_code: null }, { race_number: null }] }
      : { $or: [{ race_date: null }, { venue_code: null }, { race_number: null }] };
    const rows = await sr.RaceEntry.filter(query, "-updated_date", 500).catch(() => []);

    const grouped = new Map();
    for (const e of rows) {
      const parsed = parseRaceKey(e.race_key);
      if (!parsed) continue;
      if (!grouped.has(e.race_key)) grouped.set(e.race_key, parsed);
      if (grouped.size >= maxGroups) break;
    }

    let groupsRepaired = 0;
    let rowsRepaired = 0;
    const errors = [];
    for (const [raceKey, parsed] of grouped.entries()) {
      try {
        const res = await sr.RaceEntry.updateMany(
          { race_key: raceKey },
          { $set: { race_date: parsed.race_date, venue_code: parsed.venue_code, race_number: parsed.race_number } }
        );
        groupsRepaired++;
        rowsRepaired += Number(res?.modified_count || res?.modifiedCount || res?.matched_count || 0);
      } catch (e) {
        errors.push({ race_key: raceKey, message: e?.message || String(e) });
        if (/rate limit/i.test(e?.message || "")) break;
      }
      await sleep(140);
    }

    return Response.json({
      status: errors.length ? "partial" : "success",
      scanned_missing_rows: rows.length,
      groups_repaired: groupsRepaired,
      rows_repaired: rowsRepaired,
      remaining_sample: Math.max(0, rows.length - groupsRepaired * 6),
      target_date: targetDate,
      errors,
    });
  } catch (e) {
    return Response.json({ status: "error", message: e?.message || String(e) }, { status: 500 });
  }
}
