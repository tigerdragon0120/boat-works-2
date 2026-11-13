// =====================================================
// saveV7Predictions
// 端末(V7パネル)が生成した予想をサーバーへ同期する入口。
// 端末側では合否を判定せず、共通の保存処理(v7PredictionStore)に委ねる。
//   - 締切・開催状態・確定結果は保存時点のDB値で確認する
//   - 同一レース×段階はロックで直列化して1件だけ登録する
//   - 既存の確定記録は更新しない
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { saveV7Predictions as saveShared } from "../../shared/v7PredictionStore.js";

const MAX_DOCS = 120;

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e: any) => (e?.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const incoming = Array.isArray(body?.docs) ? body.docs : [];
    if (!incoming.length) {
      return Response.json({ ok: true, saved: 0, saved_pre: 0, saved_final: 0, reasons: {}, handled_hashes: [] });
    }

    // 端末から届いた値は SERVER を名乗れない(サーバー生成分の記録と区別する)
    const docs = incoming.slice(0, MAX_DOCS)
      .filter((doc: any) => doc && typeof doc === "object")
      .filter((doc: any) => !String(doc.record_hash || "").startsWith("server:"))
      .map((doc: any) => ({ ...doc, source: "BROWSER" }));

    if (!docs.length) {
      return Response.json({ ok: true, saved: 0, saved_pre: 0, saved_final: 0, reasons: { invalid: incoming.length }, handled_hashes: [] });
    }

    const result = await saveShared(base44, docs);
    return Response.json({ ok: true, ...result });
  } catch (error: any) {
    console.error("[V7 SAVE]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}