// 【調査専用】4028のRacerTermStatV2をフィルタ取得 + OfficialRaceResultV2構造確認
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';

async function fetchUrl(url: string, key: string, timeoutMs = 30000): Promise<any> {
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

    // === 4028のRacerTermStatV2をフィルタ取得 ===
    // Base44 APIのfilter構文を試す
    const filter4028 = await fetchUrl(
      `${entityBase}/RacerTermStatV2?limit=500&filter=${encodeURIComponent(JSON.stringify({registration_number:"4028"}))}&sort=-term_start_date`,
      key, 20000
    );
    results.termStat_4028_count = Array.isArray(filter4028) ? filter4028.length : 0;
    results.termStat_4028 = (Array.isArray(filter4028) ? filter4028 : []).slice(0, 30).map((r: any) => ({
      term_code: r.term_code,
      term_label: r.term_label,
      term_start: r.term_start_date,
      term_end: r.term_end_date,
      race_count: r.race_count,
      win_rate: r.win_rate,
      top2_rate: r.top2_rate,
      top3_rate: r.top3_rate,
      first_place: r.first_place_count,
      second_place: r.second_place_count,
      third_place: r.third_place_count,
      avg_st: r.average_start_timing,
      racer_class: r.racer_class,
      ability_index: r.ability_index,
    }));

    // === OfficialRaceResultV2構造確認 ===
    const officialSample = await fetchUrl(`${entityBase}/OfficialRaceResultV2?limit=2&sort=-created_date`, key, 15000);
    if (Array.isArray(officialSample) && officialSample.length) {
      results.OfficialRaceResultV2 = {
        exists: true,
        sample_fields: Object.keys(officialSample[0]),
        sample_record: officialSample[0],
      };
      // 件数
      let total = 0, skip = 0;
      while (total < 50000) {
        const batch = await fetchUrl(`${entityBase}/OfficialRaceResultV2?limit=500&skip=${skip}&sort=created_date`, key, 25000);
        if (!Array.isArray(batch) || !batch.length) break;
        total += batch.length;
        if (batch.length < 500) break;
        skip += 500;
      }
      results.OfficialRaceResultV2.total_count = total;
    } else {
      results.OfficialRaceResultV2 = { exists: false };
    }

    // === OfficialRaceEntryResultV2の4028データ(最新サンプル) ===
    const entryResult4028 = await fetchUrl(
      `${entityBase}/OfficialRaceEntryResultV2?limit=500&filter=${encodeURIComponent(JSON.stringify({registration_number:"4028"}))}&sort=-created_date`,
      key, 20000
    );
    results.entryResult_4028_count = Array.isArray(entryResult4028) ? entryResult4028.length : 0;
    results.entryResult_4028_sample = (Array.isArray(entryResult4028) ? entryResult4028 : []).slice(0, 5).map((r: any) => ({
      race_key: r.race_key,
      race_date: r.race_key?.split('_')[0],
      boat_number: r.boat_number,
      start_course: r.start_course,
      finish_order: r.finish_order,
      finish_status: r.finish_status,
      start_timing: r.start_timing,
      race_time: r.race_time,
    }));

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
}