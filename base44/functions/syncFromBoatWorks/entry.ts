import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { syncAndPredict } from "../../shared/predictionService.js";

// BOAT WORKS DATA SYNC
// mode: "api"  → BOAT WORKS側APIからデータを取得して同期+予想
//        body.api_base / body.api_key を使用(管理画面のAppSettingsから渡す)
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

    let payload;
    if (mode === "api") {
      const base = body.api_base;
      const key = body.api_key;
      if (!base || !key) {
        return Response.json({ error: "api_base / api_key が未設定です。管理画面でBOAT WORKS API設定を入力してください。" }, { status: 400 });
      }
      const url = `${base.replace(/\/$/, "")}/sync?date=${date}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) return Response.json({ error: `BOAT WORKS APIエラー: ${res.status}` }, { status: 502 });
      payload = await res.json();
    } else {
      payload = body.data || {};
    }

    if (!payload || !Array.isArray(payload.races)) {
      return Response.json({ error: "データ形式不正: { races, entries, series, results, odds } が必要です" }, { status: 400 });
    }

    const summary = await syncAndPredict(base44, payload, { mode });
    return Response.json({ ok: true, date, mode, summary });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}