import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

async function retry<T>(fn: () => Promise<T>, max = 5): Promise<T> {
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

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body.entries) ? body.entries.slice(0, 6) : [];
    const sr = base44.asServiceRole.entities;
    const by_key: any = {};

    for (const item of requested) {
      const reg = String(item.registration_number || '').trim();
      const lane = Number(item.lane);
      if (!/^\d{4}$/.test(reg) || lane < 1 || lane > 6) continue;

      try {
        // 全履歴取得(1回のDB呼び出し)
        const allHist: any[] = await retry(() =>
          sr.RacerRaceHistory.filter({ registration_number: reg }, '-race_date', 500)
        );

        // 枠番の正規化: Number(h.boat_number) === lane
        // boat_numberは数値または文字列で保存されている可能性があるためNumber()で統一
        const sameLane = (allHist || [])
          .filter((h: any) => {
            const bn = Number(h.boat_number);
            return bn === lane && !h.is_absent && !h.is_disqualified;
          })
          .slice(0, 10);

        console.log(`[LanePast10] reg=${reg} lane=${lane} total=${allHist.length} same_lane=${sameLane.length}`);

        const recent10 = sameLane.map((h: any) => ({
          id: h.id,
          race_date: h.race_date,
          venue_code: h.venue_code,
          race_number: h.race_number,
          boat_number: Number(h.boat_number),
          course: num(h.course),
          finish_order: num(h.finish_order),
          st: num(h.st),
          start_order: num(h.start_order),
        }));

        const finished = recent10.filter((h: any) => h.finish_order != null && h.finish_order >= 1 && h.finish_order <= 6);
        const stVals = recent10.map((h: any) => h.st).filter((v: any) => v != null);
        const soVals = recent10.map((h: any) => h.start_order).filter((v: any) => v != null);

        // sample_count = 統計計算に使った実効サンプル数(finished.length)
        //   1着率等の分母であり、UIの「走数」表示と予想ロジックの重み付けに使用
        // total_lane_count = 同枠全走数(recent10.length, DQ等含む)
        //   UIの「同枠0走」判定に使用
        const stats: any = {
          registration_number: reg,
          lane,
          sample_count: finished.length,
          total_lane_count: recent10.length,
          win_rate: finished.length ? round1(finished.filter((h: any) => h.finish_order === 1).length / finished.length * 100) : null,
          top2_rate: finished.length ? round1(finished.filter((h: any) => h.finish_order <= 2).length / finished.length * 100) : null,
          top3_rate: finished.length ? round1(finished.filter((h: any) => h.finish_order <= 3).length / finished.length * 100) : null,
          avg_st: stVals.length ? round3(stVals.reduce((a: number, b: number) => a + b, 0) / stVals.length) : null,
          avg_start_order: soVals.length ? round1(soVals.reduce((a: number, b: number) => a + b, 0) / soVals.length) : null,
          recent10,
          status: 'ok',
          updated_at: new Date().toISOString(),
        };

        // RacerLaneRecentStatsへ保存(1回のDB呼び出し)
        try {
          const old = await retry(() => sr.RacerLaneRecentStats.filter({ registration_number: reg, lane }, '-updated_at', 1), 2);
          if (old?.[0]) await sr.RacerLaneRecentStats.update(old[0].id, stats).catch(() => {});
          else await sr.RacerLaneRecentStats.create(stats).catch(() => {});
        } catch {}

        by_key[`${reg}_${lane}`] = stats;
      } catch (e: any) {
        // 個別エラー: エラー状態を返す(「—」ではなく「取得エラー」と表示するため)
        console.error(`[LanePast10] ERROR reg=${reg} lane=${lane}: ${e.message}`);
        by_key[`${reg}_${lane}`] = {
          registration_number: reg,
          lane,
          sample_count: 0,
          win_rate: null,
          top2_rate: null,
          top3_rate: null,
          avg_st: null,
          avg_start_order: null,
          recent10: [],
          status: 'error',
          error: e.message,
        };
      }
      await sleep(80);
    }

    return Response.json({ ok: true, by_key });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}