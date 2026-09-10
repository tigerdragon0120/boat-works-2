import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fetchHtml, parseRaceIndex, parseRaceCard, parseDeadlineTimes, parseResult, parseBeforeInfo, buildUrl, VENUE_MAP } from '../../shared/boatraceOfficialParser.js';
import { upsertRace, upsertEntry, upsertResultAndVerify, runAndSavePrediction, getSettings } from '../../shared/predictionService.js';
import { buildRaceKey } from '../../shared/raceKey.js';

const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Base44 Entity APIのRate limit(429)を指数バックオフで吸収
async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 8): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message || e?.response?.data?.error || e || '');
      const isRateLimit = /rate\s*limit|too many requests|429/i.test(msg);
      if (!isRateLimit || attempt === maxRetries) throw e;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      await sleep(delay + Math.floor(Math.random() * 500));
    }
  }
  throw lastError;
}

// Asia/Tokyo基準で本日日付取得
function getTodayJST(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
function getTomorrowJST(): string {
  const now = new Date();
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  jst.setDate(jst.getDate() + 1);
  return jst.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
function nowJSTTime(): string {
  return new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

// =====================================================
// STEP 1&6: 指定日付の番組表取得・保存
// =====================================================
async function fetchAndSaveRaceCards(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();
  const settings = await getSettings(base44);
  const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
  const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

  // レース指数ページ取得 → 開催場リスト
  const indexUrl = buildUrl('index', raceDate, '', 0);
  const indexRes = await fetchHtml(indexUrl);
  if (!indexRes.ok) {
    errors.push(`レース指数取得失敗: HTTP ${indexRes.status}`);
    return { venues: 0, races: 0, entries: 0, skipped: 0, errors };
  }
  const venues = parseRaceIndex(indexRes.html);
  logs.push(`${raceDate} 開催場${venues.length}場検出`);

  let totalRaces = 0, totalEntries = 0, skippedVenues = 0;

  for (const venue of venues) {
    if (Date.now() - startTime > timeBudgetMs) {
      logs.push(`時間予算到達 — 残り${venues.length - venues.indexOf(venue)}場`);
      break;
    }
    const venueCode = venue.venue_code;
    const venueName = venue.venue_name;

    // DB既存確認: この日付+会場のRace数
    const existingRaces = await sr.Race.filter({ race_date: raceDate, venue_code: venueCode }, 'race_number', 20).catch(() => []);
    const existingRaceNumbers = new Set(existingRaces.map((r: any) => r.race_number));

    // 各レースのRaceEntry数を確認
    const existingEntries = await sr.RaceEntry.filter({ race_date: raceDate, venue_code: venueCode }, 'boat_number', 200).catch(() => []);
    const entryCountByRace = {};
    for (const e of existingEntries) {
      const rn = e.race_number;
      entryCountByRace[rn] = (entryCountByRace[rn] || 0) + 1;
    }

    // 公式racelist上部には1R〜12Rの締切時刻が1行で載っている。
    // 艇が全て揃っている会場でも1ページだけ取得してRaceの締切を補正する。
    // これにより、過去バグで全12Rが1Rと同じ締切になったデータも自動修復する。
    const completeRaces = Object.keys(entryCountByRace).filter((rn) => entryCountByRace[rn] >= 6).length;
    if (existingRaces.length > 0) {
      try {
        const scheduleRes = await fetchHtml(buildUrl('racelist', raceDate, venueCode, 1));
        if (scheduleRes.ok) {
          const deadlineTimes = parseDeadlineTimes(scheduleRes.html);
          if (deadlineTimes.length >= 12) {
            for (const er of existingRaces) {
              const rn = Number(er.race_number);
              const t = deadlineTimes[rn - 1];
              if (!rn || !t) continue;
              const correctDeadline = `${raceDate}T${t}:00+09:00`;
              if (er.deadline !== correctDeadline) {
                await withRateLimitRetry(() => sr.Race.update(er.id, { deadline: correctDeadline }));
                await sleep(120);
              }
            }
          }
        }
      } catch (e: any) {
        errors.push(`${venueName}: 締切時刻補正失敗 ${e.message}`);
      }
    }

    if (completeRaces >= 12) {
      skippedVenues++;
      continue;
    }

    // 不足レースを取得
    for (let rno = 1; rno <= 12; rno++) {
      if (Date.now() - startTime > timeBudgetMs) break;
      if (entryCountByRace[rno] >= 6) continue; // 既に6艇揃っている

      const url = buildUrl('racelist', raceDate, venueCode, rno);
      const res = await fetchHtml(url);
      if (!res.ok) {
        errors.push(`${venueName} R${rno} 番組取得失敗: HTTP ${res.status}`);
        continue;
      }

      const parsed = parseRaceCard(res.html, raceDate, venueCode, venueName, rno);
      if (!parsed.ok || !parsed.data?.venues?.[0]?.races?.[0]) {
        errors.push(`${venueName} R${rno} 番組解析失敗: ${(parsed.errors || []).join('; ')}`);
        continue;
      }

      const race = parsed.data.venues[0].races[0];
      race.race_number = rno;
      const raceKey = buildRaceKey(raceDate, venueCode, rno);
      const deadlineTime = race.deadline_time;
      const deadline = deadlineTime ? `${raceDate}T${deadlineTime}:00+09:00` : undefined;

      const raceData: any = {
        race_key: raceKey,
        race_date: raceDate,
        venue_code: venueCode,
        venue: venueName,
        venue_name: venueName,
        race_number: rno,
        race_name: race.race_name || undefined,
        race_type: race.race_type || undefined,
        deadline,
        status: 'scheduled',
        sync_source: 'online_auto',
      };

      try {
        const savedRace = await withRateLimitRetry(() => upsertRace(base44, raceData));
        if (!savedRace?.id) { errors.push(`${venueName} R${rno}: Race保存失敗`); continue; }
        totalRaces++;
        await sleep(400); // Race保存直後の待機

        let entryCount = 0;
        for (const e of race.entries) {
          const entryData: any = {
            race_id: savedRace.id,
            race_key: raceKey,
            race_date: raceDate,
            venue_code: venueCode,
            race_number: rno,
            boat_number: e.boat_number,
            player_name: e.player_name,
            racer_name: e.player_name,
            register_number: e.registration_number,
            registration_number: e.registration_number,
            player_class: e.player_class || undefined,
            grade_class: e.player_class || undefined,
            national_win_rate: e.national_win_rate,
            local_win_rate: e.local_win_rate,
            national_f2_rate: e.national_2rate,
            national_2rate: e.national_2rate,
            national_f3_rate: e.national_3rate,
            national_3rate: e.national_3rate,
            local_f2_rate: e.local_2rate,
            local_2rate: e.local_2rate,
            local_f3_rate: e.local_3rate,
            local_3rate: e.local_3rate,
            motor_number: e.motor_number || undefined,
            motor_f2_rate: e.motor_2rate,
            motor_2rate: e.motor_2rate,
            motor_f3_rate: e.motor_3rate,
            motor_3rate: e.motor_3rate,
            boat_number_id: e.boat_number_id || undefined,
            boat_f2_rate: e.boat_2rate,
            boat_2rate: e.boat_2rate,
            boat_f3_rate: e.boat_3rate,
            boat_3rate: e.boat_3rate,
            f_count: e.f_count,
            l_count: e.l_count,
            avg_st: e.avg_st,
            is_absent: false,
            is_scratched: false,
          };
          await withRateLimitRetry(() => upsertEntry(base44, entryData));
          entryCount++;
          totalEntries++;
          await sleep(350); // 艇ごとのupsert間隔
        }
        logs.push(`${venueName} R${rno}: ${entryCount}艇保存`);
      } catch (e: any) {
        errors.push(`${venueName} R${rno}: ${e.message}`);
      }
      await sleep(500); // 次レースへの待機
    }
  }

  return { venues: venues.length, races: totalRaces, entries: totalEntries, skipped_venues: skippedVenues, errors };
}

// =====================================================
// STEP 4: 指定日付の結果取得・保存
// =====================================================
async function fetchAndSaveResults(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();

  // 当日全Race取得
  const races = await sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []);
  if (!races.length) {
    return { total: 0, fetched: 0, skipped: 0, errors };
  }

  // 結果済みのRaceを特定
  const existingResults = await sr.RaceResult.filter({}, '-finished_at', 500).catch(() => []);
  const raceIdsWithResult = new Set(existingResults.map((r: any) => r.race_id));

  let fetched = 0, skipped = 0;
  const now = Date.now();

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs) {
      logs.push(`結果取得: 時間予算到達 — 残り${races.length - races.indexOf(race)}R`);
      break;
    }
    if (raceIdsWithResult.has(race.id)) { skipped++; continue; }

    // 締切時刻が過ぎているか確認
    if (race.deadline) {
      const deadlineTime = new Date(race.deadline).getTime();
      if (now < deadlineTime + 5 * 60 * 1000) continue; // 締切5分後以降のみ
    }

    const venueCode = race.venue_code;
    const raceNumber = race.race_number;
    const venueName = race.venue_name || race.venue || VENUE_MAP[venueCode] || venueCode;

    const url = buildUrl('raceresult', raceDate, venueCode, raceNumber);
    const res = await fetchHtml(url);
    if (!res.ok) {
      // 結果未公開の可能性 → スキップ
      continue;
    }

    const parsed = parseResult(res.html, raceDate, venueCode, venueName);
    if (!parsed.ok || !parsed.data?.venues?.[0]?.results?.[0]) {
      continue; // 結果未公開
    }

    const result = parsed.data.venues[0].results[0];
    result.race_number = raceNumber;

    try {
      // RaceResult保存 + 検証
      await upsertResultAndVerify(base44, race, {
        result_trifecta: result.result_trifecta,
        finish_order: result.finish_order || [],
        payout: result.payout || 0,
      });

      // RacerRaceHistory蓄積
      const raceEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
      const entryByBoat = new Map(raceEntries.map((e: any) => [e.boat_number, e]));
      const histCreates: any[] = [];
      const histUpdates: any[] = [];

      // 既存履歴確認
      const existingHists = await sr.RacerRaceHistory.filter({ race_date: raceDate, venue_code: venueCode, race_number: raceNumber }, 'race_number', 10).catch(() => []);
      const histByReg = new Map(existingHists.map((h: any) => [h.registration_number, h]));

      for (const pe of result.entries || []) {
        const bn = num(pe.boat_number);
        if (!bn) continue;
        const re = entryByBoat.get(bn);
        const reg = str(re?.registration_number || re?.register_number || pe.registration_number);
        if (!reg || !/^\d{4}$/.test(reg)) continue;

        const histDoc: any = {
          registration_number: reg,
          race_date: raceDate,
          venue_code: venueCode,
          race_number: raceNumber,
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

      // 天候情報でRace更新(保護付き)
      if (result.weather || result.wind_speed != null || result.water_temp != null) {
        const raceUpdate: any = {};
        if (result.weather) raceUpdate.weather = result.weather;
        if (result.wind_speed != null) raceUpdate.wind_speed = result.wind_speed;
        if (result.water_temp != null) raceUpdate.water_temp = result.water_temp;
        if (result.air_temp != null) raceUpdate.air_temp = result.air_temp;
        if (result.wave_height != null) raceUpdate.wave_height = result.wave_height;
        await sr.Race.update(race.id, raceUpdate).catch(() => {});
      }

      fetched++;
      logs.push(`${venueName} R${raceNumber}: 結果取得成功 ${result.result_trifecta} ¥${result.payout || 0}`);
    } catch (e: any) {
      errors.push(`${venueName} R${raceNumber}: 結果保存失敗 ${e.message}`);
    }
    await sleep(300);
  }

  return { total: races.length, fetched, skipped, errors };
}

// =====================================================
// STEP 8: PRE予想生成
// =====================================================
async function generatePrePredictions(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();
  const settings = await getSettings(base44);
  const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
  const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

  const races = await sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []);
  let generated = 0, skipped = 0;

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs) {
      logs.push(`PRE予想: 時間予算到達 — 残り${races.length - races.indexOf(race)}R`);
      break;
    }
    if (race.has_pre) { skipped++; continue; }

    const entries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
    if (entries.length < 6) continue;

    try {
      await runAndSavePrediction(base44, race, entries, settings, 'PRE', {}, profileByReg, rollingByReg);
      generated++;
      logs.push(`${race.venue_name || race.venue_code} R${race.race_number}: PRE予想生成`);
    } catch (e: any) {
      errors.push(`PRE予想 ${race.venue_code} R${race.race_number}: ${e.message}`);
    }
    await sleep(200);
  }

  return { total: races.length, generated, skipped, errors };
}

