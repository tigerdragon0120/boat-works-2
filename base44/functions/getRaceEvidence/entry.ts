// =====================================================
// getRaceEvidence
// 画面用: 対象レースの結果証跡(ResultProvenance)を全件返す。
// ページ取得は日次照合と同じ共通処理(shared/resultProvenance → shared/pagedFetch)を使い、
// 例外・想定外の応答・カーソル欠落・ページ上限では complete=false(未完了)を返す。
// 画面は complete=false を判定に使わず保留とする。
//
// body: { race_id }
// =====================================================
// ページ形式({items, next_cursor, has_more})の取得を使うため 0.8.60 を使用する
import { createClientFromRequest } from "npm:@base44/sdk@0.8.60";
import { loadProvenanceByRace } from "../../shared/resultProvenance.js";

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const raceId = typeof body?.race_id === "string" ? body.race_id : null;
    if (!raceId) {
      return Response.json({ ok: false, error: "race_id is required" }, { status: 400 });
    }

    const { byRace, complete } = await loadProvenanceByRace(base44.asServiceRole.entities, [raceId]);
    return Response.json({ ok: true, rows: byRace.get(raceId) || [], complete });
  } catch (error: any) {
    console.error("[GET RACE EVIDENCE]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}