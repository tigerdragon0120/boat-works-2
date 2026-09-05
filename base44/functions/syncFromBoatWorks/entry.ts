import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { secrets } from "base44:runtime";
import { syncAndPredict } from "../../shared/predictionService.js";

// BUILD_TAG: race_date_fallback_fix_20260905_2 — 共有ファイル(raceKey.js/predictionService.js)の
// 変更を確実に再デプロイさせるための目印。中身の意味はない。

// BOAT WORKS DATA SYNC
// mode: "api"  → BOAT WORKS側APIからデータを取得して同期+予想
//        BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY をサーバー側Secretから使用
// mode: "ingest" → body.data を直接取り込んで同期+予想(テスト/手動投入用)
// date: "YYYY-MM-DD"(省略時は今日)
export default async function (req) {
// BOAT WORKS DATA SYNC
// mode: "api"  → BOAT WORKS側APIからデータを取得して同期+予想
//        BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY をサーバー側Secretから使用
// mode: "ingest" → body.data を直接取り込んで同期+予想(テスト/手動投入用)
// date: "YYYY-MM-DD"(省略時は今日)
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden: admin only" }, { status: 403 });

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const mode = body.mode || "ingest";
    const date = body.date || new Date().toISOString().slice(0, 10);
    const venueCode = body.venue_code ? String(body.venue_code).padStart(2, "0") : null;
    const manifestOnly = body.manifest === true;

    let payload;
    if (mode === "api") {
      const base = secrets.get("BOAT_WORKS_API_BASE");
      const key = secrets.get("BOAT_WORKS_API_KEY");
      if (!base || !key) {
        return Response.json({ error: "BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY がサーバーSecretに未設定です" }, { status: 500 });
      }
      const normalized = String(base).replace(/\/$/, "");
      const baseUrl = normalized.includes("exportBoatWorksData")
        ? `${normalized}${normalized.includes("?") ? "&" : "?"}date=${encodeURIComponent(date)}`
        : `${normalized}/exportBoatWorksData?date=${encodeURIComponent(date)}`;
      const qs = `${manifestOnly ? "&manifest=1" : ""}${venueCode ? `&venue_code=${encodeURIComponent(venueCode)}` : ""}`;
      const url = `${baseUrl}${qs}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return Response.json({ error: `BOAT WORKS APIエラー: ${res.status}`, detail: detail.slice(0, 500) }, { status: 502 });
      }
      payload = await res.json();
      if (manifestOnly) {
        return Response.json({ ok: true, date, mode, manifest: true, venue_codes: payload.venue_codes || [], race_count: payload.race_count || 0 });
      }
    } else {
      payload = body.data || {};
    }

    if (!payload || !Array.isArray(payload.races)) {
      return Response.json({ error: "データ形式不正: { races, entries, series, results, odds } が必要です" }, { status: 400 });
    }

     const summary = await syncAndPredict(base44, payload, { mode, venue_code: venueCode });
    return Response.json({
      ok: true, date, mode, venue_code: venueCode, summary,
      // 一時デバッグ: 受信した生entryと、送信元raceの中身をそのまま1件返す。
      // race_dateが実際に来ているかをDB画面を介さず直接確認するため。
      debug_sample_entry: Array.isArray(payload.entries) ? payload.entries[0] || null : null,
      debug_sample_race: Array.isArray(payload.races) ? payload.races[0] || null : null,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
