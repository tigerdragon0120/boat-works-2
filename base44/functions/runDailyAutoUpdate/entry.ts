// 共通取得処理はページ形式({items,next_cursor,has_more})を使うため0.8.60で実行する
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.60';
import { fetchHtml, parseRaceIndex, parseRaceCard, parseDeadlineTimes, parseSeriesName, parseResult, parseBeforeInfo, parseOdds3t, buildUrl, VENUE_MAP } from '../../shared/boatraceOfficialParser.js';
import { upsertRace, upsertEntry, dedupRace, dedupEntriesForRace, upsertResultOnly, upsertBoatcastResultAndVerify, collapseDuplicateRaceResults } from '../../shared/predictionService.js';
import { isWomensRace } from '../../shared/womensRace.js';
import { resolveRaceResult } from '../../shared/resultResolver.js';
import { computeLanePast10Stats } from '../../shared/lanePast10Engine.js';
import { buildRaceKey } from '../../shared/raceKey.js';
import { runV8LiveGeneration } from '../../shared/v8LiveGeneration.js';
import { selectLiveInputRaces, isSavedExhibitionComplete } from '../../shared/liveInputPriority.js';
import { readV8Rows } from '../../shared/v8Repository.js';
import { planRaceCardEntries } from '../../shared/raceCardEntryPlan.js';

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

function raceQuality(r: any) {
  return (r?.has_final ? 40 : 0) + (r?.exhibition_ready ? 30 : 0) +
    (r?.has_pre ? 20 : 0) + (r?.prediction_grade ? 5 : 0) + (r?.deadline ? 2 : 0);
}

function uniqueRacesByKey(races: any[]) {
  const byKey = new Map<string, any>();
  for (const race of races || []) {
    const key = String(race.race_key || buildRaceKey(race.race_date, race.venue_code, race.race_number));
    const current = byKey.get(key);
    if (!current || raceQuality(race) > raceQuality(current) ||
        (raceQuality(race) === raceQuality(current) &&
         String(race.updated_date || '') > String(current.updated_date || ''))) {
      byKey.set(key, race);
    }
  }
  return [...byKey.values()].sort((a, b) => String(a.deadline || '').localeCompare(String(b.deadline || '')));
}

function entryQuality(e: any) {
  return (e?.registration_number || e?.register_number ? 20 : 0) +
    (e?.player_name || e?.racer_name ? 10 : 0) +
    (e?.exhibition_time != null ? 8 : 0) +
    (e?.section_points != null || e?.section_finishes ? 2 : 0);
}

