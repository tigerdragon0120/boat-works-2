// =====================================================
// buildV65Calibration
// 日次検証(PredictionV65Verification)の結果から
// V6.5の補正値(EngineCalibration)を再計算して保存する。
// 保存された補正値は次回以降のV6.5予想の判定に使われる。
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { rebuildV65Calibration } from "../../shared/v65Calibration.js";

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") {
      return Response.json({ ok: false, error: "Forbidden: admin only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const lookbackDays = Number.isFinite(Number(body?.days))
      ? Math.min(365, Math.max(7, Number(body.days)))
      : 90;

    const result = await rebuildV65Calibration(base44, { lookbackDays });
    return Response.json({ ok: true, ...result, completed_at: new Date().toISOString() });
  } catch (error: any) {
    console.error("[V6.5 CALIBRATION]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}