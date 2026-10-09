// =====================================================
// verifyV62Daily
// V6.2 PROFIT Candidateの予想と確定結果を毎日再照合し、
// 検証データ(PredictionV62Verification)の取りこぼしを補完する。
//
// - 直近3日(または指定日)のRaceを対象
// - V6.2予想が存在しないレースはスキップ(空レコードを作らない)
// - すでに予想付きで検証済みのレースはスキップ(差分のみ処理)
// - 分類ロジックは predictionServiceV62.verifyV62Prediction を共用
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { verifyV62Prediction } from "../../shared/predictionServiceV62.js";

const V62_VERSION = "v6.2";
const MAX_RACES = 150;
// 1回の実行時間上限(秒)。未処理分は次回の実行で補完する
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
    const dates = requestedDate
      ? [requestedDate]
      : [jstDateOffset(-1), jstDateOffset(-2), jstDateOffset(-3)];

    const sr = base44.asServiceRole.entities;

    const raceGroups = await Promise.all(
      dates.map((raceDate) => sr.Race.filter({ race_date: raceDate }, "race_number", 500))
    ).then((groups: any[][]) => groups.flat());

    const races = raceGroups;
    if (!races.length) {
      return Response.json({ ok: true, dates, races: 0, verified: 0, skipped_no_result: 0, skipped_no_prediction: 0 });
    }

    const raceIdSet = new Set(races.map((race: any) => race.id));
    const raceIds = [...raceIdSet];

    // 対象レースに絞って取得する(全件取得はメモリを圧迫するため避ける)
    const [recentResults, verificationGroups, recentPredictions] = await Promise.all([
      sr.RaceResult.filter({ race_id: { $in: raceIds } }, "-created_date", 1000).catch(() => []),
      Promise.all(dates.map((raceDate) => sr.PredictionV62Verification.filter({ race_date: raceDate }, "-created_date", 500)))
        .then((groups: any[][]) => groups.flat()),
      sr.PredictionV6.filter({ prediction_version: V62_VERSION, race_id: { $in: raceIds } }, "-computed_at", 1000).catch(() => []),
    ]);

    const resultByRace = new Map<string, any>();
    for (const result of recentResults || []) {
      if (raceIdSet.has(result.race_id) && result.result_trifecta && !resultByRace.has(result.race_id)) {
        resultByRace.set(result.race_id, result);
      }
    }

    // V6.2予想が存在するレースだけを対象にする
    const predictedRaceIds = new Set(
      (recentPredictions || [])
        .filter((p: any) =>
          p.prediction_version === V62_VERSION &&
          (p.stage === "PRE" || p.stage === "FINAL") &&
          p.status !== "PENDING"
        )
        .map((p: any) => p.race_id)
    );

    // 予想付きで検証済みのレースはスキップ
    const verifiedRaceKeys = new Set(
      (verificationGroups || [])
        .filter((v: any) => v.v62_final_judgment || v.v62_final_prediction)
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
        const saved = await verifyV62Prediction(base44, race, {
          result_trifecta: result.result_trifecta,
          payout: result.payout,
        });
        if (saved) verified += 1;
        else skippedAlready += 1;
      } catch (e: any) {
        failed += 1;
        console.error(`[V6.2 DAILY VERIFY] race=${race.race_key}`, e?.message || e);
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
    console.error("[V6.2 DAILY VERIFY]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}