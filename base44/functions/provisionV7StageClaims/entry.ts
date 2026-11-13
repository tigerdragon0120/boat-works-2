// =====================================================
// provisionV7StageClaims
// 未来の対象レース×PRE/FINALの登録枠(V7StageClaim)を、冪等に用意し存在を確認する。
//
// ・締切済み・終了レースは対象外(事後生成・遡及確定を行わない)
// ・作成応答は存在の証明にせず、必ず再読取して「1行だけ存在」を確認する
// ・既存の登録枠・予想・検証記録は削除も更新もしない
// ・重複(2行以上)・欠損(0行)は未準備として返し、その組は保存しない
//
// body:
//   race_date  対象日(既定はJSTの今日)
//   race_keys  対象レースの明示指定(省略時は対象日の全レースから未来分)
//   dry_run    true で作成せず、確認だけを行う
// =====================================================
// 共通取得処理がページ形式({items,next_cursor,has_more})を使うため 0.8.60
import { createClientFromRequest } from "npm:@base44/sdk@0.8.60";
import { provisionStageClaims } from "../../shared/v7StageClaimProvision.js";
import { fetchAllPaged } from "../../shared/pagedFetch.js";
import { acquireLock, releaseLock } from "../../shared/concurrencyLock.js";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    let user: any = null;
    try { user = await base44.auth.me(); } catch { user = null; }
    if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ ok: false, error: "Forbidden: admin only" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const raceDate = typeof body?.race_date === "string" && body.race_date
      ? body.race_date
      : new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const onlyKeys = Array.isArray(body?.race_keys) && body.race_keys.length
      ? body.race_keys.map(String)
      : null;

    const sr = base44.asServiceRole.entities;
    const page = await fetchAllPaged(
      (query: any, options: any) => sr.Race.filter(query, options),
      { race_date: raceDate },
      { sort: "race_number" },
    );
    if (!page.complete) {
      return Response.json({ ok: false, error: "RACE_READ_INCOMPLETE" }, { status: 503 });
    }
    const races = onlyKeys
      ? page.rows.filter((race: any) => onlyKeys.includes(String(race.race_key)))
      : page.rows;

    const lockId = dryRun ? null : await acquireLock(base44, `v7_claims_${raceDate}`, "provisionV7StageClaims", 2 * 60 * 1000);
    if (!dryRun && !lockId) {
      return Response.json({ ok: true, race_date: raceDate, skipped: "locked" });
    }
    try {
      const result = await provisionStageClaims(sr, races, { allowCreate: !dryRun });
      return Response.json({
        ok: true,
        race_date: raceDate,
        dry_run: dryRun,
        races: races.length,
        expected: result.expected,
        created: result.created,
        ready: result.ready,
        missing: result.missing.length,
        duplicate: result.duplicate.length,
        read_complete: result.read_complete,
        creation_unconfirmed: result.creation_unconfirmed,
        missing_sample: result.missing.slice(0, 10),
        duplicate_sample: result.duplicate.slice(0, 10),
      });
    } finally {
      if (lockId) await releaseLock(base44, lockId);
    }
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}