// =====================================================
// STEP 2: 展示データ取得
// =====================================================
async function fetchAndSaveExhibition(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();
  const settings = await getSettings(base44);
  const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
  const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

  const races = await sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []);
  let fetched = 0, finalGenerated = 0;

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs) break;
    if (race.exhibition_ready) continue; // 既に展示取得済み
    if (race.status === 'finished' || race.status === 'cancelled') continue;

    // 直前情報は締切の60分前〜締切5分後だけ取得する。
    // 公式beforeinfoページには開催前でも選手情報が存在するため、時間制限なしで解析すると
    // 通常の数値を展示値と誤認し、朝からFINALになることがあった。
    if (!race.deadline) continue;
    const deadlineMs = new Date(race.deadline).getTime();
    if (!Number.isFinite(deadlineMs)) continue;
    const nowMs = Date.now();
    if (nowMs < deadlineMs - 60 * 60 * 1000 || nowMs > deadlineMs + 5 * 60 * 1000) continue;

    const venueCode = race.venue_code;
    const raceNumber = race.race_number;
    const venueName = race.venue_name || race.venue || VENUE_MAP[venueCode] || venueCode;

    const url = buildUrl('beforeinfo', raceDate, venueCode, raceNumber);
    const res = await fetchHtml(url);
    if (!res.ok) continue;

    const parsed = parseBeforeInfo(res.html);
    if (!parsed.ok || !parsed.data?.entries?.length) continue;

    const entries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
    const entryByBoat = new Map(entries.map((e: any) => [e.boat_number, e]));

    let updated = 0;
    for (const pe of parsed.data.entries) {
      const bn = pe.boat_number;
      const existing = entryByBoat.get(bn);
      if (!existing) continue;

      // 保護付き更新: null/空で既存値を上書きしない
      const update: any = {};
      if (pe.exhibition_time != null) update.exhibition_time = pe.exhibition_time;
      if (pe.exhibition_st != null) {
        update.exhibition_st = pe.exhibition_st;
        update.exhibition_st_raw = pe.exhibition_st;
      }
      if (pe.exhibition_course != null) update.exhibition_course = pe.exhibition_course;
      if (pe.tilt != null) update.tilt = pe.tilt;
      if (pe.is_absent) { update.is_absent = true; update.is_scratched = true; }

      if (Object.keys(update).length) {
        await sr.RaceEntry.update(existing.id, update).catch(() => {});
        updated++;
      }
    }

    if (updated > 0) {
      await sr.Race.update(race.id, { exhibition_ready: true }).catch(() => {});
      fetched++;

      // FINAL予想生成は6艇分の実展示値が確認できた場合だけ。
      // 単に6選手がページに存在するだけではFINALにしない。
      const realExhibitionCount = parsed.data.entries.filter((e: any) =>
        e.exhibition_time != null && e.exhibition_time >= 5 && e.exhibition_time <= 9 &&
        e.exhibition_st != null
      ).length;
      if (updated >= 6 && realExhibitionCount >= 6) {
        try {
          const updatedEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6);
          await runAndSavePrediction(base44, race, updatedEntries, settings, 'FINAL', {}, profileByReg, rollingByReg);
          finalGenerated++;
          logs.push(`${venueName} R${raceNumber}: 展示取得+FINAL予想生成`);
        } catch (e: any) {
          logs.push(`${venueName} R${raceNumber}: 展示取得済み(FINAL予想失敗: ${e.message})`);
        }
      } else {
        logs.push(`${venueName} R${raceNumber}: 展示${updated}艇更新`);
      }
    }

    // 天候情報でRace更新
    if (parsed.data.weather || parsed.data.wind_speed != null) {
      const raceUpdate: any = {};
      if (parsed.data.weather) raceUpdate.weather = parsed.data.weather;
      if (parsed.data.wind_speed != null) raceUpdate.wind_speed = parsed.data.wind_speed;
      if (parsed.data.water_temp != null) raceUpdate.water_temp = parsed.data.water_temp;
      if (parsed.data.air_temp != null) raceUpdate.air_temp = parsed.data.air_temp;
      if (parsed.data.wave_height != null) raceUpdate.wave_height = parsed.data.wave_height;
      await sr.Race.update(race.id, raceUpdate).catch(() => {});
    }

    await sleep(300);
  }

  return { total: races.length, fetched, final_generated: finalGenerated, errors };
}

