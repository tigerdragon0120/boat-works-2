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
const round3 = (n: any) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const pct = (a: number, b: number) => b ? round1(a / b * 100) : null;
const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const median = (arr: number[]) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round3((s[mid - 1] + s[mid]) / 2);
};
const stddev = (arr: number[]) => {
  if (arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return round3(Math.sqrt(variance));
};

// ============================================================
// 【BASE】RacerTermStatV2 → 期間別統計 (保護対象)
// ============================================================
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
  let avgFinish = null;
  if (winRate != null && top2Rate != null && top3Rate != null) {
    const p1 = winRate / 100, p2 = (top2Rate - winRate) / 100, p3 = (top3Rate - top2Rate) / 100, pRest = (100 - top3Rate) / 100;
    avgFinish = round2(p1 * 1 + p2 * 2 + p3 * 3 + pRest * 5.0);
  }
  return { sample_size: totalRaces, win_rate: winRate, top2_rate: top2Rate, top3_rate: top3Rate, avg_finish: avgFinish, avg_st: stCount > 0 ? round2(totalSt / stCount) : null };
}

// ============================================================
// 【RACE HISTORY】OfficialRaceEntryResultV2 + OfficialRaceResultV2 JOIN
// ============================================================

// race_key JOIN済みの1走レコード
interface RaceRecord {
  race_key: string;
  race_date: string;
  venue_code: string;
  race_number: number;
  registration_number: string;
  racer_name: string;
  boat_number: number;
  start_course: number;
  finish_order: number;
  finish_status: string;
  start_timing: number;
  winning_method: string;
  is_absent: boolean;
  is_disqualified: boolean;
  is_returned: boolean;
}

// JOIN + registration_number別グループ化
function joinAndGroupByReg(entries: any[], resultByRaceKey: Map<string, any>): Map<string, RaceRecord[]> {
  const byReg = new Map<string, RaceRecord[]>();
  for (const e of entries) {
    const reg = String(e.registration_number || '').trim();
    if (!reg) continue;
    const offResult = resultByRaceKey.get(e.race_key);
    const rec: RaceRecord = {
      race_key: e.race_key,
      race_date: offResult?.source_date || (e.race_key ? String(e.race_key).split('_')[0] : ''),
      venue_code: offResult?.venue_code || (e.race_key ? String(e.race_key).split('_')[1] : ''),
      race_number: offResult?.race_number || (e.race_key ? num(String(e.race_key).split('_')[2]) : null),
      registration_number: reg,
      racer_name: e.racer_name || '',
      boat_number: num(e.boat_number),
      start_course: num(e.start_course),
      finish_order: num(e.finish_order),
      finish_status: String(e.finish_status || ''),
      start_timing: num(e.start_timing),
      winning_method: offResult?.winning_method || '',
      is_absent: !!e.is_absent,
      is_disqualified: !!e.is_disqualified,
      is_returned: !!e.is_returned,
    };
    if (!byReg.has(reg)) byReg.set(reg, []);
    byReg.get(reg)!.push(rec);
  }
  // 各選手のレースを新しい順にソート
  for (const [, recs] of byReg) {
    recs.sort((a, b) => {
      const d = String(b.race_date || '').localeCompare(String(a.race_date || ''));
      if (d !== 0) return d;
      return String(b.race_key || '').localeCompare(String(a.race_key || ''));
    });
  }
  return byReg;
}

// 有効レース(FINISHED)判定
function isFinished(rec: RaceRecord): boolean {
  if (rec.is_absent || rec.is_disqualified) return false;
  if (rec.finish_order == null || rec.finish_order < 1 || rec.finish_order > 6) return false;
  const fs = rec.finish_status.toUpperCase();
  if (['F', 'L', 'K', 'S', 'DQ', 'ABS', 'CAPSIZED', 'FELL', 'INCOMPLETE', 'RETURNED', 'DISQUALIFIED', 'ABSENT'].includes(fs)) return false;
  return true;
}

// F/L判定 (finish_statusの完全一致のみ)
function isF(rec: RaceRecord): boolean {
  const fs = String(rec.finish_status || '').trim().toUpperCase();
  return fs === 'F' || fs === 'フライング' || fs === 'FLYING';
}
function isL(rec: RaceRecord): boolean {
  const fs = String(rec.finish_status || '').trim().toUpperCase();
  return fs === 'L' || fs === 'レース不参加' || fs === '出遅れ' || fs === 'LATE';
}

