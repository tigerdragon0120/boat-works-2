import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { upsertResultAndVerify, getSettings, runAndSavePrediction } from '../../shared/predictionService.js';
import { buildRaceKey } from '../../shared/raceKey.js';
import { fetchHtml, parseBeforeInfo, parseResult, parseOdds3t, parseRaceCard, buildUrl, VENUE_MAP } from '../../shared/boatraceOfficialParser.js';

const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');

// === エラー繰り返し防止: 直近5分以内の同レース同fetch_typeの失敗をスキップ ===
async function shouldSkipRecentFailure(base44: any, fetchType: string, raceDate: string, venueCode: string, raceNumber: number): Promise<boolean> {
  const sr = base44.asServiceRole.entities;
  try {
    const logs = await sr.OnlineFetchLog.filter(
      { fetch_type: fetchType, race_date: raceDate, venue_code: venueCode, race_number: raceNumber },
      '-fetched_at', 3
    );
    if (!logs || !logs.length) return false;
    const last = logs[0];
    if (last.status === 'failed' || last.status === 'no_data') {
      const fetchedAt = new Date(last.fetched_at).getTime();
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      if (fetchedAt > fiveMinAgo) return true;
    }
    return false;
  } catch { return false; }
}

// === 節間成績処理(racelist → RaceEntry更新) ===
async function processSection(base44: any, race: any, parsed: any) {
  const sr = base44.asServiceRole.entities;
  const raceData = parsed?.venues?.[0]?.races?.[0];
  const parsedEntries = raceData?.entries || [];
  const existingEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
  const entryByBoat = new Map(existingEntries.map((e: any) => [Number(e.boat_number), e]));
  let updated = 0;

  for (const pe of parsedEntries) {
    const bn = num(pe.boat_number);
    const existing = entryByBoat.get(bn);
    if (!bn || !existing) continue;
    const update: any = {};
    if (pe.section_points != null) update.section_points = pe.section_points;
    if (pe.section_finishes) update.section_finishes = pe.section_finishes;
    if (pe.section_st != null) update.section_st = pe.section_st;
    if (pe.section_momentum != null) update.section_momentum = pe.section_momentum;
    if (Object.keys(update).length) {
      await sr.RaceEntry.update(existing.id, update);
      updated++;
    }
  }
  return { entries_updated: updated };
}

// === 展示データ処理(決定論的パーサー出力 → RaceEntry更新) ===
// FINAL予想は展示取得のみでは生成しない。オッズ取得後に生成する。
async function processExhibition(base44: any, race: any, parsed: any) {
  const sr = base44.asServiceRole.entities;
  const parsedEntries = parsed.entries || [];
  const existingEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
  const entryByBoat = new Map(existingEntries.map((e: any) => [e.boat_number, e]));

  let updated = 0;
  for (const pe of parsedEntries) {
    const bn = num(pe.boat_number);
    if (!bn) continue;
    const existing = entryByBoat.get(bn);
    if (!existing) continue;

    // 保護付き更新: nullで既存値を上書きしない
    const update: any = {};
    if (pe.exhibition_time != null) update.exhibition_time = pe.exhibition_time;
    if (pe.exhibition_st != null) {
      update.exhibition_st = pe.exhibition_st;
      update.exhibition_st_raw = pe.exhibition_st_raw ?? pe.exhibition_st;
    }
    if (pe.exhibition_course != null) update.exhibition_course = pe.exhibition_course;
    if (pe.tilt != null) update.tilt = pe.tilt;
    if (pe.is_absent) { update.is_absent = true; update.is_scratched = true; }

    if (Object.keys(update).length) {
      await sr.RaceEntry.update(existing.id, update);
      updated++;
    }
  }

  // Race展示取得済フラグ + 天候情報更新
  // 実展示値(展示タイム+ST)が6艇揃った場合のみ exhibition_ready=true
  const realCount = parsed.real_exhibition_count || 0;
  const raceUpdate: any = {};
  if (realCount >= 6) raceUpdate.exhibition_ready = true;
  if (parsed.weather) raceUpdate.weather = parsed.weather;
  if (parsed.wind_speed != null) raceUpdate.wind_speed = parsed.wind_speed;
  if (parsed.water_temp != null) raceUpdate.water_temp = parsed.water_temp;
  if (parsed.air_temp != null) raceUpdate.air_temp = parsed.air_temp;
  if (parsed.wave_height != null) raceUpdate.wave_height = parsed.wave_height;
  await sr.Race.update(race.id, raceUpdate);

  return { entries_updated: updated, exhibition_ready: realCount >= 6, real_exhibition_count: realCount };
}

