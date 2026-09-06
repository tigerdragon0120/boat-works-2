import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// 全件取得ヘルパー
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
const pct = (a, b) => b ? round1(a / b * 100) : null;

function computeFinish(res, boatNumber) {
  if (!res) return null;
  const order = Array.isArray(res.finish_order) ? res.finish_order.map(Number) : String(res.result_trifecta || '').split('-').map(Number);
  const idx = order.findIndex(n => n === Number(boatNumber));
  return idx >= 0 ? idx + 1 : null;
}

// 期間別統計を計算
function computeStats(records, cutoffDate) {
  const filtered = cutoffDate ? records.filter(r => r.date >= cutoffDate) : records;
  if (!filtered.length) return { sample_size: 0, win_rate: null, top2_rate: null, top3_rate: null, avg_finish: null, avg_st: null };
  const samples = filtered.length;
  const wins = filtered.filter(r => r.finish === 1).length;
  const top2 = filtered.filter(r => r.finish <= 2).length;
  const top3 = filtered.filter(r => r.finish <= 3).length;
  const avgFinish = round1(filtered.reduce((s, r) => s + r.finish, 0) / samples);
  const stRecords = filtered.filter(r => r.st != null);
  const avgSt = stRecords.length ? round1(stRecords.reduce((s, r) => s + r.st, 0) / stRecords.length) : null;
  return { sample_size: samples, win_rate: pct(wins, samples), top2_rate: pct(top2, samples), top3_rate: pct(top3, samples), avg_finish: avgFinish, avg_st: avgSt };
}