// ============================================================
// recent_form 拡張
// ============================================================
function computeRecentFormExpanded(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  const actualSample = finished.length;
  const r5 = finished.slice(0, 5);
  const r10 = finished.slice(0, 10);
  const r20 = finished.slice(0, 20);

  const avgFinish = (arr: RaceRecord[]) => arr.length ? round2(arr.reduce((s, r) => s + r.finish_order, 0) / arr.length) : null;
  const winRate = (arr: RaceRecord[]) => arr.length ? pct(arr.filter(r => r.finish_order === 1).length, arr.length) : null;
  const top2Rate = (arr: RaceRecord[]) => arr.length ? pct(arr.filter(r => r.finish_order <= 2).length, arr.length) : null;
  const top3Rate = (arr: RaceRecord[]) => arr.length ? pct(arr.filter(r => r.finish_order <= 3).length, arr.length) : null;

  const stVals = r20.map(r => r.start_timing).filter(s => s != null && s > 0);
  const recentSt = stVals.length ? round3(stVals.reduce((a, b) => a + b, 0) / stVals.length) : null;
  const recentStStddev = stddev(stVals);

  // momentum: 直近10走 vs 11-30走
  let momentum = null;
  if (r10.length >= 3 && finished.length > 10) {
    const older = finished.slice(10, 30);
    if (older.length >= 3) {
      const recentAvg = r10.reduce((s, r) => s + r.finish_order, 0) / r10.length;
      const olderAvg = older.reduce((s, r) => s + r.finish_order, 0) / older.length;
      momentum = round2(olderAvg - recentAvg);
    }
  }

  return {
    recent_5_avg_finish: avgFinish(r5),
    recent_10_avg_finish: avgFinish(r10),
    recent_20_avg_finish: avgFinish(r20),
    recent_5_win_rate: winRate(r5),
    recent_10_win_rate: winRate(r10),
    recent_20_win_rate: winRate(r20),
    recent_5_top2_rate: top2Rate(r5),
    recent_10_top2_rate: top2Rate(r10),
    recent_20_top2_rate: top2Rate(r20),
    recent_5_top3_rate: top3Rate(r5),
    recent_10_top3_rate: top3Rate(r10),
    recent_20_top3_rate: top3Rate(r20),
    recent_st: recentSt,
    recent_st_stddev: recentStStddev,
    recent_win_rate: winRate(r20),
    recent_top3_rate: top3Rate(r20),
    momentum_score: momentum,
    actual_sample_size: actualSample,
  };
}

// ============================================================
// course_stats 拡張 (flat, start_course基準)
// ============================================================
function computeCourseStatsExpanded(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  const cs: any = {};
  for (let c = 1; c <= 6; c++) {
    const cr = finished.filter(r => r.start_course === c);
    if (cr.length) {
      const stVals = cr.map(r => r.start_timing).filter(s => s != null && s > 0);
      const firstCount = cr.filter(r => r.finish_order === 1).length;
      const secondCount = cr.filter(r => r.finish_order === 2).length;
      const thirdCount = cr.filter(r => r.finish_order === 3).length;
      cs[String(c)] = {
        sample_size: cr.length,
        first_count: firstCount,
        second_count: secondCount,
        third_count: thirdCount,
        win_rate: pct(firstCount, cr.length),
        second_rate: pct(secondCount, cr.length),
        third_rate: pct(thirdCount, cr.length),
        top2_rate: pct(firstCount + secondCount, cr.length),
        top3_rate: pct(firstCount + secondCount + thirdCount, cr.length),
        avg_finish: round2(cr.reduce((s, r) => s + r.finish_order, 0) / cr.length),
        avg_st: stVals.length ? round3(stVals.reduce((a, b) => a + b, 0) / stVals.length) : null,
        st_stddev: stddev(stVals),
      };
    } else {
      cs[String(c)] = { sample_size: 0, first_count: 0, second_count: 0, third_count: 0, win_rate: null, second_rate: null, third_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null, st_stddev: null };
    }
  }
  return cs;
}