// === オッズデータ処理(決定論的パーサー出力 → OddsSnapshot保存 + FINAL生成) ===
// オッズ取得後に展示データが揃っていればFINAL予想を生成する。
async function processOdds(base44: any, race: any, parsed: any) {
  const sr = base44.asServiceRole.entities;
  const oddsMap = parsed || {};
  const oddsCount = Object.keys(oddsMap).length;
  if (oddsCount === 0) return { odds_count: 0 };

  // OddsSnapshot保存
  await sr.OddsSnapshot.create({
    race_id: race.id, stage: 'FINAL', odds_map: oddsMap,
    captured_at: new Date().toISOString(),
  });

  // TrifectaPredictionのactual_odds更新(既存FINALがある場合)
  // bulkUpdateで一括更新し、DB API呼び出しを削減(レート制限回避)
  const preds = await sr.RacePrediction.filter({ race_id: race.id, stage: 'FINAL' }, '-computed_at', 1);
  if (preds && preds[0]) {
    const trifectas = await sr.TrifectaPrediction.filter({ prediction_id: preds[0].id }, 'rank', 120);
    const updates = trifectas.map((t: any) => {
      const actualOdds = oddsMap[t.combination] || null;
      const ev = actualOdds ? Math.round(t.probability * actualOdds * 10) / 10 : null;
      return { id: t.id, actual_odds: actualOdds, current_odds: actualOdds, expected_value: ev };
    });
    if (updates.length) await sr.TrifectaPrediction.bulkUpdate(updates);
  }

  // FINAL生成条件: 展示データあり + 6艇 + オッズ120組(全組)あり
  // 展示取得済みでFINAL未生成の場合、FINAL予想を生成
  if (race.exhibition_ready && !race.has_final && oddsCount >= 120) {
    const entries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
    if (entries.length >= 6) {
      try {
        const settings = await getSettings(base44);
        const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
        const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
        const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
        const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));
        await runAndSavePrediction(base44, race, entries, settings, 'FINAL', oddsMap, profileByReg, rollingByReg);
        return { odds_count: oddsCount, final_generated: true };
      } catch (e: any) {
        return { odds_count: oddsCount, final_error: e.message };
      }
    }
  }

  return { odds_count: oddsCount };
}

