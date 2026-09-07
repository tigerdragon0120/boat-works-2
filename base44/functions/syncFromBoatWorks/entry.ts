import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { secrets } from "base44:runtime";
import { syncAndPredict } from "../../shared/predictionService.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 指数バックオフ付きfetch。Rate limit(429)または5xx/Network Error時に再試行。
async function fetchWithRetry(url: string, key: string, maxRetries = 4): Promise<any> {
  let lastError: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      // Rate limit or server error → 再試行
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`API ${res.status}`);
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 30000); // 2s, 4s, 8s, 16s, max30s
          await sleep(delay);
          continue;
        }
        const detail = await res.text().catch(() => "");
        throw new Error(`BOAT WORKS API ${res.status} (retries exhausted): ${detail.slice(0, 200)}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`BOAT WORKS APIエラー: ${res.status} ${detail.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e: any) {
      lastError = e;
      // Network error / AbortError → 再試行
      if (e.name === "AbortError" || /fetch|network|timeout/i.test(e.message || "")) {
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
          await sleep(delay);
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError || new Error("fetch failed");
}

// BUILD_TAG: sequential_venue_sync_20260907
// BOAT WORKS DATA SYNC
// mode: "api"  → BOAT WORKS側APIからデータを取得して同期+予想
//        BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY をサーバー側Secretから使用
//        venue_code未指定時はmanifest取得→場ごとに順次取得(指数バックオフ付き)
// mode: "ingest" → body.data を直接取り込んで同期+予想(テスト/手動投入用)
// date: "YYYY-MM-DD"(省略時は今日)
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

    // --- ingest mode: body.dataを直接取り込み ---
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
      const url = `${baseUrl}&manifest=1`;
      const manifest = await fetchWithRetry(url, key);
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

    // 全場取得: manifestで場一覧を取得→場ごとに順次取得(同時並列なし)
    const manifestUrl = `${baseUrl}&manifest=1`;
    let manifest: any;
    try {
      manifest = await fetchWithRetry(manifestUrl, key);
    } catch (e: any) {
      // manifest取得失敗時は全場一括取得にフォールバック(従来動作)
      const payload = await fetchWithRetry(baseUrl, key);
      if (!payload || !Array.isArray(payload.races)) {
        return Response.json({ error: "データ形式不正 (fallback mode)" }, { status: 400 });
      }
      const summary = await syncAndPredict(base44, payload, { mode });
      return Response.json({ ok: true, date, mode, fallback: true, summary });
    }

    const venueCodes: string[] = manifest.venue_codes || [];
    if (!venueCodes.length) {
      const payload = await fetchWithRetry(baseUrl, key);
      if (!payload || !Array.isArray(payload.races)) {
        return Response.json({ error: "データ形式不正 (no venues)" }, { status: 400 });
      }
      const summary = await syncAndPredict(base44, payload, { mode });
      return Response.json({ ok: true, date, mode, fallback: true, summary });
    }

    // 場ごとに順次取得+同期。Rate limit時は指数バックオフで再試行。
    const venueResults: any[] = [];
    const venueErrors: any[] = [];
    for (const vc of venueCodes) {
      const paddedVc = String(vc).padStart(2, "0");
      try {
        const url = `${baseUrl}&venue_code=${encodeURIComponent(paddedVc)}`;
        const payload = await fetchWithRetry(url, key);
        if (!payload || !Array.isArray(payload.races) || payload.races.length === 0) {
          venueResults.push({ venue_code: paddedVc, races: 0, skipped: true });
          continue;
        }
        const summary = await syncAndPredict(base44, payload, { mode, venue_code: paddedVc });
        venueResults.push({
          venue_code: paddedVc,
          races: summary.races_upserted,
          entries: summary.entries_upserted,
          pre: summary.pre_generated,
          final: summary.final_generated,
          results: summary.results_saved,
          errors: summary.errors?.length || 0,
        });
      } catch (e: any) {
        // 場ごとのエラーは記録して次の場へ継続(全体は止めない)
        venueErrors.push({ venue_code: paddedVc, message: e?.message || String(e) });
      }
      await sleep(500); // 場間の間隔
    }

    const totalRaces = venueResults.reduce((a, r) => a + (r.races || 0), 0);
    const totalEntries = venueResults.reduce((a, r) => a + (r.entries || 0), 0);
    const totalPre = venueResults.reduce((a, r) => a + (r.pre || 0), 0);
    const totalFinal = venueResults.reduce((a, r) => a + (r.final || 0), 0);
    const totalResults = venueResults.reduce((a, r) => a + (r.results || 0), 0);

    return Response.json({
      ok: true,
      date,
      mode,
      sequential: true,
      venue_count: venueCodes.length,
      venues_processed: venueResults.length,
      venue_errors: venueErrors,
      summary: {
        races_total: totalRaces,
        races_upserted: totalRaces,
        entries_upserted: totalEntries,
        pre_generated: totalPre,
        final_generated: totalFinal,
        results_saved: totalResults,
        venue_results: venueResults,
      },
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}