// ============================================================
// course_stats_by_period (6m/1y/3y/all)
// ============================================================
function computeCourseStatsByPeriod(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  const now = new Date();
  const cutoff6m = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const cutoff1y = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const cutoff3y = new Date(now.getTime() - 1095 * 24 * 60 * 60 * 1000);

  const byPeriod = (recs: RaceRecord[]) => {
    const all = computeCourseStatsExpanded(recs);
    const r6m = computeCourseStatsExpanded(recs.filter(r => new Date(r.race_date) >= cutoff6m));
    const r1y = computeCourseStatsExpanded(recs.filter(r => new Date(r.race_date) >= cutoff1y));
    const r3y = computeCourseStatsExpanded(recs.filter(r => new Date(r.race_date) >= cutoff3y));
    const out: any = {};
    for (let c = 1; c <= 6; c++) {
      out[String(c)] = { all: all[String(c)], "6m": r6m[String(c)], "1y": r1y[String(c)], "3y": r3y[String(c)] };
    }
    return out;
  };
  return byPeriod(finished);
}

// ============================================================
// winning_methods 拡張 (決まり手別勝率)
// ============================================================
function classifyWinningMethod(method: string): string {
  const m = String(method || '');
  if (/逃げ/.test(m)) return 'escape';
  if (/まくり差し|まくり差/.test(m)) return 'makuri_sashi';
  if (/差し/.test(m)) return 'sashi';
  if (/まくり/.test(m)) return 'makuri';
  if (/抜き/.test(m)) return 'nuki';
  if (/恵まれ|恵ま/.test(m)) return 'megumare';
  return 'other';
}

function computeWinningMethodsExpanded(races: RaceRecord[]) {
  const wins = races.filter(r => isFinished(r) && r.finish_order === 1);
  const total = wins.length;
  const counts = { escape: 0, sashi: 0, makuri: 0, makuri_sashi: 0, nuki: 0, megumare: 0, other: 0 };
  for (const w of wins) {
    const type = classifyWinningMethod(w.winning_method);
    counts[type as keyof typeof counts]++;
  }
  return {
    escape_count: counts.escape, sashi_count: counts.sashi, makuri_count: counts.makuri,
    makuri_sashi_count: counts.makuri_sashi, nuki_count: counts.nuki,
    megumare_count: counts.megumare, other_count: counts.other,
    total_wins: total,
    escape_rate: pct(counts.escape, total), sashi_rate: pct(counts.sashi, total),
    makuri_rate: pct(counts.makuri, total), makuri_sashi_rate: pct(counts.makuri_sashi, total),
    nuki_rate: pct(counts.nuki, total), megumare_rate: pct(counts.megumare, total),
    other_rate: pct(counts.other, total),
  };
}

// ============================================================
// course_winning_methods (選手×コース×決まり手)
// ============================================================
function computeCourseWinningMethods(races: RaceRecord[]) {
  const wins = races.filter(r => isFinished(r) && r.finish_order === 1);
  const cwm: any = {};
  for (let c = 1; c <= 6; c++) {
    const courseWins = wins.filter(r => r.start_course === c);
    const total = courseWins.length;
    const counts = { escape: 0, sashi: 0, makuri: 0, makuri_sashi: 0, nuki: 0, megumare: 0, other: 0 };
    for (const w of courseWins) {
      const type = classifyWinningMethod(w.winning_method);
      counts[type as keyof typeof counts]++;
    }
    cwm[String(c)] = {
      total_wins: total,
      escape_count: counts.escape, sashi_count: counts.sashi, makuri_count: counts.makuri,
      makuri_sashi_count: counts.makuri_sashi, nuki_count: counts.nuki,
      megumare_count: counts.megumare, other_count: counts.other,
      escape_rate: pct(counts.escape, total), sashi_rate: pct(counts.sashi, total),
      makuri_rate: pct(counts.makuri, total), makuri_sashi_rate: pct(counts.makuri_sashi, total),
      nuki_rate: pct(counts.nuki, total), megumare_rate: pct(counts.megumare, total),
      other_rate: pct(counts.other, total),
    };
  }
  return cwm;
}

