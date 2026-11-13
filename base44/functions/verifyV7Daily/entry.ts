// =====================================================
// verifyV7Daily
// 統合V7の予想(PredictionV7)と確定結果を照合し、検証記録(PredictionV7Verification)を
// 追記のみで保存する。予想そのものは書き換えない。
//
// 方針:
//  1. 同一レース×段階に予想が複数ある場合は、全件を保留(HELD_DUPLICATE)とし、
//     的中率・回収率の分子・分母から除外する
//  2. 締切後保存 / 締切不明 / 時刻の矛盾 / 払戻不足 / 買い目不足 / 参照先の不一致 は
//     理由別に保留する
//  3. 保留も有効検証も追記のみ。既存の検証記録は書き換えない
//     (同じ予想の照合記録が既にあれば何もしない)
//  4. 新方式の記録は verification_version='v2' を付け、旧方式の記録と区別する
//  5. dry_run=true は一切書き込まず、分類結果だけを返す(事前確認用)
//
// body:
//   race_date  対象日(既定はJSTの今日)
//   days       race_date未指定時に遡る日数(既定3・最大30)
//   dry_run    true で書き込みを行わない
// =====================================================
import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const TIME_BUDGET_MS = 60000;
const MAX_RECORDS = 600;
// 生成直後のメタデータ更新を「書き換え」と誤判定しないための許容幅
const IMMUTABLE_TOLERANCE_MS = 5000;
const MAX_SAMPLE = 60;
const NEW_VERSION = "v2";

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

const hasOffset = (value: any) => /(Z|[+-]\d{2}:?\d{2})$/.test(String(value ?? "").trim());
const normalize = (value: any) => String(value ?? "").trim().replace(/(\.\d{3})\d+/, "$1");