function uniqueEntriesByBoat(entries: any[]) {
  const byBoat = new Map<number, any>();
  for (const entry of entries || []) {
    const boat = Number(entry.boat_number);
    if (!Number.isFinite(boat) || boat < 1 || boat > 6) continue;
    const current = byBoat.get(boat);
    if (!current || entryQuality(entry) > entryQuality(current) ||
        (entryQuality(entry) === entryQuality(current) &&
         String(entry.updated_date || '') > String(current.updated_date || ''))) {
      byBoat.set(boat, entry);
    }
  }
  return [...byBoat.values()].sort((a, b) => Number(a.boat_number) - Number(b.boat_number));
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
    let existingRaces: any[] = [], existingEntries: any[] = [];
    try {
      const budget = startTime + timeBudgetMs;
      [existingRaces, existingEntries] = await Promise.all([
        readV8Rows(sr.Race, {race_date:raceDate,venue_code:venueCode}, {budget,maxPages:3,sort:'race_number'}),
        readV8Rows(sr.RaceEntry, {race_date:raceDate,venue_code:venueCode}, {budget,maxPages:8,sort:'boat_number'}),
      ]);
    } catch {
      errors.push(venueName + ': 既存出走表を最後まで確認できないため保存を保留');
      continue;
    }
    const raceKeyCounts = new Map<string, number>();
    for (const race of existingRaces) {
      const key = String(race.race_key || buildRaceKey(raceDate, venueCode, race.race_number));
      raceKeyCounts.set(key, (raceKeyCounts.get(key) || 0) + 1);
    }
    if ([...raceKeyCounts.values()].some((count) => count > 1)) {
      errors.push(venueName + ': レースの重複を確認したため出走表保存を保留');
      continue;
    }
    const entrySlots = new Set<string>(), ambiguousRaceNos = new Set<number>();
    for (const e of existingEntries) {
      const rno = Number(e.race_number), slot = rno + '_' + Number(e.boat_number);
      if(entrySlots.has(slot))ambiguousRaceNos.add(rno);
      entrySlots.add(slot);
    }
    for(const rno of ambiguousRaceNos)errors.push(venueName + ' R' + rno + ': 出走表重複を保持して再保存を保留');

    let deadlineTimes: string[] = [];
    let seriesName = '';
    try {
      const sched = await fetchHtml(buildUrl('racelist', raceDate, venueCode, 1));
      if (sched.ok) {
        deadlineTimes = parseDeadlineTimes(sched.html);
        seriesName = parseSeriesName(sched.html);
      }
    } catch {}
    // 開催大会名から女子戦かどうかを判定する(V6.5の対象判定に使用)
    const venueIsWomens = seriesName ? isWomensRace({ series_name: seriesName }) : false;

    const deadlineFixes: any[] = [];
    for (const er of existingRaces) {
      const rn = Number(er.race_number);
      const t = deadlineTimes[rn - 1];
      if (!rn || !t) continue;
      const correctDeadline = `${raceDate}T${t}:00+09:00`;
      if (er.deadline !== correctDeadline) deadlineFixes.push({ id: er.id, deadline: correctDeadline });
    }
    if (deadlineFixes.length) await sr.Race.bulkUpdate(deadlineFixes).catch((e: any) => errors.push(`${venueName}: 締切補正 ${e.message}`));

    // 大会名と女子戦フラグをRaceへ保存する。
    // 値が変わったレースだけ書き込むため、2回目以降は書き込みが発生しない。
    if (seriesName) {
      const seriesFixes = existingRaces
        .filter((r: any) => r.series_name !== seriesName || r.is_womens !== venueIsWomens)
        .map((r: any) => ({ id: r.id, series_name: seriesName, is_womens: venueIsWomens }));
      if (seriesFixes.length) {
        await sr.Race.bulkUpdate(seriesFixes).catch((e: any) => errors.push(`${venueName}: 大会名保存 ${e.message}`));
      }
    }

    // 6艇揃っているレースは再取得しない。
    // 以前は「節間成績が空ならracelistを再取得」としていたが、1Rなど今節成績が
    // まだ存在しないレースは節間値がnullのままなので、5分ごとに12R/72艇を丸ごと
    // 書き直し続けて1日の書き込み上限に達し、自動更新そのものが停止していた。
    // 節間成績は出走表の取得時に取り込み、欠けた分はレースを開いた時の
    // fetchOnlineData('section')で補完する。
    const entriesByRace: Record<string, any[]> = {};
    for (const e of existingEntries) {
      const rn = String(e.race_number);
      if (!entriesByRace[rn]) entriesByRace[rn] = [];
      entriesByRace[rn].push(e);
    }
    // 6艇未満のレースに加えて、全国勝率が欠けているレースも再取得する。
    // 公式出走表は新人など平均ST未公表の選手で「F1 L0 - 2.11 …」とSTが記号になり、
    // 以前はその選手の全国・当地・モーター・ボートの全項目が欠落したまま保存されていた。
    // 値を取得できた時点でこの条件は満たなくなるため、再取得は1回で収束する。
    const targetRaceNos = Array.from({ length: 12 }, (_, i) => i + 1).filter(
      (rno) => {
        if(ambiguousRaceNos.has(rno))return false;
        const rows = entriesByRace[String(rno)] || [];
        return rows.length < 6 || rows.some((e: any) => e.national_win_rate == null);
      },
    );
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
    const raceByNo = new Map<number, any>();

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
        status: existingRaceByNo.get(rno)?.status || 'scheduled',
      };
      if (race.race_name) doc.race_name = race.race_name;
      if (race.race_type) doc.race_type = race.race_type;
      if (t) doc.deadline = `${raceDate}T${t}:00+09:00`;
      if (seriesName) {
        doc.series_name = seriesName;
        doc.is_womens = venueIsWomens;
      }
      // 1件の保存失敗(429等)で自動更新の実行全体を落とさない。失敗分は次回実行で補完する。
      let saved: any = null;
      try {
        // Recheck the exact race key; do not call the automatic deletion/merge path.
        const current = await readV8Rows(sr.Race,{race_key:raceKey},{budget:startTime+timeBudgetMs,maxPages:3});
        if(current.length>1)throw new Error('RACE_IDENTITY_AMBIGUOUS');
        const old=current[0];
        if(old&&(old.race_date!==raceDate||String(old.venue_code).padStart(2,'0')!==venueCode||Number(old.race_number)!==rno))throw new Error('RACE_IDENTITY_CONFLICT');
        saved=old?await sr.Race.update(old.id,{...doc,status:old.status||doc.status}):await sr.Race.create(doc);
      } catch(e: any) {
        errors.push(venueName + ' R' + rno + ': Race保存を保留 ' + String(e?.message||'READ_OR_WRITE_FAILED').slice(0,100));
      }
      if (saved) raceByNo.set(rno, saved);
    }
    const incomingEntries: any[] = [];

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
        incomingEntries.push(entryData);
      }
    }

    if(!incomingEntries.length)continue;
    let freshEntries: any[] = [];
    try {
      const keys=[...new Set(incomingEntries.map(row=>row.race_key))],ids=[...new Set(incomingEntries.map(row=>row.race_id))];
      const budget=startTime+timeBudgetMs;
      const [byKey,byId]=await Promise.all([
        readV8Rows(sr.RaceEntry,{race_key:{$in:keys}},{budget,maxPages:8}),
        readV8Rows(sr.RaceEntry,{race_id:{$in:ids}},{budget,maxPages:8}),
      ]);
      freshEntries=[...new Map([...byKey,...byId].map(row=>[row.id,row])).values()];
    } catch {
      errors.push(venueName + ': 保存直前の出走表再照合に失敗したため艇の追加・更新を保留');
      continue;
    }
    const entryPlan=planRaceCardEntries(freshEntries,incomingEntries);
    for(const held of entryPlan.held)errors.push(venueName + ': ' + held.race_key + ' ' + held.reason + '（既存行を保持）');
    const entryCreates=entryPlan.creates,entryUpdates=entryPlan.updates;
    if (entryCreates.length) await withRateLimitRetry(() => sr.RaceEntry.bulkCreate(entryCreates))
      .catch((e: any) => errors.push(`${venueName}: RaceEntry作成 ${e.message}`));
    if (entryUpdates.length) await withRateLimitRetry(() => sr.RaceEntry.bulkUpdate(entryUpdates))
      .catch((e: any) => errors.push(`${venueName}: RaceEntry更新 ${e.message}`));

    // Preserve raw duplicate history. Ambiguous slots are held, never deleted here.
    totalRaces += new Set([...entryCreates,...entryUpdates].map(row=>row.race_key)).size;
    totalEntries += entryCreates.length + entryUpdates.length;
    logs.push(venueName + ': 出走表 新規' + entryCreates.length + '艇 / 更新' + entryUpdates.length + '艇');
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
  const races = uniqueRacesByKey(await sr.Race.filter({ race_date: raceDate }, 'deadline', 5000).catch(() => []));
  if (!races.length) {
    return { total: 0, fetched: 0, skipped: 0, errors };
  }

  // 結果済みのRaceを特定
  const existingResults = await sr.RaceResult.filter({ race_id: { $in: races.map((r: any) => r.id) } }, '-finished_at', 600).catch(() => []);
  const raceIdsWithResult = new Set(existingResults.filter((r: any) => r.result_trifecta && (r.is_finished || r.result_status === 'RESULT_FINAL')).map((r: any) => r.race_id));

  let fetched = 0, skipped = 0, boatcastCount = 0, localCount = 0;
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

    // ============================================================
    // BOATCAST優先で結果取得(着順・ST・進入・決まり手・天候・全券種払戻)
    // 失敗時はLOCAL(boatrace.jp公式HTML)へフォールバック
    // ============================================================
    let resultSaved = false;
    try {
      const boatcastResult = await resolveRaceResult(race);
      if (boatcastResult.source === 'BOATCAST' && boatcastResult.result?.result_trifecta) {
        await upsertBoatcastResultAndVerify(base44, race, boatcastResult, { verifyLegacy: false });
        fetched++;
        boatcastCount++;
        resultSaved = true;
        logs.push(`${venueName} R${raceNumber}: BOATCAST結果 ${boatcastResult.result.result_trifecta} ¥${boatcastResult.result.payout || 0} (${boatcastResult.result.popular_trifecta || '-'})`);
      }
    } catch (e: any) {
      errors.push(`${venueName} R${raceNumber}: BOATCAST結果保存失敗 ${e.message}`);
    }

    // BOATCAST失敗時はLOCAL fallback
    if (!resultSaved) {
      const url = buildUrl('raceresult', raceDate, venueCode, raceNumber);
      const res = await fetchHtml(url);
      if (!res.ok) continue;

      const parsed = parseResult(res.html, raceDate, venueCode, venueName);
      if (!parsed.ok || !parsed.data?.venues?.[0]?.results?.[0]) continue;

      const result = parsed.data.venues[0].results[0];
      result.race_number = raceNumber;

      try {
        await upsertResultOnly(base44, race, {
          result_trifecta: result.result_trifecta,
          finish_order: result.finish_order || [],
          payout: result.payout || 0,
          payouts: result.payouts || null,
          fetched_at: new Date().toISOString(),
        });

        // RacerRaceHistory蓄積(LOCAL)
        const raceEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
        const entryByBoat = new Map(raceEntries.map((e: any) => [e.boat_number, e]));
        const histCreates: any[] = [];
        const histUpdates: any[] = [];

        const existingHists = await sr.RacerRaceHistory.filter({ race_date: raceDate, venue_code: venueCode, race_number: raceNumber }, 'race_number', 10).catch(() => []);
        const histByReg = new Map(existingHists.map((h: any) => [h.registration_number, h]));

        for (const pe of result.entries || []) {
          const bn = num(pe.boat_number);
          if (!bn) continue;
          const re = entryByBoat.get(bn);
          const reg = str(re?.registration_number || re?.register_number || pe.registration_number);
          if (!reg || !/^\d{4}$/.test(reg)) continue;

          const histDoc: any = {
            registration_number: reg, race_date: raceDate, venue_code: venueCode, race_number: raceNumber,
            boat_number: bn, finish_order: num(pe.finish_order) || undefined,
            st: num(pe.st) ?? undefined, winning_method: str(pe.winning_method) || undefined,
            race_time: str(pe.race_time) || undefined,
          };
          const old = histByReg.get(reg);
          if (old) histUpdates.push({ id: old.id, ...histDoc });
          else histCreates.push(histDoc);
        }

        if (histCreates.length) await sr.RacerRaceHistory.bulkCreate(histCreates).catch(() => {});
        if (histUpdates.length) await sr.RacerRaceHistory.bulkUpdate(histUpdates).catch(() => {});

        // 天候情報でRace更新
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
        localCount++;
        resultSaved = true;
        logs.push(`${venueName} R${raceNumber}: LOCAL結果 ${result.result_trifecta} ¥${result.payout || 0}`);
      } catch (e: any) {
        errors.push(`${venueName} R${raceNumber}: LOCAL結果保存失敗 ${e.message}`);
      }
    }

    // V8 settlement is handled by the shared all-race verification queue.

    await sleep(300);
  }

  logs.push(`結果取得: BOATCAST=${boatcastCount}R LOCAL=${localCount}R`);
  return { total: races.length, fetched, skipped, boatcast: boatcastCount, local: localCount, errors };
}

