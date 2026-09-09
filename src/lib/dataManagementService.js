// BOAT WORKS 2 データ管理サービス層
// ファイル取込・オンライン取得・ダッシュボード・履歴参照
import { base44 } from "@/api/base44Client";
import { todayStr } from "@/lib/predictionService";
import { parseRacerTermFile, detectTermFromFilename } from "@/lib/racerTermParser";

// === ファイル取込 ===
export async function importOfficialFile(importType, file) {
  const { file_url } = await base44.integrations.Core.UploadFile({ file });
  return await base44.functions.invoke("importOfficialFile", {
    import_type: importType,
    file_url,
    file_name: file.name,
  });
}

// 複数ファイル一括取込
export async function importOfficialFiles(importType, files) {
  const results = [];
  for (const file of files) {
    try {
      const r = await importOfficialFile(importType, file);
      results.push({ file: file.name, ok: true, ...r.data });
    } catch (e) {
      results.push({ file: file.name, ok: false, error: e.message });
    }
  }
  return results;
}

// === 競艇オフィシャルTXT(B/K)保存 ===
// 全国1日分を1回で送ると、144R/864艇 + 予想生成でFunctionがタイムアウトしやすい。
// そのため会場単位で順番に保存し、結果を集計する。
export async function saveBoatraceData(dataType, parsedData, fileName, onProgress = null) {
  const venues = parsedData?.venues || [];

  // 旧形式や単一会場データは従来通り1回で保存
  if (!venues.length) {
    return await base44.functions.invoke("saveBoatraceData", {
      data_type: dataType,
      parsed_data: parsedData,
      file_name: fileName,
    });
  }

  // B番組表は再投入時に全864艇を更新し直さない。
  // 同一race_keyで6艇の登録番号まで一致しているRaceは完全既存としてクライアント側で除外する。
  let venuesToSave = venues;
  let completeRaceCount = 0;
  const sourceRaceCount = venues.reduce((sum, v) => sum + (v.races || []).length, 0);

  if (dataType === "B" && parsedData.race_date) {
    const [existingRaces, existingEntries] = await Promise.all([
      base44.entities.Race.filter({ race_date: parsedData.race_date }, "race_key", 500),
      base44.entities.RaceEntry.filter({ race_date: parsedData.race_date }, "boat_number", 5000),
    ]);

    const raceKeys = new Set((existingRaces || []).map((r) => r.race_key).filter(Boolean));
    const existingByKey = new Map();
    for (const e of existingEntries || []) {
      if (!e.race_key) continue;
      if (!existingByKey.has(e.race_key)) existingByKey.set(e.race_key, new Map());
      existingByKey.get(e.race_key).set(Number(e.boat_number), String(e.registration_number || e.register_number || ""));
    }

    const makeKey = (venueCode, raceNumber) =>
      `${parsedData.race_date}_${String(venueCode).padStart(2, "0")}_${String(raceNumber).padStart(2, "0")}`;

    venuesToSave = venues.map((venue) => {
      const races = (venue.races || []).filter((race) => {
        const key = makeKey(venue.venue_code, race.race_number);
        if (!raceKeys.has(key)) return true;
        const current = existingByKey.get(key);
        if (!current || current.size < 6) return true;

        // 6艇すべて存在し、艇番ごとの登録番号が今回のBファイルと一致する場合だけ完全既存。
        for (const incoming of race.entries || []) {
          const boat = Number(incoming.boat_number);
          const reg = String(incoming.registration_number || "");
          if (!boat || !reg || current.get(boat) !== reg) return true;
        }
        if ((race.entries || []).length !== 6) return true;
        completeRaceCount++;
        return false;
      });
      return { ...venue, races };
    }).filter((venue) => venue.races.length > 0);

    // 全レースが既に完全ならバックエンドFunctionを1回も呼ばず終了。
    if (venuesToSave.length === 0) {
      return {
        data: {
          ok: true,
          data_type: dataType,
          created: 0,
          updated: 0,
          skipped: completeRaceCount,
          errors: 0,
          total: sourceRaceCount,
          completeRaces: completeRaceCount,
          savedRaces: 0,
          errorDetails: [],
          venueResults: [],
          message: `差分確認完了: ${venues.length}場 / ${sourceRaceCount}R中 ${completeRaceCount}R既存完全 / 追加更新0R / エラー0`,
        },
      };
    }
  }

  const aggregate = {
    ok: true,
    data_type: dataType,
    created: 0,
    updated: 0,
    skipped: completeRaceCount,
    errors: 0,
    total: sourceRaceCount,
    completeRaces: completeRaceCount,
    savedRaces: 0,
    errorDetails: [],
    venueResults: [],
  };

  for (let i = 0; i < venuesToSave.length; i++) {
    const venue = venuesToSave[i];
    const chunk = {
      type: dataType,
      race_date: parsedData.race_date,
      venues: [venue],
    };

    try {
      const resp = await base44.functions.invoke("saveBoatraceData", {
        data_type: dataType,
        parsed_data: chunk,
        file_name: fileName,
        suppress_prediction_during_import: true,
      });
      const d = resp?.data || {};
      aggregate.created += d.created || 0;
      aggregate.updated += d.updated || 0;
      aggregate.errors += d.errors || 0;
      aggregate.savedRaces += d.total || 0;
      if (d.errorDetails?.length) aggregate.errorDetails.push(...d.errorDetails);
      aggregate.venueResults.push({
        venue_code: venue.venue_code,
        venue_name: venue.venue_name,
        ok: true,
        created: d.created || 0,
        updated: d.updated || 0,
        skipped: d.skipped || 0,
        errors: d.errors || 0,
        races: d.total || 0,
      });
    } catch (e) {
      aggregate.ok = false;
      aggregate.errors += 1;
      const msg = `${venue.venue_name || venue.venue_code}: ${e?.response?.data?.error || e.message}`;
      aggregate.errorDetails.push(msg);
      aggregate.venueResults.push({
        venue_code: venue.venue_code,
        venue_name: venue.venue_name,
        ok: false,
        error: msg,
      });
    }

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: venuesToSave.length,
        venue_code: venue.venue_code,
        venue_name: venue.venue_name,
      });
    }

    if (i < venuesToSave.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  if (dataType === "B") {
    aggregate.message = `差分取込完了: ${venues.length}場 / ${sourceRaceCount}R中 ${aggregate.completeRaces}R既存完全 / ${aggregate.savedRaces}R追加更新 / エラー${aggregate.errors}`;
  } else {
    aggregate.message = `全国取込完了: ${venues.length}場 / ${aggregate.savedRaces}R / 更新${aggregate.updated} / エラー${aggregate.errors}`;
  }
  return { data: aggregate };
}