// DBのcreated_date/updated_dateはオフセットの無いUTC壁時計時刻なので、UTCとして解釈する
function dbMs(value: any): number | null {
  const raw = normalize(value);
  if (!raw) return null;
  const ms = Date.parse(hasOffset(raw) ? raw : `${raw}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Race.deadlineはタイムゾーン付きが前提。オフセットが無い値は9時間ずれるため判定不能として扱う
function deadlineMs(value: any): number | null {
  const raw = normalize(value);
  if (!raw || !hasOffset(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// 同じrace_keyのRace行が複数ある場合も、予想が参照した行だけを締切判定に使う
function resolveRace(rows: any[], record: any): { race?: any; reason?: string } {
  if (!rows.length) return { reason: "RACE_MISMATCH" };
  if (record.race_id) {
    const exact = rows.find((row) => row.id === record.race_id);
    return exact ? { race: exact } : { reason: "RACE_MISMATCH" };
  }
  const withDeadline = rows.filter((row) => row.deadline);
  const deadlines = new Set(withDeadline.map((row) => String(row.deadline)));
  if (deadlines.size > 1) return { reason: "RACE_MISMATCH" };
  return { race: withDeadline[0] || rows[0] };
}

function validTickets(record: any): string[] {
  const tickets: string[] = [];
  for (const plan of Object.values(record?.plans || {})) {
    const list = Array.isArray((plan as any)?.tickets) ? (plan as any).tickets : [];
    for (const ticket of list) {
      if (typeof ticket === "string" && COMBO_RE.test(ticket) && !tickets.includes(ticket)) tickets.push(ticket);
    }
  }
  return tickets;
}

function heldDoc(record: any, race: any, reason: string, reasons: string[], extra: any, nowIso: string) {
  return {
    verification_version: NEW_VERSION,
    verification_status: `HELD_${reason}`,
    hold_reason: reason,
    hold_reasons: reasons,
    record_hash: String(record.record_hash || ""),
    race_id: record.race_id || (race ? race.id : null),
    race_key: record.race_key,
    race_date: record.race_date || null,
    venue_code: record.venue_code != null ? String(record.venue_code) : null,
    race_number: record.race_number != null ? Number(record.race_number) : null,
    model: record.model || null,
    stage: record.stage || null,
    generated_at: record.generated_at || null,
    record_created_at: record.created_date || null,
    record_updated_at: record.updated_date || null,
    race_deadline: race ? race.deadline || null : null,
    pre_deadline_verified: false,
    record_fixed: false,
    result_finished: false,
    verified_at: nowIso,
    ...extra,
  };
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
    const dryRun = body?.dry_run === true;
    const requestedDate = typeof body?.race_date === "string" ? body.race_date : null;
    const days = Number.isFinite(Number(body?.days)) ? Math.min(30, Math.max(1, Number(body.days))) : 3;
    const dates = requestedDate ? [requestedDate] : Array.from({ length: days }, (_, i) => jstDateOffset(-i));

    const sr = base44.asServiceRole.entities;
    const nowIso = new Date().toISOString();

    const records: any[] = (await Promise.all(
      dates.map((raceDate) => sr.PredictionV7.filter({ race_date: raceDate }, "-generated_at", 500))
    )).flat();

    if (!records.length) {
      return Response.json({ ok: true, dates, dry_run: dryRun, records: 0, groups: 0, verified: 0, held: 0, held_by_reason: {} });
    }

    const limited = records.slice(0, MAX_RECORDS).filter((record: any) => record?.race_key && record?.stage && record?.record_hash);
    const raceKeys = [...new Set(limited.map((record: any) => record.race_key))];

    const races: any[] = raceKeys.length
      ? await sr.Race.filter({ race_key: { $in: raceKeys } }, "-created_date", 2000).catch(() => [])
      : [];
    const raceRowsByKey = new Map<string, any[]>();
    for (const race of races || []) {
      if (!race?.race_key) continue;
      const list = raceRowsByKey.get(race.race_key) || [];
      list.push(race);
      raceRowsByKey.set(race.race_key, list);
    }

    const raceIds = [...new Set((races || []).map((race: any) => race.id).filter(Boolean))];
    const results: any[] = raceIds.length
      ? await sr.RaceResult.filter({ race_id: { $in: raceIds } }, "-created_date", 2000).catch(() => [])
      : [];

    const resultByRace = new Map<string, any>();
    for (const result of results || []) {
      const combination = String(result?.result_trifecta || "");
      if (!COMBO_RE.test(combination) || new Set(combination.split("-")).size !== 3) continue;
      if (!(result?.is_finished === true || result?.result_status === "RESULT_FINAL")) continue;
      const previous = resultByRace.get(result.race_id);
      if (!previous || (previous.conflict_log && !result.conflict_log)) resultByRace.set(result.race_id, result);
    }

    // 既存の照合記録は書き換えない。同じ予想に記録があれば再照合しない
    const existing: any[] = await sr.PredictionV7Verification
      .filter({ race_date: { $in: dates } }, "-verified_at", 2000)
      .catch(() => []);
    const done = new Set((existing || []).map((row: any) => row.record_hash).filter(Boolean));

    // 同一レース×段階でまとめる(モデルは含めない)
    const groups = new Map<string, any[]>();
    for (const record of limited) {
      const key = `${record.race_key}::${record.stage}`;
      const list = groups.get(key) || [];
      list.push(record);
      groups.set(key, list);
    }

    const docs: any[] = [];
    const samples: any[] = [];
    const heldByReason: Record<string, number> = {};
    let verified = 0;
    let skippedAlready = 0;
    let skippedNotReady = 0;
    let timedOut = false;
    const startedAt = Date.now();
    const bump = (reason: string) => { heldByReason[reason] = (heldByReason[reason] || 0) + 1; };

    for (const list of groups.values()) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { timedOut = true; break; }
      const hashes = list.map((record: any) => String(record.record_hash));
      if (hashes.some((hash) => done.has(hash))) { skippedAlready += 1; continue; }

      const ordered = [...list].sort((a: any, b: any) =>
        String(a.created_date || "").localeCompare(String(b.created_date || "")) || String(a.id).localeCompare(String(b.id)));
      const record = ordered[0];
      const raceRows = raceRowsByKey.get(record.race_key) || [];
      const resolved = resolveRace(raceRows, record);
      const race = resolved.race || null;

      // 1) 同一レース×段階の重複は全件保留
      if (list.length > 1) {
        const extra = {
          duplicate_count: list.length,
          duplicate_hashes: hashes.slice(0, 10),
          result_finished: !!resultByRace.get(race ? race.id : record.race_id),
        };
        docs.push(heldDoc(record, race, "DUPLICATE", ["DUPLICATE"], extra, nowIso));
        done.add(String(record.record_hash));
        bump("DUPLICATE");
        samples.push({ race_key: record.race_key, stage: record.stage, status: "HELD_DUPLICATE", reasons: ["DUPLICATE"], duplicate_count: list.length });
        continue;
      }

      // 2) 理由別の保留判定
      const reasons: string[] = [];
      if (resolved.reason) reasons.push("RACE_MISMATCH");

      const savedAt = dbMs(record.created_date);
      const updatedAt = dbMs(record.updated_date || record.created_date);
      const generatedAt = dbMs(record.generated_at);
      const deadline = race ? deadlineMs(race.deadline) : null;

      if (!resolved.reason) {
        if (deadline == null) reasons.push("DEADLINE_UNKNOWN");
        if (savedAt == null) reasons.push("TIME_CONFLICT");
        else {
          if (updatedAt == null || updatedAt - savedAt > IMMUTABLE_TOLERANCE_MS) reasons.push("TIME_CONFLICT");
          if (generatedAt != null && generatedAt > savedAt + IMMUTABLE_TOLERANCE_MS) reasons.push("TIME_CONFLICT");
          if (deadline != null && savedAt >= deadline) reasons.push("LATE");
        }
      }

      const result = race ? resultByRace.get(race.id) || null : null;
      const tickets = validTickets(record);
      const payout = result ? dividend(result) : null;

      if (result) {
        const finishedAt = dbMs(result.finished_at);
        if (finishedAt != null && savedAt != null && finishedAt < savedAt - IMMUTABLE_TOLERANCE_MS) reasons.push("TIME_CONFLICT");
        if (payout == null) reasons.push("PAYOUT_MISSING");
        if (!tickets.length) reasons.push("TICKETS_MISSING");
      }

      // 結果待ちは保留記録を作らず、未検証として残す(次回の照合で判定する)
      if (!result && !reasons.length) { skippedNotReady += 1; continue; }

      if (reasons.length) {
        const unique = [...new Set(reasons)];
        const priority = ["RACE_MISMATCH", "DEADLINE_UNKNOWN", "LATE", "TIME_CONFLICT", "PAYOUT_MISSING", "TICKETS_MISSING"];
        const primary = priority.find((reason) => unique.includes(reason)) || unique[0];
        docs.push(heldDoc(record, race, primary, unique, {
          result_status: result ? result.result_status || null : null,
          result_finished: !!result,
        }, nowIso));
        done.add(String(record.record_hash));
        bump(primary);
        samples.push({ race_key: record.race_key, stage: record.stage, status: `HELD_${primary}`, reasons: unique });
        continue;
      }

      // 3) 有効検証: 締切前のDB保存・記録固定・確定結果・払戻・買い目がすべて揃っている
      const combination = String(result.result_trifecta);
      const actual = combination.split("-").map(Number);
      const plans: any[] = [];
      for (const [key, plan] of Object.entries(record.plans || {})) {
        const list = Array.isArray((plan as any)?.tickets)
          ? (plan as any).tickets.filter((ticket: any) => COMBO_RE.test(String(ticket)))
          : [];
        if (!list.length) continue;
        const hit = list.includes(combination);
        const investment = list.length * 100;
        plans.push({
          key,
          tickets: list.length,
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

      const order = Array.isArray(record.rank_order) ? record.rank_order.map(Number) : [];

      docs.push({
        verification_version: NEW_VERSION,
        verification_status: "VERIFIED",
        hold_reasons: [],
        record_hash: record.record_hash,
        race_id: race.id,
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
        record_created_at: record.created_date || null,
        record_updated_at: record.updated_date || null,
        race_deadline: race.deadline || null,
        pre_deadline_verified: true,
        record_fixed: true,
        result_status: result.result_status || null,
        result_finished: true,
        payout,
        verified_at: nowIso,
      });
      done.add(String(record.record_hash));
      verified += 1;
      samples.push({ race_key: record.race_key, stage: record.stage, status: "VERIFIED", reasons: [] });
    }

    const held = docs.length - verified;
    if (!dryRun) {
      for (let i = 0; i < docs.length; i += 100) {
        await sr.PredictionV7Verification.bulkCreate(docs.slice(i, i + 100));
      }
    }

    return Response.json({
      ok: true,
      dates,
      dry_run: dryRun,
      version: NEW_VERSION,
      records: limited.length,
      groups: groups.size,
      verified,
      held,
      held_by_reason: heldByReason,
      written: dryRun ? 0 : docs.length,
      skipped_already: skippedAlready,
      skipped_not_ready: skippedNotReady,
      timed_out: timedOut,
      samples: samples.slice(0, MAX_SAMPLE),
      completed_at: nowIso,
    });
  } catch (error: any) {
    console.error("[V7 DAILY VERIFY]", error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}