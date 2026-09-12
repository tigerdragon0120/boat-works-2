// ============================================================
// 第6段階クリーンアップ監視
// Race/RaceEntry/FINAL/RESULT重複・CONFLICT・MISSING逆戻り・
// BOATCAST取得失敗・LOCAL fallback・429回数を集計する。
// Admin手動実行またはrunDailyAutoUpdateから呼ばれる。
// ============================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

function getTodayJST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let user: any = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }

    const sr = base44.asServiceRole.entities;
    const today = getTodayJST();

    // === Race重複(race_keyごと) ===
    const todayRaces = await sr.Race.filter({ race_date: today }, 'race_number', 500).catch(() => []);
    const raceByKey: Record<string, number> = {};
    for (const r of todayRaces) {
      const k = r.race_key || 'NO_KEY';
      raceByKey[k] = (raceByKey[k] || 0) + 1;
    }
    const raceDuplicates = Object.entries(raceByKey).filter(([, v]) => v > 1);

    // === RaceEntry重複(race_key+boat_numberごと) ===
    const todayEntries = await sr.RaceEntry.filter({ race_date: today }, 'boat_number', 5000).catch(() => []);
    const entryByKey: Record<string, number> = {};
    for (const e of todayEntries) {
      const k = `${e.race_key || 'NO_KEY'}_${e.boat_number}`;
      entryByKey[k] = (entryByKey[k] || 0) + 1;
    }
    const entryDuplicates = Object.entries(entryByKey).filter(([, v]) => v > 1);

    // === RaceResult重複(race_idごと) ===
    const allResults = await sr.RaceResult.filter({}, '-finished_at', 500).catch(() => []);
    const resultByRace: Record<string, number> = {};
    for (const r of allResults) {
      const k = r.race_id || 'NO_RACE';
      resultByRace[k] = (resultByRace[k] || 0) + 1;
    }
    const resultDuplicates = Object.entries(resultByRace).filter(([, v]) => v > 1);

    // === FINAL予想重複(race_idごと) ===
    const allFinals = await sr.RacePrediction.filter({ stage: 'FINAL' }, '-computed_at', 500).catch(() => []);
    const finalByRace: Record<string, number> = {};
    for (const f of allFinals) {
      const k = f.race_id || 'NO_RACE';
      finalByRace[k] = (finalByRace[k] || 0) + 1;
    }
    const finalDuplicates = Object.entries(finalByRace).filter(([, v]) => v > 1);

    // === RESULT_CONFLICT ===
    const resultConflicts = allResults.filter((r: any) => r.conflict_log).length;

    // === MISSING逆戻り(COMPLETED→MISSING) ===
    const missingFinals = allFinals.filter((f: any) => f.status === 'MISSING').length;

    // === BOATCAST vs LOCAL取得元集計 ===
    const boatcastResults = allResults.filter((r: any) => r.source === 'BOATCAST').length;
    const localResults = allResults.filter((r: any) => r.source === 'LOCAL').length;
    const txtResults = allResults.filter((r: any) => r.source === 'TXT').length;

    // === OnlineFetchLog集計(直近100件) ===
    const fetchLogs = await sr.OnlineFetchLog.list('-fetched_at', 100).catch(() => []);
    const fetchStats = {
      total: fetchLogs.length,
      success: fetchLogs.filter((l: any) => l.status === 'success').length,
      failed: fetchLogs.filter((l: any) => l.status === 'failed').length,
      no_data: fetchLogs.filter((l: any) => l.status === 'no_data').length,
      not_ready: fetchLogs.filter((l: any) => l.status === 'not_ready').length,
      skipped: fetchLogs.filter((l: any) => l.status === 'skipped').length,
    };

    // === OddsSnapshot取得元集計 ===
    const oddsSnapshots = await sr.OddsSnapshot.list('-captured_at', 200).catch(() => []);
    const boatcastOdds = oddsSnapshots.filter((o: any) => o.source === 'BOATCAST').length;
    const localOdds = oddsSnapshots.filter((o: any) => !o.source || o.source === 'LOCAL').length;

    // === 異常0件目標チェック ===
    const anomalies = {
      race_duplicates: raceDuplicates.length,
      entry_duplicates: entryDuplicates.length,
      final_duplicates: finalDuplicates.length,
      result_duplicates: resultDuplicates.length,
      result_conflicts: resultConflicts,
      missing_finals: missingFinals,
    };
    const allZero = Object.values(anomalies).every((v) => v === 0);

    return Response.json({
      ok: true,
      today,
      anomalies,
      all_zero: allZero,
      result_sources: {
        BOATCAST: boatcastResults,
        LOCAL: localResults,
        TXT: txtResults,
      },
      odds_sources: {
        BOATCAST: boatcastOdds,
        LOCAL: localOdds,
      },
      fetch_stats: fetchStats,
      race_total: todayRaces.length,
      entry_total: todayEntries.length,
      result_total: allResults.length,
      final_total: allFinals.length,
      duplicate_examples: {
        races: raceDuplicates.slice(0, 3),
        entries: entryDuplicates.slice(0, 3),
        results: resultDuplicates.slice(0, 3),
        finals: finalDuplicates.slice(0, 3),
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}