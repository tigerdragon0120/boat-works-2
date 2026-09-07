import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { secrets } from "base44:runtime";
import { syncAndPredict } from "../../shared/predictionService.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 指数バックオフ付きfetch。Rate limit(429)または5xx/Network Error時に再試行。
// API呼び出し回数を最小化するため、全場一括取得(1回)を基本とする。
async function fetchWithRetry(url: string, key: string, maxRetries = 4): Promise<any> {
  let lastError: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      // Rate limit or server error → 指数バックオフで再試行
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Rate limit exceeded (HTTP ${res.status})`);
        if (attempt < maxRetries) {
          const delay = Math.min(10000 * Math.pow(2, attempt), 120000); // 10s, 20s, 40s, 80s
          await sleep(delay);
          continue;
        }
        const detail = await res.text().catch(() => "");
        throw new Error(`BOAT WORKS API ${res.status} (retries exhausted): ${detail.slice(0, 300)}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`BOAT WORKS APIエラー: ${res.status} ${detail.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e: any) {
      lastError = e;
      // Network error / AbortError / Rate limit → 再試行
      if (e.name === "AbortError" || /fetch|network|timeout|rate limit/i.test(e.message || "")) {
        if (attempt < maxRetries) {
          const delay = Math.min(10000 * Math.pow(2, attempt), 120000);
          await sleep(delay);
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError || new Error("fetch failed");
}

// BUILD_TAG: full_fetch_sync_20260907
// BOAT WORKS DATA SYNC
// mode: "api"  → BOAT WORKS側APIからデータを取得して同期+予想
//        BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY をサーバー側Secretから使用
//        全場一括取得(1回のAPI呼び出し)でRate limitを回避
// mode: "ingest" → body.data を直接取り込んで同期+予想(デバッグ用途)
// date: "YYYY-MM-DD"(省略時は今日)
// venue_code: 特定場のみ同期する場合に指定(通常運用では未指定)
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden: admin only" }, { status: 403 });

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const mode = body.mode || "ingest";
    const date = body.date || new Date().toISOString().slice(0, 10);
    const venueCode = body.venue_code ? String(body.venue_code).padStart(2, "0") : null;
    const manifestOnly = body.manifest === true;

    // --- ingest mode: body.dataを直接取り込み(デバッグ用途) ---
    if (mode !== "api") {
      const payload = body.data || {};
      if (!payload || !Array.isArray(payload.races)) {
        return Response.json({ error: "データ形式不正: { races, entries, series, results, odds } が必要です" }, { status: 400 });
      }
      const summary = await syncAndPredict(base44, payload, { mode, venue_code: venueCode });
      return Response.json({ ok: true, date, mode, venue_code: venueCode, summary });
    }

    // --- api mode ---
    const base = secrets.get("BOAT_WORKS_API_BASE");
    const key = secrets.get("BOAT_WORKS_API_KEY");
    if (!base || !key) {
      return Response.json({ error: "BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY がサーバーSecretに未設定です" }, { status: 500 });
    }
    const normalized = String(base).replace(/\/$/, "");
    const baseUrl = normalized.includes("exportBoatWorksData")
      ? `${normalized}${normalized.includes("?") ? "&" : "?"}date=${encodeURIComponent(date)}`
      : `${normalized}/exportBoatWorksData?date=${encodeURIComponent(date)}`;

    // manifest only
    if (manifestOnly) {
      const manifest = await fetchWithRetry(`${baseUrl}&manifest=1`, key);
      return Response.json({ ok: true, date, mode, manifest: true, venue_codes: manifest.venue_codes || [], race_count: manifest.race_count || 0 });
    }

    // 特定場指定: その場だけ取得して同期
    if (venueCode) {
      const url = `${baseUrl}&venue_code=${encodeURIComponent(venueCode)}`;
      const payload = await fetchWithRetry(url, key);
      if (!payload || !Array.isArray(payload.races)) {
        return Response.json({ error: "データ形式不正 (venue mode)" }, { status: 400 });
      }
      const summary = await syncAndPredict(base44, payload, { mode, venue_code: venueCode });
      return Response.json({ ok: true, date, mode, venue_code: venueCode, summary });
    }

    // 全場一括取得: 1回のAPI呼び出しで全データ取得(Rate limit回避)
    const payload = await fetchWithRetry(baseUrl, key);
    if (!payload || !Array.isArray(payload.races)) {
      return Response.json({ error: "データ形式不正: { races, entries, series, results, odds } が必要です" }, { status: 400 });
    }

    const summary = await syncAndPredict(base44, payload, { mode });
    return Response.json({ ok: true, date, mode, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}