import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

async function all(entity, sort = '-updated_date', max = 50000) {
  const out = [];
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

const round1 = (n) => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const round2 = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
const pct = (a, b) => b ? round1(a / b * 100) : null;
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function computeFinish(res, boatNumber) {
  if (!res) return null;
  const order = Array.isArray(res.finish_order) && res.finish_order.length
    ? res.finish_order.map(Number)
    : String(res.result_trifecta || '').split('-').map(Number).filter(n => n);
  const idx = order.findIndex(n => n === Number(boatNumber));
  if (idx >= 0) return idx + 1;
  // 3連単に入っていない → 4-6着のいずれか(近似4.5)
  return 4.5;
}

function computeStats(records, cutoffDate) {
  const filtered = cutoffDate ? records.filter(r => r.date >= cutoffDate) : records;
  if (!filtered.length) return { sample_size: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null };
  const samples = filtered.length;
  const wins = filtered.filter(r => r.finish === 1).length;
  const top2 = filtered.filter(r => r.finish <= 2).length;
  const top3 = filtered.filter(r => r.finish <= 3).length;
  const avgFinish = round2(filtered.reduce((s, r) => s + r.finish, 0) / samples);
  const stRecords = filtered.filter(r => r.st != null);
  const avgSt = stRecords.length ? round2(stRecords.reduce((s, r) => s + r.st, 0) / stRecords.length) : null;
  return { sample_size: samples, win_rate: pct(wins, samples), top2_rate: pct(top2, samples), top3_rate: pct(top3, samples), avg_finish: avgFinish, avg_st: avgSt };
}

function inferKimarite(boatNumber, finish) {
  if (finish !== 1) return null;
  if (boatNumber === 1) return 'escape';
  if (boatNumber === 2) return 'sashi';
  if (boatNumber === 3) return 'makuri';
  if (boatNumber === 4) return 'makuri_sashi';
  if (boatNumber === 5) return 'nuki';
  if (boatNumber === 6) return 'nuki';
  return 'other';
}

function computeWinningMethods(records) {
  const wins = records.filter(r => r.finish === 1);
  const total = wins.length;
  if (!total) return { escape_rate: null, sashi_rate: null, makuri_rate: null, makuri_sashi_rate: null, nuki_rate: null, other_rate: null, total_wins: 0 };
  const counts = { escape: 0, sashi: 0, makuri: 0, makuri_sashi: 0, nuki: 0, other: 0 };
  for (const w of wins) {
    const k = inferKimarite(w.course, w.finish);
    if (k && counts[k] != null) counts[k]++;
    else counts.other++;
  }
  return {
    escape_rate: pct(counts.escape, total),
    sashi_rate: pct(counts.sashi, total),
    makuri_rate: pct(counts.makuri, total),
    makuri_sashi_rate: pct(counts.makuri_sashi, total),
    nuki_rate: pct(counts.nuki, total),
    other_rate: pct(counts.other, total),
    total_wins: total,
  };
}

function computeRecentForm(records) {
  if (!records.length) return { recent_5_avg_finish: null, recent_10_avg_finish: null, recent_20_avg_finish: null, recent_st: null, recent_win_rate: null, recent_top3_rate: null, momentum_score: null };
  const avgFinish = (arr) => arr.length ? round2(arr.reduce((s, r) => s + r.finish, 0) / arr.length) : null;
  const r5 = records.slice(0, 5);
  const r10 = records.slice(0, 10);
  const r20 = records.slice(0, 20);
  const stVals = r20.filter(r => r.st != null).map(r => r.st);
  const recentSt = stVals.length ? round2(stVals.reduce((a, b) => a + b, 0) / stVals.length) : null;
  const recentWin = r20.length ? pct(r20.filter(r => r.finish === 1).length, r20.length) : null;
  const recentTop3 = r20.length ? pct(r20.filter(r => r.finish <= 3).length, r20.length) : null;
  let momentum = null;
  if (r10.length >= 3 && records.length > 10) {
    const older = records.slice(10, 30);
    if (older.length) {
      const recentAvg = r10.reduce((s, r) => s + r.finish, 0) / r10.length;
      const olderAvg = older.reduce((s, r) => s + r.finish, 0) / older.length;
      momentum = round2(olderAvg - recentAvg);
    }
  }
  return {
    recent_5_avg_finish: avgFinish(r5),
    recent_10_avg_finish: avgFinish(r10),
    recent_20_avg_finish: avgFinish(r20),
    recent_st: recentSt,
    recent_win_rate: recentWin,
    recent_top3_rate: recentTop3,
    momentum_score: momentum,
  };
}

function computeLosingPattern(records) {
  if (!records.length) return { outside_top3_rate: null, first_course_loss_rate: null, start_late_rate: null, collapse_rate: null };
  const outside = records.filter(r => r.course >= 4);
  const outsideTop3 = outside.length ? pct(outside.filter(r => r.finish <= 3).length, outside.length) : null;
  const firstCourse = records.filter(r => r.course === 1);
  const firstLoss = firstCourse.length ? pct(firstCourse.filter(r => r.finish > 1).length, firstCourse.length) : null;
  const stRecords = records.filter(r => r.st != null);
  const startLate = stRecords.length ? pct(stRecords.filter(r => r.st > 0.2).length, stRecords.length) : null;
  const positioned = records.filter(r => r.course != null && r.finish != null);
  const collapse = positioned.length ? pct(positioned.filter(r => r.finish > r.course).length, positioned.length) : null;
  return { outside_top3_rate: outsideTop3, first_course_loss_rate: firstLoss, start_late_rate: startLate, collapse_rate: collapse };
}

function computeWinningStyle(records) {
  if (!records.length) return { front_runner_score: null, chaser_score: null, st_stability: null, attack_score: null, defense_score: null };
  const inner = records.filter(r => r.course <= 2);
  const outer = records.filter(r => r.course >= 4);
  const frontRunner = inner.length ? pct(inner.filter(r => r.finish <= 2).length, inner.length) : null;
  const chaser = outer.length ? pct(outer.filter(r => r.finish <= 3).length, outer.length) : null;
  const stVals = records.filter(r => r.st != null).map(r => r.st);
  let stStability = null;
  if (stVals.length >= 3) {
    const mean = stVals.reduce((a, b) => a + b, 0) / stVals.length;
    const variance = stVals.reduce((s, v) => s + (v - mean) ** 2, 0) / stVals.length;
    const stdDev = Math.sqrt(variance);
    stStability = round1(Math.max(0, Math.min(100, 100 - (stdDev - 0.05) / 0.15 * 100)));
  }
  const positioned = records.filter(r => r.course != null && r.finish != null);
  const gains = positioned.filter(r => r.finish < r.course);
  const holds = positioned.filter(r => r.finish <= r.course);
  const attackScore = positioned.length ? pct(gains.length, positioned.length) : null;
  const defenseScore = positioned.length ? pct(holds.length, positioned.length) : null;
  return { front_runner_score: frontRunner, chaser_score: chaser, st_stability: stStability, attack_score: attackScore, defense_score: defenseScore };
}

// data_confidence: サンプル数に基づく信頼度(ユーザー指定の目安に準拠)
// 0-5走→10以下, 6-20走→20-40, 21-50走→40-60, 51-100走→60-80, 101+走→80-100
// 期間別データ量も考慮(6m/1y/3yに十分なデータがあればボーナス)
function computeDataConfidence(totalSamples, samples6m, samples1y, samples3y) {
  let base;
  if (totalSamples <= 5) base = Math.min(10, totalSamples * 2);
  else if (totalSamples <= 20) base = 20 + Math.round((totalSamples - 5) / 15 * 20);
  else if (totalSamples <= 50) base = 40 + Math.round((totalSamples - 20) / 30 * 20);
  else if (totalSamples <= 100) base = 60 + Math.round((totalSamples - 50) / 50 * 20);
  else base = Math.min(100, 80 + Math.round((totalSamples - 100) / 100 * 20));

  // 期間別データ充足ボーナス(最大+10)
  let bonus = 0;
  if (samples6m >= 10) bonus += 4;
  if (samples1y >= 30) bonus += 3;
  if (samples3y >= 50) bonus += 3;

  return Math.min(100, Math.max(0, base + bonus));
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  let user = null;
  try { user = await base44.auth.me(); } catch {}
  if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const sr = base44.asServiceRole.entities;
  const now = new Date().toISOString();

  try {
    // 既存プロファイルを取得(upsert用)
    const existingProfiles = await all(sr.RacerPerformanceProfile, 'registration_number', 50000);
    const profileByReg = new Map(existingProfiles.map(p => [p.registration_number, p]));

    // 全データ取得(エントリは件数が多いため最新数日分に限定)
    const races = await all(sr.Race, 'race_date', 50000);
    const results = await all(sr.RaceResult, '-finished_at', 50000);

    const raceById = new Map(races.map(r => [r.id, r]));
    const resultByRace = new Map(results.map(r => [r.race_id, r]));

    // エントリ: 最新日から順に取得(キャリア統計+結果レース分をカバー)
    // 全14000+件のページングはレート制限に引っかかるため、最新3000件に限定
    const entries = await all(sr.RaceEntry, '-race_date', 3000);

    // 選手ごとにレコードを集約 + キャリア統計(最新エントリから取得)
    const racerData = new Map();
    for (const e of entries) {
      const race = raceById.get(e.race_id);
      if (!race) continue;
      const reg = String(e.registration_number || e.register_number || '').trim();
      if (!reg) continue;

      if (!racerData.has(reg)) racerData.set(reg, {
        name: e.player_name || e.racer_name || '',
        grade: e.player_class || e.grade_class || '',
        records: [],
        latestEntry: null,
        latestRaceDate: '',
        careerStats: null,
      });
      const a = racerData.get(reg);

      // 最新エントリ(キャリア統計用)を保持
      const raceDate = String(race.race_date || '');
      const entryUpdated = String(e.updated_date || e.updated_at || '');
      if (raceDate >= a.latestRaceDate) {
        a.latestRaceDate = raceDate;
        a.latestEntry = e;
        a.careerStats = {
          national_win_rate: num(e.national_win_rate),
          national_2rate: num(e.national_2rate) ?? num(e.national_f2_rate),
          national_3rate: num(e.national_3rate) ?? num(e.national_f3_rate),
          local_win_rate: num(e.local_win_rate),
          local_2rate: num(e.local_2rate) ?? num(e.local_f2_rate),
          local_3rate: num(e.local_3rate) ?? num(e.local_f3_rate),
          avg_st: num(e.avg_st),
          f_count: num(e.f_count),
          l_count: num(e.l_count),
          c1_win_rate: num(e.c1_win_rate),
          c1_2rate: num(e.c1_2rate),
          c1_3rate: num(e.c1_3rate),
        };
      }

      // レース別データ(結果がある場合のみ)
      const res = resultByRace.get(e.race_id);
      const finish = computeFinish(res, e.boat_number);
      if (finish === null) continue;

      a.records.push({
        date: race.race_date,
        finish,
        course: e.entry_course != null ? e.entry_course : e.boat_number,
        st: e.exhibition_st != null ? e.exhibition_st : e.avg_st,
        venue: race.venue_code,
        race_updated: race.updated_date || e.updated_date || '',
      });
    }

    const cutoff6m = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    const cutoff1y = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const cutoff3y = new Date(Date.now() - 1095 * 86400000).toISOString().slice(0, 10);

    let upserted = 0, skipped = 0, created = 0;
    let warning_same_sample = 0;
    for (const [reg, a] of racerData) {
      const records = a.records.sort((x, y) => String(y.date).localeCompare(String(x.date)));

      // 差分判定: 元データの最終更新日時 vs プロファイルのsource_updated_at
      const latestSourceUpdate = records.reduce((max, r) => (r.race_updated > max ? r.race_updated : max), '');
      const careerUpdate = a.latestEntry ? String(a.latestEntry.updated_date || a.latestEntry.updated_at || '') : '';
      const latestUpdate = latestSourceUpdate > careerUpdate ? latestSourceUpdate : careerUpdate;
      const existing = profileByReg.get(reg);
      // v2移行: 旧バージョン(v1)のプロファイルは強制更新
      const isOldVersion = existing && (!existing.source_meta?.source_version || !String(existing.source_meta.source_version).startsWith('v2'));
      if (existing && !isOldVersion && existing.source_meta?.source_updated_at && latestUpdate <= existing.source_meta.source_updated_at) {
        skipped++;
        continue;
      }

      // 期間別集計(レース別データから日付でフィルタ)
      const stats6m = computeStats(records, cutoff6m);
      const stats1y = computeStats(records, cutoff1y);
      const stats3y = computeStats(records, cutoff3y);

      // stats_all: キャリア通算成績(エントリのnational_win_rate等)を優先使用
      // これが「長期履歴データ」への接続。レース別データはフォールバック。
      const career = a.careerStats || {};
      const statsAll = {
        sample_size: records.length,
        win_rate: career.national_win_rate != null ? round1(career.national_win_rate)
          : (records.length ? pct(records.filter(r => r.finish === 1).length, records.length) : null),
        top2_rate: career.national_2rate != null ? round1(career.national_2rate)
          : (records.length ? pct(records.filter(r => r.finish <= 2).length, records.length) : null),
        top3_rate: career.national_3rate != null ? round1(career.national_3rate)
          : (records.length ? pct(records.filter(r => r.finish <= 3).length, records.length) : null),
        avg_finish: records.length ? round2(records.reduce((s, r) => s + r.finish, 0) / records.length) : null,
        avg_st: career.avg_st != null ? round2(career.avg_st) : null,
      };

      // 期間別決まり手
      const winningMethods = computeWinningMethods(records);
      const winningMethods6m = computeWinningMethods(records.filter(r => r.date >= cutoff6m));
      const winningMethods1y = computeWinningMethods(records.filter(r => r.date >= cutoff1y));
      const winningMethods3y = computeWinningMethods(records.filter(r => r.date >= cutoff3y));
      const recentForm = computeRecentForm(records);
      const losingPattern = computeLosingPattern(records);
      const winningStyle = computeWinningStyle(records);

      // コース別成績: レース別データから計算。コース1はキャリア統計(c1_win_rate)を優先。
      const courseStats = {};
      for (let c = 1; c <= 6; c++) {
        const cr = records.filter(r => r.course === c);
        if (cr.length) {
          const stVals = cr.filter(r => r.st != null).map(r => r.st);
          courseStats[String(c)] = {
            sample_size: cr.length,
            win_rate: pct(cr.filter(r => r.finish === 1).length, cr.length),
            top2_rate: pct(cr.filter(r => r.finish <= 2).length, cr.length),
            top3_rate: pct(cr.filter(r => r.finish <= 3).length, cr.length),
            avg_finish: round2(cr.reduce((s, r) => s + r.finish, 0) / cr.length),
            avg_st: stVals.length ? round2(stVals.reduce((a, b) => a + b, 0) / stVals.length) : null,
          };
        } else if (c === 1 && career.c1_win_rate != null) {
          // コース1のキャリア統計があれば使用(レース別データがない場合)
          courseStats[String(c)] = {
            sample_size: 0,
            win_rate: round1(career.c1_win_rate),
            top2_rate: career.c1_2rate != null ? round1(career.c1_2rate) : null,
            top3_rate: career.c1_3rate != null ? round1(career.c1_3rate) : null,
            avg_finish: null,
            avg_st: null,
          };
        } else {
          courseStats[String(c)] = { sample_size: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null };
        }
      }

      // 競艇場別成績
      const venueStats = {};
      for (const r of records) {
        if (!r.venue) continue;
        const vc = String(r.venue);
        if (!venueStats[vc]) venueStats[vc] = [];
        venueStats[vc].push(r);
      }
      const venueStatsOut = {};
      for (const [vc, vr] of Object.entries(venueStats)) {
        venueStatsOut[vc] = {
          samples: vr.length,
          win_rate: pct(vr.filter(r => r.finish === 1).length, vr.length),
          top2_rate: pct(vr.filter(r => r.finish <= 2).length, vr.length),
          top3_rate: pct(vr.filter(r => r.finish <= 3).length, vr.length),
        };
      }

      const totalSamples = records.length;
      const dataConfidence = computeDataConfidence(totalSamples, stats6m.sample_size, stats1y.sample_size, stats3y.sample_size);
      const sourceVersion = `v2_${records.length}_${latestUpdate || 'init'}`;

      // WARNING: 6m=1y=3yのsample_sizeが同じ場合(全データが6ヶ月以内)
      if (stats6m.sample_size > 0 && stats6m.sample_size === stats1y.sample_size && stats1y.sample_size === stats3y.sample_size) {
        warning_same_sample++;
      }

      const doc = {
        registration_number: reg,
        racer_name: a.name,
        grade_class: a.grade,
        stats_6m: stats6m,
        stats_1y: stats1y,
        stats_3y: stats3y,
        stats_all: statsAll,
        course_stats: courseStats,
        winning_methods: winningMethods,
        winning_methods_6m: winningMethods6m,
        winning_methods_1y: winningMethods1y,
        winning_methods_3y: winningMethods3y,
        recent_form: recentForm,
        losing_pattern: losingPattern,
        venue_stats: venueStatsOut,
        winning_style: winningStyle,
        recent_finishes: records.slice(0, 10).map(r => r.finish),
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
        await sr.RacerPerformanceProfile.update(existing.id, doc);
        upserted++;
      } else {
        await sr.RacerPerformanceProfile.create(doc);
        created++;
        upserted++;
      }
    }

    return Response.json({
      status: 'success',
      total_racers: racerData.size,
      profiles_upserted: upserted,
      profiles_created: created,
      profiles_skipped: skipped,
      warning_same_sample_6m_1y_3y: warning_same_sample,
      total_results: results.length,
      total_entries: entries.length,
      total_races: races.length,
      message: `選手プロファイル${upserted}件更新(新規${created}・差分skip${skipped}・6m=1y=3y警告${warning_same_sample}件)`
    });
  } catch(error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}