// === オンライン取得 ===
export async function fetchOnlineData(fetchType, raceDate, venueCode, raceNumber, raceId = null) {
  return await base44.functions.invoke("fetchOnlineData", {
    fetch_type: fetchType,
    race_date: raceDate,
    venue_code: venueCode,
    race_number: raceNumber,
    race_id: raceId,
  });
}

// 対象レース一覧取得(今日)
export async function listTodayRacesForFetch() {
  const date = todayStr();
  const races = await base44.entities.Race.filter({ race_date: date }, "race_number", 500);
  return races || [];
}

// === 取込履歴 ===
export async function getDataImportLogs(limit = 20) {
  return await base44.entities.DataImportLog.list("-imported_at", limit);
}

// === 取得履歴 ===
export async function getOnlineFetchLogs(limit = 20) {
  return await base44.entities.OnlineFetchLog.list("-fetched_at", limit);
}

// === 今日のダッシュボードデータ ===
export async function getDashboardData() {
  const date = todayStr();
  const [races, entries, importLogs, fetchLogs] = await Promise.all([
    base44.entities.Race.filter({ race_date: date }, "-deadline", 500),
    base44.entities.RaceEntry.filter({ race_date: date }, "boat_number", 5000),
    base44.entities.DataImportLog.list("-imported_at", 5),
    base44.entities.OnlineFetchLog.list("-fetched_at", 10),
  ]);

  // race_key / race_key+boat_number で表示側も重複除外する。
  // 取込途中の一時重複や古いテストデータが残ってもダッシュボード件数を誤表示しない。
  const raceMap = new Map();
  for (const r of (races || [])) {
    const key = r.race_key || `${r.race_date}_${r.venue_code}_${r.race_number}`;
    if (!raceMap.has(key)) raceMap.set(key, r);
  }
  const raceList = [...raceMap.values()];

  const validRaceKeys = new Set(raceList.map((r) => r.race_key).filter(Boolean));
  const entryMap = new Map();
  for (const e of (entries || [])) {
    if (e.race_key && validRaceKeys.size && !validRaceKeys.has(e.race_key)) continue;
    const key = `${e.race_key || e.race_id}_${Number(e.boat_number)}`;
    if (!entryMap.has(key)) entryMap.set(key, e);
  }
  const entryList = [...entryMap.values()];
  const totalRaces = raceList.length;
  const totalEntries = entryList.length;
  const expectedEntries = totalRaces * 6;

  const venues = new Set(raceList.map((r) => r.venue_code).filter(Boolean));
  const exhibitionReady = raceList.filter((r) => r.exhibition_ready).length;
  const finished = raceList.filter((r) => r.status === "finished").length;
  const hasPre = raceList.filter((r) => r.has_pre).length;
  const hasFinal = raceList.filter((r) => r.has_final).length;

  // BUY/WATCH/SKIP集計(Raceのfinal_judgment)
  const buyCount = raceList.filter((r) => r.final_judgment === "STRONG_BUY" || r.final_judgment === "BUY").length;
  const watchCount = raceList.filter((r) => r.final_judgment === "WATCH").length;
  const skipCount = raceList.filter((r) => r.final_judgment === "SKIP").length;

  // オッズ取得済数(OddsSnapshotから今日のrace_idでユニークカウント)
  let oddsReady = 0;
  try {
    const oddsSnapshots = await base44.entities.OddsSnapshot.list("-captured_at", 500);
    const raceIds = new Set(raceList.map((r) => r.id));
    oddsReady = new Set((oddsSnapshots || []).filter((o) => raceIds.has(o.race_id)).map((o) => o.race_id)).size;
  } catch {}

  // エラー数(今日のOnlineFetchLogでfailed)
  const todayFetchErrors = (fetchLogs || []).filter(
    (l) => l.status === "failed" && l.race_date === date
  ).length;

  return {
    date,
    venues: venues.size,
    totalRaces,
    totalEntries,
    expectedEntries,
    exhibitionReady,
    oddsReady,
    finished,
    hasPre,
    hasFinal,
    buyCount,
    watchCount,
    skipCount,
    fetchErrors: todayFetchErrors,
    recentImports: importLogs || [],
    recentFetchLogs: fetchLogs || [],
  };
}

