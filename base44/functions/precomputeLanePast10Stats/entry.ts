import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { computeLanePast10Stats } from '../../shared/lanePast10Engine.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');

async function withRetry<T>(fn: () => Promise<T>, max = 5): Promise<T> {
  let last: any;
  for (let i = 0; i <= max; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const msg = String(e?.message || e || '');
      if (!/rate\s*limit|429|too many requests/i.test(msg) || i === max) throw e;
      await sleep(Math.min(10000, 800 * 2 ** i));
    }
  }
  throw last;
}

// Asia/Tokyo基準で本日日付取得
function getTodayJST(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// =====================================================
// 事前計算対象のレースを優先度順に取得
// 優先順位: 現在時刻に近いレース > 次のレース > 翌日レース
// =====================================================
async function getTargetRaces(sr: any, mode: string, raceDate: string | null, raceIds: string[] | null) {
  const today = getTodayJST();
  const logs: string[] = [];

  let races: any[] = [];

  if (raceIds && raceIds.length > 0) {
    // 指定race_idのレースを取得
    for (const rid of raceIds.slice(0, 50)) {
      try {
        const r = await withRetry(() => sr.Race.get(rid));
        if (r) races.push(r);
      } catch {}
      await sleep(50);
    }
  } else if (raceDate) {
    races = await withRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []));
  } else if (mode === 'today') {
    races = await withRetry(() => sr.Race.filter({ race_date: today }, 'race_number', 300).catch(() => []));
  } else if (mode === 'tomorrow') {
    const [y, m, d] = today.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const tomorrow = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    races = await withRetry(() => sr.Race.filter({ race_date: tomorrow }, 'race_number', 300).catch(() => []));
  } else if (mode === 'all' || !mode) {
    // 当日+翌日のレースを取得
    const todayRaces = await withRetry(() => sr.Race.filter({ race_date: today }, 'race_number', 300).catch(() => []));
    const [y, m, d] = today.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const tomorrow = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    const tomorrowRaces = await withRetry(() => sr.Race.filter({ race_date: tomorrow }, 'race_number', 300).catch(() => []));
    races = [...todayRaces, ...tomorrowRaces];
  }

  // 終了済みレースは除外
  races = races.filter((r: any) => r.status !== 'finished' && r.status !== 'cancelled');

  // 優先度ソート: 締切時刻が現在に近い順
  const now = Date.now();
  races.sort((a: any, b: any) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    // 締切済み(過去)は後回し、未締切で近いものを優先
    const diffA = da < now ? (now - da + 999999999) : (da - now);
    const diffB = db < now ? (now - db + 999999999) : (db - now);
    return diffA - diffB;
  });

  logs.push(`事前計算対象: ${races.length}レース (mode=${mode || 'all'})`);
  return { races, logs };
}

// =====================================================
// レースのキャッシュ存在確認
// =====================================================
async function hasCache(sr: any, raceId: string): Promise<boolean> {
  try {
    const cached = await withRetry(() =>
      sr.RacerLaneRecentStats.filter({ race_id: raceId }, '-updated_at', 6).catch(() => []), 2
    );
    return cached && cached.length >= 6;
  } catch {
    return false;
  }
}

// =====================================================
// メイン処理
// =====================================================
export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    // ワークフロー・バックエンド関数からの呼出も許可
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ ok: false, error: 'Forbidden: admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const mode = body.mode || 'all';
    const raceDate = body.race_date || null;
    const raceIds = Array.isArray(body.race_ids) ? body.race_ids : null;
    const forceRecompute = !!body.force;
    const timeBudgetMs = 75000;

    const sr = base44.asServiceRole.entities;
    const startTime = Date.now();
    const logs: string[] = [];
    const errors: string[] = [];

    // 対象レース取得
    const { races, logs: targetLogs } = await getTargetRaces(sr, mode, raceDate, raceIds);
    logs.push(...targetLogs);

    let processed = 0, skipped = 0, failed = 0, remaining = 0;

    for (const race of races) {
      if (Date.now() - startTime > timeBudgetMs) {
        remaining = races.length - processed - skipped - failed;
        logs.push(`時間予算到達 — 残り${remaining}レースは次回へ継続`);
        break;
      }

      // キャッシュ確認(強制再計算でない場合)
      if (!forceRecompute) {
        const cached = await hasCache(sr, race.id);
        if (cached) {
          skipped++;
          continue;
        }
      }

      // 6艇の出走表取得
      let entries: any[];
      try {
        entries = await withRetry(() =>
          sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6), 3
        );
      } catch (e: any) {
        errors.push(`${race.venue_code || '?'} R${race.race_number}: RaceEntry取得失敗 ${e.message}`);
        failed++;
        continue;
      }

      if (!entries || entries.length < 6) {
        logs.push(`${race.venue_code || '?'} R${race.race_number}: 6艇未満(${entries?.length || 0})のためスキップ`);
        skipped++;
        continue;
      }

      // 計算用エントリ配列構築
      const reqEntries = entries
        .map((e: any) => ({
          registration_number: String(e.register_number || e.registration_number || ''),
          lane: Number(e.boat_number),
        }))
        .filter((x: any) => /^\d{4}$/.test(x.registration_number) && x.lane >= 1 && x.lane <= 6);

      if (reqEntries.length < 6) {
        logs.push(`${race.venue_code || '?'} R${race.race_number}: 登録番号不足のためスキップ`);
        skipped++;
        continue;
      }

      const raceContext = {
        race_id: race.id,
        venue_code: race.venue_code || null,
        race_number: race.race_number || null,
      };

      try {
        const { logs: calcLogs } = await computeLanePast10Stats(sr, reqEntries, race.race_date, raceContext);
        for (const l of calcLogs) console.log(l);
        processed++;
        logs.push(`${race.venue_code || '?'} R${race.race_number}: 事前計算完了`);
      } catch (e: any) {
        errors.push(`${race.venue_code || '?'} R${race.race_number}: 計算失敗 ${e.message}`);
        failed++;
      }

      // 1レース処理後に待機(429回避)
      await sleep(500);
    }

    return Response.json({
      ok: errors.length === 0,
      mode,
      processed,
      skipped,
      failed,
      remaining,
      total: races.length,
      logs,
      errors,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}