// =====================================================
// STEP 5: 完全性チェック
// =====================================================
async function checkCompleteness(base44: any, raceDate: string, logs: string[]) {
  const sr = base44.asServiceRole.entities;
  const races = await sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []);
  const entries = await sr.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []);
  const results = await sr.RaceResult.filter({}, '-finished_at', 500).catch(() => []);
  const raceIdsWithResult = new Set(results.map((r: any) => r.race_id));

  const venueSet = new Set(races.map((r: any) => r.venue_code));
  const entryByRace = {};
  for (const e of entries) {
    const key = `${e.venue_code}_${e.race_number}`;
    entryByRace[key] = (entryByRace[key] || 0) + 1;
  }

  const incompleteRaces = [];
  for (const race of races) {
    const key = `${race.venue_code}_${race.race_number}`;
    const entryCount = entryByRace[key] || 0;
    if (entryCount < 6) incompleteRaces.push(`${race.venue_code} R${race.race_number}(${entryCount}艇)`);
  }

  const finishedCount = races.filter((r: any) => raceIdsWithResult.has(r.id)).length;
  const preCount = races.filter((r: any) => r.has_pre).length;

  logs.push(`${raceDate}: ${venueSet.size}場/${races.length}R/艇${entries.length}/結果${finishedCount}/PRE${preCount}`);
  if (incompleteRaces.length) logs.push(`不足: ${incompleteRaces.slice(0, 10).join(', ')}${incompleteRaces.length > 10 ? ` ほか${incompleteRaces.length - 10}件` : ''}`);

  return {
    venues: venueSet.size,
    races: races.length,
    entries: entries.length,
    results: finishedCount,
    pre_predictions: preCount,
    incomplete: incompleteRaces.length,
  };
}

