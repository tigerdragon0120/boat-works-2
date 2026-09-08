// BOAT WORKS 2 データ管理サービス層
// ファイル取込・オンライン取得・ダッシュボード・履歴参照
import { base44 } from "@/api/base44Client";
import { todayStr } from "@/lib/predictionService";

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
export async function saveBoatraceData(dataType, parsedData, fileName) {
  return await base44.functions.invoke("saveBoatraceData", {
    data_type: dataType,
    parsed_data: parsedData,
    file_name: fileName,
  });
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