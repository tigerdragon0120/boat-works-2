import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { upsertRace, upsertEntry, getSettings, runAndSavePrediction, upsertResultAndVerify, upsertResultOnly } from '../../shared/predictionService.js';
import { buildRaceKey } from '../../shared/raceKey.js';

const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Base44 Entity API の短時間連続書込による Rate limit を吸収する。
// 429/Rate limit のときだけ指数バックオフして再試行する。
async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 6): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message || e?.response?.data?.error || e || '');
      const isRateLimit = /rate\s*limit|too many requests|429/i.test(msg);
      if (!isRateLimit || attempt === maxRetries) throw e;
      await sleep(Math.min(8000, 700 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// =====================================================
// Bファイル データ保存(全会場対応)
// data.venues = [{ venue_code, venue_name, races: [...] }]
// =====================================================
async function saveBFileData(base44: any, data: any, suppressPrediction = false) {
  const sr = base44.asServiceRole.entities;
  const settings = await getSettings(base44);
  const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
  const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));
  let created = 0, updated = 0, skipped = 0, errors = 0;
  const errorDetails: string[] = [];
  const raceDate = str(data.race_date);
  const venues = data.venues || [];

  for (const venue of venues) {
    const venueCode = str(venue.venue_code);
    const venueName = str(venue.venue_name) || venueCode;

    for (const r of venue.races || []) {
      try {
        const raceNumber = num(r.race_number);
        if (!raceNumber) { skipped++; errorDetails.push(`${venueName}: race_number不正`); continue; }
        const raceKey = buildRaceKey(raceDate, venueCode, raceNumber);
        const deadlineTime = str(r.deadline_time);
        const deadline = deadlineTime ? `${raceDate}T${deadlineTime}:00+09:00` : undefined;
        const raceData: any = {
          race_key: raceKey,
          race_date: raceDate,
          venue_code: venueCode,
          venue: venueName || undefined,
          venue_name: venueName || undefined,
          race_number: raceNumber,
          race_name: str(r.race_name) || undefined,
          race_type: str(r.race_type) || undefined,
          grade: str(r.grade) || undefined,
          deadline,
          status: 'scheduled',
          sync_source: 'txt_b_file',
        };
        const race = await withRateLimitRetry(() => upsertRace(base44, raceData));
        if (!race?.id) {
          throw new Error('Race保存後にidを取得できませんでした');
        }
        // Race 1件 + Entry 6件を連打しない。Race保存直後にも待機する。
        await sleep(450);
        const entryDocs = [];
        for (const e of r.entries || []) {
          const bn = num(e.boat_number);
          if (!bn || bn < 1 || bn > 6) { skipped++; continue; }
          const entryData: any = {
            race_id: race.id,
            race_key: raceKey,
            race_date: raceDate,
            venue_code: venueCode,
            race_number: raceNumber,
            boat_number: bn,
            player_name: str(e.player_name),
            racer_name: str(e.player_name),
            register_number: str(e.registration_number),
            registration_number: str(e.registration_number),
            player_class: str(e.player_class) || undefined,
            grade_class: str(e.player_class) || undefined,
            motor_number: num(e.motor_number) || undefined,
            boat_number_id: str(e.boat_number_id) || undefined,
            national_win_rate: num(e.national_win_rate),
            local_win_rate: num(e.local_win_rate),
            national_f2_rate: num(e.national_2rate),
            national_2rate: num(e.national_2rate),
            local_f2_rate: num(e.local_2rate),
            local_2rate: num(e.local_2rate),
            is_absent: false,
            is_scratched: false,
          };
          const saved = await withRateLimitRetry(() => upsertEntry(base44, entryData));
          if (saved) entryDocs.push(saved);
          updated++;
          // 艇ごとのupsertは内部でfilter+update/createを行うため間隔を空ける。
          await sleep(300);
        }
        // 大量TXT取込中は予想生成を抑止して保存完走を優先する。
        // 予想は取込完了後に別処理で生成できる。
        if (!suppressPrediction && entryDocs.length >= 6) {
          try { await runAndSavePrediction(base44, race, entryDocs, settings, 'PRE', {}, profileByReg, rollingByReg); }
          catch (e: any) { errorDetails.push(`${venueName} R${raceNumber}: 予想生成失敗 ${e.message}`); }
        }
        // 1Rあたり Race + RaceEntry 6艇で複数APIアクセスが発生するため、
        // 次レース開始前に少し間隔を空けてレート制限を回避する。
        await sleep(350);
      } catch (e: any) {
        errors++;
        errorDetails.push(`${venueName} R${r.race_number}: ${e.message}`);
      }
    }
  }

  const total = venues.reduce((a: number, v: any) => a + (v.races || []).length, 0);
  return { created, updated, skipped, errors, errorDetails, total };
}

