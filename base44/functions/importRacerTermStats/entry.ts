import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

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
    const body = await req.json();
    const records = body.records || [];
    const fileName = body.file_name || '';
    const termOverride = body.term_override || null;
    const batchOffset = body.batch_offset || 0;
    // 504回避のため1回の処理量を小さく制限する。
    // クライアントが大きい値を送っても最大100件まで。
    const batchSize = Math.max(20, Math.min(Number(body.batch_size || 100), 100));
    const logId = body.log_id || null;
    const now = new Date().toISOString();

    if (!records.length) return Response.json({ error: 'records が空です' }, { status: 400 });

    // 期の強制上書き
    const processedRecords = records.map((r) => {
      if (termOverride) {
        return {
          ...r,
          term_year: termOverride.term_year,
          term_half: termOverride.term_half,
          term_key: `${termOverride.term_year}_${termOverride.term_half}`,
        };
      }
      return r;
    });

    // バッチ抽出
    const batch = processedRecords.slice(batchOffset, batchOffset + batchSize);
    if (!batch.length) {
      // 全件処理完了
      if (logId) {
        await sr.DataImportLog.update(logId, { status: 'success' });
      }
      return Response.json({
        ok: true,
        completed: true,
        processed: batchOffset,
        created: 0,
        updated: 0,
        errors: 0,
        total: processedRecords.length,
      });
    }

    // === 既存レコード取得（term_key単位で一括取得） ===
    const termKeys = [...new Set(batch.map((r) => r.term_key))].filter(Boolean);
    const existingByRegTerm = new Map();
    for (const tk of termKeys) {
      const existing = await sr.RacerTermStats.filter({ term_key: tk }, 'registration_number', 5000).catch(() => []);
      for (const e of existing) {
        existingByRegTerm.set(`${e.registration_number}_${e.term_key}`, e);
      }
    }

    const toCreate = [];
    const toUpdate = [];
    const errorDetails = [];

    for (const rec of batch) {
      try {
        const reg = String(rec.registration_number || '').trim();
        if (!reg || !/^\d{3,5}$/.test(reg)) {
          errorDetails.push(`登録番号異常: ${reg}`);
          continue;
        }
        const key = `${reg}_${rec.term_key}`;
        const doc = {
          registration_number: reg,
          racer_name: rec.racer_name || '',
          racer_name_kana: rec.racer_name_kana || '',
          term_year: rec.term_year,
          term_half: rec.term_half,
          term_key: rec.term_key,
          term_start_date: rec.term_start_date || null,
          term_end_date: rec.term_end_date || null,
          player_class: rec.player_class || '',
          prev_class: rec.prev_class || '',
          prev2_class: rec.prev2_class || '',
          prev3_class: rec.prev3_class || '',
          branch_name: rec.branch_name || '',
          birth_era: rec.birth_era || '',
          birth_date: rec.birth_date || '',
          gender: rec.gender,
          age: rec.age,
          height: rec.height,
          weight: rec.weight,
          blood_type: rec.blood_type || '',
          birthplace: rec.birthplace || '',
          training_term: rec.training_term,
          win_rate: rec.win_rate,
          fukusho_rate: rec.fukusho_rate,
          first_count: rec.first_count,
          second_count: rec.second_count,
          race_count: rec.race_count,
          yushutsu_count: rec.yushutsu_count,
          yusho_count: rec.yusho_count,
          avg_st: rec.avg_st,
          prev_ability_index: rec.prev_ability_index,
          current_ability_index: rec.current_ability_index,
          f_count: rec.f_count || 0,
          l_count: rec.l_count || 0,
          course_stats: rec.course_stats || {},
          no_course_l0: rec.no_course_l0,
          no_course_l1: rec.no_course_l1,
          no_course_k0: rec.no_course_k0,
          no_course_k1: rec.no_course_k1,
          source_file: fileName,
          imported_at: now,
        };

        const existing = existingByRegTerm.get(key);
        if (existing) {
          toUpdate.push({ id: existing.id, ...doc });
        } else {
          toCreate.push(doc);
        }
      } catch (e) {
        errorDetails.push(`${rec.registration_number}: ${e.message}`);
      }
    }

    // === バルク書き込み ===
    let createdCount = 0, updatedCount = 0;
    for (let i = 0; i < toCreate.length; i += 100) {
      const chunk = toCreate.slice(i, i + 100);
      await sr.RacerTermStats.bulkCreate(chunk);
      createdCount += chunk.length;
    }
    for (let i = 0; i < toUpdate.length; i += 100) {
      const chunk = toUpdate.slice(i, i + 100);
      await sr.RacerTermStats.bulkUpdate(chunk);
      updatedCount += chunk.length;
    }

    // RacerProfileは「全件完了時に全選手を1人ずつ検索」しない。
    // それが504の主因だったため、このバッチに含まれる選手だけを更新する。
    const batchRegs = [...new Set(batch.map((r:any) => String(r.registration_number || '').trim()).filter(Boolean))];
    const profileByReg = new Map();
    for (const reg of batchRegs) {
      const existing = await sr.RacerProfile.filter({ registration_number: reg }, '-updated_at', 1).catch(() => []);
      if (existing && existing[0]) profileByReg.set(reg, existing[0]);
    }
    const latestInBatch = new Map();
    for (const rec of batch) {
      const reg = String(rec.registration_number || '').trim();
      if (!reg) continue;
      const prev = latestInBatch.get(reg);
      if (!prev || String(rec.term_key || '') > String(prev.term_key || '')) latestInBatch.set(reg, rec);
    }
    const profileCreates:any[] = [];
    const profileUpdates:any[] = [];
    for (const [reg, latest] of latestInBatch) {
      const doc:any = {
        registration_number: reg,
        racer_name: latest.racer_name || '',
        player_name: latest.racer_name || '',
        player_class: latest.player_class || '',
        grade_class: latest.player_class || '',
        branch_name: latest.branch_name || '',
        age: latest.age,
        weight: latest.weight,
        national_win_rate: latest.win_rate,
        national_2rate: latest.fukusho_rate,
        avg_st: latest.avg_st,
        f_count: latest.f_count,
        l_count: latest.l_count,
        updated_at: now,
      };
      const old = profileByReg.get(reg);
      if (old) profileUpdates.push({ id: old.id, ...doc });
      else profileCreates.push(doc);
    }
    for (let i = 0; i < profileCreates.length; i += 100) {
      await sr.RacerProfile.bulkCreate(profileCreates.slice(i, i + 100));
    }
    for (let i = 0; i < profileUpdates.length; i += 100) {
      await sr.RacerProfile.bulkUpdate(profileUpdates.slice(i, i + 100));
    }

    const totalProcessed = batchOffset + batch.length;
    const isComplete = totalProcessed >= processedRecords.length;

    // === DataImportLog更新 ===
    let finalLogId = logId;
    if (!finalLogId) {
      const log = await sr.DataImportLog.create({
        import_type: 'racer_data',
        file_name: fileName,
        imported_at: now,
        status: 'running',
        total_rows: processedRecords.length,
        created_count: 0,
        updated_count: 0,
        skipped_count: 0,
        error_count: 0,
        details: { term_keys: termKeys, batch_size: batchSize },
      });
      finalLogId = log.id;
    }

    // ログ累積更新（簡易: 現在のバッチ分を加算）
    const existingLog = await sr.DataImportLog.get(finalLogId);
    const accCreated = (existingLog?.created_count || 0) + createdCount;
    const accUpdated = (existingLog?.updated_count || 0) + updatedCount;
    const accErrors = (existingLog?.error_count || 0) + errorDetails.length;

    await sr.DataImportLog.update(finalLogId, {
      status: isComplete ? (accErrors > 0 ? 'partial' : 'success') : 'running',
      created_count: accCreated,
      updated_count: accUpdated,
      error_count: accErrors,
      error_message: errorDetails.length > 0 ? errorDetails.slice(0, 20).join('; ') : undefined,
      details: {
        ...(existingLog?.details || {}),
        term_keys: termKeys,
        last_offset: totalProcessed,
        batch_errors: errorDetails.slice(0, 50),
      },
    });


    return Response.json({
      ok: true,
      completed: isComplete,
      processed: totalProcessed,
      created: createdCount,
      updated: updatedCount,
      errors: errorDetails.length,
      error_details: errorDetails.slice(0, 20),
      total: processedRecords.length,
      log_id: finalLogId,
      next_offset: isComplete ? null : totalProcessed,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}