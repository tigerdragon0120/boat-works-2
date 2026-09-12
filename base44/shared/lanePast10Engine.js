// BOAT WORKS 2 - 枠番過去10走 計算エンジン
// getLanePast10Stats と precomputeLanePast10Stats の両方から呼ばれる共通ロジック。
// 計算ロジック(勝率・平均ST・ST順位・進入コース・着順)は変更しない。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

async function retry(fn, max = 5) {
  let last;
  for (let i = 0; i <= max; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e?.message || e || '');
      if (!/rate\s*limit|429|too many requests/i.test(msg) || i === max) throw e;
      await sleep(Math.min(10000, 800 * 2 ** i));
    }
  }
  throw last;
}

// =====================================================
// 着順点計算(BOATCAST方式)
// BOATCASTの枠番別過去10走は基本着順点のみ使用。
// SG/G1/G2/優勝戦などのグレード加点は行わない。
// =====================================================
const BASE_POINTS = { 1: 10, 2: 8, 3: 6, 4: 4, 5: 2, 6: 1 };

function calculateFinishPoint(h) {
  if (h.finish_status && String(h.finish_status).trim() !== '') return 0;
  if (h.is_disqualified) return 0;
  const finish = Number(h.finish_order);
  if (!Number.isFinite(finish) || finish < 1 || finish > 6) return 0;
  return BASE_POINTS[finish] || 0;
}

// 特殊結果(F/L/K/S/欠等)かどうか。これらは勝率の分母からも除外する。
function isSpecialResult(h) {
  return (h.finish_status && String(h.finish_status).trim() !== '') || h.is_disqualified || h.is_absent;
}

// =====================================================
// 公式サイトからST情報を取得(DB欠損時の補完用)
// boatrace.jpのレース結果ページから6艇のSTを解析する。
// STがDBに欠損している場合のみ呼ばれ、BOATCASTと同じST値を取得する。
// =====================================================
const officialSTCache = new Map();

async function fetchOfficialST(date, venueCode, raceNumber) {
  const cacheKey = `${date}_${venueCode}_${raceNumber}`;
  if (officialSTCache.has(cacheKey)) return officialSTCache.get(cacheKey);

  const hd = date.replace(/-/g, '');
  const url = `https://boatrace.jp/owpc/pc/race/raceresult?rno=${raceNumber}&jcd=${venueCode}&hd=${hd}`;
  let stMap = null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      // "スタート情報"セクションを抽出
      const startIdx = html.indexOf('スタート情報');
      if (startIdx >= 0) {
        const searchEnd = html.indexOf('水面気象情報', startIdx);
        const sectionEnd = searchEnd > 0 ? searchEnd : html.indexOf('勝式', startIdx);
        const section = html.slice(startIdx, sectionEnd > 0 ? sectionEnd : startIdx + 3000);
        // img_boat2_X.png の後に続く ST値(.XX または F.XX)を抽出
        stMap = {};
        const regex = /img_boat2_(\d)\.png[^.]*?\.(\d+)/g;
        let match;
        while ((match = regex.exec(section)) !== null) {
          const bn = parseInt(match[1]);
          const st = parseFloat(`0.${match[2]}`);
          if (bn >= 1 && bn <= 6 && Number.isFinite(st)) stMap[bn] = st;
        }
        if (Object.keys(stMap).length === 0) stMap = null;
      }
    }
  } catch {}
  officialSTCache.set(cacheKey, stMap);
  return stMap;
}

