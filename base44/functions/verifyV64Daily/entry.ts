// =====================================================
// verifyV64Daily
// V6.4(合議)予想と確定結果を毎日再照合し、
// 検証データ(PredictionV64Verification)の取りこぼしを補完する。
//
// - 直近7日(または指定日)のRaceを対象
// - V6.4予想が存在しないレースはスキップ(空レコードを作らない)
// - すでに検証済みのレースはスキップ(差分のみ処理)
// - 分類ロジックは predictionServiceV64.verifyV64Prediction を共用
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { verifyV64Prediction } from "../../shared/predictionServiceV64.js";

const V64_VERSION = "v6.4";
const MAX_RACES = 240;
const TIME_BUDGET_MS = 60000;

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
    const backfillDays = Number.isFinite(Number(body?.days)) ? Math.min(30, Math.max(1, Number(body.days))) : 7;
    const dates = requestedDate
      ? [requestedDate]
      : Array.from({ length: backfillDays }, (_, i) => jstDateOffset(-(i + 1)));

    const sr = base44.asServiceRole.entities;

    const races: any[] = await Promise.all(
      dates.map((raceDate) => sr.Race.filter({ race_date: raceDate }, "race_number", 500))
    ).then((groups: any[][]) => groups.flat());

    if (!races.length) {
      return Response.json({ ok: true, dates, races: 0, verified: 0, skipped_no_result: 0, skipped_no_prediction: 0 });
    }

    const raceIds = [...new Set(races.map((race: any) => race.id))];

    const [recentResults, verificationGroups, recentPredictions] = await Promise.all([
      sr.RaceResult.filter({ race_id: { $in: raceIds } }, "-created_date", 2000).catch(() => []),
      Promise.all(dates.map((raceDate) => sr.PredictionV64Verification.filter({ race_date: raceDate }, "-created_date", 500)))
        .then((groups: any[][]) => groups.flat()),
      sr.PredictionV6.filter({ prediction_version: V64_VERSION, race_id: { $in: raceIds } }, "-computed_at", 2000).catch(() => []),
    ]);

    const resultByRace = new Map<string, any>();
    for (const result of recentResults || []) {
      if (result.result_trifecta && !resultByRace.has(result.race_id)) {
        resultByRace.set(result.race_id, result);
      }
    }

    const predictedRaceIds = new Set(
      (recentPredictions || [])
        .filter((p: any) =>
          p.prediction_version === V64_VERSION &&
          (p.stage === "PRE" || p.stage === "FINAL") &&
          p.status !== "PENDING"
        )
        .map((p: any) => p.race_id)
    );

    const verifiedRaceKeys = new Set(
      (verificationGroups || [])
        .filter((v: any) => v.v64_final_judgment || v.v64_final_prediction)
        .map((v: any) => v.race_key)
    );

    let verified = 0;
    let skippedNoResult = 0;
    let skippedNoPrediction = 0;
    let skippedAlready = 0;
    let failed = 0;

    const startedAt = Date.now();

    for (const race of races) {
      if (verified >= MAX_RACES) break;
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const result = resultByRace.get(race.id);
      if (!result) { skippedNoResult += 1; continue; }
      if (!predictedRaceIds.has(race.id)) { skippedNoPrediction += 1; continue; }
      if (verifiedRaceKeys.has(race.race_key)) { skippedAlready += 1; continue; }

      try {
        const saved = await verifyV64Prediction(base44, race, {
          result_trifecta: result.result_trifecta,
          payout: result.payout,
        });
        if (saved) verified += 1;
        else skippedAlready += 1;
      } catch (e: any) {
        failed += 1;
        console.error(`[V6.4 DAILY VERIFY] race=${race.race_key}`, e?.message || e);
      }
      await sleep(80);
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
    console.error("[V6.4 DAILY VERIFY]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}