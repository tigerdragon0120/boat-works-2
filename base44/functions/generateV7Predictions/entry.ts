// =====================================================
// generateV7Predictions
// 統合V7の予想を、パネルを開かなくてもサーバー側で生成し PredictionV7 に保存する。
//
// - 対象は「まもなく締切が来るレース」(既定25分以内)。定期実行で全レースを拾う
// - PRE は出走表が揃えば生成、FINAL は展示(進入・ST・タイム)が揃えば生成
// - record_hash はレース×段階で固定し、締切前の初回予想だけを残す(不変・重複なし)
// - 締切後は生成しない。パネル側の生成・表示には影響しない
// - 計算はブラウザ版と同じ base44/shared/liveV7* を使用する
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { acquireLock, releaseLock } from "../../shared/concurrencyLock.js";
import { buildSnapshot, fingerprintInput } from "../../shared/liveV7Snapshot.js";
import { unifiedV7 } from "../../shared/liveV7Unified.js";
import { digest, raceKey, platformUtc, timeMs } from "../../shared/liveV7Time.js";

const DEFAULT_HORIZON_MINUTES = 25;
const MAX_RACES = 200;
const TIME_BUDGET_MS = 90000;

function jstToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// 暫定順位づけに足りる展示の有無(最終品質の証拠ではない)
function hasPartialExhibition(entries: any[], race: any): boolean {
  const scratched = new Set((race?.scratched_boats || []).map(Number));
  const active = (entries || []).filter((e) => !e.is_absent && !e.is_scratched && !scratched.has(Number(e.boat_number)));
  if (active.length < 3 || active.length > 6) return false;
  const usable = active.filter((e) =>
    Number(e.exhibition_time) > 0 && Number.isFinite(Number(e.exhibition_time)) &&
    e.exhibition_st != null && Number.isFinite(Number(e.exhibition_st)) &&
    Number.isInteger(Number(e.exhibition_course)) && Number(e.exhibition_course) >= 1 && Number(e.exhibition_course) <= 6);
  return usable.length >= 3 && new Set(usable.map((e) => Number(e.exhibition_course))).size === usable.length;
}

function rankOrder(output: any): number[] | null {
  const order = (output?.marginals || [])
    .map((marginal: any) => Object.entries(marginal || {}).sort((a: any, b: any) => b[1] - a[1] || +a[0] - +b[0])[0]?.[0])
    .map(Number);
  return order.length === 3 && order.every((n) => Number.isInteger(n)) ? order : null;
}

const num = (value: any) => (Number.isFinite(Number(value)) ? Number(value) : null);