// ============================================================
// winning_style_type
// ============================================================
function computeWinningStyleType(wm: any, cwm: any) {
  const totalWins = wm.total_wins || 0;
  if (totalWins < 5) {
    return { type: "DATA_INSUFFICIENT", confidence: 0, description: `勝利数${totalWins}件でデータ不足` };
  }
  const confidence = Math.min(100, Math.round(totalWins / 10 * 100));
  const escapeRate = wm.escape_rate || 0;
  const sashiRate = wm.sashi_rate || 0;
  const makuriRate = wm.makuri_rate || 0;
  const makuriSashiRate = wm.makuri_sashi_rate || 0;
  const nukiRate = wm.nuki_rate || 0;

  // 1コース勝ちの逃げ率
  const c1EscapeRate = cwm?.["1"]?.escape_rate || 0;
  const c1Total = cwm?.["1"]?.total_wins || 0;
  // 外コース(3-6)のまくり・抜き率
  const outsideMakuri = (cwm?.["3"]?.makuri_rate || 0) + (cwm?.["4"]?.makuri_rate || 0) + (cwm?.["5"]?.makuri_rate || 0) + (cwm?.["6"]?.makuri_rate || 0);
  const outsideNuki = (cwm?.["3"]?.nuki_rate || 0) + (cwm?.["4"]?.nuki_rate || 0) + (cwm?.["5"]?.nuki_rate || 0) + (cwm?.["6"]?.nuki_rate || 0);

  if (c1Total >= 3 && c1EscapeRate >= 60) return { type: "ESCAPE_SPECIALIST", confidence, description: `1コース逃げ${c1EscapeRate}%` };
  if (sashiRate >= 40) return { type: "SASHI_SPECIALIST", confidence, description: `差し勝率${sashiRate}%` };
  if (makuriRate >= 35) return { type: "MAKURI_ATTACKER", confidence, description: `まくり勝率${makuriRate}%` };
  if (makuriSashiRate >= 30) return { type: "MAKURI_SASHI_SPECIALIST", confidence, description: `まくり差し${makuriSashiRate}%` };
  if (outsideMakuri + outsideNuki >= 40 && nukiRate >= 20) return { type: "OUTSIDE_ATTACKER", confidence, description: `外枠攻撃型` };
  if (escapeRate >= 30 && sashiRate >= 20 && makuriRate >= 15) return { type: "BALANCED", confidence, description: `バランス型` };
  return { type: "DATA_INSUFFICIENT", confidence: Math.max(0, confidence - 30), description: `勝ち方偏り不明確` };
}

// ============================================================
// losing_pattern 拡張
// ============================================================
function computeLosingPatternExpanded(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  if (!finished.length) return { outside_top3_rate: null, first_course_loss_rate: null, first_course_escape_fail_rate: null, second_course_sashi_fail_rate: null, third_course_attack_fail_rate: null, fourth_course_attack_fail_rate: null, outside56_top3_rate: null, start_late_rate: null, st_late_avg_finish: null, collapse_rate: null };

  // 1コース逃げ失敗率: 1コースで2着以下の率
  const c1 = finished.filter(r => r.start_course === 1);
  const c1EscapeFail = c1.length ? pct(c1.filter(r => r.finish_order > 1).length, c1.length) : null;

  // 2コース差し不発: 2コースで3着以下の率
  const c2 = finished.filter(r => r.start_course === 2);
  const c2SashiFail = c2.length ? pct(c2.filter(r => r.finish_order > 2).length, c2.length) : null;

  // 3コース攻め不発: 3コースで3着以下の率
  const c3 = finished.filter(r => r.start_course === 3);
  const c3AttackFail = c3.length ? pct(c3.filter(r => r.finish_order > 3).length, c3.length) : null;

  // 4コース攻め不発: 4コースで3着以下の率
  const c4 = finished.filter(r => r.start_course === 4);
  const c4AttackFail = c4.length ? pct(c4.filter(r => r.finish_order > 3).length, c4.length) : null;

  // 5・6コース3着外率
  const c56 = finished.filter(r => r.start_course >= 5);
  const c56Top3Out = c56.length ? pct(c56.filter(r => r.finish_order > 3).length, c56.length) : null;

  // 外コース(4-6)からの3連内率
  const outside = finished.filter(r => r.start_course >= 4);
  const outsideTop3 = outside.length ? pct(outside.filter(r => r.finish_order <= 3).length, outside.length) : null;

  // 1コース敗退率
  const firstLoss = c1.length ? pct(c1.filter(r => r.finish_order > 1).length, c1.length) : null;

  // ST遅れ率(ST >= 0.20)
  const stRecords = finished.filter(r => r.start_timing != null && r.start_timing > 0);
  const stLate = stRecords.length ? pct(stRecords.filter(r => r.start_timing >= 0.20).length, stRecords.length) : null;

  // ST遅れ時の平均着順
  const stLateRaces = stRecords.filter(r => r.start_timing >= 0.20);
  const stLateAvgFinish = stLateRaces.length ? round2(stLateRaces.reduce((s, r) => s + r.finish_order, 0) / stLateRaces.length) : null;

  // 崩れ率(着順>進入コース)
  const collapse = finished.length ? pct(finished.filter(r => r.finish_order > r.start_course).length, finished.length) : null;

  return {
    outside_top3_rate: outsideTop3,
    first_course_loss_rate: firstLoss,
    first_course_escape_fail_rate: c1EscapeFail,
    second_course_sashi_fail_rate: c2SashiFail,
    third_course_attack_fail_rate: c3AttackFail,
    fourth_course_attack_fail_rate: c4AttackFail,
    outside56_top3_rate: c56Top3Out,
    start_late_rate: stLate,
    st_late_avg_finish: stLateAvgFinish,
    collapse_rate: collapse,
  };
}

