// =====================================================
// generateV7Predictions
// 統合V7の予想をサーバー側で生成し PredictionV7 に保存する入口。
// 実処理は base44/shared/v7AutoGeneration.js に集約しており、
// 締切前確認・同一レース段階の二重登録防止・確定記録の不変性はそこで担保する。
//
// body:
//   race_date        対象日(既定はJSTの今日)
//   horizon_minutes  締切までの対象範囲(既定25分)
//   race_keys        明示指定(指定時はそのレースのみ)
//   force            true でロックを取らずに実行(検証用)
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { acquireLock, releaseLock } from "../../shared/concurrencyLock.js";
import { runV7AutoGeneration } from "../../shared/v7AutoGeneration.js";
// 共有モジュール(v7AutoGeneration)を更新した場合はこの関数を再保存して再バンドルする。

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  let user: any = null;
  try { user = await base44.auth.me(); } catch { user = null; }
  if (user && user.role !== "admin") {
    return Response.json({ ok: false, error: "Forbidden: admin only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const raceDate = typeof body?.race_date === "string" && body.race_date
    ? body.race_date
    : new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const force = body?.force === true;

  const lockId = force ? null : await acquireLock(base44, `v7_generate_${raceDate}`, "generateV7Predictions", 4 * 60 * 1000);
  if (!force && !lockId) {
    return Response.json({ ok: true, race_date: raceDate, skipped: "locked" });
  }

  try {
    const summary = await runV7AutoGeneration(base44, {
      race_date: raceDate,
      horizon_minutes: body?.horizon_minutes,
      race_keys: body?.race_keys,
    });
    return Response.json({ ok: true, ...summary, completed_at: new Date().toISOString() });
  } catch (error: any) {
    console.error("[V7 AUTO PREDICTION]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  } finally {
    await releaseLock(base44, lockId).catch(() => {});
  }
}