// === 選手期別成績パース＋プレビュー ===
export async function parseRacerTermFileForPreview(file) {
  const arrayBuffer = await file.arrayBuffer();
  return parseRacerTermFile(arrayBuffer, file.name);
}

// === 選手期別成績DB保存（バッチ処理・再開可能） ===
export async function saveRacerTermStats(parsedData, fileName, termOverride = null) {
  const records = parsedData.records || [];
  if (!records.length) return { ok: false, error: "レコードが空です" };

  let offset = 0;
  const batchSize = 500;
  let logId = null;
  let totalCreated = 0, totalUpdated = 0, totalErrors = 0;
  const allErrorDetails = [];

  while (offset < records.length) {
    const resp = await base44.functions.invoke("importRacerTermStats", {
      records,
      file_name: fileName,
      term_override: termOverride,
      batch_offset: offset,
      batch_size: batchSize,
      log_id: logId,
    });
    const d = resp.data;
    if (!d.ok) throw new Error(d.error || "取込失敗");
    totalCreated += d.created || 0;
    totalUpdated += d.updated || 0;
    totalErrors += d.errors || 0;
    if (d.error_details?.length) allErrorDetails.push(...d.error_details);
    logId = d.log_id;
    if (d.completed || !d.next_offset) break;
    offset = d.next_offset;
  }

  return {
    ok: true,
    created: totalCreated,
    updated: totalUpdated,
    errors: totalErrors,
    error_details: allErrorDetails.slice(0, 50),
    total: records.length,
    log_id: logId,
  };
}