// =====================================================
// STEP 2: 展示データ取得(FINAL生成はしない・オッズ取得後に生成)
// =====================================================
async function fetchAndSaveExhibition(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[], options: any = {}) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();

  const allRaces = uniqueRacesByKey(await sr.Race.filter({ race_date: raceDate }, 'deadline', 5000));
  const races = options.liveOnly ? selectLiveInputRaces(allRaces, startTime) : allRaces;
  let fetched = 0;
  // 展示が揃ったレースは、この回の最後にV7のFINAL判定へ回す
  const forecastReadyKeys = new Set<string>();

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs) break;
    if (race.status === 'finished' || race.status === 'cancelled') continue;

    // 直前情報は締切の60分前〜締切30分後まで取得する（遅延・復旧時も回収）。
    // 一度展示READYになったレースも、FINAL生成直前は再取得する。
    // 進入変更・展示ST修正があれば、この直後のオッズ+FINAL処理で全予想を作り直す。
    if (!race.deadline) continue;
    const deadlineMs = new Date(race.deadline).getTime();
    if (!Number.isFinite(deadlineMs)) continue;
    const nowMs = Date.now();
    if (options.liveOnly && deadlineMs <= nowMs + 90000) continue;
    if (nowMs < deadlineMs - 60 * 60 * 1000 || nowMs > deadlineMs + 30 * 60 * 1000) continue;
    const inFinalRefreshWindow = nowMs >= deadlineMs - 12 * 60 * 1000 && nowMs <= deadlineMs - 1 * 60 * 1000;
    if (race.exhibition_ready && !inFinalRefreshWindow) continue;

    const venueCode = race.venue_code;
    const raceNumber = race.race_number;
    const venueName = race.venue_name || race.venue || VENUE_MAP[venueCode] || venueCode;

    const url = buildUrl('beforeinfo', raceDate, venueCode, raceNumber);
    const res = await fetchHtml(url, 0, { timeoutMs: 6000, deadlineMs: startTime + timeBudgetMs });
    if (!res.ok) continue;

    const parsed = parseBeforeInfo(res.html);
    if (!parsed.ok || !parsed.data?.entries?.length) continue;

    const entries = uniqueEntriesByBoat(await sr.RaceEntry.filter({ race_key: race.race_key }, '-updated_date', 100).catch(() => []));
    const entryByBoat = new Map(entries.map((e: any) => [e.boat_number, e]));

    let updated = 0;
    let criticalChanged = false;
    for (const pe of parsed.data.entries) {
      const bn = pe.boat_number;
      const existing = entryByBoat.get(bn);
      if (!existing) continue;

      const update: any = {};
      const changed = (current: any, incoming: any) => {
        if (incoming == null) return false;
        if (current == null || current === '') return true;
        const a = Number(current), b = Number(incoming);
        if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) > 0.0001;
        return current !== incoming;
      };
      if (changed(existing.exhibition_time, pe.exhibition_time)) update.exhibition_time = pe.exhibition_time;
      if (changed(existing.exhibition_st, pe.exhibition_st)) {
        update.exhibition_st = pe.exhibition_st;
        update.exhibition_st_raw = pe.exhibition_st;
      }
      if (changed(existing.exhibition_st_raw, pe.exhibition_st)) update.exhibition_st_raw = pe.exhibition_st;
      if (changed(existing.exhibition_course, pe.exhibition_course)) update.exhibition_course = pe.exhibition_course;
      if (changed(existing.tilt, pe.tilt)) update.tilt = pe.tilt;
      if (pe.is_absent && (!existing.is_absent || !existing.is_scratched)) {
        update.is_absent = true;
        update.is_scratched = true;
      }

      if (Object.keys(update).length) {
        const courseChanged = Object.prototype.hasOwnProperty.call(update, 'exhibition_course');
        const previousCourse = existing.exhibition_course;
        try {
          await sr.RaceEntry.update(existing.id, update);
          Object.assign(existing, update); // Only confirmed writes count as saved evidence.
          updated++;
          criticalChanged = true;
          if (courseChanged) {
            logs.push(`${venueName} R${raceNumber}: ${bn}号艇の進入変更を検知 ${previousCourse ?? '未取得'}→${pe.exhibition_course}`);
          }
        } catch (e: any) {
          errors.push(`${venueName} R${raceNumber}: ${bn}号艇の展示更新失敗 ${e.message}`);
        }
      }
    }

    // 欠場艇は今回取得した直前情報から即時反映する。
    // Race.scratched_boats がまだ古くても、parserが検出した欠場艇を優先して
    // ACTIVE_BOATSだけで exhibition_ready を判定する。
    const realCount = parsed.data.real_exhibition_count || 0;
    const parsedScratched = Array.isArray(parsed.data.scratched_boats) ? parsed.data.scratched_boats.map(Number) : [];
    const storedScratched = Array.isArray(race.scratched_boats) ? race.scratched_boats.map(Number) : [];
    const scratchedBoats = [...new Set([...storedScratched, ...parsedScratched])].filter((n: any) => n >= 1 && n <= 6).sort((a: any,b: any) => a-b);
    const activeBoatCount = parsed.data.active_boat_count || Math.max(1, 6 - scratchedBoats.length);
    const complete = isSavedExhibitionComplete(entries, scratchedBoats);
    const raceUpdate: any = {};
    if (JSON.stringify(storedScratched) !== JSON.stringify(scratchedBoats)) raceUpdate.scratched_boats = scratchedBoats;
    if (race.exhibition_ready !== complete) raceUpdate.exhibition_ready = complete;
    for (const field of ['weather','wind_speed','water_temp','air_temp','wave_height']) {
      const value = parsed.data[field];
      if (value != null && value !== '' && race[field] !== value) raceUpdate[field] = value;
    }
    if (criticalChanged && race.has_final) {
      raceUpdate.final_refresh_required = true;
      raceUpdate.final_refresh_reason = 'EXHIBITION_CHANGED';
      raceUpdate.final_refresh_requested_at = new Date().toISOString();
    }
    let raceSaved = true;
    if (Object.keys(raceUpdate).length) {
      try {
        await withRateLimitRetry(() => sr.Race.update(race.id, raceUpdate), 1);
        Object.assign(race, raceUpdate);
      } catch (e: any) {
        raceSaved = false;
        errors.push(`${venueName} R${raceNumber}: 展示保存 ${e.message}`);
      }
    }
    // Recheck complete saved values even when the source has not changed.
    if (complete && raceSaved && deadlineMs > Date.now() + 90000) forecastReadyKeys.add(race.race_key);
    if (updated > 0 || complete) {
      fetched++;
      logs.push(`${venueName} R${raceNumber}: 展示${updated}艇更新 / 保存済み${complete?'全艇確認':'一部不足'} (取得${realCount}/${activeBoatCount})`);
    }

    await sleep(300);
  }

  // Scheduled collection continues directly into the V8 workflow step.
  // Manual exhibition collection uses only its remaining budget for saved V8 forecasts.
  let v8: any = null;
  if (forecastReadyKeys.size && !options.deferForecasts) {
    v8 = await runV8LiveGeneration(base44, {
      race_keys: [...forecastReadyKeys], deadlineMs: startTime + timeBudgetMs,
    });
    logs.push(`V8: 展示後予想 ${Number(v8?.v8?.final || 0)}R保存`);
    if (v8.ok === false) errors.push(`V8予想保存: ${v8.error || 'failed'}`);
  }
  return { total: races.length, fetched, ready_keys: [...forecastReadyKeys], forecasts: v8, errors };
}

