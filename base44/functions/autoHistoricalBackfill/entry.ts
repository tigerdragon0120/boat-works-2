import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';
import { syncAndPredict } from '../../shared/predictionService.js';
import { acquireLock, releaseLock, cleanupExpiredLocks } from '../../shared/concurrencyLock.js';

function prevDate(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchWithRetry(url: string, key: string, maxRetries = 3): Promise<any> {
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
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Rate limit exceeded (HTTP ${res.status})`);
        if (attempt < maxRetries) {
          const delay = Math.min(10000 * Math.pow(2, attempt), 120000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        const detail = await res.text().catch(() => '');
        throw new Error(`BOAT WORKS API ${res.status}: ${detail.slice(0, 300)}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`BOAT WORKS API ${res.status}: ${detail.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e: any) {
      lastError = e;
      if (e.name === 'AbortError' || /fetch|network|timeout|rate limit/i.test(e.message || '')) {
        if (attempt < maxRetries) {
          const delay = Math.min(10000 * Math.pow(2, attempt), 120000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw e;
    }
  }
  throw lastError || new Error('fetch failed');
}

// 過去日のBOAT WORKSデータを一括取得して取り込む(履歴バックフィル)。
// 全場一括取得(1回のAPI呼び出し)でRate limitを回避。
// 予想生成はスキップし、データ蓄積のみ行う。
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let user: any = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ status: 'error', message: '管理者権限が必要です' }, { status: 403 });
    const body = await req.json().catch(() => ({}));

    const oldest = (await base44.asServiceRole.entities.Race.filter({}, 'race_date', 1).catch(() => []))[0];
    if (!oldest?.race_date) return Response.json({ status: 'waiting', message: '基準となるRaceがありません' });
    const targetDate = body.date || prevDate(oldest.race_date);

    const base = secrets.get('BOAT_WORKS_API_BASE');
    const key = secrets.get('BOAT_WORKS_API_KEY');
    if (!base || !key) return Response.json({ status: 'error', message: 'BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY 未設定' }, { status: 500 });
    const normalized = String(base).replace(/\/$/, '');
    const endpoint = normalized.includes('exportBoatWorksData') ? normalized : `${normalized}/exportBoatWorksData`;

    // manifest確認(データ存在確認)
    const manifest = await fetchWithRetry(`${endpoint}?date=${encodeURIComponent(targetDate)}&manifest=1`, key);
    const venues = (manifest.venue_codes || []).map((x: any) => String(x).padStart(2, '0'));
    if (!venues.length || !manifest.race_count) {
      return Response.json({ status: 'waiting_source', target_date: targetDate, race_count: manifest.race_count || 0, message: 'BOAT WORKS側のフルデータ待ち' });
    }

    // 排他ロック: 同一過去日の同時バックフィルを防止
    await cleanupExpiredLocks(base44);
    const lockKey = `backfill_${targetDate}`;
    const lockId = await acquireLock(base44, lockKey, 'autoHistoricalBackfill');
    if (!lockId) {
      return Response.json({ status: 'busy', target_date: targetDate, message: '別ワーカーが同日を処理中のためスキップ' });
    }

    // 全場一括取得(1回のAPI呼び出し)
    const payload = await fetchWithRetry(`${endpoint}?date=${encodeURIComponent(targetDate)}`, key);
    if (!payload || !Array.isArray(payload.races)) {
      await releaseLock(base44, lockId);
      return Response.json({ status: 'error', message: 'データ形式不正' }, { status: 400 });
    }

    // syncAndPredictで一括取り込み(予想スキップ・検証スキップ)
    const summary = await syncAndPredict(base44, payload, {
      mode: 'historical_auto',
      skip_predictions: true,
      skip_verification: true,
    });

    // DB更新
    let dbRefresh = null;
    try {
      const rr = await base44.asServiceRole.functions.invoke('refreshDatabase', {});
      dbRefresh = rr?.data || rr;
    } catch (e: any) {
      summary.errors.push({ step: 'refreshDatabase', message: e?.message || String(e) });
    }

    await releaseLock(base44, lockId);
    return Response.json({
      status: summary.errors.length ? 'partial' : 'success',
      target_date: targetDate,
      venues: venues.length,
      races_saved: summary.races_upserted,
      entries_saved: summary.entries_upserted,
      results_saved: summary.results_saved,
      errors: summary.errors,
      db_refresh: dbRefresh,
    });
  } catch (error: any) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}