// ============================================================
// st_profile
// ============================================================
function computeStProfile(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  const allSt = finished.map(r => r.start_timing).filter(s => s != null && s > 0);
  if (!allSt.length) return { overall_avg_st: null, overall_median_st: null, overall_st_stddev: null, st_fast_rate: null, st_stable_rate: null, st_late_rate: null, course: {} };

  const overallAvg = round3(allSt.reduce((a, b) => a + b, 0) / allSt.length);
  const overallMedian = median(allSt);
  const overallStddev = stddev(allSt);
  const stFast = pct(allSt.filter(s => s <= 0.10).length, allSt.length);
  const stStable = pct(allSt.filter(s => s <= 0.15).length, allSt.length);
  const stLate = pct(allSt.filter(s => s >= 0.20).length, allSt.length);

  const course: any = {};
  for (let c = 1; c <= 6; c++) {
    const cs = finished.filter(r => r.start_course === c).map(r => r.start_timing).filter(s => s != null && s > 0);
    if (cs.length) {
      course[String(c)] = {
        avg_st: round3(cs.reduce((a, b) => a + b, 0) / cs.length),
        median_st: median(cs),
        st_stddev: stddev(cs),
        sample_size: cs.length,
      };
    }
  }

  return { overall_avg_st: overallAvg, overall_median_st: overallMedian, overall_st_stddev: overallStddev, st_fast_rate: stFast, st_stable_rate: stStable, st_late_rate: stLate, course };
}

// ============================================================
// venue_stats 拡張
// ============================================================
function computeVenueStatsExpanded(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  const byVenue: any = {};
  for (const r of finished) {
    const vc = String(r.venue_code || '');
    if (!vc) continue;
    if (!byVenue[vc]) byVenue[vc] = [];
    byVenue[vc].push(r);
  }
  const out: any = {};
  for (const [vc, vr] of Object.entries(byVenue)) {
    const arr = vr as RaceRecord[];
    const stVals = arr.map(r => r.start_timing).filter(s => s != null && s > 0);
    out[vc] = {
      samples: arr.length,
      win_rate: pct(arr.filter(r => r.finish_order === 1).length, arr.length),
      top2_rate: pct(arr.filter(r => r.finish_order <= 2).length, arr.length),
      top3_rate: pct(arr.filter(r => r.finish_order <= 3).length, arr.length),
      avg_finish: round2(arr.reduce((s, r) => s + r.finish_order, 0) / arr.length),
      avg_st: stVals.length ? round3(stVals.reduce((a, b) => a + b, 0) / stVals.length) : null,
    };
  }
  return out;
}

