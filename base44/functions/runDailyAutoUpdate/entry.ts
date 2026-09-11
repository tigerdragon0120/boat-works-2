import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fetchHtml, parseRaceIndex, parseRaceCard, parseDeadlineTimes, parseResult, parseBeforeInfo, parseOdds3t, buildUrl, VENUE_MAP } from '../../shared/boatraceOfficialParser.js';
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
  // JSTの「今日」文字列を基準に暦日を1日進める。
  // JST時刻をDateへ再解釈してから再度timeZone変換すると、環境によって+9時間が二重適用され
  // 21時以降などに翌々日へずれることがあるため、UTCの暦日演算だけを使う。
  const today = getTodayJST();
  const [y, m, d] = today.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
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
    if (Date.now() - startTime > timeBudgetMs - 5000) {
      logs.push(`時間予算到達 — 残り${venues.length - venues.indexOf(venue)}場は次回継続`);
      break;
    }

    const venueCode = venue.venue_code;
    const venueName = venue.venue_name;
    const existingRaces = await sr.Race.filter({ race_date: raceDate, venue_code: venueCode }, 'race_number', 30).catch(() => []);
    const existingEntries = await sr.RaceEntry.filter({ race_date: raceDate, venue_code: venueCode }, 'boat_number', 200).catch(() => []);
    const entryCountByRace: Record<string, number> = {};
    for (const e of existingEntries) {
      const rn = String(e.race_number);
      entryCountByRace[rn] = (entryCountByRace[rn] || 0) + 1;
    }

    let deadlineTimes: string[] = [];
    try {
      const sched = await fetchHtml(buildUrl('racelist', raceDate, venueCode, 1));
      if (sched.ok) deadlineTimes = parseDeadlineTimes(sched.html);
    } catch {}

    const deadlineFixes: any[] = [];
    for (const er of existingRaces) {
      const rn = Number(er.race_number);
      const t = deadlineTimes[rn - 1];
      if (!rn || !t) continue;
      const correctDeadline = `${raceDate}T${t}:00+09:00`;
      if (er.deadline !== correctDeadline) deadlineFixes.push({ id: er.id, deadline: correctDeadline });
    }
    if (deadlineFixes.length) await sr.Race.bulkUpdate(deadlineFixes).catch((e: any) => errors.push(`${venueName}: 締切補正 ${e.message}`));

    // 出走表6艇が揃っていても、節間成績が空ならracelistを再取得して補完する。
    // 以前は「6艇揃い=スキップ」だったため、section_* が永遠にnullのままになっていた。
    const entriesByRace: Record<string, any[]> = {};
    for (const e of existingEntries) {
      const rn = String(e.race_number);
      if (!entriesByRace[rn]) entriesByRace[rn] = [];
      entriesByRace[rn].push(e);
    }
    const targetRaceNos = Array.from({ length: 12 }, (_, i) => i + 1).filter((rno) => {
      const raceEntries = entriesByRace[String(rno)] || [];
      if (raceEntries.length < 6) return true;
      return raceEntries.some((e: any) =>
        e.section_points == null && !e.section_finishes && e.section_st == null && e.section_momentum == null
      );
    });
    if (!targetRaceNos.length) {
      skippedVenues++;
      continue;
    }

    const parsedCards: any[] = [];
    for (let i = 0; i < targetRaceNos.length; i += 4) {
      if (Date.now() - startTime > timeBudgetMs - 5000) break;
      const batch = targetRaceNos.slice(i, i + 4);
      const got = await Promise.all(batch.map(async (rno) => {
        try {
          const res = await fetchHtml(buildUrl('racelist', raceDate, venueCode, rno));
          if (!res.ok) return { rno, error: `HTTP ${res.status}` };
          const parsed = parseRaceCard(res.html, raceDate, venueCode, venueName, rno);
          const race = parsed.data?.venues?.[0]?.races?.[0];
          if (!parsed.ok || !race || !Array.isArray(race.entries) || race.entries.length !== 6) {
            return { rno, error: `解析失敗 ${(parsed.errors || []).join('; ')}` };
          }
          return { rno, race };
        } catch (e: any) {
          return { rno, error: e.message };
        }
      }));
      for (const g of got) {
        if (g.error) errors.push(`${venueName} R${g.rno} 番組取得失敗: ${g.error}`);
        else parsedCards.push(g);
      }
    }

    if (!parsedCards.length) continue;

    const existingRaceByNo = new Map(existingRaces.map((r: any) => [Number(r.race_number), r]));
    const raceCreates: any[] = [];
    const raceUpdates: any[] = [];

    for (const { rno, race } of parsedCards) {
      const raceKey = buildRaceKey(raceDate, venueCode, rno);
      const t = deadlineTimes[rno - 1] || race.deadline_time;
      const doc: any = {
        race_key: raceKey,
        race_date: raceDate,
        venue_code: venueCode,
        venue: venueName,
        venue_name: venueName,
        race_number: rno,
        sync_source: 'online_auto',
      };
      if (race.race_name) doc.race_name = race.race_name;
      if (race.race_type) doc.race_type = race.race_type;
      if (t) doc.deadline = `${raceDate}T${t}:00+09:00`;
      const old = existingRaceByNo.get(rno);
      if (old) raceUpdates.push({ id: old.id, ...doc });
      else raceCreates.push({ ...doc, status: 'scheduled' });
    }

    if (raceCreates.length) await withRateLimitRetry(() => sr.Race.bulkCreate(raceCreates));
    if (raceUpdates.length) await withRateLimitRetry(() => sr.Race.bulkUpdate(raceUpdates));

    const savedRaces = await sr.Race.filter({ race_date: raceDate, venue_code: venueCode }, 'race_number', 30).catch(() => []);
    const raceByNo = new Map(savedRaces.map((r: any) => [Number(r.race_number), r]));
    const existingEntryByKey = new Map(existingEntries.map((e: any) => [`${Number(e.race_number)}_${Number(e.boat_number)}`, e]));
    const entryCreates: any[] = [];
    const entryUpdates: any[] = [];

    for (const { rno, race } of parsedCards) {
      const savedRace: any = raceByNo.get(rno);
      if (!savedRace?.id) { errors.push(`${venueName} R${rno}: Race保存確認失敗`); continue; }
      const raceKey = buildRaceKey(raceDate, venueCode, rno);
      for (const e of race.entries) {
        const entryData: any = {
          race_id: savedRace.id, race_key: raceKey, race_date: raceDate, venue_code: venueCode, race_number: rno,
          boat_number: e.boat_number,
          player_name: e.player_name, racer_name: e.player_name,
          register_number: e.registration_number, registration_number: e.registration_number,
          is_absent: false, is_scratched: false,
        };
        const optional: any = {
          player_class: e.player_class, grade_class: e.player_class,
          national_win_rate: e.national_win_rate, local_win_rate: e.local_win_rate,
          national_f2_rate: e.national_2rate, national_2rate: e.national_2rate,
          national_f3_rate: e.national_3rate, national_3rate: e.national_3rate,
          local_f2_rate: e.local_2rate, local_2rate: e.local_2rate,
          local_f3_rate: e.local_3rate, local_3rate: e.local_3rate,
          motor_number: e.motor_number, motor_f2_rate: e.motor_2rate, motor_2rate: e.motor_2rate,
          motor_f3_rate: e.motor_3rate, motor_3rate: e.motor_3rate,
          boat_number_id: e.boat_number_id, boat_f2_rate: e.boat_2rate, boat_2rate: e.boat_2rate,
          boat_f3_rate: e.boat_3rate, boat_3rate: e.boat_3rate,
          f_count: e.f_count, l_count: e.l_count, avg_st: e.avg_st,
          section_points: e.section_points,
          section_finishes: e.section_finishes,
          section_st: e.section_st,
          section_momentum: e.section_momentum,
        };
        for (const [k, v] of Object.entries(optional)) if (v !== null && v !== undefined && v !== '') entryData[k] = v;
        const old = existingEntryByKey.get(`${rno}_${Number(e.boat_number)}`);
        if (old) entryUpdates.push({ id: old.id, ...entryData });
        else entryCreates.push(entryData);
      }
    }

    if (entryCreates.length) await withRateLimitRetry(() => sr.RaceEntry.bulkCreate(entryCreates));
    if (entryUpdates.length) await withRateLimitRetry(() => sr.RaceEntry.bulkUpdate(entryUpdates));

    totalRaces += parsedCards.length;
    totalEntries += parsedCards.length * 6;
    logs.push(`${venueName}: ${parsedCards.length}R/${parsedCards.length * 6}艇 一括保存`);
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
  const pending = races.filter((r: any) => !r.has_pre);
  let generated = 0, skipped = races.length - pending.length, rateLimited = false;

  // 1回の実行で最大5Rだけ生成する。
  // runAndSavePrediction は1Rあたり複数Entityを書き込むため、短時間に大量実行するとBase44の429制限に達する。
  // 30分周期の自動更新または手動ボタンで続きを安全に処理する。
  const batch = pending.slice(0, 5);

  for (const race of batch) {
    if (Date.now() - startTime > timeBudgetMs - 5000) {
      logs.push(`PRE予想: 時間予算到達 — 次回へ継続`);
      break;
    }

    const entries = await withRateLimitRetry(
      () => sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6),
      4
    ).catch(() => []);
    if (entries.length < 6) {
      logs.push(`${race.venue_name || race.venue_code} R${race.race_number}: 6艇未満のため保留`);
      continue;
    }

    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        await runAndSavePrediction(base44, race, entries, settings, 'PRE', {}, profileByReg, rollingByReg);
        success = true;
        generated++;
        logs.push(`${race.venue_name || race.venue_code} R${race.race_number}: PRE予想生成`);
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        if (/rate\s*limit|too many requests|429/i.test(msg)) {
          rateLimited = true;
          const waitMs = 4000 * (attempt + 1);
          logs.push(`${race.venue_name || race.venue_code} R${race.race_number}: Rate limit — ${waitMs/1000}秒待機して再試行`);
          await sleep(waitMs);
          continue;
        }
        errors.push(`PRE予想 ${race.venue_code} R${race.race_number}: ${msg}`);
        break;
      }
    }

    if (!success && rateLimited) {
      logs.push(`PRE予想: Rate limit保護のため今回の処理を停止。残りは次回継続`);
      break;
    }

    // 1Rごとに十分な間隔を空ける
    await sleep(1800);
  }

  const remaining = Math.max(0, pending.length - generated);
  logs.push(`PRE予想: 今回${generated}R生成 / 残り${remaining}R`);
  return { total: races.length, generated, skipped, remaining, rate_limited: rateLimited, errors };
}

