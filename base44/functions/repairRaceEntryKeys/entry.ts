import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";

function parseRaceKey(key: string) {
  const parts = String(key || "").split("_");
  if (parts.length < 3) return null;
  const raceNumberRaw = parts.pop()!;
  const venueCode = parts.pop()!;
  const raceDate = parts.join("_");
  const raceNumber = Number(raceNumberRaw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raceDate) || !venueCode || !Number.isFinite(raceNumber)) return null;
  return { race_date: raceDate, venue_code: String(venueCode).padStart(2, "0"), race_number: raceNumber };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 2026-09-06等の指定日(または全期間)のRaceEntryを一括修復する。
// 修復内容:
//   1. race_date / venue_code / race_number が空欄(null/undefined/""/NaN/"00")の行をrace_keyから補完
//   2. race_id を正しい親Race(canonical Race)へ再接続
//   3. 親Raceが存在しない場合はスキップ(削除しない)
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let user: any = null;
    try { user = await base44.auth.me(); } catch {}
    if (!user || user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const sr = base44.asServiceRole.entities;
    const body = await req.json().catch(() => ({}));
    const targetDate = body.race_date || null;

    // 対象のRaceEntryを全件取得(指定日ならその日のrace_keyで絞り込み)
    const entryQuery = targetDate
      ? { race_key: { $regex: `^${targetDate}_` } }
      : {};
    const entries = await sr.RaceEntry.filter(entryQuery, "boat_number", 10000).catch(() => []);

    // race_keyごとにグループ化
    const byRaceKey = new Map<string, any[]>();
    for (const e of entries) {
      if (!e.race_key) continue;
      if (!byRaceKey.has(e.race_key)) byRaceKey.set(e.race_key, []);
      byRaceKey.get(e.race_key)!.push(e);
    }

    let groupsProcessed = 0;
    let rowsRepaired = 0;
    let raceIdReconnected = 0;
    let entriesPerRaceOk = 0;
    const errors: any[] = [];

    for (const [raceKey, entryList] of byRaceKey.entries()) {
      try {
        const parsed = parseRaceKey(raceKey);
        if (!parsed) { errors.push({ race_key: raceKey, message: "race_key parse failed" }); continue; }

        // canonical Raceを特定(race_keyで検索、最も完全なものを選ぶ)
        const races = await sr.Race.filter({ race_key: raceKey }, "-updated_date", 20).catch(() => []);
        if (!races || !races.length) {
          errors.push({ race_key: raceKey, message: "Race not found (skip)" });
          continue;
        }
        // 複数ある場合は最初のものをcanonicalとする(削除せずそのまま)
        const canonicalRace = races[0];

        // 6艇揃っているか
        if (entryList.length >= 6) entriesPerRaceOk++;

        // 各エントリを修復
        for (const e of entryList) {
          const needsFix =
            e.race_date !== parsed.race_date ||
            e.venue_code !== parsed.venue_code ||
            e.race_number !== parsed.race_number ||
            e.race_id !== canonicalRace.id;

          if (needsFix) {
            await sr.RaceEntry.update(e.id, {
              race_date: parsed.race_date,
              venue_code: parsed.venue_code,
              race_number: parsed.race_number,
              race_id: canonicalRace.id,
            }).catch(() => {});
            rowsRepaired++;
            if (e.race_id !== canonicalRace.id) raceIdReconnected++;
          }
        }
        groupsProcessed++;
      } catch (e: any) {
        errors.push({ race_key: raceKey, message: e?.message || String(e) });
        if (/rate limit/i.test(e?.message || "")) { await sleep(2000); continue; }
      }
      await sleep(80); // rate limit対策
    }

    return Response.json({
      status: errors.length ? "partial" : "success",
      target_date: targetDate,
      total_entries_scanned: entries.length,
      unique_race_keys: byRaceKey.size,
      groups_processed: groupsProcessed,
      rows_repaired: rowsRepaired,
      race_id_reconnected: raceIdReconnected,
      races_with_6_entries: entriesPerRaceOk,
      errors: errors.slice(0, 50),
    });
  } catch (e: any) {
    return Response.json({ status: "error", message: e?.message || String(e) }, { status: 500 });
  }
}