function toPlans(output: any) {
  const plans: Record<string, any> = {};
  for (const [mode, source] of [["hit", "ticketPlans"], ["value", "recoveryPlans"]] as const) {
    for (const count of [4, 6, 8, 12]) {
      const plan = output?.[source]?.[count];
      const tickets = Array.isArray(plan?.tickets) ? plan.tickets.filter((t: any) => typeof t === "string") : [];
      if (!tickets.length) continue;
      plans[`${mode}_${count}`] = { tickets, probability: num(plan.probability), judgment: plan.judgment || null };
    }
  }
  return plans;
}

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  let user: any = null;
  try { user = await base44.auth.me(); } catch { user = null; }
  if (user && user.role !== "admin") {
    return Response.json({ ok: false, error: "Forbidden: admin only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const raceDate = typeof body?.race_date === "string" && body.race_date ? body.race_date : jstToday();
  const horizonMinutes = Number.isFinite(Number(body?.horizon_minutes))
    ? Math.min(180, Math.max(1, Number(body.horizon_minutes)))
    : DEFAULT_HORIZON_MINUTES;
  const onlyKeys = Array.isArray(body?.race_keys) ? body.race_keys.map(String) : null;
  const force = body?.force === true;

  const sr = base44.asServiceRole.entities;
  const lockId = force ? null : await acquireLock(base44, `v7_generate_${raceDate}`, "generateV7Predictions", 4 * 60 * 1000);
  if (!force && !lockId) {
    return Response.json({ ok: true, race_date: raceDate, skipped: "locked" });
  }

  try {
    const races: any[] = await sr.Race.filter({ race_date: raceDate }, "race_number", 500).catch(() => []);
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    const targets = races.filter((race: any) => {
      if (!race?.deadline || !race?.id) return false;
      const deadline = timeMs(race.deadline);
      if (deadline == null || deadline <= nowMs) return false;
      if (["finished", "cancelled"].includes(race.status)) return false;
      if (onlyKeys && !onlyKeys.includes(race.race_key)) return false;
      return deadline - nowMs <= horizonMinutes * 60000;
    }).slice(0, MAX_RACES);

    if (!targets.length) {
      return Response.json({ ok: true, race_date: raceDate, targets: 0, saved: 0 });
    }

    const ids = targets.map((race: any) => race.id);
    const keys = [...new Set(targets.map((race: any) => race.race_key).filter(Boolean))];
    const existingHashes = targets.flatMap((race: any) => {
      try { const key = raceKey(race.race_key); return [`server:${key}:PRE`, `server:${key}:FINAL`]; } catch { return []; }
    });

    const [entriesById, entriesByKey, oddsById, oddsByKey, logs, existing] = await Promise.all([
      sr.RaceEntry.filter({ race_id: { $in: ids } }, "boat_number", 2000).catch(() => []),
      keys.length ? sr.RaceEntry.filter({ race_key: { $in: keys } }, "boat_number", 2000).catch(() => []) : Promise.resolve([]),
      sr.OddsSnapshot.filter({ race_id: { $in: ids } }, "-captured_at", 1000).catch(() => []),
      keys.length ? sr.OddsSnapshot.filter({ race_key: { $in: keys } }, "-captured_at", 1000).catch(() => []) : Promise.resolve([]),
      sr.OnlineFetchLog.filter({ race_date: raceDate }, "-fetched_at", 1000).catch(() => []),
      existingHashes.length ? sr.PredictionV7.filter({ record_hash: { $in: existingHashes } }, "-created_date", 1000).catch(() => []) : Promise.resolve([]),
    ]);

    const dedupe = (rows: any[]) => {
      const map = new Map<string, any>();
      for (const row of rows || []) if (row?.id && !map.has(row.id)) map.set(row.id, row);
      return [...map.values()];
    };
    const entryRows = dedupe([...(entriesById || []), ...(entriesByKey || [])]);
    const oddsRows = dedupe([...(oddsById || []), ...(oddsByKey || [])]);

    const entriesByRaceKey = new Map<string, any[]>();
    for (const row of entryRows) {
      const key = row.race_key || (targets.find((race: any) => race.id === row.race_id)?.race_key);
      if (!key) continue;
      const list = entriesByRaceKey.get(key) || [];
      list.push(row);
      entriesByRaceKey.set(key, list);
    }
    for (const list of entriesByRaceKey.values()) list.sort((a, b) => Number(a.boat_number) - Number(b.boat_number));

    const oddsByRaceId = new Map<string, any[]>();
    for (const row of oddsRows) {
      const list = oddsByRaceId.get(row.race_id) || [];
      list.push(row);
      oddsByRaceId.set(row.race_id, list);
    }

    const done = new Set((existing || []).map((row: any) => row.record_hash));
    const docs: any[] = [];
    const reasons: Record<string, number> = {};
    const bump = (key: string) => { reasons[key] = (reasons[key] || 0) + 1; };
    const startedAt = Date.now();

    for (const race of targets) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { bump("time_budget"); break; }
      let key: string;
      try { key = raceKey(race.race_key); } catch { bump("invalid_race_key"); continue; }

      const raceEntries = (entriesByRaceKey.get(race.race_key) || []).map((row: any) => ({
        ...row, updated_date: platformUtc(row.updated_date),
      }));
      const raceOdds = (oddsByRaceId.get(race.id) || []).map((row: any) => ({
        ...row, captured_at: platformUtc(row.captured_at), updated_date: platformUtc(row.updated_date),
      }));
      const raceLogs = (logs || []).filter((log: any) =>
        (!log.venue_code || String(log.venue_code) === String(race.venue_code)) &&
        (!log.race_number || Number(log.race_number) === Number(race.race_number)) &&
        (!log.race_id || log.race_id === race.id));
      const oddsLogs = raceLogs
        .filter((log: any) => log.fetch_type === "odds" && timeMs(platformUtc(log.fetched_at)) != null)
        .sort((a: any, b: any) => String(b.fetched_at).localeCompare(String(a.fetched_at)));
      const quality = { rows: [{ key: "odds", failed: !!oddsLogs[0] && oddsLogs[0].status !== "success" }] };
      const normalizedRace = { ...race, updated_date: platformUtc(race.updated_date) };

      for (const stage of ["PRE", "FINAL"]) {
        const hash = `server:${key}:${stage}`;
        if (done.has(hash)) { bump("already"); continue; }
        if (stage === "FINAL" && !hasPartialExhibition(raceEntries, race)) { bump("waiting_exhibition"); continue; }

        let snapshot: any;
        try {
          snapshot = buildSnapshot({ race: normalizedRace, entries: raceEntries, odds: raceOdds, observedAt: now, quality }, stage);
        } catch {
          bump("input_incomplete");
          continue;
        }
        const output = unifiedV7(snapshot, stage);
        if (output?.status !== "READY" || !output?.model) { bump("engine_unavailable"); continue; }
        const plans = toPlans(output);
        if (!Object.keys(plans).length) { bump("no_plans"); continue; }

        const top = (output.combinations || [])
          .filter((row: any) => row && typeof row.combination === "string" && Number.isFinite(Number(row.probability)))
          .sort((a: any, b: any) => b.probability - a.probability || a.combination.localeCompare(b.combination))[0] || null;

        docs.push({
          record_hash: hash,
          input_hash: await digest(fingerprintInput(snapshot)),
          race_id: race.id,
          race_key: key,
          race_date: race.race_date || key.slice(0, 10),
          venue_code: race.venue_code != null ? String(race.venue_code) : null,
          race_number: Number.isFinite(Number(race.race_number)) ? Number(race.race_number) : null,
          series_name: race.series_name || null,
          is_womens: output.model === "WOMENS",
          model: output.model,
          stage,
          generated_at: now,
          deadline: race.deadline,
          top_combination: top ? top.combination : null,
          top_probability: top ? num(top.probability) : null,
          rank_order: rankOrder(output),
          plans,
          coverage: num(output.coverage),
          judgment_reason: output.judgment_reason ? String(output.judgment_reason).slice(0, 500) : null,
          source: "SERVER",
        });
        done.add(hash);
      }
    }

    if (docs.length) await sr.PredictionV7.bulkCreate(docs);

    return Response.json({
      ok: true,
      race_date: raceDate,
      horizon_minutes: horizonMinutes,
      targets: targets.length,
      saved: docs.length,
      saved_pre: docs.filter((doc) => doc.stage === "PRE").length,
      saved_final: docs.filter((doc) => doc.stage === "FINAL").length,
      reasons,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[V7 AUTO PREDICTION]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  } finally {
    await releaseLock(base44, lockId).catch(() => {});
  }
}