// =====================================================
// STEP 5: 完全性チェック
// =====================================================
async function checkCompleteness(base44: any, raceDate: string, logs: string[]) {
  const sr = base44.asServiceRole.entities;
  const races = uniqueRacesByKey(await sr.Race.filter({ race_date: raceDate }, 'deadline', 5000).catch(() => []));
  const entries = await sr.RaceEntry.filter({ race_date: raceDate }, 'boat_number', 5000).catch(() => []);
  const results = await sr.RaceResult.filter({ race_id: { $in: races.map((r: any) => r.id) } }, '-finished_at', 600).catch(() => []);
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
  // V8 no longer maintain the retired Race.has_pre flag.
  // Count persisted V8 hypotheses so the admin status matches the current forecast store.
  const savedPre = await readV8Rows(sr.V8RaceForecast,
    {race_date: raceDate, stage: {$in: ['DAY_BEFORE', 'PRE']}},
    {budget: Date.now() + 10000, maxPages: 12});
  const raceIds = new Set(races.map((race: any) => race.id));
  const preCount = new Set(savedPre.filter((row: any) => raceIds.has(row.race_id)).map((row: any) => row.race_id)).size;

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

    const status = result.ok === false || result.errors?.length > 0 ? 'partial' : 'success';
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
// STEP 9: 枠番過去10走事前計算
// =====================================================
async function precomputeLanePast10(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities;
  const startTime = Date.now();
  const races = await withRateLimitRetry(() => sr.Race.filter({ race_date: raceDate }, 'race_number', 300).catch(() => []));
  let processed = 0, skipped = 0;

  for (const race of races) {
    if (Date.now() - startTime > timeBudgetMs - 5000) {
      logs.push(`事前計算: 時間予算到達 — 残り${races.length - processed - skipped}R`);
      break;
    }
    if (race.status === 'finished' || race.status === 'cancelled') { skipped++; continue; }

    // キャッシュ確認
    try {
      const cached = await withRateLimitRetry(() =>
        sr.RacerLaneRecentStats.filter({ race_id: race.id }, '-updated_at', 6), 2
      ).catch(() => []);
      if (cached && cached.length >= 6) { skipped++; continue; }
    } catch {}

    // 6艇取得
    const entries = await withRateLimitRetry(() =>
      sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6), 3
    ).catch(() => []);
    if (!entries || entries.length < 6) { skipped++; continue; }

    const reqEntries = entries
      .map((e: any) => ({
        registration_number: String(e.register_number || e.registration_number || ''),
        lane: Number(e.boat_number),
      }))
      .filter((x: any) => /^\d{4}$/.test(x.registration_number) && x.lane >= 1 && x.lane <= 6);
    if (reqEntries.length < 6) { skipped++; continue; }

    try {
      const raceContext = { race_id: race.id, venue_code: race.venue_code, race_number: race.race_number };
      const { logs: calcLogs } = await computeLanePast10Stats(sr, reqEntries, race.race_date, raceContext);
      for (const l of calcLogs) console.log(l);
      processed++;
      logs.push(`${race.venue_name || race.venue_code} R${race.race_number}: 枠番過去10走事前計算完了`);
    } catch (e: any) {
      errors.push(`事前計算 ${race.venue_code} R${race.race_number}: ${e.message}`);
    }
    await sleep(500);
  }

  logs.push(`事前計算: ${processed}R処理 / ${skipped}Rスキップ`);
  return { total: races.length, processed, skipped, errors };
}

