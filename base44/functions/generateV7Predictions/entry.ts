// Retired compatibility endpoint. V8 owns all new forecasts. Historical records are kept.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.60";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  // 認証: 未認証は401、管理者以外は403
  // 定期実行はワークフローが作成者(管理者)として呼ぶため、この判定で通る。
  let user: any = null;
  try { user = await base44.auth.me(); } catch { user = null; }
  if (!user) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return Response.json({ ok: false, error: "Forbidden: admin only" }, { status: 403 });
  }

  return Response.json({
    ok: true, skipped: "V7_RETIRED", saved_pre: 0, saved_final: 0,
    message: "V7の予想生成は終了しました。V8の保存済み買い目を使用してください。",
  });
}
