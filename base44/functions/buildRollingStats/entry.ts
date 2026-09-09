import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { computeRollingStats } from "../../shared/rollingStatsEngine.js";

// === ページネーション取得 ===
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

export default async function(req: Request) {
  const base44 = createClientFromRequest(req);
  let user: any = null;
  try { user = await base44.auth.me(); } catch {}
  if (!user || user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const sr = base44.asServiceRole.entities;

  try {
    const body = await req.json().catch(() => ({}));
    const targetReg = body.registration_number || null; // 指定選手のみ再計算
    const batchSize = body.batch_size || 500;
    const batchOffset = body.batch_offset || 0;

    // === 全RacerTermStats取得 ===
    const allTermStats = await all(sr.RacerTermStats, 'registration_number', 200000);
    // === 全RacerRaceHistory取得 ===
    const allHistory = await all(sr.RacerRaceHistory, '-race_date', 200000);

    // registration_number別にグループ化
    const termByReg = new Map();
    for (const t of allTermStats) {
      const reg = String(t.registration_number || '').trim();
      if (!reg) continue;
      if (!termByReg.has(reg)) termByReg.set(reg, []);
      termByReg.get(reg).push(t);
    }
    const historyByReg = new Map();
    for (const h of allHistory) {
      const reg = String(h.registration_number || '').trim();
      if (!reg) continue;
      if (!historyByReg.has(reg)) historyByReg.set(reg, []);
      historyByReg.get(reg).push(h);
    }

    // 対象選手リスト
    const allRegs = [...new Set([...termByReg.keys(), ...historyByReg.keys()])];
    const targetRegs = targetReg ? [targetReg] : allRegs;
    const batch = targetRegs.slice(batchOffset, batchOffset + batchSize);

    if (!batch.length) {
      return Response.json({
        ok: true,
        completed: true,
        processed: batchOffset,
        total: targetRegs.length,
      });
    }

    // 既存RacerRollingStats取得
    const existingRolling = await all(sr.RacerRollingStats, 'registration_number', 50000);
    const rollingByReg = new Map(existingRolling.map((r) => [r.registration_number, r]));

    const toCreate = [];
    const toUpdate = [];
    let computed = 0;

    for (const reg of batch) {
      const termRecords = termByReg.get(reg) || [];
      const historyRecords = historyByReg.get(reg) || [];
      if (!termRecords.length && !historyRecords.length) continue;

      const racerName = (termRecords[0] || historyRecords[0])?.racer_name || '';
      const rolling = computeRollingStats(reg, racerName, termRecords, historyRecords);

      const existing = rollingByReg.get(reg);
      if (existing) {
        toUpdate.push({ id: existing.id, ...rolling });
      } else {
        toCreate.push(rolling);
      }
      computed++;
    }

    // バルク書き込み
    for (let i = 0; i < toCreate.length; i += 500) {
      await sr.RacerRollingStats.bulkCreate(toCreate.slice(i, i + 500));
    }
    for (let i = 0; i < toUpdate.length; i += 500) {
      await sr.RacerRollingStats.bulkUpdate(toUpdate.slice(i, i + 500));
    }

    const totalProcessed = batchOffset + batch.length;
    const isComplete = totalProcessed >= targetRegs.length;

    return Response.json({
      ok: true,
      completed: isComplete,
      processed: totalProcessed,
      computed,
      created: toCreate.length,
      updated: toUpdate.length,
      total: targetRegs.length,
      total_term_stats: allTermStats.length,
      total_history: allHistory.length,
      next_offset: isComplete ? null : totalProcessed,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}