// =====================================================
// AutoUpdateStatus更新
// =====================================================
async function updateAutoUpdateStatus(base44: any, today: string, tomorrow: string, step: string, result: any) {
  const sr = base44.asServiceRole.entities;
  try {
    const todayStats = await checkCompleteness(base44, today, []);
    const tomorrowStats = await checkCompleteness(base44, tomorrow, []);

    const status = result.errors?.length > 0 ? 'partial' : 'success';
    const doc: any = {
      name: 'default',
      target_date: today,
      tomorrow_date: tomorrow,
      today_venues: todayStats.venues,
      today_races: todayStats.races,
      today_results: todayStats.results,
      tomorrow_venues: tomorrowStats.venues,
      tomorrow_races: tomorrowStats.races,
      tomorrow_entries: tomorrowStats.entries,
      pre_predictions: todayStats.pre_predictions,
      status,
      last_updated: new Date().toISOString(),
      current_step: step,
      error_count: result.errors?.length || 0,
      errors: (result.errors || []).slice(0, 20),
    };

    const existing = await sr.AutoUpdateStatus.filter({ name: 'default' }, '-last_updated', 1).catch(() => []);
    if (existing?.[0]) {
      await sr.AutoUpdateStatus.update(existing[0].id, doc);
    } else {
      await sr.AutoUpdateStatus.create(doc);
    }
  } catch {}
}

