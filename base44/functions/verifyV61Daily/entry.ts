// =====================================================
// verifyV61Daily
// V6.1 PROFIT Candidateの予想と確定結果を毎日再照合し、
// 検証データ(PredictionV61Verification)の取りこぼしを補完する。
//
// - 直近3日(または指定日)のRaceを対象
// - V6.1予想が存在しないレースはスキップ(空レコードを作らない)
// - すでに予想付きで検証済みのレースはスキップ(差分のみ処理)
// - 分類ロジックは predictionServiceV61.verifyV61Prediction を共用
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { verifyV61Prediction } from "../../shared/predictionServiceV61.js";

const V61_VERSION = "v6.1";
const MAX_RACES = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jstDateOffset(days: number): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== "admin") {
      return Response.json({ ok: false, error: "Forbidden: admin only" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const requestedDate = typeof body?.race_date === "string" ? body.race_date : null;
    const dates = requestedDate
      ? [requestedDate]
      : [jstDateOffset(-1), jstDateOffset(-2), jstDateOffset(-3)];

    const sr = base44.asServiceRole.entities;

    const [raceGroups, recentResults, verificationGroups, recentPredictions] = await Promise.all([
      Promise.all(dates.map((raceDate) => sr.Race.filter({ race_date: raceDate }, "race_number", 500)))
        .then((groups: any[][]) => groups.flat()),
      sr.RaceResult.list("-created_date", 2000),
      Promise.all(dates.map((raceDate) => sr.PredictionV61Verification.filter({ race_date: raceDate }, "-created_date", 500)))
        .then((groups: any[][]) => groups.flat()),
      sr.PredictionV6.list("-computed_at", 3000).catch(() => []),
    ]);

    const races = raceGroups;
    if (!races.length) {
      return Response.json({ ok: true, dates, races: 0, verified: 0, skipped_no_result: 0, skipped_no_prediction: 0 });
    }

    const raceIdSet = new Set(races.map((race: any) => race.id));

    const resultByRace = new Map<string, any>();
    for (const result of recentResults || []) {
      if (raceIdSet.has(result.race_id) && result.result_trifecta && !resultByRace.has(result.race_id)) {
        resultByRace.set(result.race_id, result);
      }
    }

    // V6.1予想が存在するレースだけを対象にする
    const predictedRaceIds = new Set(
      (recentPredictions || [])
        .filter((p: any) =>
          p.prediction_version === V61_VERSION &&
          (p.stage === "PRE" || p.stage === "FINAL") &&
          p.status !== "PENDING"
        )
        .map((p: any) => p.race_id)
    );

    // 予想付きで検証済みのレースはスキップ
    const verifiedRaceKeys = new Set(
      (verificationGroups || [])
        .filter((v: any) => v.v61_final_judgment || v.v61_final_prediction)
        .map((v: any) => v.race_key)
    );

    let verified = 0;
    let skippedNoResult = 0;
    let skippedNoPrediction = 0;
    let skippedAlready = 0;
    let failed = 0;

    for (const race of races) {
      if (verified >= MAX_RACES) break;

      const result = resultByRace.get(race.id);
      if (!result) { skippedNoResult += 1; continue; }
      if (!predictedRaceIds.has(race.id)) { skippedNoPrediction += 1; continue; }
      if (verifiedRaceKeys.has(race.race_key)) { skippedAlready += 1; continue; }

      try {
        const saved = await verifyV61Prediction(base44, race, {
          result_trifecta: result.result_trifecta,
          payout: result.payout,
        });
        if (saved) verified += 1;
        else skippedAlready += 1;
      } catch (e: any) {
        failed += 1;
        console.error(`[V6.1 DAILY VERIFY] race=${race.race_key}`, e?.message || e);
      }
      await sleep(120);
    }

    return Response.json({
      ok: true,
      dates,
      races: races.length,
      results_found: resultByRace.size,
      verified,
      skipped_already: skippedAlready,
      skipped_no_result: skippedNoResult,
      skipped_no_prediction: skippedNoPrediction,
      failed,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[V6.1 DAILY VERIFY]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}