// === レース結果処理(決定論的パーサー出力 → RaceResult + RacerRaceHistory) ===
async function processResult(base44: any, race: any, parsed: any) {
  const sr = base44.asServiceRole.entities;
  const result = parsed.data?.venues?.[0]?.results?.[0];
  if (!result) throw new Error('結果データが見つかりません');

  const resultTrifecta = str(result.result_trifecta);
  const finishOrder = result.finish_order || [];
  const payout = num(result.payout) || 0;
  if (!resultTrifecta) throw new Error('3連単結果が見つかりません');

  await upsertResultAndVerify(base44, race, {
    result_trifecta: resultTrifecta,
    finish_order: finishOrder,
    payout,
  });

  // RacerRaceHistory蓄積
  const raceEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
  const entryByBoat = new Map(raceEntries.map((e: any) => [e.boat_number, e]));
  const existingHists = await sr.RacerRaceHistory.filter(
    { race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number },
    'race_number', 10
  ).catch(() => []);
  const histByReg = new Map(existingHists.map((h: any) => [h.registration_number, h]));

  const histCreates: any[] = [];
  const histUpdates: any[] = [];

  for (const pe of result.entries || []) {
    const bn = num(pe.boat_number);
    if (!bn) continue;
    const re = entryByBoat.get(bn);
    const reg = str(re?.registration_number || re?.register_number || pe.registration_number);
    if (!reg || !/^\d{4}$/.test(reg)) continue;

    const histDoc: any = {
      registration_number: reg,
      race_date: race.race_date,
      venue_code: race.venue_code,
      race_number: race.race_number,
      boat_number: bn,
      finish_order: num(pe.finish_order) || undefined,
      st: num(pe.st) ?? undefined,
      winning_method: str(pe.winning_method) || undefined,
      race_time: str(pe.race_time) || undefined,
    };
    const old = histByReg.get(reg);
    if (old) histUpdates.push({ id: old.id, ...histDoc });
    else histCreates.push(histDoc);
  }

  if (histCreates.length) await sr.RacerRaceHistory.bulkCreate(histCreates).catch(() => {});
  if (histUpdates.length) await sr.RacerRaceHistory.bulkUpdate(histUpdates).catch(() => {});

  // 天候情報でRace更新
  if (result.weather || result.wind_speed != null) {
    const raceUpdate: any = {};
    if (result.weather) raceUpdate.weather = result.weather;
    if (result.wind_speed != null) raceUpdate.wind_speed = result.wind_speed;
    if (result.water_temp != null) raceUpdate.water_temp = result.water_temp;
    if (result.air_temp != null) raceUpdate.air_temp = result.air_temp;
    if (result.wave_height != null) raceUpdate.wave_height = result.wave_height;
    await sr.Race.update(race.id, raceUpdate).catch(() => {});
  }

  return { result_trifecta: resultTrifecta, payout };
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json();
    const { fetch_type, race_date, venue_code, race_number, race_id } = body;
    if (!fetch_type || !race_date || !venue_code || !race_number) {
      return Response.json({ error: 'fetch_type, race_date, venue_code, race_number are required' }, { status: 400 });
    }

    const sr = base44.asServiceRole.entities;
    const now = new Date().toISOString();
    const vc = str(venue_code);
    const rn = num(race_number);

    // エラー繰り返し防止
    const skip = await shouldSkipRecentFailure(base44, fetch_type, race_date, vc, rn);
    if (skip) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_date, venue_code: vc, race_number: rn,
        status: 'skipped', fetched_at: now, error_message: '直近5分以内に失敗のためスキップ',
      });
      return Response.json({ ok: false, status: 'skipped', message: '直近5分以内に失敗のためスキップしました' });
    }

    // Race検索
    const raceKey = buildRaceKey(race_date, vc, rn);
    let race = null;
    if (race_id) {
      race = await sr.Race.get(race_id).catch(() => null);
    }
    if (!race) {
      const races = await sr.Race.filter({ race_key: raceKey }, '-updated_date', 1);
      race = races && races[0] ? races[0] : null;
    }
    if (!race) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_date, venue_code: vc, race_number: rn,
        status: 'failed', fetched_at: now, error_message: '対象Raceが見つかりません',
      });
      return Response.json({ ok: false, status: 'failed', message: '対象Raceが見つかりません' });
    }

    // URL構築(正しいURL形式: jcd パラメータ使用)
    const url = buildUrl(fetch_type === 'exhibition' ? 'beforeinfo' : fetch_type === 'odds' ? 'odds3t' : fetch_type === 'section' ? 'racelist' : 'raceresult', race_date, vc, rn);

    // HTML取得(決定論的パーサー使用、InvokeLLM不使用)
    const fetchRes = await fetchHtml(url);
    if (!fetchRes.ok) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: vc, race_number: rn,
        status: fetchRes.status === 0 ? 'failed' : 'no_data', fetched_at: now,
        http_status: fetchRes.status, error_message: fetchRes.error || `HTTP ${fetchRes.status}`,
      });
      return Response.json({ ok: false, status: fetchRes.status === 0 ? 'failed' : 'no_data', message: fetchRes.error || `HTTP ${fetchRes.status}` });
    }

    // 決定論的HTML解析(InvokeLLM不使用)
    let parsed: any;
    try {
      if (fetch_type === 'section') {
        const venueName = race.venue_name || race.venue || VENUE_MAP[vc] || vc;
        const p = parseRaceCard(fetchRes.html, race_date, vc, venueName, rn);
        if (!p.ok) throw new Error((p.errors || []).join('; ') || '節間成績解析失敗');
        parsed = p.data;
      } else if (fetch_type === 'exhibition') {
        const p = parseBeforeInfo(fetchRes.html);
        if (!p.ok) throw new Error(p.errors.join('; ') || '展示データ解析失敗');
        parsed = p.data;
      } else if (fetch_type === 'odds') {
        parsed = parseOdds3t(fetchRes.html);
      } else if (fetch_type === 'result') {
        const venueName = race.venue_name || race.venue || VENUE_MAP[vc] || vc;
        const p = parseResult(fetchRes.html, race_date, vc, venueName);
        if (!p.ok) throw new Error((p.errors || []).join('; ') || '結果解析失敗');
        parsed = p;
      } else {
        throw new Error(`不明なfetch_type: ${fetch_type}`);
      }
    } catch (e: any) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: vc, race_number: rn,
        status: 'failed', fetched_at: now, http_status: 200, error_message: 'HTML解析失敗: ' + e.message,
      });
      return Response.json({ ok: false, status: 'failed', message: 'HTML解析失敗: ' + e.message });
    }

    // データ処理
    try {
      let resultData: any = {};
      switch (fetch_type) {
        case 'section':
          resultData = await processSection(base44, race, parsed);
          break;
        case 'exhibition':
          resultData = await processExhibition(base44, race, parsed);
          break;
        case 'odds':
          resultData = await processOdds(base44, race, parsed);
          break;
        case 'result':
          resultData = await processResult(base44, race, parsed);
          break;
      }

      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: vc, race_number: rn,
        status: 'success', fetched_at: now, http_status: 200,
      });

      return Response.json({
        ok: true, status: 'success', fetch_type, race_id: race.id,
        ...resultData,
        message: `${fetch_type}データ取得完了(決定論的解析)`,
      });
    } catch (e: any) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: vc, race_number: rn,
        status: 'failed', fetched_at: now, http_status: 200, error_message: 'データ処理失敗: ' + e.message,
      });
      return Response.json({ ok: false, status: 'failed', message: 'データ処理失敗: ' + e.message });
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}