// 勝ち方プロファイル計算(決まり手なし→着順とコースから推定)
function computeWinningStyle(records) {
  if (!records.length) return { front_runner_score: null, chaser_score: null, st_stability: null, attack_score: null, defense_score: null };
  const inner = records.filter(r => r.course <= 2); // 内コース(1-2)
  const outer = records.filter(r => r.course >= 4); // 外コース(4-6)
  const frontRunner = inner.length ? pct(inner.filter(r => r.finish <= 2).length, inner.length) : null;
  const chaser = outer.length ? pct(outer.filter(r => r.finish <= 3).length, outer.length) : null;
  // ST安定性: STの分散が小さいほど安定
  const stVals = records.filter(r => r.st != null).map(r => r.st);
  let stStability = null;
  if (stVals.length >= 3) {
    const mean = stVals.reduce((a, b) => a + b, 0) / stVals.length;
    const variance = stVals.reduce((s, v) => s + (v - mean) ** 2, 0) / stVals.length;
    const stdDev = Math.sqrt(variance);
    // 標準偏差0.05秒→100点、0.20秒→0点
    stStability = round1(Math.max(0, Math.min(100, 100 - (stdDev - 0.05) / 0.15 * 100)));
  }
  // 攻撃/守備: 進入コースより着順が良ければ攻撃、維持すれば守備
  const positioned = records.filter(r => r.course != null && r.finish != null);
  const gains = positioned.filter(r => r.finish < r.course); // コースより着順が良い
  const holds = positioned.filter(r => r.finish <= r.course); // コース以下の着順
  const attackScore = positioned.length ? pct(gains.length, positioned.length) : null;
  const defenseScore = positioned.length ? pct(holds.length, positioned.length) : null;
  return { front_runner_score: frontRunner, chaser_score: chaser, st_stability: stStability, attack_score: attackScore, defense_score: defenseScore };
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  let user = null;
  try { user = await base44.auth.me(); } catch {}
  if (user && user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const sr = base44.asServiceRole.entities;
  const now = new Date().toISOString();

  try {
    // Race, RaceResult, RaceEntryを全件取得
    const [races, results, entries] = await Promise.all([
      all(sr.Race, 'race_date', 50000),
      all(sr.RaceResult, '-finished_at', 50000),
      all(sr.RaceEntry, '-updated_date', 50000)
    ]);

    const raceById = new Map(races.map(r => [r.id, r]));
    const resultByRace = new Map(results.map(r => [r.race_id, r]));

    // 選手ごとにレコードを集約
    const racerRecords = new Map(); // reg -> [{date, finish, course, st, venue}]

    for (const e of entries) {
      const race = raceById.get(e.race_id);
      if (!race) continue;
      const reg = String(e.registration_number || e.register_number || '').trim();
      if (!reg) continue;
      const res = resultByRace.get(e.race_id);
      const finish = computeFinish(res, e.boat_number);
      if (!finish) continue; // 結果不明はスキップ

      if (!racerRecords.has(reg)) racerRecords.set(reg, { name: e.player_name || e.racer_name || '', grade: e.player_class || e.grade_class || '', records: [] });
      const a = racerRecords.get(reg);
      a.records.push({
        date: race.race_date,
        finish,
        course: e.entry_course != null ? e.entry_course : e.boat_number,
        st: e.exhibition_st != null ? e.exhibition_st : e.avg_st,
        venue: race.venue_code,
      });
    }

    // 期間のcutoff日を計算
    const today = new Date().toISOString().slice(0, 10);
    const cutoff6m = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    const cutoff1y = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const cutoff3y = new Date(Date.now() - 1095 * 86400000).toISOString().slice(0, 10);

    const docs = [];
    for (const [reg, a] of racerRecords) {
      const records = a.records.sort((x, y) => String(y.date).localeCompare(String(x.date)));
      const stats6m = computeStats(records, cutoff6m);
      const stats1y = computeStats(records, cutoff1y);
      const stats3y = computeStats(records, cutoff3y);
      const statsAll = computeStats(records, null);
      const winningStyle = computeWinningStyle(records);

      // コース別成績
      const courseStats = {};
      for (let c = 1; c <= 6; c++) {
        const courseRecords = records.filter(r => r.course === c);
        if (courseRecords.length) {
          courseStats[String(c)] = {
            samples: courseRecords.length,
            win_rate: pct(courseRecords.filter(r => r.finish === 1).length, courseRecords.length),
            top2_rate: pct(courseRecords.filter(r => r.finish <= 2).length, courseRecords.length),
            top3_rate: pct(courseRecords.filter(r => r.finish <= 3).length, courseRecords.length),
          };
        } else {
          courseStats[String(c)] = { samples: 0, win_rate: null, top2_rate: null, top3_rate: null };
        }
      }

      // 勢い: 直近5走の平均着順 vs それ以前の平均着順
      const recent5 = records.slice(0, 5);
      const older = records.slice(5);
      let momentum = null;
      if (recent5.length && older.length) {
        const recentAvg = recent5.reduce((s, r) => s + r.finish, 0) / recent5.length;
        const olderAvg = older.reduce((s, r) => s + r.finish, 0) / older.length;
        momentum = round1(olderAvg - recentAvg); // 正=上向き
      }

      const totalSamples = records.length;
      // データ信頼度: 30走で100点、5走で30点
      const dataConfidence = Math.min(100, Math.round(totalSamples / 30 * 100));

      docs.push({
        registration_number: reg,
        racer_name: a.name,
        grade_class: a.grade,
        stats_6m: stats6m,
        stats_1y: stats1y,
        stats_3y: stats3y,
        stats_all: statsAll,
        course_stats: courseStats,
        winning_style: winningStyle,
        recent_finishes: records.slice(0, 10).map(r => r.finish),
        momentum,
        total_samples: totalSamples,
        data_confidence: dataConfidence,
        updated_at: now,
      });
    }

    // 既存プロファイルを全削除して再構築
    await sr.RacerPerformanceProfile.deleteMany({});
    const chunkSize = 80;
    for (let i = 0; i < docs.length; i += chunkSize) {
      await sr.RacerPerformanceProfile.bulkCreate(docs.slice(i, i + chunkSize));
    }

    return Response.json({
      status: 'success',
      profiles_built: docs.length,
      total_results: results.length,
      total_entries: entries.length,
      message: `選手プロファイル${docs.length}件を構築`
    });
  } catch(error) {
    return Response.json({ status: 'error', message: error?.message || String(error) }, { status: 500 });
  }
}