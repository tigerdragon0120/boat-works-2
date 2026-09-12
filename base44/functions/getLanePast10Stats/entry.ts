import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

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

// =====================================================
// 着順点計算(BOAT RACE公式ルール)
// =====================================================
// 一般競走: 1着=10, 2着=8, 3着=6, 4着=4, 5着=2, 6着=1
// G1・G2: +1点
// SG: +2点
// 優勝戦: +1点(準優勝戦は含まない)
// 特殊結果(F/L/転/落/沈/失格/欠場): 0点
// =====================================================
const BASE_POINTS: Record<number, number> = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2, 6: 1 };

function calculateFinishPoint(h: any): number {
  // 特殊結果: 0点
  if (h.finish_status && String(h.finish_status).trim() !== '') return 0;
  if (h.is_disqualified) return 0;

  const finish = Number(h.finish_order);
  if (!Number.isFinite(finish) || finish < 1 || finish > 6) return 0;

  let point = BASE_POINTS[finish] || 0;

  const grade = String(h.race_grade || '').toUpperCase();
  const raceName = String(h.race_name || '');

  // グレードボーナス
  if (grade.includes('SG') || raceName.includes('SG')) {
    point += 2;
  } else if (grade.includes('G1') || grade.includes('G2') || raceName.includes('G1') || raceName.includes('G2')) {
    point += 1;
  }

  // 優勝戦ボーナス(+1) — 準優勝戦は含まない
  const raceType = String(h.race_type || '');
  const isChampionship =
    (raceType.includes('優勝') || raceName.includes('優勝')) && !raceName.includes('準優');
  if (isChampionship) {
    point += 1;
  }

  return point;
}

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body.entries) ? body.entries.slice(0, 6) : [];
    const raceDate = body.race_date || null;
    const sr = base44.asServiceRole.entities;

    // RacerProfile一括取得(支部・年齢用)
    let profileByReg = new Map<string, any>();
    try {
      const allProfiles = await retry(() => sr.RacerProfile.filter({}, '-updated_at', 5000), 3);
      profileByReg = new Map(allProfiles.map((p: any) => [p.registration_number, p]));
    } catch {}

    // RacerTermStats一括取得(出身地用、最新termのみ保持)
    let termByReg = new Map<string, any>();
    try {
      const allTerms = await retry(() => sr.RacerTermStats.filter({}, '-term_key', 5000), 3);
      for (const t of allTerms) {
        if (!termByReg.has(t.registration_number) || t.term_key > termByReg.get(t.registration_number).term_key) {
          termByReg.set(t.registration_number, t);
        }
      }
    } catch {}

    // =====================================================
    // Phase 1: 全選手のRacerRaceHistory取得 + 全レース日収集
    // =====================================================
    const histByReg = new Map<string, any[]>();
    const recent10ByReg = new Map<string, any[]>();
    const allDates = new Set<string>();

    for (const item of requested) {
      const reg = String(item.registration_number || '').trim();
      const lane = Number(item.lane);
      if (!/^\d{4}$/.test(reg) || lane < 1 || lane > 6) continue;

      try {
        const allHist: any[] = await retry(() =>
          sr.RacerRaceHistory.filter({ registration_number: reg }, '-race_date', 500)
        );
        histByReg.set(reg, allHist || []);
        // recent10候補のみから日付を収集(全履歴から収集すると日付が多すぎてRace取得で429が多発する)
        const sameLaneCandidates = (allHist || [])
          .filter((h: any) => {
            const bn = Number(h.boat_number);
            if (bn !== lane) return false;
            if (h.is_absent) return false;
            if (raceDate && h.race_date >= raceDate) return false;
            return true;
          })
          .slice(0, 10);
        recent10ByReg.set(reg, sameLaneCandidates);
        for (const h of sameLaneCandidates) {
          if (h.race_date) allDates.add(h.race_date);
        }
      } catch (e: any) {
        console.error(`[LanePast10] hist fetch error reg=${reg}: ${e.message}`);
        histByReg.set(reg, []);
        recent10ByReg.set(reg, []);
      }
      await sleep(80);
    }

    // =====================================================
    // Phase 2: Race一括取得(着順点計算用のrace_type/grade/race_name)
    // =====================================================
    const raceMap = new Map<string, any>();
    for (const date of allDates) {
      try {
        const races = await retry(() => sr.Race.filter({ race_date: date }, 'race_number', 200), 3);
        for (const r of races) {
          raceMap.set(`${r.race_date}_${r.venue_code}_${r.race_number}`, r);
        }
      } catch (e: any) {
        console.error(`[LanePast10] race fetch error date=${date}: ${e.message}`);
      }
      await sleep(60);
    }

    // =====================================================
    // Phase 2.5: ST順位計算(各レースの6艇STから順位算出)
    // =====================================================
    // Step 1: 既存のRacerRaceHistory(Phase 1で取得済み)からST順位を計算
    // Step 2: 6艇揃わないレースのみ、date+venueごとにバッチ取得(5件同時)
    // start_orderがDBに存在すればそれを優先、なければST値から算出
    // 順位を出せないレースは平均ST順位の分母から除外
    const stOrderByRace = new Map<string, Map<number, number>>(); // race_key -> (boat_number -> start_order)
    {
      // recent10のユニークレースキーを収集
      const uniqueRaceKeys = new Set<string>();
      for (const [, candidates] of recent10ByReg) {
        for (const h of candidates) {
          uniqueRaceKeys.add(`${h.race_date}_${h.venue_code}_${h.race_number}`);
        }
      }

      // Step 1: 既存データからST順位を計算(追加クエリなし)
      // histByRegの6選手全履歴からrace_key -> (boat_number -> record)を構築
      const raceBoatsMap = new Map<string, Map<number, any>>();
      for (const [, allHist] of histByReg) {
        for (const h of allHist || []) {
          const raceKey = `${h.race_date}_${h.venue_code}_${h.race_number}`;
          if (!uniqueRaceKeys.has(raceKey)) continue;
          if (!raceBoatsMap.has(raceKey)) raceBoatsMap.set(raceKey, new Map());
          raceBoatsMap.get(raceKey)!.set(Number(h.boat_number), h);
        }
      }
      const needFetch = new Set<string>();
      for (const raceKey of uniqueRaceKeys) {
        const boats = raceBoatsMap.get(raceKey);
        if (boats && boats.size >= 1) {
          const byBoat = new Map<number, any>();
          for (const [, b] of boats) {
            if (b.st != null && Number.isFinite(Number(b.st))) {
              byBoat.set(Number(b.boat_number), b);
            }
          }
          if (byBoat.size >= 1) {
            const sorted = [...byBoat.values()].sort((a: any, b: any) => Number(a.st) - Number(b.st));
            const orderMap = new Map<number, number>();
            sorted.forEach((b: any, i: number) => {
              orderMap.set(Number(b.boat_number), i + 1);
            });
            stOrderByRace.set(raceKey, orderMap);
          }
        } else {
          needFetch.add(raceKey);
        }
      }
      console.log(`[LanePast10] ST順位 Step1: 既存データで計算=${stOrderByRace.size} | 追加取得必要=${needFetch.size}`);

      // Step 2: 追加取得が必要なレースのみ、date+venueごとにバッチ取得(5件同時)
      if (needFetch.size > 0) {
        // date+venueごとにグループ化
        const needDateVenues = new Set<string>();
        for (const raceKey of needFetch) {
          const [date, venue] = raceKey.split('_');
          needDateVenues.add(`${date}_${venue}`);
        }
        const dvList = [...needDateVenues];
        const BATCH_SIZE = 5;
        for (let i = 0; i < dvList.length; i += BATCH_SIZE) {
          const batch = dvList.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (dv) => {
              const [date, venue] = dv.split('_');
              const allBoats: any[] = await retry(() =>
                sr.RacerRaceHistory.filter({ race_date: date, venue_code: venue }, null, 500), 3
              );
              return { dv, allBoats };
            })
          );
          for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            const { allBoats } = result.value;
            const byRace = new Map<string, any[]>();
            for (const b of allBoats || []) {
              const raceKey = `${b.race_date}_${b.venue_code}_${b.race_number}`;
              if (!needFetch.has(raceKey)) continue;
              if (!byRace.has(raceKey)) byRace.set(raceKey, []);
              byRace.get(raceKey)!.push(b);
            }
            for (const [raceKey, boats] of byRace) {
              const byBoat = new Map<number, any>();
              for (const b of boats) {
                if (b.st != null && Number.isFinite(Number(b.st))) {
                  byBoat.set(Number(b.boat_number), b);
                }
              }
              if (byBoat.size >= 1) {
                const sorted = [...byBoat.values()].sort((a: any, b: any) => Number(a.st) - Number(b.st));
                const orderMap = new Map<number, number>();
                sorted.forEach((b: any, i: number) => {
                  orderMap.set(Number(b.boat_number), i + 1);
                });
                stOrderByRace.set(raceKey, orderMap);
              }
            }
          }
          await sleep(50);
        }
      }
      console.log(`[LanePast10] ST順位計算: unique races=${uniqueRaceKeys.size} | 計算済みレース数=${stOrderByRace.size}`);
    }

    // =====================================================
    // Phase 3: 各選手のrecent10処理 + 勝率計算
    // =====================================================
    const by_key: any = {};

    for (const item of requested) {
      const reg = String(item.registration_number || '').trim();
      const lane = Number(item.lane);
      if (!/^\d{4}$/.test(reg) || lane < 1 || lane > 6) continue;

      try {
        const allHist = histByReg.get(reg) || [];
        const sameLane = recent10ByReg.get(reg) || [];

        // 古い順(10走前→前走)に並び替え + Race情報マージ + 着順点計算
        const recent10 = sameLane.slice().reverse().map((h: any) => {
          const raceKey = `${h.race_date}_${h.venue_code}_${h.race_number}`;
          const race = raceMap.get(raceKey) || {};
          const stOrderMap = stOrderByRace.get(raceKey);
          const calculatedStartOrder = stOrderMap?.get(Number(h.boat_number)) ?? null;
          const enriched = {
            id: h.id,
            race_date: h.race_date,
            venue_code: h.venue_code,
            race_number: h.race_number,
            boat_number: Number(h.boat_number),
            course: num(h.course),
            finish_order: num(h.finish_order),
            finish_status: h.finish_status || null,
            st: num(h.st),
            start_order: num(h.start_order) ?? calculatedStartOrder,
            race_grade: race.grade || null,
            race_type: race.race_type || null,
            race_name: race.race_name || null,
          };
          enriched.finish_point = calculateFinishPoint(enriched);
          return enriched;
        });

        // 統計計算: 有効着順(1-6)のみ対象(1着率等用)
        const finished = recent10.filter((h: any) => h.finish_order != null && h.finish_order >= 1 && h.finish_order <= 6);
        const stVals = recent10.map((h: any) => h.st).filter((v: any) => v != null);
        const soVals = recent10.map((h: any) => h.start_order).filter((v: any) => v != null);

        // === 勝率計算(BOAT RACE公式ルール) ===
        // 勝率 = 着順点合計 ÷ 有効出走数
        // 有効出走数 = recent10全件(欠場除外済み)。F/L/失格等は0点だが出走数に含む。
        const totalPoints = recent10.reduce((sum: number, h: any) => sum + (h.finish_point || 0), 0);
        const validRaceCount = recent10.length; // 欠場除外済み
        const winningRate = validRaceCount > 0 ? round2(totalPoints / validRaceCount) : null;

        // === 追加指標(予想エンジンv5用) ===
        const recent3Finished = finished.slice(-3);
        const recent3Avg = recent3Finished.length
          ? recent3Finished.reduce((a: number, h: any) => a + h.finish_order, 0) / recent3Finished.length
          : null;
        const overallAvg = finished.length
          ? finished.reduce((a: number, h: any) => a + h.finish_order, 0) / finished.length
          : null;
        const recent3Momentum = (recent3Avg != null && overallAvg != null) ? round1(overallAvg - recent3Avg) : null;

        const finishStddev = finished.length >= 2
          ? Math.sqrt(finished.reduce((s: number, h: any) => s + Math.pow(h.finish_order - overallAvg, 2), 0) / finished.length)
          : null;
        const finishStability = finishStddev != null ? round1(clamp(100 - finishStddev * 25, 0, 100)) : null;

        const stAvg = stVals.length ? stVals.reduce((a: number, b: number) => a + b, 0) / stVals.length : null;
        const stStddev = stVals.length >= 2
          ? Math.sqrt(stVals.reduce((s: number, v: number) => s + Math.pow(v - stAvg, 2), 0) / stVals.length)
          : null;
        const stStability = stStddev != null ? round1(clamp(100 - stStddev * 500, 0, 100)) : null;

        const courseDiffs = recent10
          .filter((h: any) => h.course != null)
          .map((h: any) => Math.abs(h.boat_number - h.course));
        const courseLaneDiff = courseDiffs.length
          ? round1(courseDiffs.reduce((a: number, b: number) => a + b, 0) / courseDiffs.length)
          : null;

        const specialCount = recent10.filter((h: any) => h.finish_status && h.finish_status !== '').length;

        const stats: any = {
          registration_number: reg,
          lane,
          sample_count: finished.length,
          total_lane_count: recent10.length,
          win_rate: finished.length ? round1(finished.filter((h: any) => h.finish_order === 1).length / finished.length * 100) : null,
          winning_rate: winningRate,
          top2_rate: finished.length ? round1(finished.filter((h: any) => h.finish_order <= 2).length / finished.length * 100) : null,
          top3_rate: finished.length ? round1(finished.filter((h: any) => h.finish_order <= 3).length / finished.length * 100) : null,
          avg_st: stVals.length ? round3(stVals.reduce((a: number, b: number) => a + b, 0) / stVals.length) : null,
          avg_start_order: soVals.length ? round1(soVals.reduce((a: number, b: number) => a + b, 0) / soVals.length) : null,
          recent3_momentum: recent3Momentum,
          finish_stability: finishStability,
          st_stability: stStability,
          course_lane_diff: courseLaneDiff,
          special_count: specialCount,
          recent10,
          status: 'ok',
          updated_at: new Date().toISOString(),
        };

        // プロフィール情報付与
        const profile = profileByReg.get(reg);
        const term = termByReg.get(reg);
        stats.profile = {
          branch_name: profile?.branch_name || term?.branch_name || null,
          birthplace: term?.birthplace || null,
          age: profile?.age || term?.age || null,
          birth_date: profile?.birth_date || null,
        };

        // RacerLaneRecentStatsへ保存
        try {
          const old = await retry(() => sr.RacerLaneRecentStats.filter({ registration_number: reg, lane }, '-updated_at', 1), 2);
          if (old?.[0]) await sr.RacerLaneRecentStats.update(old[0].id, stats).catch(() => {});
          else await sr.RacerLaneRecentStats.create(stats).catch(() => {});
        } catch {}

        by_key[`${reg}_${lane}`] = stats;

        // =====================================================
        // 検証ログ(6選手全員)
        // =====================================================
        {
          console.log(`\n========== 勝率検証 reg=${reg} lane=${lane} ==========`);
          let pointSum = 0;
          for (const h of recent10) {
            console.log(
              `  ${h.race_date} | 会場${h.venue_code} | ${h.race_number}R | ` +
              `grade=${h.race_grade || '(null)'} | type=${h.race_type || '(null)'} | name=${h.race_name || '(null)'} | ` +
              `着順=${h.finish_order != null ? h.finish_order : (h.finish_status || '(特殊)')} | 着順点=${h.finish_point} | ` +
              `ST=${h.st != null ? Number(h.st).toFixed(2) : '—'} | ST順=${h.start_order ?? '—'}`
            );
            pointSum += h.finish_point || 0;
          }
          console.log(
            `  --- 着順点合計=${pointSum} | 有効出走数=${validRaceCount} | 勝率=${winningRate != null ? winningRate.toFixed(2) : '—'} | ` +
            `平均ST=${stats.avg_st != null ? Number(stats.avg_st).toFixed(3) : '—'} | 平均ST順位=${stats.avg_start_order != null ? Number(stats.avg_start_order).toFixed(1) : '—'} ---`
          );
          console.log(`==================================================\n`);
        }

        console.log(
          `[LanePast10] reg=${reg} lane=${lane} | RacerRaceHistory=${allHist.length} | 同枠=${sameLane.length} | recent10=${recent10.length} | ` +
          `着順点合計=${totalPoints} | 勝率=${winningRate != null ? winningRate.toFixed(2) : '—'} | ` +
          `avg_st=${stats.avg_st ?? '—'} | avg_start_order=${stats.avg_start_order ?? '—'}`
        );
      } catch (e: any) {
        console.error(`[LanePast10] ERROR reg=${reg} lane=${lane}: ${e.message}`);
        by_key[`${reg}_${lane}`] = {
          registration_number: reg,
          lane,
          sample_count: 0,
          total_lane_count: 0,
          win_rate: null,
          winning_rate: null,
          top2_rate: null,
          top3_rate: null,
          avg_st: null,
          avg_start_order: null,
          recent3_momentum: null,
          finish_stability: null,
          st_stability: null,
          course_lane_diff: null,
          special_count: 0,
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