// =====================================================
// メイン: Autoモード
// =====================================================
async function autoUpdate(base44: any, today: string, tomorrow: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();
  const jstHour = parseInt(nowJSTTime().split(':')[0], 10);

  // 現在のDB状態を確認
  const todayRaces = await sr.Race.filter({ race_date: today }, 'race_number', 300).catch(() => []);
  const tomorrowRaces = await sr.Race.filter({ race_date: tomorrow }, 'race_number', 300).catch(() => []);
  const existingResults = await sr.RaceResult.filter({}, '-finished_at', 500).catch(() => []);
  const raceIdsWithResult = new Set(existingResults.map((r: any) => r.race_id));

  const todayRaceCount = todayRaces.length;
  const tomorrowRaceCount = tomorrowRaces.length;
  const todayResultCount = todayRaces.filter((r: any) => raceIdsWithResult.has(r.id)).length;
  const todayPreCount = todayRaces.filter((r: any) => r.has_pre).length;
  const tomorrowPreCount = tomorrowRaces.filter((r: any) => r.has_pre).length;

  const steps: string[] = [];
  let remaining = timeBudgetMs;

  // 優先順位:
  // 1. 翌日番組表が未取得 → 取得(夜間優先)
  // 2. 翌日PRE予想が未生成 → 生成
  // 3. 当日番組表の不足を毎回補完（部分取得で止まっても次回継続）
  // 4. 当日結果が未取得 → 取得(レース後)
  // 5. 当日展示データ → 取得(レース中)

  if (tomorrowRaceCount === 0 && jstHour >= 16) {
    logs.push(`AUTO: 翌日番組表取得開始`);
    const r = await fetchAndSaveRaceCards(base44, tomorrow, remaining, logs, errors);
    steps.push(`tomorrow_card: ${r.races}R/${r.entries}艇`);
    remaining -= (Date.now() - startTime);
  }

  if (remaining > 10000 && tomorrowRaceCount > 0 && tomorrowPreCount < tomorrowRaceCount) {
    logs.push(`AUTO: 翌日PRE予想生成開始`);
    const r = await generatePrePredictions(base44, tomorrow, remaining, logs, errors);
    steps.push(`pre_predictions: ${r.generated}R`);
    remaining -= (Date.now() - startTime);
  }

  // 当日Raceが0件かどうかではなく、毎回完全性を見ながら不足だけ補完する。
  // fetchAndSaveRaceCards側が6艇揃ったRaceをスキップするため冪等で安全。
  if (remaining > 10000) {
    logs.push(`AUTO: 当日番組表の完全性確認・不足補完開始`);
    const before = Date.now();
    const r = await fetchAndSaveRaceCards(base44, today, remaining, logs, errors);
    steps.push(`today_card: +${r.races}R/+${r.entries}艇`);
    remaining -= (Date.now() - before);
  }

  if (remaining > 10000 && todayRaceCount > 0 && todayResultCount < todayRaceCount && jstHour >= 10) {
    logs.push(`AUTO: 当日結果取得開始`);
    const before = Date.now();
    const r = await fetchAndSaveResults(base44, today, remaining, logs, errors);
    steps.push(`today_results: ${r.fetched}R`);
    remaining -= (Date.now() - before);
  }

  if (remaining > 10000 && todayRaceCount > 0 && jstHour >= 8 && jstHour <= 22) {
    logs.push(`AUTO: 展示データ取得開始`);
    const r = await fetchAndSaveExhibition(base44, today, remaining, logs, errors);
    steps.push(`exhibition: ${r.fetched}R`);
  }

  return { steps, logs, errors };
}

