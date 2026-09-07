import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from "base44:runtime";

// === BOAT WORKS API からエンティティをページネーション取得 ===
async function fetchBoatWorksEntity(entityName: string, sort = 'created_date', max = 100000): Promise<any[]> {
  const base = secrets.get("BOAT_WORKS_API_BASE");
  const key = secrets.get("BOAT_WORKS_API_KEY");
  if (!base || !key) return [];
  const normalized = String(base).replace(/\/$/, "");
  const appRoot = normalized.replace(/\/functions\/?$/, "").replace(/\/exportBoatWorksData.*$/, "");
  const entityBase = `${appRoot}/entities`;
  const out: any[] = [];
  let skip = 0;
  const limit = 500;
  while (out.length < max) {
    const url = `${entityBase}/${entityName}?limit=${limit}&skip=${skip}&sort=${sort}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let rows: any;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      if (!res.ok) break;
      rows = await res.json();
    } catch { break; }
    finally { clearTimeout(timer); }
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < limit) break;
    skip += limit;
  }
  return out;
}

// === 現在のアプリのエンティティをページネーション取得 ===
async function all(entity: any, sort = '-updated_date', max = 50000): Promise<any[]> {
  const out: any[] = [];
  let skip = 0;
  const limit = 500;
  while (out.length < max) {
    const rows = await entity.filter({}, sort, limit, skip).catch(() => []);
    if (!rows?.length) break;
    out.push(...rows);
    if (rows.length < limit) break;
    skip += limit;
  }
  return out.slice(0, max);
}

// === 数値ユーティリティ ===
const round1 = (n: any) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n: any) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
const pct = (a: number, b: number) => b ? round1(a / b * 100) : null;
const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// === RacerTermStatV2の期別データから期間別統計を集計 ===
// terms: 降順(新しい順)のRacerTermStatV2レコード配列
// count: 期数 (6m=1, 1y=2, 3y=6, all=null)
function aggregateTermStats(terms: any[], count: number | null) {
  const selected = count ? terms.slice(0, count) : terms;
  if (!selected.length) return { sample_size: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null };
  let totalRaces = 0, totalWins = 0, totalTop2 = 0, totalTop3 = 0;
  let totalSt = 0, stCount = 0;
  for (const t of selected) {
    const rc = num(t.race_count) || 0;
    if (rc <= 0) continue;
    totalRaces += rc;
    totalWins += num(t.first_place_count) || 0;
    totalTop2 += (num(t.first_place_count) || 0) + (num(t.second_place_count) || 0);
    totalTop3 += (num(t.first_place_count) || 0) + (num(t.second_place_count) || 0) + (num(t.third_place_count) || 0);
    const st = num(t.average_start_timing);
    if (st != null && st > 0) { totalSt += st * rc; stCount += rc; }
  }
  if (totalRaces === 0) return { sample_size: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null };
  const winRate = pct(totalWins, totalRaces);
  const top2Rate = pct(totalTop2, totalRaces);
  const top3Rate = pct(totalTop3, totalRaces);
  // avg_finishを勝率/2連率/3連率から推定
  let avgFinish = null;
  if (winRate != null && top2Rate != null && top3Rate != null) {
    const p1 = winRate / 100;
    const p2 = (top2Rate - winRate) / 100;
    const p3 = (top3Rate - top2Rate) / 100;
    const pRest = (100 - top3Rate) / 100;
    avgFinish = round2(p1 * 1 + p2 * 2 + p3 * 3 + pRest * 5.0);
  }
  const avgSt = stCount > 0 ? round2(totalSt / stCount) : null;
  return { sample_size: totalRaces, win_rate: winRate, top2_rate: top2Rate, top3_rate: top3Rate, avg_finish: avgFinish, avg_st: avgSt };
}

// === OfficialRaceEntryResultV2から最近の調子を計算 ===
function computeRecentFormFromOfficial(raceResults: any[]) {
  const valid = raceResults.filter(r => num(r.finish_order) != null && !r.is_absent);
  if (!valid.length) return { recent_5_avg_finish: null, recent_10_avg_finish: null, recent_20_avg_finish: null, recent_st: null, recent_win_rate: null, recent_top3_rate: null, momentum_score: null };
  const avgFinish = (arr: any[]) => arr.length ? round2(arr.reduce((s, r) => s + num(r.finish_order)!, 0) / arr.length) : null;
  const r5 = valid.slice(0, 5);
  const r10 = valid.slice(0, 10);
  const r20 = valid.slice(0, 20);
  const stVals = r20.map(r => num(r.start_timing)).filter(s => s != null && s! > 0);
  const recentSt = stVals.length ? round2(stVals.reduce((a, b) => a + b!, 0) / stVals.length) : null;
  const recentWin = r20.length ? pct(r20.filter(r => num(r.finish_order) === 1).length, r20.length) : null;
  const recentTop3 = r20.length ? pct(r20.filter(r => num(r.finish_order)! <= 3).length, r20.length) : null;
  let momentum = null;
  if (r10.length >= 3 && valid.length > 10) {
    const older = valid.slice(10, 30);
    if (older.length) {
      const recentAvg = r10.reduce((s, r) => s + num(r.finish_order)!, 0) / r10.length;
      const olderAvg = older.reduce((s, r) => s + num(r.finish_order)!, 0) / older.length;
      momentum = round2(olderAvg - recentAvg);
    }
  }
  return { recent_5_avg_finish: avgFinish(r5), recent_10_avg_finish: avgFinish(r10), recent_20_avg_finish: avgFinish(r20), recent_st: recentSt, recent_win_rate: recentWin, recent_top3_rate: recentTop3, momentum_score: momentum };
}

// === OfficialRaceEntryResultV2からコース別成績を計算 ===
function computeCourseStatsFromOfficial(raceResults: any[]) {
  const courseStats: any = {};
  for (let c = 1; c <= 6; c++) {
    const cr = raceResults.filter(r => num(r.start_course) === c && num(r.finish_order) != null);
    if (cr.length) {
      const stVals = cr.map(r => num(r.start_timing)).filter(s => s != null && s! > 0);
      courseStats[String(c)] = {
        sample_size: cr.length,
        win_rate: pct(cr.filter(r => num(r.finish_order) === 1).length, cr.length),
        top2_rate: pct(cr.filter(r => num(r.finish_order)! <= 2).length, cr.length),
        top3_rate: pct(cr.filter(r => num(r.finish_order)! <= 3).length, cr.length),
        avg_finish: round2(cr.reduce((s, r) => s + num(r.finish_order)!, 0) / cr.length),
        avg_st: stVals.length ? round2(stVals.reduce((a, b) => a + b!, 0) / stVals.length) : null,
      };
    } else {
      courseStats[String(c)] = { sample_size: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null };
    }
  }
  return courseStats;
}

// === OfficialRaceEntryResultV2 + OfficialRaceResultV2から決まり手別勝率を計算 ===
function computeWinningMethodsFromOfficial(raceResults: any[], officialResultByRaceKey: Map<string, any>) {
  const wins = raceResults.filter(r => num(r.finish_order) === 1);
  const total = wins.length;
  if (!total) return { escape_rate: null, sashi_rate: null, makuri_rate: null, makuri_sashi_rate: null, nuki_rate: null, other_rate: null, total_wins: 0 };
  const counts = { escape: 0, sashi: 0, makuri: 0, makuri_sashi: 0, nuki: 0, other: 0 };
  for (const w of wins) {
    const offResult = officialResultByRaceKey.get(w.race_key);
    if (!offResult) { counts.other++; continue; }
    const method = String(offResult.winning_method || '').trim();
    if (/逃げ/.test(method)) counts.escape++;
    else if (/まくり差し|まくり差/.test(method)) counts.makuri_sashi++;
    else if (/差し/.test(method)) counts.sashi++;
    else if (/まくり/.test(method)) counts.makuri++;
    else if (/抜き/.test(method)) counts.nuki++;
    else counts.other++;
  }
  return {
    escape_rate: pct(counts.escape, total), sashi_rate: pct(counts.sashi, total),
    makuri_rate: pct(counts.makuri, total), makuri_sashi_rate: pct(counts.makuri_sashi, total),
    nuki_rate: pct(counts.nuki, total), other_rate: pct(counts.other, total), total_wins: total,
  };
}

// === 敗戦パターン ===
function computeLosingPatternFromOfficial(raceResults: any[]) {
  const valid = raceResults.filter(r => num(r.finish_order) != null && num(r.start_course) != null);
  if (!valid.length) return { outside_top3_rate: null, first_course_loss_rate: null, start_late_rate: null, collapse_rate: null };
  const outside = valid.filter(r => num(r.start_course)! >= 4);
  const outsideTop3 = outside.length ? pct(outside.filter(r => num(r.finish_order)! <= 3).length, outside.length) : null;
  const firstCourse = valid.filter(r => num(r.start_course) === 1);
  const firstLoss = firstCourse.length ? pct(firstCourse.filter(r => num(r.finish_order)! > 1).length, firstCourse.length) : null;
  const stRecords = valid.filter(r => num(r.start_timing) != null && num(r.start_timing)! > 0);
  const startLate = stRecords.length ? pct(stRecords.filter(r => num(r.start_timing)! > 0.2).length, stRecords.length) : null;
  const collapse = valid.length ? pct(valid.filter(r => num(r.finish_order)! > num(r.start_course)!).length, valid.length) : null;
  return { outside_top3_rate: outsideTop3, first_course_loss_rate: firstLoss, start_late_rate: startLate, collapse_rate: collapse };
}

// === 勝ち方プロファイル ===
function computeWinningStyleFromOfficial(raceResults: any[]) {
  const valid = raceResults.filter(r => num(r.finish_order) != null && num(r.start_course) != null);
  if (!valid.length) return { front_runner_score: null, chaser_score: null, st_stability: null, attack_score: null, defense_score: null };
  const inner = valid.filter(r => num(r.start_course)! <= 2);
  const outer = valid.filter(r => num(r.start_course)! >= 4);
  const frontRunner = inner.length ? pct(inner.filter(r => num(r.finish_order)! <= 2).length, inner.length) : null;
  const chaser = outer.length ? pct(outer.filter(r => num(r.finish_order)! <= 3).length, outer.length) : null;
  const stVals = valid.map(r => num(r.start_timing)).filter(s => s != null && s! > 0);
  let stStability = null;
  if (stVals.length >= 3) {
    const mean = stVals.reduce((a, b) => a + b!, 0) / stVals.length;
    const variance = stVals.reduce((s, v) => s + (v! - mean) ** 2, 0) / stVals.length;
    const stdDev = Math.sqrt(variance);
    stStability = round1(Math.max(0, Math.min(100, 100 - (stdDev - 0.05) / 0.15 * 100)));
  }
  const gains = valid.filter(r => num(r.finish_order)! < num(r.start_course)!);
  const holds = valid.filter(r => num(r.finish_order)! <= num(r.start_course)!);
  const attackScore = valid.length ? pct(gains.length, valid.length) : null;
  const defenseScore = valid.length ? pct(holds.length, valid.length) : null;
  return { front_runner_score: frontRunner, chaser_score: chaser, st_stability: stStability, attack_score: attackScore, defense_score: defenseScore };
}

// === data_confidence計算 ===
function computeDataConfidence(totalSamples: number, samples6m: number, samples1y: number, samples3y: number) {
  let base;
  if (totalSamples <= 5) base = Math.min(10, totalSamples * 2);
  else if (totalSamples <= 20) base = 20 + Math.round((totalSamples - 5) / 15 * 20);
  else if (totalSamples <= 50) base = 40 + Math.round((totalSamples - 20) / 30 * 20);
  else if (totalSamples <= 100) base = 60 + Math.round((totalSamples - 50) / 50 * 20);
  else base = Math.min(100, 80 + Math.round((totalSamples - 100) / 100 * 20));
  let bonus = 0;
  if (samples6m >= 10) bonus += 4;
  if (samples1y >= 30) bonus += 3;
  if (samples3y >= 50) bonus += 3;
  return Math.min(100, Math.max(0, base + bonus));
}

export default async function(req: Request) {
  const base44 = createClientFromRequest(req);
  let user: any = null;
  try { user = await base44.auth.me(); } catch {}
  if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const sr = base44.asServiceRole.entities;
  const now = new Date().toISOString();

  try {
    // === 1. BOAT WORKS V2エンティティを並列取得 ===
    // RacerTermStatV2: 最新20,000件(約13期=6.5年分)に限定して取得時間を短縮
    // stats_allはRaceEntryキャリア統計で補完するため、全件不要
    const [termStats, officialEntries, officialResults, entries] = await Promise.all([
      fetchBoatWorksEntity('RacerTermStatV2', '-term_start_date', 20000),
      fetchBoatWorksEntity('OfficialRaceEntryResultV2', '-created_date', 100000),
      fetchBoatWorksEntity('OfficialRaceResultV2', '-created_date', 100000),
      all(sr.RaceEntry, '-race_date', 50000),
    ]);

    // RacerTermStatV2をregistration_number別にグループ化(降順=新しい順)
    const termStatsByReg = new Map<string, any[]>();
    for (const t of termStats) {
      const reg = String(t.registration_number || '').trim();
      if (!reg) continue;
      if (!termStatsByReg.has(reg)) termStatsByReg.set(reg, []);
      termStatsByReg.get(reg)!.push(t);
    }
    for (const [, terms] of termStatsByReg) {
      terms.sort((a, b) => String(b.term_start_date || '').localeCompare(String(a.term_start_date || '')));
    }

    // OfficialRaceEntryResultV2をregistration_number別にグループ化
    const officialEntriesByReg = new Map<string, any[]>();
    for (const e of officialEntries) {
      const reg = String(e.registration_number || '').trim();
      if (!reg) continue;
      if (!officialEntriesByReg.has(reg)) officialEntriesByReg.set(reg, []);
      officialEntriesByReg.get(reg)!.push(e);
    }

    // OfficialRaceResultV2をrace_key別にマップ化
    const officialResultByRaceKey = new Map<string, any>();
    for (const r of officialResults) {
      if (r.race_key) officialResultByRaceKey.set(r.race_key, r);
    }
    // アクティブな選手リスト + キャリア統計(最新エントリから)
    const activeRacers = new Map<string, any>();
    for (const e of entries) {
      const reg = String(e.registration_number || e.register_number || '').trim();
      if (!reg) continue;
      const raceDate = String(e.race_date || '');
      if (!activeRacers.has(reg) || raceDate >= (activeRacers.get(reg).latestRaceDate || '')) {
        activeRacers.set(reg, {
          name: e.player_name || e.racer_name || '',
          grade: e.player_class || e.grade_class || '',
          latestRaceDate: raceDate,
          latestEntry: e,
          careerStats: {
            national_win_rate: num(e.national_win_rate),
            national_2rate: num(e.national_2rate) ?? num(e.national_f2_rate),
            national_3rate: num(e.national_3rate) ?? num(e.national_f3_rate),
            avg_st: num(e.avg_st),
            c1_win_rate: num(e.c1_win_rate),
            c1_2rate: num(e.c1_2rate),
            c1_3rate: num(e.c1_3rate),
          },
        });
      }
    }

    // === 3. 既存プロファイル取得 ===
    const existingProfiles = await all(sr.RacerPerformanceProfile, 'registration_number', 50000);
    const profileByReg = new Map(existingProfiles.map(p => [p.registration_number, p]));

    // === 4. プロファイル生成 ===
    let upserted = 0, created = 0, skipped = 0;
    let noTermStats = 0;
    const toCreate: any[] = [];
    const toUpdate: any[] = [];

    for (const [reg, active] of activeRacers) {
      const terms = termStatsByReg.get(reg) || [];
      const raceResults = (officialEntriesByReg.get(reg) || []).sort((a, b) =>
        String(b.race_key || '').localeCompare(String(a.race_key || ''))
      );

      if (!terms.length) noTermStats++;

      // 差分判定
      const latestImport = terms.length ? String(terms[0].imported_at || '') : '';
      const latestEntryUpdate = active.latestEntry ? String(active.latestEntry.updated_date || active.latestEntry.updated_at || '') : '';
      const latestUpdate = latestImport > latestEntryUpdate ? latestImport : latestEntryUpdate;
      const existing = profileByReg.get(reg);
      const isOldVersion = existing && (!existing.source_meta?.source_version || !String(existing.source_meta.source_version).startsWith('v3'));
      if (existing && !isOldVersion && existing.source_meta?.source_updated_at && latestUpdate <= existing.source_meta.source_updated_at) {
        skipped++;
        continue;
      }

      // === 期間別統計(メインデータソース: RacerTermStatV2) ===
      const stats6m = aggregateTermStats(terms, 1);   // 最新1期=6ヶ月
      const stats1y = aggregateTermStats(terms, 2);    // 最新2期=1年
      const stats3y = aggregateTermStats(terms, 6);    // 最新6期=3年
      let statsAll = aggregateTermStats(terms, null);  // 全期間

      // stats_allのフォールバック: RaceEntryのキャリア統計
      if (statsAll.sample_size === 0 && active.careerStats) {
        const c = active.careerStats;
        statsAll = {
          sample_size: 0,
          win_rate: c.national_win_rate != null ? round1(c.national_win_rate) : null,
          top2_rate: c.national_2rate != null ? round1(c.national_2rate) : null,
          top3_rate: c.national_3rate != null ? round1(c.national_3rate) : null,
          avg_finish: null,
          avg_st: c.avg_st != null ? round2(c.avg_st) : null,
        };
      }

      // === 1走ごとのデータ(OfficialRaceEntryResultV2) ===
      const recentForm = computeRecentFormFromOfficial(raceResults);
      const courseStats = computeCourseStatsFromOfficial(raceResults);
      const winningMethods = computeWinningMethodsFromOfficial(raceResults, officialResultByRaceKey);
      const losingPattern = computeLosingPatternFromOfficial(raceResults);
      const winningStyle = computeWinningStyleFromOfficial(raceResults);

      // === 競艇場別成績 ===
      const venueStats: any = {};
      for (const r of raceResults) {
        const offResult = officialResultByRaceKey.get(r.race_key);
        if (!offResult?.venue_code) continue;
        const vc = String(offResult.venue_code);
        if (!venueStats[vc]) venueStats[vc] = [];
        venueStats[vc].push(r);
      }
      const venueStatsOut: any = {};
      for (const [vc, vr] of Object.entries(venueStats)) {
        const valid = (vr as any[]).filter(r => num(r.finish_order) != null);
        if (valid.length) {
          venueStatsOut[vc] = {
            samples: valid.length,
            win_rate: pct(valid.filter(r => num(r.finish_order) === 1).length, valid.length),
            top2_rate: pct(valid.filter(r => num(r.finish_order)! <= 2).length, valid.length),
            top3_rate: pct(valid.filter(r => num(r.finish_order)! <= 3).length, valid.length),
          };
        }
      }

      // === data_confidence ===
      const totalSamples = statsAll.sample_size || 0;
      const dataConfidence = computeDataConfidence(totalSamples, stats6m.sample_size, stats1y.sample_size, stats3y.sample_size);
      const sourceVersion = `v3_${terms.length}terms_${latestImport || 'init'}`;

      const doc: any = {
        registration_number: reg,
        racer_name: active.name,
        grade_class: active.grade,
        stats_6m: stats6m,
        stats_1y: stats1y,
        stats_3y: stats3y,
        stats_all: statsAll,
        course_stats: courseStats,
        winning_methods: winningMethods,
        winning_methods_6m: winningMethods,
        winning_methods_1y: winningMethods,
        winning_methods_3y: winningMethods,
        recent_form: recentForm,
        losing_pattern: losingPattern,
        venue_stats: venueStatsOut,
        winning_style: winningStyle,
        recent_finishes: raceResults.filter(r => num(r.finish_order) != null).slice(0, 10).map(r => num(r.finish_order)),
        momentum: recentForm.momentum_score,
        total_samples: totalSamples,
        data_confidence: dataConfidence,
        source_meta: {
          source_updated_at: latestUpdate || now,
          profile_calculated_at: now,
          source_version: sourceVersion,
          source_race_count: totalSamples,
        },
        updated_at: now,
      };

      if (existing) {
        toUpdate.push({ id: existing.id, ...doc });
        upserted++;
      } else {
        toCreate.push(doc);
        created++;
        upserted++;
      }
    }

    // === 5. バルク書き込み ===
    // bulkCreate/bulkUpdateは500件まで対応
    for (let i = 0; i < toCreate.length; i += 500) {
      await sr.RacerPerformanceProfile.bulkCreate(toCreate.slice(i, i + 500));
    }
    for (let i = 0; i < toUpdate.length; i += 500) {
      await sr.RacerPerformanceProfile.bulkUpdate(toUpdate.slice(i, i + 500));
    }

    return Response.json({
      status: 'success',
      total_active_racers: activeRacers.size,
      profiles_upserted: upserted,
      profiles_created: created,
      profiles_skipped: skipped,
      term_stats_total: termStats.length,
      term_stats_racers: termStatsByReg.size,
      official_entries_total: officialEntries.length,
      official_results_total: officialResults.length,
      racers_without_term_stats: noTermStats,
      message: `選手プロファイル${upserted}件更新(新規${created}・差分skip${skipped}・期別データなし${noTermStats}件)`,
    });
  } catch(error: any) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}