// =====================================================
// メイン: Autoモード
// =====================================================
// Live V8 pricing only. Legacy prediction expansion is not part of this path.
async function fetchLiveOdds(base44: any, raceDate: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities, started = Date.now();
  const races = selectLiveInputRaces(uniqueRacesByKey(await sr.Race.filter({ race_date: raceDate }, 'deadline', 500)), started, { horizonMinutes: 25 });
  const ready = new Set<string>();
  let saved = 0;
  for (const race of races) {
    if (Date.now() >= started + timeBudgetMs) break;
    if (new Date(race.deadline).getTime() <= Date.now() + 90000) continue;
    try {
      const res = await fetchHtml(buildUrl('odds3t', raceDate, race.venue_code, race.race_number), 0, { timeoutMs: 6000, deadlineMs: started + timeBudgetMs });
      if (!res.ok) { errors.push(`${race.race_key}: オッズ取得 ${res.status || res.error}`); continue; }
      const oddsMap = parseOdds3t(res.html);
      const active = 6 - new Set((race.scratched_boats || []).map(Number).filter((n: number) => n >= 1 && n <= 6)).size;
      if (active < 3) continue;
      if (Object.keys(oddsMap).length < Math.min(100, active * (active - 1) * (active - 2))) continue;
      const capturedAt = new Date().toISOString();
      if (new Date(race.deadline).getTime() <= Date.now() + 60000) continue;
      const previous = await sr.OddsSnapshot.filter({ race_id: race.id, stage: 'FINAL' }, '-captured_at', 1);
      const prior = previous?.[0];
      const changed = !prior || Object.entries(oddsMap).some(([key,value]) => Number(prior.odds_map?.[key]) !== Number(value));
      const age = prior ? Date.now() - new Date(prior.captured_at).getTime() : Infinity;
      // A fresh observation with identical prices must not retain an expired timestamp.
      if (changed || !Number.isFinite(age) || age >= 180000) {
        if (!prior) {
          const early = await sr.OddsSnapshot.filter({ race_id: race.id, stage: 'EARLY' }, '-captured_at', 1);
          if (!early.length) await sr.OddsSnapshot.create({race_id:race.id,stage:'EARLY',odds_map:oddsMap,captured_at:capturedAt,source:'LOCAL'});
        }
        await sr.OddsSnapshot.create({race_id:race.id,stage:'FINAL',odds_map:oddsMap,captured_at:capturedAt,source:'LOCAL'});
        saved++;
      }
      if (race.exhibition_ready === true) ready.add(race.race_key);
    } catch (e: any) { errors.push(`${race.race_key}: V8オッズ保存 ${e?.message || e}`); }
  }
  logs.push(`V8: 締切前オッズ ${saved}R保存`);
  return { saved, ready_keys: [...ready] };
}

