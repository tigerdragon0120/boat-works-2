import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { waitUntil } from 'base44:runtime';
import { upsertRace, upsertEntry, getSettings, runAndSavePrediction } from '../../shared/predictionService.js';
import { buildRaceKey } from '../../shared/raceKey.js';

const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');

// === 取込タイプ別の抽出スキーマ ===
function getSchemaForImportType(importType: string): object {
  switch (importType) {
    case 'race_card':
      return {
        type: 'object',
        properties: {
          races: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                race_date: { type: 'string', description: 'YYYY-MM-DD' },
                venue_code: { type: 'string', description: '場コード 2桁' },
                venue_name: { type: 'string' },
                race_number: { type: 'number' },
                race_name: { type: 'string' },
                grade: { type: 'string' },
                deadline: { type: 'string' },
                series_day: { type: 'number' },
                is_final_day: { type: 'boolean' },
                entries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      boat_number: { type: 'number' },
                      player_name: { type: 'string' },
                      registration_number: { type: 'string' },
                      player_class: { type: 'string' },
                      motor_number: { type: 'number' },
                      boat_number_id: { type: 'string' },
                      national_win_rate: { type: 'number' },
                      local_win_rate: { type: 'number' },
                      national_f2_rate: { type: 'number' },
                      national_f3_rate: { type: 'number' },
                      local_f2_rate: { type: 'number' },
                      local_f3_rate: { type: 'number' },
                      avg_st: { type: 'number' },
                      f_count: { type: 'number' },
                      l_count: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      };
    case 'racer_data':
      return {
        type: 'object',
        properties: {
          racers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                registration_number: { type: 'string' },
                racer_name: { type: 'string' },
                player_class: { type: 'string' },
                branch: { type: 'number' },
                branch_name: { type: 'string' },
                birth_date: { type: 'string' },
                age: { type: 'number' },
                weight: { type: 'number' },
                national_win_rate: { type: 'number' },
                national_2rate: { type: 'number' },
                national_3rate: { type: 'number' },
                avg_st: { type: 'number' },
                f_count: { type: 'number' },
                l_count: { type: 'number' },
              },
            },
          },
        },
      };
    case 'past_results':
      return {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                race_date: { type: 'string' },
                venue_code: { type: 'string' },
                race_number: { type: 'number' },
                result_trifecta: { type: 'string' },
                finish_order: { type: 'array', items: { type: 'number' } },
                payout: { type: 'number' },
                entries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      boat_number: { type: 'number' },
                      registration_number: { type: 'string' },
                      course: { type: 'number' },
                      finish_order: { type: 'number' },
                      st: { type: 'number' },
                      winning_method: { type: 'string' },
                      motor_number: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      };
    case 'motor_boat':
      return {
        type: 'object',
        properties: {
          motors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                venue_code: { type: 'string' },
                motor_number: { type: 'number' },
                win_rate: { type: 'number' },
                top2_rate: { type: 'number' },
                top3_rate: { type: 'number' },
                sample_races: { type: 'number' },
              },
            },
          },
          boats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                venue_code: { type: 'string' },
                boat_number_id: { type: 'string' },
                win_rate: { type: 'number' },
                top2_rate: { type: 'number' },
                top3_rate: { type: 'number' },
                sample_races: { type: 'number' },
              },
            },
          },
        },
      };
    default:
      return { type: 'object', properties: { data: { type: 'object' } } };
  }
}

// === 出走表取込処理 ===
async function processRaceCard(base44: any, races: any[]) {
  const sr = base44.asServiceRole.entities;
  const settings = await getSettings(base44);
  // プロファイル一括取得(予想生成用)
  const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
  let created = 0, updated = 0, skipped = 0, errors = 0;

  for (const r of races) {
    try {
      const raceDate = str(r.race_date);
      const venueCode = str(r.venue_code);
      const raceNumber = num(r.race_number);
      if (!raceDate || !venueCode || !raceNumber) { skipped++; continue; }
      const raceKey = buildRaceKey(raceDate, venueCode, raceNumber);
      const raceData: any = {
        race_key: raceKey,
        race_date: raceDate,
        venue_code: venueCode,
        venue_name: str(r.venue_name) || undefined,
        venue: str(r.venue_name) || undefined,
        race_number: raceNumber,
        race_name: str(r.race_name) || undefined,
        grade: str(r.grade) || undefined,
        deadline: str(r.deadline) || undefined,
        series_day: num(r.series_day) || undefined,
        status: 'scheduled',
        sync_source: 'file_import',
      };
      const race = await upsertRace(base44, raceData);
      const entries = r.entries || [];
      const entryDocs = [];
      for (const e of entries) {
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
          national_f2_rate: num(e.national_f2_rate),
          national_f3_rate: num(e.national_f3_rate),
          national_2rate: num(e.national_f2_rate),
          national_3rate: num(e.national_f3_rate),
          local_f2_rate: num(e.local_f2_rate),
          local_f3_rate: num(e.local_f3_rate),
          local_2rate: num(e.local_f2_rate),
          local_3rate: num(e.local_f3_rate),
          avg_st: num(e.avg_st),
          f_count: num(e.f_count) || 0,
          l_count: num(e.l_count) || 0,
          is_absent: false,
          is_scratched: false,
        };
        const saved = await upsertEntry(base44, entryData);
        entryDocs.push(saved);
        updated++;
      }
      // 6艇揃いならPRE予想生成
      if (entryDocs.length >= 6) {
        try {
          await runAndSavePrediction(base44, race, entryDocs, settings, 'PRE', {}, profileByReg);
        } catch {}
      }
    } catch (e: any) {
      errors++;
    }
  }
  return { created, updated, skipped, errors, total: races.length };
}

