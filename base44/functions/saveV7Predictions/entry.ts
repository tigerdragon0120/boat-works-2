// Retired compatibility endpoint. Old open clients cannot append V7 predictions.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.60";

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e: any) => (e?.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    return Response.json({
      ok: true, skipped: "V7_RETIRED", saved: 0, saved_pre: 0, saved_final: 0,
      reasons: { V7_RETIRED: 1 }, handled_hashes: [],
      message: "V7の予想保存は終了しました。V8の保存済み買い目を使用してください。",
    });
  } catch (error: any) {
    console.error("[V7 SAVE]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}