// ============================================================
// weather_stats (サンプル十分時のみ)
// ============================================================
function computeWeatherStats(races: RaceRecord[], resultByRaceKey: Map<string, any>) {
  const finished = races.filter(isFinished);
  if (finished.length < 10) return null;

  const byWeather: any = {};
  for (const r of finished) {
    const off = resultByRaceKey.get(r.race_key);
    if (!off?.weather) continue;
    const w = String(off.weather);
    if (!byWeather[w]) byWeather[w] = [];
    byWeather[w].push(r);
  }
  const out: any = {};
  for (const [w, arr] of Object.entries(byWeather)) {
    const a = arr as RaceRecord[];
    if (a.length >= 3) {
      out[w] = {
        sample_size: a.length,
        win_rate: pct(a.filter(r => r.finish_order === 1).length, a.length),
        top3_rate: pct(a.filter(r => r.finish_order <= 3).length, a.length),
        avg_finish: round2(a.reduce((s, r) => s + r.finish_order, 0) / a.length),
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

// ============================================================
// winning_style (互換用)
// ============================================================
function computeWinningStyleCompat(races: RaceRecord[], stProfile: any) {
  const finished = races.filter(isFinished);
  if (!finished.length) return { front_runner_score: null, chaser_score: null, st_stability: null, attack_score: null, defense_score: null };
  const inner = finished.filter(r => r.start_course <= 2);
  const outer = finished.filter(r => r.start_course >= 4);
  const frontRunner = inner.length ? pct(inner.filter(r => r.finish_order <= 2).length, inner.length) : null;
  const chaser = outer.length ? pct(outer.filter(r => r.finish_order <= 3).length, outer.length) : null;
  const stStability = stProfile?.overall_st_stddev != null
    ? round1(Math.max(0, Math.min(100, 100 - (stProfile.overall_st_stddev - 0.05) / 0.15 * 100)))
    : null;
  const gains = finished.filter(r => r.finish_order < r.start_course);
  const holds = finished.filter(r => r.finish_order <= r.start_course);
  return {
    front_runner_score: frontRunner,
    chaser_score: chaser,
    st_stability: stStability,
    attack_score: finished.length ? pct(gains.length, finished.length) : null,
    defense_score: finished.length ? pct(holds.length, finished.length) : null,
  };
}

// ============================================================
// confidence_split
// ============================================================
function computeConfidenceSplit(baseSamples: number, raceHistoryCount: number, finishedCount: number, totalWins: number, venueCount: number) {
  // base_confidence: RacerTermStatV2のサンプル数から
  let baseConf;
  if (baseSamples >= 100) baseConf = 100;
  else if (baseSamples >= 50) baseConf = 80 + Math.round((baseSamples - 50) / 50 * 20);
  else if (baseSamples >= 20) baseConf = 60 + Math.round((baseSamples - 20) / 30 * 20);
  else if (baseSamples >= 5) baseConf = 30 + Math.round((baseSamples - 5) / 15 * 30);
  else baseConf = Math.max(0, baseSamples * 6);

  // recent_confidence: 完走数から
  let recentConf;
  if (finishedCount >= 20) recentConf = 100;
  else if (finishedCount >= 10) recentConf = 70 + Math.round((finishedCount - 10) / 10 * 30);
  else if (finishedCount >= 5) recentConf = 40 + Math.round((finishedCount - 5) / 5 * 30);
  else if (finishedCount >= 1) recentConf = finishedCount * 8;
  else recentConf = 0;

  // course_confidence: 完走数とコース分散から
  let courseConf;
  if (finishedCount >= 30) courseConf = 90;
  else if (finishedCount >= 15) courseConf = 60 + Math.round((finishedCount - 15) / 15 * 30);
  else if (finishedCount >= 5) courseConf = 30 + Math.round((finishedCount - 5) / 10 * 30);
  else courseConf = Math.min(25, finishedCount * 5);

  // winning_method_confidence: 勝利数から
  let wmConf;
  if (totalWins >= 20) wmConf = 90;
  else if (totalWins >= 10) wmConf = 60 + Math.round((totalWins - 10) / 10 * 30);
  else if (totalWins >= 5) wmConf = 30 + Math.round((totalWins - 5) / 5 * 30);
  else if (totalWins >= 1) wmConf = totalWins * 6;
  else wmConf = 0;

  // venue_confidence: 競艇場数とサンプルから
  let venueConf;
  if (finishedCount >= 30 && venueCount >= 3) venueConf = 80;
  else if (finishedCount >= 15 && venueCount >= 2) venueConf = 50 + Math.round((finishedCount - 15) / 15 * 30);
  else if (finishedCount >= 5) venueConf = 20 + Math.round((finishedCount - 5) / 10 * 30);
  else venueConf = Math.min(20, finishedCount * 4);

  return {
    base_confidence: Math.min(100, baseConf),
    recent_confidence: Math.min(100, recentConf),
    course_confidence: Math.min(100, courseConf),
    winning_method_confidence: Math.min(100, wmConf),
    venue_confidence: Math.min(100, venueConf),
  };
}

// ============================================================
// race_history
// ============================================================
function computeRaceHistory(races: RaceRecord[]) {
  const finished = races.filter(isFinished);
  const dates = races.map(r => r.race_date).filter(d => d);
  const absent = races.filter(r => r.is_absent).length;
  const dq = races.filter(r => r.is_disqualified).length;
  const fCount = races.filter(isF).length;
  const lCount = races.filter(isL).length;
  return {
    race_history_count: races.length,
    oldest_race_date: dates.length ? dates.sort()[0] : null,
    newest_race_date: dates.length ? dates.sort().reverse()[0] : null,
    finished_count: finished.length,
    absent_count: absent,
    disqualified_count: dq,
    f_count: fCount,
    l_count: lCount,
  };
}

// ============================================================
// data_confidence (互換用: base_confidenceを優先)
// ============================================================
function computeDataConfidence(totalSamples: number) {
  if (totalSamples >= 100) return 100;
  if (totalSamples >= 50) return 80 + Math.round((totalSamples - 50) / 50 * 20);
  if (totalSamples >= 20) return 60 + Math.round((totalSamples - 20) / 30 * 20);
  if (totalSamples >= 5) return 30 + Math.round((totalSamples - 5) / 15 * 30);
  return Math.max(0, totalSamples * 6);
}

// ============================================================
// メイン処理
// ============================================================
export default async function(req: Request) {
  const base44 = createClientFromRequest(req);
  let user: any = null;
  try { user = await base44.auth.me(); } catch {}
  if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const sr = base44.asServiceRole.entities;
  const now = new Date().toISOString();

  try {
    // === 1. データ取得(並列) ===
    const [termStats, officialEntries, officialResults, entries] = await Promise.all([
      fetchBoatWorksEntity('RacerTermStatV2', '-term_start_date', 20000),
      fetchBoatWorksEntity('OfficialRaceEntryResultV2', '-created_date', 100000),
      fetchBoatWorksEntity('OfficialRaceResultV2', '-created_date', 100000),
      all(sr.RaceEntry, '-race_date', 50000),
    ]);

    // === 2. RacerTermStatV2をregistration_number別にグループ化 ===
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

    // === 3. OfficialRaceResultV2をrace_key別にマップ化 ===
    const officialResultByRaceKey = new Map<string, any>();
    for (const r of officialResults) {
      if (r.race_key) officialResultByRaceKey.set(r.race_key, r);
    }

    // === 4. OfficialRaceEntryResultV2 + OfficialRaceResultV2をJOIN → registration_number別 ===
    const raceHistoryByReg = joinAndGroupByReg(officialEntries, officialResultByRaceKey);

    // === 5. アクティブな選手リスト作成 ===
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
          },
        });
      }
    }

    // === 6. 既存プロファイル取得 ===
    const existingProfiles = await all(sr.RacerPerformanceProfile, 'registration_number', 50000);
    const profileByReg = new Map(existingProfiles.map(p => [p.registration_number, p]));

    // === 7. プロファイル生成 ===
    let upserted = 0, created = 0, skipped = 0;
    let noTermStats = 0, noRaceHistory = 0;
    const toCreate: any[] = [];
    const toUpdate: any[] = [];

    for (const [reg, active] of activeRacers) {
      const terms = termStatsByReg.get(reg) || [];
      const raceRecords = raceHistoryByReg.get(reg) || [];

      if (!terms.length) noTermStats++;
      if (!raceRecords.length) noRaceHistory++;

      // === BASE stats (RacerTermStatV2) ===
      let stats6m = aggregateTermStats(terms, 1);
      let stats1y = aggregateTermStats(terms, 2);
      let stats3y = aggregateTermStats(terms, 6);
      let statsAll = aggregateTermStats(terms, null);

      // stats_allフォールバック: RaceEntryキャリア統計
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

      // === BASE保護: 既存プロファイルのBASE statsが新しいものより多ければ保持 ===
      const existing = profileByReg.get(reg);
      if (existing) {
        if (existing.stats_all?.sample_size > statsAll.sample_size) {
          statsAll = existing.stats_all;
        }
        if (existing.stats_3y?.sample_size > stats3y.sample_size) {
          stats3y = existing.stats_3y;
        }
        if (existing.stats_1y?.sample_size > stats1y.sample_size) {
          stats1y = existing.stats_1y;
        }
        if (existing.stats_6m?.sample_size > stats6m.sample_size) {
          stats6m = existing.stats_6m;
        }
      }

      // === RACE HISTORY (OfficialRaceEntryResultV2 + OfficialRaceResultV2) ===
      const recentForm = computeRecentFormExpanded(raceRecords);
      const courseStats = computeCourseStatsExpanded(raceRecords);
      const courseStatsByPeriod = computeCourseStatsByPeriod(raceRecords);
      const winningMethods = computeWinningMethodsExpanded(raceRecords);
      const courseWinningMethods = computeCourseWinningMethods(raceRecords);
      const winningStyleType = computeWinningStyleType(winningMethods, courseWinningMethods);
      const losingPattern = computeLosingPatternExpanded(raceRecords);
      const stProfile = computeStProfile(raceRecords);
      const venueStats = computeVenueStatsExpanded(raceRecords);
      const weatherStats = computeWeatherStats(raceRecords, officialResultByRaceKey);
      const winningStyle = computeWinningStyleCompat(raceRecords, stProfile);
      const raceHistory = computeRaceHistory(raceRecords);

      // === confidence_split ===
      const totalSamples = statsAll.sample_size || 0;
      const confidenceSplit = computeConfidenceSplit(
        totalSamples,
        raceHistory.race_history_count,
        raceHistory.finished_count,
        winningMethods.total_wins,
        Object.keys(venueStats).length
      );

      // === source_meta ===
      const latestImport = terms.length ? String(terms[0].imported_at || '') : '';
      const latestEntryUpdate = active.latestEntry ? String(active.latestEntry.updated_date || active.latestEntry.updated_at || '') : '';
      const latestRaceDate = raceHistory.newest_race_date || '';
      const latestUpdate = [latestImport, latestEntryUpdate, latestRaceDate].sort().reverse()[0] || '';
      const sourceVersion = `v4_${terms.length}terms_${raceHistory.race_history_count}races`;

      const doc: any = {
        registration_number: reg,
        racer_name: active.name,
        grade_class: active.grade,
        // BASE (保護済み)
        stats_6m: stats6m,
        stats_1y: stats1y,
        stats_3y: stats3y,
        stats_all: statsAll,
        // RACE HISTORY
        course_stats: courseStats,
        course_stats_by_period: courseStatsByPeriod,
        course_winning_methods: courseWinningMethods,
        winning_methods: winningMethods,
        winning_methods_6m: winningMethods,
        winning_methods_1y: winningMethods,
        winning_methods_3y: winningMethods,
        winning_style_type: winningStyleType,
        recent_form: recentForm,
        recent_finishes: raceRecords.filter(isFinished).slice(0, 20).map(r => r.finish_order),
        losing_pattern: losingPattern,
        st_profile: stProfile,
        venue_stats: venueStats,
        weather_stats: weatherStats,
        winning_style: winningStyle,
        confidence_split: confidenceSplit,
        race_history: raceHistory,
        // 互換用
        momentum: recentForm.momentum_score,
        total_samples: totalSamples,
        data_confidence: computeDataConfidence(totalSamples),
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

    // === 8. バルク書き込み ===
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
      racers_without_race_history: noRaceHistory,
      message: `選手プロファイル${upserted}件更新(新規${created}・期別データなし${noTermStats}・履歴なし${noRaceHistory})`,
    });
  } catch(error: any) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}