async function autoUpdate(base44: any, today: string, tomorrow: string, timeBudgetMs: number, logs: string[], errors: string[]) {
  const sr = base44.asServiceRole.entities, started = Date.now();
  const remaining = () => Math.max(0, timeBudgetMs - (Date.now() - started));
  const jstHour = parseInt(nowJSTTime().split(':')[0], 10), steps: string[] = [];
  const todayRaces = await sr.Race.filter({race_date:today}, 'deadline', 300);

  // Time-sensitive inputs come first. V1-V6 PRE/FINAL expansion is retired from AUTO.
  if (todayRaces.length && jstHour >= 8 && jstHour <= 22) {
    logs.push('AUTO: 締切前の展示・オッズを最優先で取得（V8）');
    const exhibition = await fetchAndSaveExhibition(base44, today, Math.min(30000, remaining()), logs, errors, {liveOnly:true,deferForecasts:true});
    steps.push(`exhibition: ${exhibition.fetched}R`);
    const odds = remaining() > 3000
      ? await fetchLiveOdds(base44, today, Math.min(18000, remaining()), logs, errors)
      : {saved:0,ready_keys:[]};
    steps.push(`live_odds: ${odds.saved}R`);
    const keys = [...new Set([...exhibition.ready_keys, ...odds.ready_keys])];
    steps.push(`forecast_inputs_ready: ${keys.length}R`);
    // The five-minute unified forecast workflow owns V7 -> V8 generation.
    // This collector saves inputs only; independent generation also covers PRE and DAY_BEFORE.
  }

  // Maintenance only uses time left after time-sensitive inputs.
  if (remaining() > 8000 && todayRaces.length && jstHour >= 8) {
    const r = await fetchAndSaveResults(base44, today, Math.min(15000, remaining()), logs, errors);
    steps.push(`today_results: ${r.fetched}R`);
  }
  if (remaining() > 8000) {
    const r = await fetchAndSaveRaceCards(base44, today, Math.min(20000, remaining()), logs, errors);
    steps.push(`today_card: +${r.races}R/+${r.entries}艇`);
  }
  if (remaining() > 8000 && jstHour >= 16) {
    const r = await fetchAndSaveRaceCards(base44, tomorrow, remaining(), logs, errors);
    steps.push(`tomorrow_card: +${r.races}R/+${r.entries}艇`);
  }
  return {steps,logs,errors};
}