// =====================================================
// STEP 2: 展示データ取得(FINAL生成はしない・オッズ取得後に生成)
// =====================================================
async function fetchAndSaveExhibition(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();

  const races = await sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []);
  let fetched = 0;

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs) break;
    if (race.exhibition_ready) continue;
    if (race.status === 'finished' || race.status === 'cancelled') continue;

    // 直前情報は締切の60分前〜締切5分後だけ取得する。
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

    // 実展示値(展示タイム+ST)が6艇揃った場合のみ exhibition_ready=true
    const realCount = parsed.data.real_exhibition_count || 0;
    if (updated > 0) {
      const raceUpdate: any = {};
      if (realCount >= 6) raceUpdate.exhibition_ready = true;
      if (parsed.data.weather) raceUpdate.weather = parsed.data.weather;
      if (parsed.data.wind_speed != null) raceUpdate.wind_speed = parsed.data.wind_speed;
      if (parsed.data.water_temp != null) raceUpdate.water_temp = parsed.data.water_temp;
      if (parsed.data.air_temp != null) raceUpdate.air_temp = parsed.data.air_temp;
      if (parsed.data.wave_height != null) raceUpdate.wave_height = parsed.data.wave_height;
      await sr.Race.update(race.id, raceUpdate).catch(() => {});
      fetched++;
      logs.push(`${venueName} R${raceNumber}: 展示${updated}艇更新(実展示${realCount}/6)`);
    }

    await sleep(300);
  }

  return { total: races.length, fetched, errors };
}