// =====================================================
// Kファイル データ保存(全会場対応)
// data.venues = [{ venue_code, venue_name, results: [...] }]
// =====================================================
async function saveKFileData(base44: any, data: any, fastHistorical = true) {
  const sr = base44.asServiceRole.entities;
  let created = 0, updated = 0, skipped = 0, errors = 0;
  const errorDetails: string[] = [];
  const raceDate = str(data.race_date);
  const venues = data.venues || [];

  // K取込は1艇ごとのfilter→create/updateを廃止し、日付単位で既存データを先読みする。
  const [existingRaces, existingEntries, existingHistories] = await Promise.all([
    sr.Race.filter({ race_date: raceDate }, 'race_number', 500).catch(() => []),
    sr.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []),
    sr.RacerRaceHistory.filter({ race_date: raceDate }, 'race_number', 5000).catch(() => []),
  ]);
  const raceByKey = new Map((existingRaces || []).map((x: any) => [x.race_key, x]));
  const entryByKey = new Map((existingEntries || []).map((x: any) => [`${x.race_key || x.race_id}_${Number(x.boat_number)}`, x]));
  const histByKey = new Map((existingHistories || []).map((x: any) => [`${x.registration_number}_${x.venue_code}_${Number(x.race_number)}`, x]));
  const histCreates: any[] = [];
  const histUpdates: any[] = [];
  const entryUpdates: any[] = [];

  for (const venue of venues) {
    const venueCode = str(venue.venue_code);
    const venueName = str(venue.venue_name) || venueCode;
    for (const r of venue.results || []) {
      try {
        const raceNumber = num(r.race_number);
        if (!raceNumber) { skipped++; continue; }
        const raceKey = buildRaceKey(raceDate, venueCode, raceNumber);
        let race: any = raceByKey.get(raceKey);
        if (!race) {
          race = await withRateLimitRetry(() => sr.Race.create({
            race_key: raceKey, race_date: raceDate, venue_code: venueCode,
            venue: venueName || undefined, venue_name: venueName || undefined,
            race_number: raceNumber, race_name: str(r.race_name) || undefined,
            status: 'finished', sync_source: 'txt_k_file',
          }));
          raceByKey.set(raceKey, race);
          created++;
        }

        const resultTrifecta = str(r.result_trifecta);
        const orderedEntries = [...(r.entries || [])].sort((a: any, b: any) => (num(a.finish_order) || 99) - (num(b.finish_order) || 99));
        const finishOrder = orderedEntries.map((e: any) => e.boat_number);
        if (resultTrifecta) {
          const saver = fastHistorical ? upsertResultOnly : upsertResultAndVerify;
          await withRateLimitRetry(() => saver(base44, race, {
            result_trifecta: resultTrifecta, finish_order: finishOrder, payout: num(r.payout) || 0,
          }));
          updated++;
        } else skipped++;

        for (const e of r.entries || []) {
          const bn = num(e.boat_number);
          if (!bn) continue;
          const existingEntry = entryByKey.get(`${raceKey}_${bn}`) || entryByKey.get(`${race.id}_${bn}`);
          if (existingEntry) {
            const patch: any = { id: existingEntry.id };
            if (num(e.exhibition_time) != null) patch.exhibition_time = num(e.exhibition_time);
            if (e.is_absent) { patch.is_absent = true; patch.is_scratched = true; }
            if (Object.keys(patch).length > 1) entryUpdates.push(patch);
          }

          const reg = str(e.registration_number);
          if (!reg) continue;
          const histDoc: any = {
            registration_number: reg, race_date: raceDate, venue_code: venueCode, race_number: raceNumber,
            boat_number: bn, course: num(e.course) || undefined, finish_order: num(e.finish_order) || undefined,
            st: num(e.st) ?? undefined, motor_number: num(e.motor_number) || undefined,
            is_absent: !!e.is_absent, is_disqualified: !!e.is_disqualified,
            finish_status: str(e.finish_status) || undefined,
          };
          const hk = `${reg}_${venueCode}_${raceNumber}`;
          const old = histByKey.get(hk);
          if (old) histUpdates.push({ id: old.id, ...histDoc });
          else { histCreates.push(histDoc); histByKey.set(hk, histDoc); }
        }
      } catch (e: any) {
        errors++;
        errorDetails.push(`${venueName} R${r.race_number}: ${e.message}`);
      }
    }
  }

  // まとめ書き。Base44 API呼び出し数を大幅に削減する。
  for (let i = 0; i < histCreates.length; i += 100) {
    await withRateLimitRetry(() => sr.RacerRaceHistory.bulkCreate(histCreates.slice(i, i + 100)));
  }
  for (let i = 0; i < histUpdates.length; i += 100) {
    await withRateLimitRetry(() => sr.RacerRaceHistory.bulkUpdate(histUpdates.slice(i, i + 100)));
  }
  for (let i = 0; i < entryUpdates.length; i += 100) {
    await withRateLimitRetry(() => sr.RaceEntry.bulkUpdate(entryUpdates.slice(i, i + 100)));
  }

  const total = venues.reduce((a: number, v: any) => a + (v.results || []).length, 0);
  return { created, updated, skipped, errors, errorDetails, total, history_created: histCreates.length, history_updated: histUpdates.length };
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json();
    const { data_type, parsed_data, file_name, suppress_prediction_during_import = false } = body;
    if (!data_type || !parsed_data) {
      return Response.json({ error: 'data_type and parsed_data are required' }, { status: 400 });
    }

    const sr = base44.asServiceRole.entities;
    const now = new Date().toISOString();
    const importType = data_type === 'B' ? 'race_card' : 'past_results';

    // 取込ログ開始
    const logRecord = await sr.DataImportLog.create({
      import_type: importType,
      file_name: str(file_name) || 'unknown',
      imported_at: now,
      status: 'running',
      total_rows: 0, created_count: 0, updated_count: 0, skipped_count: 0, error_count: 0,
    });

    try {
      let result;
      if (data_type === 'B') {
        result = await saveBFileData(base44, parsed_data, !!suppress_prediction_during_import);
      } else if (data_type === 'K') {
        result = await saveKFileData(base44, parsed_data);
      } else {
        await sr.DataImportLog.update(logRecord.id, { status: 'failed', error_message: '不明なdata_type' });
        return Response.json({ ok: false, error: '不明なdata_type' });
      }

      const status = result.errors === 0 ? 'success' : (result.updated > 0 || result.created > 0 ? 'partial' : 'failed');
      await sr.DataImportLog.update(logRecord.id, {
        status,
        total_rows: result.total,
        created_count: result.created,
        updated_count: result.updated,
        skipped_count: result.skipped,
        error_count: result.errors,
        error_message: result.errorDetails?.slice(0, 20).join('; ') || undefined,
      });

      return Response.json({
        ok: true, data_type, ...result,
        log_id: logRecord.id,
        message: `取込完了: 新規${result.created} / 更新${result.updated} / スキップ${result.skipped} / エラー${result.errors}`,
      });
    } catch (e: any) {
      await sr.DataImportLog.update(logRecord.id, { status: 'failed', error_message: e.message });
      return Response.json({ ok: false, error: e.message, log_id: logRecord.id });
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}