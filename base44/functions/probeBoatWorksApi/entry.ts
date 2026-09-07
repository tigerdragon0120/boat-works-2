// 【調査専用】古いRaceResult(2月/4月/7月)の全フィールドを確認し、finishers有無を判定
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';

async function fetchEntity(url: string, key: string, timeoutMs = 30000): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
    if (!res.ok) return [];
    return await res.json().catch(() => []);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let user: any = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const base = secrets.get('BOAT_WORKS_API_BASE');
    const key = secrets.get('BOAT_WORKS_API_KEY');
    if (!base || !key) return Response.json({ error: 'Secret未設定' }, { status: 500 });

    const normalized = String(base).replace(/\/$/, '');
    const appRoot = normalized.replace(/\/functions\/?$/, '').replace(/\/exportBoatWorksData.*$/, '');
    const entityBase = `${appRoot}/entities`;
    const results: any = {};

    // === 各月のRaceResultサンプルを取得して全フィールド確認 ===
    // 2月(最古付近)
    const feb = await fetchEntity(`${entityBase}/RaceResult?limit=2&sort=race_date`, key, 15000);
    // skipで4月あたりにジャンプ
    const apr = await fetchEntity(`${entityBase}/RaceResult?limit=2&skip=8000&sort=race_date`, key, 15000);
    // 7月あたり
    const jul = await fetchEntity(`${entityBase}/RaceResult?limit=2&skip=24000&sort=race_date`, key, 15000);
    // 8月(最新付近)
    const aug = await fetchEntity(`${entityBase}/RaceResult?limit=2&skip=30000&sort=race_date`, key, 15000);
    // 最新
    const latest = await fetchEntity(`${entityBase}/RaceResult?limit=2&sort=-race_date`, key, 15000);

    const checkRecord = (r: any, label: string) => {
      if (!r) return null;
      return {
        label,
        race_date: r.race_date,
        race_id: r.race_id,
        all_fields: Object.keys(r),
        has_finishers: !!r.finishers,
        finishers_count: r.finishers?.length || 0,
        has_start_info: !!r.start_info,
        has_winning_method: r.winning_method != null,
        winning_method: r.winning_method,
        has_result_1: r.result_1 != null,
        result_1: r.result_1,
        result_2: r.result_2,
        result_3: r.result_3,
        trifecta: r.trifecta,
        has_payout: r.payout_trifecta != null,
        data_source: r.data_source,
        // finishersがある場合のみ
        finishers_sample: r.finishers?.[0] || null,
        start_info_sample: r.start_info?.[0] || null,
      };
    };

    results.feb = feb.map((r, i) => checkRecord(r, `feb_${i}`));
    results.apr = apr.map((r, i) => checkRecord(r, `apr_${i}`));
    results.jul = jul.map((r, i) => checkRecord(r, `jul_${i}`));
    results.aug = aug.map((r, i) => checkRecord(r, `aug_${i}`));
    results.latest = latest.map((r, i) => checkRecord(r, `latest_${i}`));

    // === finishers有無の集計 ===
    let withFinishers = 0, withoutFinishers = 0;
    let skip = 0;
    const limit = 500;
    while (skip < 34000) {
      const batch = await fetchEntity(`${entityBase}/RaceResult?limit=${limit}&skip=${skip}&sort=race_date`, key, 25000);
      if (!batch.length) break;
      for (const r of batch) {
        if (r.finishers && r.finishers.length > 0) withFinishers++;
        else withoutFinishers++;
      }
      skip += limit;
      if (skip > 34000) break; // 時間短縮
    }
    results.finishers_availability = {
      with_finishers: withFinishers,
      without_finishers: withoutFinishers,
      sampled: withFinishers + withoutFinishers,
    };

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
}