// =====================================================
// STEP 3: 3連単オッズ取得 + FINAL予想生成
// 展示取得済みのレースについてオッズを取得し、FINAL予想を生成する。
// =====================================================
async function fetchAndSaveOddsAndFinal(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();
  const settings = await getSettings(base44);
  const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
  const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
  const rolling = await sr.RacerRollingStats.filter({}, '-calculated_at', 5000).catch(() => []);
  const rollingByReg = new Map(rolling.map((r: any) => [r.registration_number, r]));

  const races = await sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []);
  let oddsFetched = 0, finalGenerated = 0;

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs) break;
    if (race.status === 'finished' || race.status === 'cancelled') continue;
    if (!race.exhibition_ready) continue; // 展示未取得はスキップ

    // 表示用オッズは公式に出たら早めに取り込み、FINAL判定は締切5分前付近だけ行う。
    // これにより「公式にはオッズが出ているのにアプリは—」を防ぎつつ、
    // BUY/SKIPは直前オッズで確定する。
    if (!race.deadline) continue;
    const deadlineMs = new Date(race.deadline).getTime();
    if (!Number.isFinite(deadlineMs)) continue;
    const nowMs = Date.now();
    const inDisplayOddsWindow = nowMs >= deadlineMs - 25 * 60 * 1000 && nowMs <= deadlineMs - 1 * 60 * 1000;
    const inFinalWindow = nowMs >= deadlineMs - 6 * 60 * 1000 && nowMs <= deadlineMs - 2 * 60 * 1000;
    if (!inDisplayOddsWindow) continue;

    const venueCode = race.venue_code;
    const raceNumber = race.race_number;
    const venueName = race.venue_name || race.venue || VENUE_MAP[venueCode] || venueCode;

    const url = buildUrl('odds3t', raceDate, venueCode, raceNumber);
    const res = await fetchHtml(url);
    if (!res.ok) continue;

    const oddsMap = parseOdds3t(res.html);
    const oddsCount = Object.keys(oddsMap).length;
    if (oddsCount < 100) continue; // オッズが十分でない場合はスキップ

    // OddsSnapshot保存
    await sr.OddsSnapshot.create({
      race_id: race.id, stage: inFinalWindow ? 'FINAL' : 'LIVE', odds_map: oddsMap,
      captured_at: new Date().toISOString(),
    }).catch(() => {});
    oddsFetched++;

    // PRE/FINALどちらが表示中でも実オッズを画面に出せるよう、
    // 最新予想の120通りへactual_odds/current_oddsを反映する。
    const latestPreds = await sr.RacePrediction.filter({ race_id: race.id }, '-computed_at', 2).catch(() => []);
    for (const pred of latestPreds) {
      const trifectas = await sr.TrifectaPrediction.filter({ prediction_id: pred.id }, 'rank', 120).catch(() => []);
      const updates = trifectas.map((t: any) => {
        const actualOdds = oddsMap[t.combination] || null;
        const ev = actualOdds ? Math.round(t.probability * actualOdds * 10) / 10 : null;
        return { id: t.id, actual_odds: actualOdds, current_odds: actualOdds, expected_value: ev };
      });
      if (updates.length) await sr.TrifectaPrediction.bulkUpdate(updates).catch(() => {});
    }

    // FINAL予想は締切5分前付近だけ再計算する。
    if (inFinalWindow) {
      const entries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
      if (entries.length >= 6) {
        try {
          await runAndSavePrediction(base44, race, entries, settings, 'FINAL', oddsMap, profileByReg, rollingByReg);
          finalGenerated++;
          logs.push(`${venueName} R${raceNumber}: 実オッズ${oddsCount}件反映+FINAL予想生成`);
        } catch (e: any) {
          errors.push(`${venueName} R${raceNumber}: FINAL予想失敗 ${e.message}`);
        }
      }
    } else {
      logs.push(`${venueName} R${raceNumber}: 実オッズ${oddsCount}件を表示用に反映`);
    }

    await sleep(300);
  }

  return { total: races.length, odds_fetched: oddsFetched, final_generated: finalGenerated, errors };
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
  // 1. 当日展示データ（締切が近いレースを最優先）
  // 2. 当日オッズ + FINAL予想
  // 3. 当日結果
  // 4. 当日番組表の不足補完
  // 5. 翌日番組表/PRE
  //
  // 重要: 展示・FINALは取得可能時間が短いリアルタイム処理。
  // 番組表補完や結果回収を先に実行して時間予算を使い切ると、
  // 場によって展示が入る/入らない状態になるため、必ず最優先にする。

  if (tomorrowRaceCount === 0 && jstHour >= 16) {
    logs.push(`AUTO: 翌日番組表取得開始`);
    const before = Date.now();
    const r = await fetchAndSaveRaceCards(base44, tomorrow, remaining, logs, errors);
    steps.push(`tomorrow_card: ${r.races}R/${r.entries}艇`);
    remaining -= (Date.now() - before);
  }

  if (remaining > 10000 && tomorrowRaceCount > 0 && tomorrowPreCount < tomorrowRaceCount) {
    logs.push(`AUTO: 翌日PRE予想生成開始`);
    const before = Date.now();
    const r = await generatePrePredictions(base44, tomorrow, remaining, logs, errors);
    steps.push(`pre_predictions: ${r.generated}R`);
    remaining -= (Date.now() - before);
  }

  // リアルタイム系を最優先。ここを番組表/結果より後ろに置かない。
  if (remaining > 10000 && todayRaceCount > 0 && jstHour >= 8 && jstHour <= 22) {
    logs.push(`AUTO: 展示データ取得開始（最優先）`);
    const before = Date.now();
    const r = await fetchAndSaveExhibition(base44, today, remaining, logs, errors);
    steps.push(`exhibition: ${r.fetched}R`);
    remaining -= (Date.now() - before);
  }

  if (remaining > 10000 && todayRaceCount > 0 && jstHour >= 8 && jstHour <= 22) {
    logs.push(`AUTO: オッズ取得+FINAL予想生成開始（最優先）`);
    const before = Date.now();
    const r = await fetchAndSaveOddsAndFinal(base44, today, remaining, logs, errors);
    steps.push(`odds_final: ${r.odds_fetched}R/${r.final_generated}FINAL`);
    remaining -= (Date.now() - before);
  }

  if (remaining > 10000 && todayRaceCount > 0 && todayResultCount < todayRaceCount && jstHour >= 10) {
    logs.push(`AUTO: 当日結果取得開始`);
    const before = Date.now();
    const r = await fetchAndSaveResults(base44, today, remaining, logs, errors);
    steps.push(`today_results: ${r.fetched}R`);
    remaining -= (Date.now() - before);
  }

  // 当日Raceが0件かどうかではなく、毎回完全性を見ながら不足だけ補完する。
  // リアルタイム取得を終えて余った時間だけ使う。
  if (remaining > 10000) {
    logs.push(`AUTO: 当日番組表の完全性確認・不足補完開始`);
    const before = Date.now();
    const r = await fetchAndSaveRaceCards(base44, today, remaining, logs, errors);
    steps.push(`today_card: +${r.races}R/+${r.entries}艇`);
    remaining -= (Date.now() - before);
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
      case 'odds_final':
        result = await fetchAndSaveOddsAndFinal(base44, today, TIME_BUDGET, logs, errors);
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