// === 選手データ取込処理 ===
async function processRacerData(base44: any, racers: any[]) {
  const sr = base44.asServiceRole.entities;
  let created = 0, updated = 0, skipped = 0, errors = 0;
  const now = new Date().toISOString();
  for (const r of racers) {
    try {
      const reg = str(r.registration_number);
      if (!reg) { skipped++; continue; }
      const existing = await sr.RacerProfile.filter({ registration_number: reg }, 'registration_number', 1);
      const doc: any = {
        registration_number: reg,
        racer_name: str(r.racer_name),
        player_name: str(r.racer_name),
        player_class: str(r.player_class) || undefined,
        grade_class: str(r.player_class) || undefined,
        branch: num(r.branch) || undefined,
        branch_name: str(r.branch_name) || undefined,
        birth_date: str(r.birth_date) || undefined,
        age: num(r.age) || undefined,
        weight: num(r.weight) || undefined,
        national_win_rate: num(r.national_win_rate),
        national_2rate: num(r.national_2rate),
        national_3rate: num(r.national_3rate),
        avg_st: num(r.avg_st),
        f_count: num(r.f_count) || 0,
        l_count: num(r.l_count) || 0,
        updated_at: now,
      };
      if (existing && existing[0]) {
        await sr.RacerProfile.update(existing[0].id, doc);
        updated++;
      } else {
        await sr.RacerProfile.create(doc);
        created++;
      }
    } catch (e: any) {
      errors++;
    }
  }
  return { created, updated, skipped, errors, total: racers.length };
}

// === 過去成績取込処理 ===
async function processPastResults(base44: any, results: any[]) {
  const sr = base44.asServiceRole.entities;
  let created = 0, updated = 0, skipped = 0, errors = 0;
  for (const r of results) {
    try {
      const raceDate = str(r.race_date);
      const venueCode = str(r.venue_code);
      const raceNumber = num(r.race_number);
      if (!raceDate || !venueCode || !raceNumber) { skipped++; continue; }
      const raceKey = buildRaceKey(raceDate, venueCode, raceNumber);
      // Race存在確認(なければ作成)
      let race = null;
      const existingRaces = await sr.Race.filter({ race_key: raceKey }, '-updated_date', 1).catch(() => []);
      if (existingRaces && existingRaces[0]) {
        race = existingRaces[0];
      } else {
        race = await sr.Race.create({
          race_key: raceKey, race_date: raceDate, venue_code: venueCode,
          race_number: raceNumber, status: 'finished', sync_source: 'file_import',
        });
      }
      // RaceResult upsert
      const existingResult = await sr.RaceResult.filter({ race_id: race.id }, '-finished_at', 1).catch(() => []);
      const resultDoc = {
        race_id: race.id,
        result_trifecta: str(r.result_trifecta),
        finish_order: r.finish_order || [],
        payout: num(r.payout) || 0,
        is_finished: true,
        finished_at: new Date(raceDate).toISOString(),
      };
      if (existingResult && existingResult[0]) {
        await sr.RaceResult.update(existingResult[0].id, resultDoc);
        updated++;
      } else {
        await sr.RaceResult.create(resultDoc);
        created++;
      }
      await sr.Race.update(race.id, { status: 'finished' });
      // RacerRaceHistory蓄積
      const entries = r.entries || [];
      for (const e of entries) {
        const reg = str(e.registration_number);
        if (!reg) continue;
        const histKey = { registration_number: reg, race_date: raceDate, venue_code: venueCode, race_number: raceNumber };
        const existingHist = await sr.RacerRaceHistory.filter(histKey, '-created_date', 1).catch(() => []);
        const histDoc = {
          registration_number: reg,
          race_date: raceDate,
          venue_code: venueCode,
          race_number: raceNumber,
          boat_number: num(e.boat_number) || undefined,
          course: num(e.course) || undefined,
          finish_order: num(e.finish_order) || undefined,
          st: num(e.st) || undefined,
          winning_method: str(e.winning_method) || undefined,
          motor_number: num(e.motor_number) || undefined,
          is_absent: false,
        };
        if (existingHist && existingHist[0]) {
          await sr.RacerRaceHistory.update(existingHist[0].id, histDoc);
        } else {
          await sr.RacerRaceHistory.create(histDoc);
        }
      }
    } catch (e: any) {
      errors++;
    }
  }
  return { created, updated, skipped, errors, total: results.length };
}