// =====================================================
// エントリポイント
// =====================================================
export default async function(req: Request) {
  // 失敗時にも「どこまで進んだか」を返せるよう、ログはハンドラの外側で保持する。
  const logs: string[] = [];
  const errors: string[] = [];
  try {
    const base44 = createClientFromRequest(req);

    // 認証: 未認証は401、管理者以外は403
    // 定期実行はワークフローが作成者(管理者)として呼ぶため、この判定で通る。
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { step = 'auto' } = body;

    const today = getTodayJST();
    const tomorrow = getTomorrowJST();
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
      case 'main_pre':
        // Existing admin actions now use the same V8 engine as scheduled generation.
        if (body.race_date && ![today, tomorrow].includes(body.race_date)) {
          return Response.json({ok:false,error:'過去日の予想は全レース検証の再現処理を使用してください。'}, {status:400});
        }
        result = await runV8LiveGeneration(base44, {timeBudgetMs: TIME_BUDGET});
        logs.push('V8の事前・展示後予想を保存');
        break;
      case 'exhibition':
        result = await fetchAndSaveExhibition(base44, today, TIME_BUDGET, logs, errors);
        break;
      case 'odds_final': {
        const started = Date.now();
        const odds = await fetchLiveOdds(base44, today, 25000, logs, errors);
        const forecasts = await runV8LiveGeneration(base44, {deadlineMs: started + TIME_BUDGET});
        result = {odds_fetched: odds.saved, forecasts, ok: forecasts.ok};
        break;
      }
      case 'completeness':
        const todayStats = await checkCompleteness(base44, today, logs);
        const tomorrowStats = await checkCompleteness(base44, tomorrow, logs);
        result = { today: todayStats, tomorrow: tomorrowStats };
        break;
      case 'precompute_lane':
        result = await precomputeLanePast10(base44, body.race_date || today, TIME_BUDGET, logs, errors);
        break;
      case 'auto':
      default:
        // 429等の一時的な失敗で実行全体を失敗扱いにしない。
        // 失敗が続くとワークフロー自体が停止し、直前予想が生成されなくなるため、
        // 短い待機後に一度だけ再試行する。
        try {
          result = await autoUpdate(base44, today, tomorrow, TIME_BUDGET, logs, errors);
        } catch (e: any) {
          errors.push(`AUTO: ${e?.message || e} — 再試行`);
          await sleep(8000);
          result = await autoUpdate(base44, today, tomorrow, 45000, logs, errors);
        }
        break;
    }

    // Carry phase failures into the admin status instead of reporting a partial run as success.
    const phaseErrors = result?.errors || result?.forecasts?.errors || [];
    if (Array.isArray(phaseErrors)) for (const item of phaseErrors) {
      const message = typeof item === 'string' ? item : `${item?.phase || 'V8'}: ${item?.reason || item?.error || '処理未完了'}`;
      if (!errors.includes(message)) errors.push(message);
    }
    if (result?.ok === false && errors.length === 0) errors.push(result.error || 'V8予想の一部が未完了です。');

    // ステータス更新
    await updateAutoUpdateStatus(base44, today, tomorrow, step, { ...result, errors });

    return Response.json({
      ...result,
      ok: result?.ok !== false && errors.length === 0,
      step,
      today,
      tomorrow,
      jst_time: nowJSTTime(),
      logs,
      errors,
    });
  } catch (error: any) {
    // 失敗時もログを返し、どのステップで止まったかを追えるようにする。
    return Response.json({ ok: false, error: error.message, logs, errors }, { status: 500 });
  }
}