// =====================================================
// エントリポイント
// =====================================================
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);

    // 認証(ワークフロー呼出の場合はスキップ)
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { step = 'auto' } = body;

    const today = getTodayJST();
    const tomorrow = getTomorrowJST();
    const logs: string[] = [];
    const errors: string[] = [];
    const TIME_BUDGET = 80000;

    let result;
    switch (step) {
      case 'today_card':
        result = await fetchAndSaveRaceCards(base44, today, TIME_BUDGET, logs, errors);
        break;
      case 'today_results':
        result = await fetchAndSaveResults(base44, today, TIME_BUDGET, logs, errors);
        break;
      case 'tomorrow_card':
        result = await fetchAndSaveRaceCards(base44, tomorrow, TIME_BUDGET, logs, errors);
        break;
      case 'pre_predictions':
        result = await generatePrePredictions(base44, tomorrow, TIME_BUDGET, logs, errors);
        break;
      case 'exhibition':
        result = await fetchAndSaveExhibition(base44, today, TIME_BUDGET, logs, errors);
        break;
      case 'completeness':
        const todayStats = await checkCompleteness(base44, today, logs);
        const tomorrowStats = await checkCompleteness(base44, tomorrow, logs);
        result = { today: todayStats, tomorrow: tomorrowStats };
        break;
      case 'auto':
      default:
        result = await autoUpdate(base44, today, tomorrow, TIME_BUDGET, logs, errors);
        break;
    }

    // ステータス更新
    await updateAutoUpdateStatus(base44, today, tomorrow, step, { ...result, errors });

    return Response.json({
      ok: errors.length === 0,
      step,
      today,
      tomorrow,
      jst_time: nowJSTTime(),
      logs,
      errors,
      ...result,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}