// === モーター/ボートデータ取込処理 ===
async function processMotorBoat(base44: any, data: any) {
  const sr = base44.asServiceRole.entities;
  let created = 0, updated = 0, skipped = 0, errors = 0;
  const now = new Date().toISOString();
  const motors = data?.motors || [];
  for (const m of motors) {
    try {
      const vc = str(m.venue_code);
      const mn = num(m.motor_number);
      if (!vc || !mn) { skipped++; continue; }
      const existing = await sr.MotorDatabase.filter({ venue_code: vc, motor_number: mn }, '-updated_at', 1).catch(() => []);
      const doc = {
        venue_code: vc, motor_number: mn,
        win_rate: num(m.win_rate), top2_rate: num(m.top2_rate), top3_rate: num(m.top3_rate),
        sample_races: num(m.sample_races) || 0,
        updated_at: now,
      };
      if (existing && existing[0]) { await sr.MotorDatabase.update(existing[0].id, doc); updated++; }
      else { await sr.MotorDatabase.create(doc); created++; }
    } catch (e: any) { errors++; }
  }
  return { created, updated, skipped, errors, total: motors.length };
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json();
    const { import_type, file_url, file_name } = body;
    if (!import_type || !file_url) {
      return Response.json({ error: 'import_type and file_url are required' }, { status: 400 });
    }

    const sr = base44.asServiceRole.entities;
    const now = new Date().toISOString();

    // 取込ログ開始
    const logRecord = await sr.DataImportLog.create({
      import_type, file_name: str(file_name) || 'unknown', file_url,
      imported_at: now, status: 'running',
      total_rows: 0, created_count: 0, updated_count: 0, skipped_count: 0, error_count: 0,
    });

    try {
      // ファイルからデータ抽出
      const schema = getSchemaForImportType(import_type);
      const extracted = await base44.asServiceRole.integrations.Core.ExtractDataFromUploadedFile({
        file_url,
        json_schema: schema,
      });

      if (extracted.status !== 'success' || !extracted.output) {
        await sr.DataImportLog.update(logRecord.id, {
          status: 'failed', error_message: extracted.details || 'Extraction returned no output',
        });
        return Response.json({ ok: false, error: 'Extraction failed', details: extracted.details });
      }

      const data = extracted.output;
      let result;

      switch (import_type) {
        case 'race_card':
          result = await processRaceCard(base44, data.races || []);
          break;
        case 'racer_data':
          result = await processRacerData(base44, data.racers || []);
          break;
        case 'past_results':
          result = await processPastResults(base44, data.results || []);
          break;
        case 'motor_boat':
          result = await processMotorBoat(base44, data);
          break;
        default:
          result = { created: 0, updated: 0, skipped: 0, errors: 0, total: 0 };
      }

      const status = result.errors === 0 ? 'success' : (result.updated > 0 || result.created > 0 ? 'partial' : 'failed');
      await sr.DataImportLog.update(logRecord.id, {
        status,
        total_rows: result.total,
        created_count: result.created,
        updated_count: result.updated,
        skipped_count: result.skipped,
        error_count: result.errors,
      });

      // 出走表取込後: 枠番過去10走の事前計算をバックグラウンド起動
      if (import_type === 'race_card') {
        waitUntil(base44.functions.invoke('precomputeLanePast10Stats', { mode: 'all' }).catch(() => {}));
      }

      return Response.json({
        ok: true, import_type, ...result,
        log_id: logRecord.id,
        message: `取込完了: 新規${result.created} / 更新${result.updated} / スキップ${result.skipped} / エラー${result.errors}`,
      });
    } catch (e: any) {
      await sr.DataImportLog.update(logRecord.id, {
        status: 'failed', error_message: e.message,
      });
      return Response.json({ ok: false, error: e.message, log_id: logRecord.id });
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}