// === ローリング統計再計算（バッチ処理） ===
export async function rebuildRollingStats(onProgress = null) {
  let offset = 0;
  const batchSize = 500;
  let totalComputed = 0, totalCreated = 0, totalUpdated = 0;
  let totalCount = 0;

  while (true) {
    const resp = await base44.functions.invoke("buildRollingStats", {
      batch_offset: offset,
      batch_size: batchSize,
    });
    const d = resp.data;
    if (!d.ok) throw new Error(d.error || "再計算失敗");
    totalComputed += d.computed || 0;
    totalCreated += d.created || 0;
    totalUpdated += d.updated || 0;
    totalCount = d.total || totalCount;
    if (onProgress) onProgress({ processed: d.processed, total: totalCount });
    if (d.completed || !d.next_offset) break;
    offset = d.next_offset;
  }

  return { ok: true, computed: totalComputed, created: totalCreated, updated: totalUpdated, total: totalCount };
}

// === 選手データ管理ダッシュボード ===
export async function getRacerDataDashboard() {
  const [termStats, profiles, rollingStats] = await Promise.all([
    base44.entities.RacerTermStats.list('registration_number', 500),
    base44.entities.RacerProfile.list('registration_number', 500),
    base44.entities.RacerRollingStats.list('registration_number', 500),
  ]);

  const termList = termStats || [];
  const profileList = profiles || [];
  const rollingList = rollingStats || [];

  // 期別サマリー
  const termSet = new Set();
  const termMap = new Map(); // term_key -> count
  for (const t of termList) {
    termSet.add(t.term_key);
    termMap.set(t.term_key, (termMap.get(t.term_key) || 0) + 1);
  }
  const sortedTerms = [...termSet].sort();

  // 2002年前期から現在までの全期リスト生成
  const allTerms = [];
  for (let year = 2002; year <= new Date().getFullYear(); year++) {
    allTerms.push({ term_key: `${year}_FIRST`, term_year: year, term_half: "FIRST", label: `${year}前期` });
    allTerms.push({ term_key: `${year}_SECOND`, term_year: year, term_half: "SECOND", label: `${year}後期` });
  }
  const termStatus = allTerms.map((t) => ({
    ...t,
    imported: termSet.has(t.term_key),
    count: termMap.get(t.term_key) || 0,
  }));

  // 最新取込日
  const importDates = termList.map((t) => t.imported_at).filter(Boolean).sort().reverse();
  const latestImport = importDates[0] || null;

  return {
    total_racers: profileList.length,
    profile_count: profileList.length,
    term_stats_count: termList.length,
    rolling_stats_count: rollingList.length,
    oldest_term: sortedTerms[0] || null,
    latest_term: sortedTerms[sortedTerms.length - 1] || null,
    imported_term_count: termSet.size,
    latest_import_at: latestImport,
    term_status: termStatus,
  };
}

// === 選手詳細データ取得 ===
export async function getRacerDetailData(registrationNumber) {
  const [termStats, rollingStats, profile, history] = await Promise.all([
    base44.entities.RacerTermStats.filter({ registration_number: registrationNumber }, 'term_year', 100),
    base44.entities.RacerRollingStats.filter({ registration_number: registrationNumber }, '-calculated_at', 1),
    base44.entities.RacerProfile.filter({ registration_number: registrationNumber }, '-updated_at', 1),
    base44.entities.RacerRaceHistory.filter({ registration_number: registrationNumber }, '-race_date', 200),
  ]);

  return {
    profile: profile?.[0] || null,
    termStats: (termStats || []).sort((a, b) => {
      const ka = `${a.term_year}_${a.term_half === "FIRST" ? "0" : "1"}`;
      const kb = `${b.term_year}_${b.term_half === "FIRST" ? "0" : "1"}`;
      return ka.localeCompare(kb);
    }),
    rollingStats: rollingStats?.[0] || null,
    history: history || [],
  };
}