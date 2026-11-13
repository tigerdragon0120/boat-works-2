// =====================================================
// verifyV7Daily
// 統合V7の予想(PredictionV7)と確定結果を照合し、
// 検証結果(PredictionV7Verification)を保存する。
//
// - 対象は直近数日(既定3日)のサーバー保存済み予想
// - 締切後に生成された予想は対象外(データリーク防止)
// - 照合済みレコードはスキップ(差分のみ処理)
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const TIME_BUDGET_MS = 60000;
const MAX_RECORDS = 600;

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

function dividend(result: any): number | null {
  const direct = Number(result?.payout);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const nested = Number(result?.payouts?.trifecta?.payout);
  return Number.isFinite(nested) && nested > 0 ? nested : null;
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
    const days = Number.isFinite(Number(body?.days)) ? Math.min(30, Math.max(1, Number(body.days))) : 3;
    const dates = requestedDate ? [requestedDate] : Array.from({ length: days }, (_, i) => jstDateOffset(-i));

    const sr = base44.asServiceRole.entities;

    const records: any[] = await Promise.all(
      dates.map((raceDate) => sr.PredictionV7.filter({ race_date: raceDate }, "-generated_at", 500))
    ).then((groups: any[][]) => groups.flat());

    if (!records.length) {
      return Response.json({ ok: true, dates, records: 0, verified: 0 });
    }

    const limited = records.slice(0, MAX_RECORDS);
    const raceIds = [...new Set(limited.map((record: any) => record.race_id).filter(Boolean))];
    const hashes = limited.map((record: any) => record.record_hash);

    const [results, verifications] = await Promise.all([
      raceIds.length
        ? sr.RaceResult.filter({ race_id: { $in: raceIds } }, "-created_date", 2000).catch(() => [])
        : Promise.resolve([]),
      sr.PredictionV7Verification.filter({ record_hash: { $in: hashes } }, "-verified_at", 1000).catch(() => []),
    ]);

    const resultByRace = new Map<string, any>();
    for (const result of results || []) {
      const combination = String(result?.result_trifecta || "");
      if (!COMBO_RE.test(combination) || new Set(combination.split("-")).size !== 3) continue;
      const previous = resultByRace.get(result.race_id);
      if (!previous || (result.is_finished && !previous.is_finished)) {
        resultByRace.set(result.race_id, result);
      }
    }

    const done = new Set((verifications || []).map((row: any) => row.record_hash));

    let skippedAlready = 0;
    let skippedNoResult = 0;
    const docs: any[] = [];
    const startedAt = Date.now();

    for (const record of limited) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      if (!record.record_hash || done.has(record.record_hash)) { skippedAlready += 1; continue; }

      const result = resultByRace.get(record.race_id);
      if (!result) { skippedNoResult += 1; continue; }

      const deadline = Date.parse(record.deadline || "");
      const generated = Date.parse(record.generated_at || "");
      if (!Number.isFinite(deadline) || !Number.isFinite(generated) || generated >= deadline) continue;

      const combination = String(result.result_trifecta);
      const actual = combination.split("-").map(Number);
      const payout = dividend(result);

      const plans: any[] = [];
      for (const [key, plan] of Object.entries(record.plans || {})) {
        const tickets = Array.isArray((plan as any)?.tickets)
          ? (plan as any).tickets.filter((ticket: any) => COMBO_RE.test(String(ticket)))
          : [];
        if (!tickets.length) continue;
        const hit = tickets.includes(combination);
        const investment = tickets.length * 100;
        plans.push({
          key,
          tickets: tickets.length,
          probability: Number.isFinite(Number((plan as any).probability)) ? Number((plan as any).probability) : null,
          judgment: (plan as any).judgment || null,
          hit,
          investment,
          payout: hit ? payout : 0,
          recovery: hit && payout != null && investment > 0
            ? Math.round((payout / investment) * 1000) / 10
            : null,
        });
      }
      if (!plans.length) continue;

      const order = Array.isArray(record.rank_order) ? record.rank_order.map(Number) : [];

      docs.push({
        record_hash: record.record_hash,
        race_id: record.race_id,
        race_key: record.race_key,
        race_date: record.race_date,
        venue_code: record.venue_code || null,
        race_number: record.race_number || null,
        model: record.model || null,
        stage: record.stage || null,
        generated_at: record.generated_at || null,
        actual_result: combination,
        actual_first_boat: actual[0],
        top_hit: record.top_combination === combination,
        rank_hits: [0, 1, 2].map((i) => order[i] === actual[i]),
        plans,
        verified_at: new Date().toISOString(),
      });
    }

    for (let i = 0; i < docs.length; i += 100) {
      await sr.PredictionV7Verification.bulkCreate(docs.slice(i, i + 100));
    }

    return Response.json({
      ok: true,
      dates,
      records: limited.length,
      results_found: resultByRace.size,
      verified: docs.length,
      skipped_already: skippedAlready,
      skipped_no_result: skippedNoResult,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[V7 DAILY VERIFY]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}