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

  const aggregate = {
    ok: true,
    data_type: dataType,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    total: 0,
    errorDetails: [],
    venueResults: [],
  };

  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i];
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
      aggregate.skipped += d.skipped || 0;
      aggregate.errors += d.errors || 0;
      aggregate.total += d.total || 0;
      if (d.errorDetails?.length) aggregate.errorDetails.push(...d.errorDetails);
      aggregate.venueResults.push({
        venue_code: venue.venue_code,
        venue_name: venue.venue_name,
        ok: true,
        created: d.created || 0,
        updated: d.updated || 0,
        skipped: d.skipped || 0,
        errors: d.errors || 0,
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
        total: venues.length,
        venue_code: venue.venue_code,
        venue_name: venue.venue_name,
      });
    }

    // 会場間でも少し休止し、Base44 Function/Entity APIのレート制限を回避する。
    if (i < venues.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }

  aggregate.message = `全国取込完了: ${venues.length}場 / ${aggregate.total}R / 更新${aggregate.updated} / スキップ${aggregate.skipped} / エラー${aggregate.errors}`;
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

  const raceList = races || [];
  const entryList = entries || [];
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