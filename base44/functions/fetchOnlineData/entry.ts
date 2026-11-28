// 共通取得処理はページ形式({items,next_cursor,has_more})を使うため0.8.60で実行する
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.60';
import { upsertResultAndVerify } from '../../shared/predictionService.js';
import { buildRaceKey } from '../../shared/raceKey.js';
import { runV8LiveGeneration } from '../../shared/v8LiveGeneration.js';
import { readV8Rows } from '../../shared/v8Repository.js';
import { buildCommittedExhibitionKey } from '../../shared/exhibitionInputKey.js';
import { fetchOriginalExhibition } from '../../shared/originalExhibition.js';
import { fetchExhibitionSource } from '../../shared/exhibitionSource.js';
import { fetchHtml, parseResult, parseOdds3t, parseRaceCard, buildUrl, VENUE_MAP } from '../../shared/boatraceOfficialParser.js';

const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');

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

// === エラー繰り返し防止: 直近5分以内の同レース同fetch_typeの失敗をスキップ ===
async function shouldSkipRecentFailure(base44: any, fetchType: string, raceDate: string, venueCode: string, raceNumber: number): Promise<boolean> {
  const sr = base44.asServiceRole.entities;
  try {
    const logs = await sr.OnlineFetchLog.filter(
      { fetch_type: fetchType, race_date: raceDate, venue_code: venueCode, race_number: raceNumber,
        status: {$in:['success','failed','no_data','not_ready']} },
      '-fetched_at', 3
    );
    const last = Array.isArray(logs) ? logs[0] : logs?.items?.[0];
    if (!last) return false;
    // An old primary-only 403 must not suppress the newly available official
    // alternative. Failures after both sources were attempted keep the cooldown.
    if (fetchType === 'exhibition' && last.http_status === 403 && /^HTTP 403$/.test(last.error_message || '')) return false;
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
  const entryRows = await sr.RaceEntry.filter({ race_key: race.race_key }, '-updated_date', 100).catch(() => []);
  const existingEntries = uniqueEntriesByBoat(entryRows);
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
// A complete confirmed collection is committed before the V8 worker reads it.
async function processExhibition(base44: any, race: any, parsed: any, source: any) {
  const sr = base44.asServiceRole.entities;
  const parsedEntries = parsed.entries || [];
  const existingEntries = await readV8Rows(sr.RaceEntry, {race_key:race.race_key},
    {budget:Date.now()+8000,maxPages:2,sort:'-updated_date'});
  const present = (value: any) => value != null && String(value).trim() !== '';
  const registration = (entry: any) => {
    const values = [entry?.registration_number,entry?.register_number].filter(present).map((value: any)=>String(value).trim());
    return values.length && values.every((value: string)=>/^\d{4}$/.test(value)) && new Set(values).size===1 ? values[0] : null;
  };
  if (existingEntries.length!==6 || existingEntries.some((entry: any)=>!entry.id || entry.race_id!==race.id || entry.race_key!==race.race_key
      || (present(entry.race_date) && entry.race_date!==race.race_date)
      || !Number.isInteger(Number(entry.boat_number)) || Number(entry.boat_number)<1 || Number(entry.boat_number)>6 || !registration(entry))
    || new Set(existingEntries.map((entry: any)=>Number(entry.boat_number))).size!==6
    || new Set(existingEntries.map(registration)).size!==6) throw new Error('EXHIBITION_ROSTER_UNCONFIRMED');
  const entryByBoat = new Map(existingEntries.map((e: any) => [Number(e.boat_number), e]));
  if (!Array.isArray(parsedEntries) || new Set(parsedEntries.map((entry: any)=>Number(entry.boat_number))).size!==parsedEntries.length
    || parsedEntries.some((entry: any)=>{
      const stored=entryByBoat.get(Number(entry.boat_number));
      return !stored || ['race_id','race_key','race_date'].some(key=>present(entry[key]) && entry[key]!==race[key==='race_id'?'id':key])
        || ([entry.registration_number,entry.register_number].some(present) && registration(entry)!==registration(stored))
        || ['is_absent','is_scratched'].some(key=>entry[key]!=null && typeof entry[key]!=='boolean');
    })) throw new Error('EXHIBITION_SOURCE_IDENTITY_MISMATCH');
  // Associate only roster identity. Never fill a missing source observation from
  // older saved values, even if those old rows happen to look complete.
  const sourceEntries=parsedEntries.map((entry: any)=>({...entry,race_id:race.id,race_key:race.race_key,
    registration_number:registration(entryByBoat.get(Number(entry.boat_number))),
    exhibition_st_raw:entry.exhibition_st_raw ?? entry.exhibition_st}));

  let updated = 0;
  for (const pe of parsedEntries) {
    const bn = num(pe.boat_number);
    if (!bn) continue;
    const existing = entryByBoat.get(bn);
    if (!existing) continue;

    // 保護付き更新: nullで既存値を上書きしない
    const update: any = {};
    for (const field of ['exhibition_time','exhibition_st','exhibition_course','tilt']) {
      if (present(pe[field]) && String(existing[field])!==String(pe[field])) update[field]=pe[field];
    }
    const rawStart=pe.exhibition_st_raw ?? pe.exhibition_st;
    if (present(rawStart) && String(existing.exhibition_st_raw)!==String(rawStart)) update.exhibition_st_raw=rawStart;
    if (pe.is_absent || pe.is_scratched) {
      if (existing.is_absent!==true) update.is_absent=true;
      if (existing.is_scratched!==true) update.is_scratched=true;
    }

    if (Object.keys(update).length) {
      const savedEntry=await sr.RaceEntry.update(existing.id, update);
      if (savedEntry?.id!==existing.id) throw new Error('EXHIBITION_ENTRY_SAVE_UNCONFIRMED');
      Object.assign(existing,update);
      updated++;
    }
  }

  // Commit the source-equivalent saved inputs and READY in one Race write.
  // A partial source leaves the last complete marker and READY state intact.
  const realCount = parsed.real_exhibition_count || 0;
  const parsedScratched = Array.isArray(parsed.scratched_boats) ? parsed.scratched_boats.map(Number) : [];
  const storedScratched = Array.isArray(race.scratched_boats) ? race.scratched_boats.map(Number) : [];
  const scratchedBoats = [...new Set([...storedScratched, ...parsedScratched])].filter((n: any) => n >= 1 && n <= 6).sort((a: any,b: any) => a-b);
  const activeBoatCount = parsed.active_boat_count || Math.max(1, 6 - scratchedBoats.length);
  const commitRace={...race,scratched_boats:scratchedBoats};
  const sourceKey=buildCommittedExhibitionKey(commitRace,sourceEntries);
  const savedKey=buildCommittedExhibitionKey(commitRace,existingEntries);
  const sourceCommitted=sourceKey!=null && sourceKey===savedKey;
  const original = await fetchOriginalExhibition({
    race:commitRace,entries:existingEntries,exhibitionEntries:parsedEntries,
    exhibitionSourceUrl:source.url,exhibitionCapturedAt:source.captured_at,
    deadlineMs:Date.now()+2500,
  });
  const raceUpdate: any = { original_exhibition: original.snapshot };
  if (scratchedBoats.length) raceUpdate.scratched_boats = scratchedBoats;
  if (sourceCommitted) {
    raceUpdate.exhibition_ready=true;
    if (source.provider) raceUpdate.exhibition_collection={...source,revision:'EXHIBITION_SOURCE_2',input_key:sourceKey};
    const committedAt=Date.parse(race.exhibition_committed_at || '');
    if (race.exhibition_input_key!==sourceKey || !Number.isFinite(committedAt) || committedAt>Date.now()) {
      raceUpdate.exhibition_input_key=sourceKey;
      raceUpdate.exhibition_committed_at=new Date().toISOString();
    }
  }
  if (parsed.weather) raceUpdate.weather = parsed.weather;
  if (parsed.wind_speed != null) raceUpdate.wind_speed = parsed.wind_speed;
  if (parsed.water_temp != null) raceUpdate.water_temp = parsed.water_temp;
  if (parsed.air_temp != null) raceUpdate.air_temp = parsed.air_temp;
  if (parsed.wave_height != null) raceUpdate.wave_height = parsed.wave_height;
  const savedRace=await sr.Race.update(race.id, raceUpdate);
  if (savedRace?.id!==race.id) throw new Error('EXHIBITION_RACE_SAVE_UNCONFIRMED');
  Object.assign(race,raceUpdate);

  // Save V8's own forecast immediately after this race's exhibition is saved.
  const forecasts = sourceCommitted
    ? await runV8LiveGeneration(base44, { race_keys: [race.race_key], timeBudgetMs: 30000 })
    : null;

  return {
    entries_updated: updated,
    exhibition_ready: race.exhibition_ready===true,
    exhibition_committed: sourceCommitted,
    real_exhibition_count: realCount,
    active_boat_count: activeBoatCount,
    original_exhibition_status: original.snapshot.status,
    original_exhibition_reasons: original.snapshot.reasons,
    forecasts,
  };
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
    captured_at: new Date().toISOString(), source: 'LOCAL',
  });

  // Legacy predictions are retired. V8 reads the persisted quote as reference.
  const forecasts = race.exhibition_ready
    ? await runV8LiveGeneration(base44, { race_keys: [race.race_key], timeBudgetMs: 30000 })
    : null;
  return { odds_count: oddsCount, forecasts };
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
    payouts: result.payouts || null,
    fetched_at: new Date().toISOString(),
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

    let parsed: any;
    let sourceCapturedAt: string;
    let exhibitionSource: any = null;
    if (fetch_type === 'exhibition') {
      const sourceBudget = Date.now()+12000;
      const entries = await readV8Rows(sr.RaceEntry,{race_key:race.race_key},
        {budget:Math.min(sourceBudget,Date.now()+4000),maxPages:2,sort:'-updated_date'});
      const acquired = await fetchExhibitionSource({race,entries,deadlineMs:sourceBudget});
      if (!acquired.ok) {
        await sr.OnlineFetchLog.create({fetch_type,race_id:race.id,race_date,venue_code:vc,race_number:rn,
          status:'no_data',fetched_at:now,http_status:acquired.http_status||0,
          error_message:'EXHIBITION_SOURCES_UNAVAILABLE: '+acquired.reason});
        return Response.json({ok:false,status:'no_data',message:'公式展示の取得を完了できませんでした。次回再取得します。',reason:acquired.reason});
      }
      parsed=acquired.data;sourceCapturedAt=acquired.source.captured_at;
      exhibitionSource={...acquired.source,primary_http_status:acquired.primary_http_status};
    } else {
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

    sourceCapturedAt = new Date().toISOString();
    // 決定論的HTML解析(InvokeLLM不使用)
    try {
      if (fetch_type === 'section') {
        const venueName = race.venue_name || race.venue || VENUE_MAP[vc] || vc;
        const p = parseRaceCard(fetchRes.html, race_date, vc, venueName, rn);
        if (!p.ok) throw new Error((p.errors || []).join('; ') || '節間成績解析失敗');
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

    }

    // データ処理
    try {
      let resultData: any = {};
      switch (fetch_type) {
        case 'section':
          resultData = await processSection(base44, race, parsed);
          break;
        case 'exhibition':
          resultData = await processExhibition(base44, race, parsed, exhibitionSource || { url, captured_at: sourceCapturedAt });
          break;
        case 'odds':
          resultData = await processOdds(base44, race, parsed);
          break;
        case 'result':
          resultData = await processResult(base44, race, parsed);
          break;
      }

      // HTTP 200やHTML解析成功だけではsuccessにしない。
      // 対象データがDBへ必要量保存された時だけsuccessとする。
      let notReadyReason = '';
      if (fetch_type === 'section' && Number(resultData.entries_updated || 0) < 1) {
        notReadyReason = '節間成績の保存件数が0件';
      } else if (fetch_type === 'exhibition' && (resultData.exhibition_ready !== true || resultData.exhibition_committed !== true)) {
        notReadyReason = `今回取得した展示データの保存未完了: ${Number(resultData.real_exhibition_count || 0)}/${Number(resultData.active_boat_count || 6)}艇`;
      } else if (fetch_type === 'odds' && Number(resultData.odds_count || 0) < 120) {
        notReadyReason = `3連単オッズ未完了: ${Number(resultData.odds_count || 0)}/120組`;
      } else if (fetch_type === 'result' && !resultData.result_trifecta) {
        notReadyReason = '3連単結果が未確定';
      }

      if (notReadyReason) {
        await sr.OnlineFetchLog.create({
          fetch_type, race_id: race.id, race_date, venue_code: vc, race_number: rn,
          status: 'not_ready', fetched_at: now, http_status: 200, error_message: notReadyReason,
        });
        return Response.json({ ok: false, status: 'not_ready', fetch_type, race_id: race.id, ...resultData, message: notReadyReason });
      }

      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: vc, race_number: rn,
        status: 'success', fetched_at: now, http_status: 200,
      });

      return Response.json({
        ok: true, status: 'success', fetch_type, race_id: race.id,
        ...resultData,
        message: `${fetch_type}データ取得・DB保存完了`,
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