// =====================================================
// メイン計算関数
// =====================================================
// sr: base44.asServiceRole.entities
// requested: [{ registration_number, lane }]
// raceDate: "YYYY-MM-DD" (対象レース日付)
// raceContext: { race_id, venue_code, race_number } or null
// returns: { by_key, logs }
// =====================================================
export async function computeLanePast10Stats(sr, requested, raceDate, raceContext) {
  const logs = [];

  // RacerProfile一括取得(支部・年齢用)
  let profileByReg = new Map();
  try {
    const allProfiles = await retry(() => sr.RacerProfile.filter({}, '-updated_at', 5000), 3);
    profileByReg = new Map(allProfiles.map((p) => [p.registration_number, p]));
  } catch {}

  // RacerTermStats一括取得(出身地用、最新termのみ保持)
  let termByReg = new Map();
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
  const histByReg = new Map();
  const recent10ByReg = new Map();
  const allDates = new Set();

  for (const item of requested) {
    const reg = String(item.registration_number || '').trim();
    const lane = Number(item.lane);
    if (!/^\d{4}$/.test(reg) || lane < 1 || lane > 6) continue;

    try {
      const allHist = await retry(() =>
        sr.RacerRaceHistory.filter({ registration_number: reg }, '-race_date', 500)
      );
      histByReg.set(reg, allHist || []);
      const sameLaneCandidates = (allHist || [])
        .filter((h) => {
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
    } catch (e) {
      logs.push(`[LanePast10] hist fetch error reg=${reg}: ${e.message}`);
      histByReg.set(reg, []);
      recent10ByReg.set(reg, []);
    }
    await sleep(80);
  }

  // =====================================================
  // Phase 2: Race一括取得(着順点計算用のrace_type/grade/race_name)
  // =====================================================
  const raceMap = new Map();
  for (const date of allDates) {
    try {
      const races = await retry(() => sr.Race.filter({ race_date: date }, 'race_number', 200), 3);
      for (const r of races) {
        raceMap.set(`${r.race_date}_${r.venue_code}_${r.race_number}`, r);
      }
    } catch (e) {
      logs.push(`[LanePast10] race fetch error date=${date}: ${e.message}`);
    }
    await sleep(60);
  }

  // =====================================================
  // Phase 2.5: ST順位計算(6艇すべてのSTが揃っている場合のみ)
  // =====================================================
  const stOrderByRace = new Map();
  const allBoatsByRace = new Map();
  const stRankExcludedRaces = new Map();
  {
    const uniqueRaceKeys = new Set();
    for (const [, candidates] of recent10ByReg) {
      for (const h of candidates) {
        uniqueRaceKeys.add(`${h.race_date}_${h.venue_code}_${h.race_number}`);
      }
    }

    const dateVenueToRaceKeys = new Map();
    for (const raceKey of uniqueRaceKeys) {
      const [date, venue] = raceKey.split('_');
      const dv = `${date}_${venue}`;
      if (!dateVenueToRaceKeys.has(dv)) dateVenueToRaceKeys.set(dv, new Set());
      dateVenueToRaceKeys.get(dv).add(raceKey);
    }

    const dvList = [...dateVenueToRaceKeys.keys()];
    const BATCH_SIZE = 3;
    for (let i = 0; i < dvList.length; i += BATCH_SIZE) {
      const batch = dvList.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (dv) => {
          const [date, venue] = dv.split('_');
          const allBoats = await retry(() =>
            sr.RacerRaceHistory.filter({ race_date: date, venue_code: venue }, null, 500), 5
          );
          return { dv, allBoats };
        })
      );
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { allBoats } = result.value;
        for (const b of allBoats || []) {
          const raceKey = `${b.race_date}_${b.venue_code}_${b.race_number}`;
          if (!uniqueRaceKeys.has(raceKey)) continue;
          if (!allBoatsByRace.has(raceKey)) allBoatsByRace.set(raceKey, new Map());
          allBoatsByRace.get(raceKey).set(Number(b.boat_number), b);
        }
      }
      await sleep(200);
    }

    // DB欠損STを公式サイトから並列取得して補完しつつST順位を計算
    // 1. 補完が必要なレースを特定
    const racesNeedingOfficial = [];
    for (const raceKey of uniqueRaceKeys) {
      const boats = allBoatsByRace.get(raceKey);
      if (!boats) continue;
      const hasNullST = [1,2,3,4,5,6].some(bn => {
        const b = boats.get(bn);
        return !b || b.st == null || !Number.isFinite(Number(b.st));
      });
      if (hasNullST) {
        const [date, venue, race] = raceKey.split('_');
        racesNeedingOfficial.push({ raceKey, date, venue, race: parseInt(race) });
      }
    }

    // 2. 公式STを並列取得(5件ずつ)
    let officialFetched = 0;
    const FETCH_BATCH = 5;
    for (let i = 0; i < racesNeedingOfficial.length; i += FETCH_BATCH) {
      const batch = racesNeedingOfficial.slice(i, i + FETCH_BATCH);
      const results = await Promise.allSettled(
        batch.map(async (r) => ({
          raceKey: r.raceKey,
          stMap: await fetchOfficialST(r.date, r.venue, r.race),
        }))
      );
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { raceKey, stMap } = result.value;
        if (!stMap) continue;
        officialFetched++;
        const boats = allBoatsByRace.get(raceKey);
        if (!boats) continue;
        for (const bn of [1,2,3,4,5,6]) {
          if (stMap[bn] != null) {
            if (!boats.has(bn)) boats.set(bn, { boat_number: bn, st: stMap[bn] });
            else if (boats.get(bn).st == null || !Number.isFinite(Number(boats.get(bn).st))) {
              boats.get(bn).st = stMap[bn];
            }
          }
        }
      }
    }

    // 3. 補完済みデータでST順位計算
    for (const raceKey of uniqueRaceKeys) {
      const boats = allBoatsByRace.get(raceKey);
      if (!boats) {
        stRankExcludedRaces.set(raceKey, 'レースデータ取得失敗');
        continue;
      }
      const nullStBoats = [1,2,3,4,5,6].filter(bn => {
        const b = boats.get(bn);
        return !b || b.st == null || !Number.isFinite(Number(b.st));
      });
      if (nullStBoats.length > 0) {
        stRankExcludedRaces.set(raceKey, `ST欠損: ${nullStBoats.join(',')}号艇`);
        continue;
      }
      const sorted = [1,2,3,4,5,6].map(bn => boats.get(bn)).sort((a, b) => Number(a.st) - Number(b.st));
      const orderMap = new Map();
      sorted.forEach((b, i) => orderMap.set(Number(b.boat_number), i + 1));
      stOrderByRace.set(raceKey, orderMap);
    }

    logs.push(`[LanePast10] ST順位: 計算済み=${stOrderByRace.size} | 対象外=${stRankExcludedRaces.size} | 公式ST補完=${officialFetched} / 全${uniqueRaceKeys.size}レース`);
  }

  // =====================================================
  // Phase 3: 各選手のrecent10処理 + 勝率計算
  // =====================================================
  const by_key = {};

  for (const item of requested) {
    const reg = String(item.registration_number || '').trim();
    const lane = Number(item.lane);
    if (!/^\d{4}$/.test(reg) || lane < 1 || lane > 6) continue;

    try {
      const allHist = histByReg.get(reg) || [];
      const sameLane = recent10ByReg.get(reg) || [];

      const recent10 = sameLane.slice().reverse().map((h) => {
        const raceKey = `${h.race_date}_${h.venue_code}_${h.race_number}`;
        const race = raceMap.get(raceKey) || {};
        const stOrderMap = stOrderByRace.get(raceKey);
        const calculatedStartOrder = stOrderMap?.get(Number(h.boat_number)) ?? null;
        // DB欠損STを公式ST(Phase 2.5でallBoatsByRaceに補完済み)で補完
        const raceBoats = allBoatsByRace.get(raceKey);
        const officialBoat = raceBoats?.get(Number(h.boat_number));
        const dbSt = num(h.st);
        const effectiveSt = dbSt != null ? dbSt : (officialBoat?.st != null ? num(officialBoat.st) : null);
        const enriched = {
          id: h.id,
          race_date: h.race_date,
          venue_code: h.venue_code,
          race_number: h.race_number,
          boat_number: Number(h.boat_number),
          course: num(h.course),
          finish_order: num(h.finish_order),
          finish_status: h.finish_status || null,
          st: effectiveSt,
          start_order: num(h.start_order) ?? num(h.st_rank) ?? num(h.start_rank) ?? calculatedStartOrder,
          is_disqualified: h.is_disqualified || false,
          is_absent: h.is_absent || false,
          race_grade: race.grade || null,
          race_type: race.race_type || null,
          race_name: race.race_name || null,
        };
        enriched.finish_point = calculateFinishPoint(enriched);
        return enriched;
      });

      const finished = recent10.filter((h) => h.finish_order != null && h.finish_order >= 1 && h.finish_order <= 6);
      const stVals = recent10.map((h) => h.st).filter((v) => v != null);
      const soVals = recent10.map((h) => h.start_order).filter((v) => v != null);

      // BOATCAST方式: 勝率 = 着順点合計 / 有効出走数(特殊結果を除く)
      const totalPoints = recent10.reduce((sum, h) => sum + (h.finish_point || 0), 0);
      const validRaceCount = recent10.filter((h) => !isSpecialResult(h)).length;
      const winningRate = validRaceCount > 0 ? round2(totalPoints / validRaceCount) : null;

      const recent3Finished = finished.slice(-3);
      const recent3Avg = recent3Finished.length
        ? recent3Finished.reduce((a, h) => a + h.finish_order, 0) / recent3Finished.length
        : null;
      const overallAvg = finished.length
        ? finished.reduce((a, h) => a + h.finish_order, 0) / finished.length
        : null;
      const recent3Momentum = (recent3Avg != null && overallAvg != null) ? round1(overallAvg - recent3Avg) : null;

      const finishStddev = finished.length >= 2
        ? Math.sqrt(finished.reduce((s, h) => s + Math.pow(h.finish_order - overallAvg, 2), 0) / finished.length)
        : null;
      const finishStability = finishStddev != null ? round1(clamp(100 - finishStddev * 25, 0, 100)) : null;

      const stAvg = stVals.length ? stVals.reduce((a, b) => a + b, 0) / stVals.length : null;
      const stStddev = stVals.length >= 2
        ? Math.sqrt(stVals.reduce((s, v) => s + Math.pow(v - stAvg, 2), 0) / stVals.length)
        : null;
      const stStability = stStddev != null ? round1(clamp(100 - stStddev * 500, 0, 100)) : null;

      const courseDiffs = recent10
        .filter((h) => h.course != null)
        .map((h) => Math.abs(h.boat_number - h.course));
      const courseLaneDiff = courseDiffs.length
        ? round1(courseDiffs.reduce((a, b) => a + b, 0) / courseDiffs.length)
        : null;

      const specialCount = recent10.filter((h) => h.finish_status && h.finish_status !== '').length;

      const stats = {
        registration_number: reg,
        lane,
        race_date: raceDate || null,
        race_id: raceContext?.race_id || null,
        venue_code: raceContext?.venue_code || null,
        race_number: raceContext?.race_number || null,
        sample_count: finished.length,
        total_lane_count: recent10.length,
        win_rate: finished.length ? round1(finished.filter((h) => h.finish_order === 1).length / finished.length * 100) : null,
        winning_rate: winningRate,
        top2_rate: finished.length ? round1(finished.filter((h) => h.finish_order <= 2).length / finished.length * 100) : null,
        top3_rate: finished.length ? round1(finished.filter((h) => h.finish_order <= 3).length / finished.length * 100) : null,
        avg_st: stVals.length ? round2(stVals.reduce((a, b) => a + b, 0) / stVals.length) : null,
        avg_start_order: soVals.length ? round1(soVals.reduce((a, b) => a + b, 0) / soVals.length) : null,
        st_rank_sample_count: soVals.length,
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

      // RacerLaneRecentStatsへ保存(キャッシュキー: registration_number + lane + race_id)
      try {
        const filterKey = raceContext?.race_id
          ? { registration_number: reg, lane, race_id: raceContext.race_id }
          : { registration_number: reg, lane, race_date: raceDate };
        const old = await retry(() => sr.RacerLaneRecentStats.filter(filterKey, '-updated_at', 1), 2);
        if (old?.[0]) await sr.RacerLaneRecentStats.update(old[0].id, stats).catch(() => {});
        else await sr.RacerLaneRecentStats.create(stats).catch(() => {});
      } catch {}

      by_key[`${reg}_${lane}`] = stats;

      logs.push(
        `[LanePast10] reg=${reg} lane=${lane} | RacerRaceHistory=${allHist.length} | 同枠=${sameLane.length} | recent10=${recent10.length} | ` +
        `着順点合計=${totalPoints} | 勝率=${winningRate != null ? winningRate.toFixed(2) : '—'} | ` +
        `avg_st=${stats.avg_st ?? '—'} | avg_start_order=${stats.avg_start_order ?? '—'}`
      );
    } catch (e) {
      logs.push(`[LanePast10] ERROR reg=${reg} lane=${lane}: ${e.message}`);
      by_key[`${reg}_${lane}`] = {
        registration_number: reg,
        lane,
        race_date: raceDate || null,
        race_id: raceContext?.race_id || null,
        venue_code: raceContext?.venue_code || null,
        race_number: raceContext?.race_number || null,
        sample_count: 0,
        total_lane_count: 0,
        win_rate: null,
        winning_rate: null,
        top2_rate: null,
        top3_rate: null,
        avg_st: null,
        avg_start_order: null,
        st_rank_sample_count: 0,
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

  // 異常値チェック
  {
    const allStats = Object.values(by_key);
    const allOne = allStats.length > 0 && allStats.every((s) =>
      s.avg_start_order != null && Math.abs(s.avg_start_order - 1.0) < 0.01
    );
    if (allOne) {
      logs.push('ST_RANK_SUSPICIOUS_ALL_ONE: 全選手の平均ST順位が1.0です。ST順位計算に異常がある可能性があります。');
    }
  }

  return { by_key, logs };
}