import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";

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

async function withRetry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function bulkCreateChunks(entity: any, rows: any[]) {
  for (let index = 0; index < rows.length; index += 50) {
    await withRetry(() => entity.bulkCreate(rows.slice(index, index + 50)));
  }
}

async function bulkUpdateChunks(entity: any, rows: any[]) {
  for (let index = 0; index < rows.length; index += 50) {
    await withRetry(() => entity.bulkUpdate(rows.slice(index, index + 50)));
  }
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
    );
    const races = raceGroups.flat();
    const raceIds = new Set(races.map((race: any) => race.id));

    if (races.length === 0) {
      return Response.json({ ok: true, dates, races: 0, verified: 0, created: 0, updated: 0 });
    }

    const [recentResults, recentPredictions, verificationGroups] = await Promise.all([
      sr.RaceResult.list("-created_date", 2000),
      sr.PredictionV31.list("-computed_at", 2500),
      Promise.all(
        dates.map((raceDate) =>
          sr.PredictionV31Verification.filter({ race_date: raceDate }, "-created_date", 500)
        )
      ).then((groups: any[][]) => groups.flat()),
    ]);

    const resultByRace = new Map<string, any>();
    for (const result of recentResults || []) {
      if (raceIds.has(result.race_id) && !resultByRace.has(result.race_id)) {
        resultByRace.set(result.race_id, result);
      }
    }

    const predictionByRaceStage = new Map<string, any>();
    for (const prediction of recentPredictions || []) {
      if (
        raceIds.has(prediction.race_id) &&
        prediction.prediction_version === "v3.1" &&
        (prediction.stage === "PRE" || prediction.stage === "FINAL")
      ) {
        const key = `${prediction.race_id}_${prediction.stage}`;
        if (!predictionByRaceStage.has(key)) predictionByRaceStage.set(key, prediction);
      }
    }

    const verificationByRaceKey = new Map(
      (verificationGroups || []).map((verification: any) => [verification.race_key, verification])
    );

    const creates: any[] = [];
    const updates: any[] = [];
    let skippedNoResult = 0;
    let skippedNoPrediction = 0;

    for (const race of races) {
      const result = resultByRace.get(race.id);
      if (!result?.result_trifecta) {
        skippedNoResult += 1;
        continue;
      }

      const pre = predictionByRaceStage.get(`${race.id}_PRE`);
      const final = predictionByRaceStage.get(`${race.id}_FINAL`);
      if (!pre && !final) {
        skippedNoPrediction += 1;
        continue;
      }

      const actual = result.result_trifecta;
      const preSelected = Array.isArray(pre?.selected_trifectas) ? pre.selected_trifectas : [];
      const finalSelected = Array.isArray(final?.selected_trifectas) ? final.selected_trifectas : [];
      const preHit = preSelected.includes(actual) || pre?.top_trifecta === actual;
      const finalHit = finalSelected.includes(actual) || final?.top_trifecta === actual;
      const recommendedHit = finalSelected.includes(actual);
      const investment =
        final?.final_judgment === "BUY"
          ? Number(final.ticket_count || finalSelected.length || 6) * 100
          : 0;
      const payout = recommendedHit ? Number(result.payout || 0) : 0;
      const recoveryRate = investment > 0 ? Math.round((payout / investment) * 100) : 0;
      const sourceForTickets = final || pre;
      const selectedSet = new Set(finalSelected.length ? finalSelected : preSelected);
      const ticketDetails = (Array.isArray(sourceForTickets?.trifectas) ? sourceForTickets.trifectas : [])
        .filter((ticket: any) => selectedSet.has(ticket?.combination) || ticket?.is_selected)
        .sort((a: any, b: any) => Number(a?.ticket_rank ?? a?.rank ?? 999) - Number(b?.ticket_rank ?? b?.rank ?? 999))
        .slice(0, 8)
        .map((ticket: any) => ({
          combination: ticket.combination,
          rank: Number(ticket.ticket_rank ?? ticket.rank ?? 0),
          probability: Number(ticket.race_probability ?? 0),
          actual_odds: ticket.actual_odds == null ? null : Number(ticket.actual_odds),
          expected_value: ticket.expected_value == null
            ? (ticket.actual_odds == null ? null : Math.round(Number(ticket.race_probability || 0) * Number(ticket.actual_odds) * 10) / 10)
            : Number(ticket.expected_value),
          is_selected: true,
        }));

      const document = {
        race_id: race.id,
        race_key: race.race_key,
        race_date: race.race_date,
        venue_code: race.venue_code,
        race_number: race.race_number,
        actual_result: actual,
        v3_pre_prediction: pre?.top_trifecta || "",
        v3_final_prediction: final?.top_trifecta || "",
        v3_pre_hit: Boolean(preHit),
        v3_final_hit: Boolean(finalHit),
        v3_recommended_hit: Boolean(recommendedHit),
        v3_final_judgment: final?.final_judgment || null,
        v3_ticket_count: final?.ticket_count || null,
        v3_selected_trifectas: finalSelected,
        v31_ticket_details: ticketDetails,
        v3_payout: payout,
        v3_investment: investment,
        v3_recovery_rate: recoveryRate,
        v3_race_type: final?.race_type || pre?.race_type || null,
        v3_first_probability_gap:
          final?.first_probability_gap ?? pre?.first_probability_gap ?? null,
        v3_first_confidence: final?.first_confidence ?? pre?.first_confidence ?? null,
        verified_at: new Date().toISOString(),
      };

      const existing = verificationByRaceKey.get(race.race_key);
      if (existing?.id) updates.push({ id: existing.id, ...document });
      else creates.push(document);
    }

    if (creates.length) await bulkCreateChunks(sr.PredictionV31Verification, creates);
    if (updates.length) await bulkUpdateChunks(sr.PredictionV31Verification, updates);

    return Response.json({
      ok: true,
      dates,
      races: races.length,
      results_found: resultByRace.size,
      verified: creates.length + updates.length,
      created: creates.length,
      updated: updates.length,
      skipped_no_result: skippedNoResult,
      skipped_no_prediction: skippedNoPrediction,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[V3.1 DAILY VERIFY]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}
