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
// ページ形式({items, next_cursor, has_more})の取得を使うため 0.8.60 を使用する
import { createClientFromRequest } from "npm:@base44/sdk@0.8.60";
import { loadProvenanceByRace } from "../../shared/resultProvenance.js";
// 予想・検証記録も全件読み切る(途中で切れると重複した組を見落とすため)
import { fetchAllPaged } from "../../shared/pagedFetch.js";
// 証跡は全件取得できない場合に判定を保留する(共有のページ取得処理を使用)
import { resolveEvidence, evidenceHoldReason } from "../../shared/resultEvidenceRules.js";

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const TIME_BUDGET_MS = 60000;
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

// 予想レコードの並び順: 保存時刻 → 照合時刻 → id(画面の集計と同じ規則)
const rowOrder = (a: any, b: any) =>
  String(a?.created_date || "").localeCompare(String(b?.created_date || ""))
  || String(a?.verified_at || "").localeCompare(String(b?.verified_at || ""))
  || String(a?.id || "").localeCompare(String(b?.id || ""));

// 予想1件の現在の判定。判定状態が無い行は旧方式として扱う
function judgmentOf(row: any): string | null {
  if (!row) return null;
  if (row.verification_status) return String(row.verification_status);
  if (row.pre_deadline_verified === true && row.record_fixed === true && row.result_finished === true) return "VERIFIED";
  return "LEGACY";
}

// 判定が変わったかどうかだけを見る。最新の記録と同じ判定なら追記しない
const judgmentChanged = (previous: any, nextStatus: string): boolean => {
  if (!previous) return true;
  return judgmentOf(previous) !== nextStatus;
};

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

    // 証跡が不足して保留した記録は、あとから公式結果を実取得したときに再判定できるよう、
    // 通常の対象日より前の日も照合し直す。保留は保留のまま維持し、
    // 実取得の証跡が揃って判定が変わったときだけ新しい行を追記する
    const PROVENANCE_HOLDS = ["HELD_PROVENANCE_MISSING", "HELD_PROVENANCE_BACKFILL", "HELD_PROVENANCE_INCOMPLETE", "HELD_PROVENANCE_DUPLICATE"];
    const recheckDays = Number.isFinite(Number(body?.recheck_days)) ? Math.min(30, Math.max(1, Number(body.recheck_days))) : 7;
    let recheckDates: string[] = [];
    if (!requestedDate) {
      const cutoff = jstDateOffset(-recheckDays);
      const heldRows: any[] = await sr.PredictionV7Verification
        .filter({ verification_status: { $in: PROVENANCE_HOLDS }, race_date: { $gte: cutoff } }, "-verified_at", 1000)
        .catch(() => []);
      recheckDates = [...new Set((heldRows || [])
        .map((row: any) => row?.race_date)
        .filter((value: any) => typeof value === "string" && value >= cutoff && !dates.includes(value)))];
    }
    const targetDates = [...dates, ...recheckDates];

    // 対象日の予想は全件読み切る。読み切れなかった場合は、重複した組を見落として
    // 的中率・回収率に混ぜてしまうため、判定そのものを行わず保留する
    const predictionPages = await fetchAllPaged(
      (query: any, options: any) => sr.PredictionV7.filter(query, options),
      { race_date: { $in: targetDates } },
      { sort: "-generated_at" },
    );
    if (!predictionPages.complete) {
      return Response.json({
        ok: true,
        dates,
        dry_run: dryRun,
        skipped_incomplete: "PREDICTIONS_INCOMPLETE",
        written: 0,
        completed_at: nowIso,
      });
    }
    const records: any[] = predictionPages.rows;

    if (!records.length) {
      return Response.json({ ok: true, dates, dry_run: dryRun, records: 0, groups: 0, verified: 0, held: 0, held_by_reason: {} });
    }

    // 途中で切り捨てると重複した組が1件だけに見えてしまうため、切り捨ては行わない
    // (実行時間は下の TIME_BUDGET_MS で打ち切る)
    const limited = records.filter((record: any) => record?.race_key && record?.stage && record?.record_hash);
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

    // 公式取得経路の記録: 結果の取得時に保存された実取得の証跡だけを読む(事後補完は判定に使わない)。
    // 証跡を全件読み切れなかった場合は、証跡に依存する判定を行わず保留する
    const provenance = await loadProvenanceByRace(sr, raceIds);
    const provenanceByRace = provenance.byRace;
    const provenanceComplete = provenance.complete;

    // 既存の照合記録は書き換えない。予想1件につき最新の記録だけを「現在の判定」として読む。
    // 判定が変わったときだけ新しい行を追記する(再判定)
    const existingPages = await fetchAllPaged(
      (query: any, options: any) => sr.PredictionV7Verification.filter(query, options),
      { race_date: { $in: targetDates } },
      { sort: "-verified_at" },
    );
    if (!existingPages.complete) {
      return Response.json({
        ok: true,
        dates,
        dry_run: dryRun,
        skipped_incomplete: "VERIFICATION_RECORDS_INCOMPLETE",
        written: 0,
        completed_at: nowIso,
      });
    }
    const existing: any[] = existingPages.rows;
    const latestByHash = new Map<string, any>();
    for (const row of existing || []) {
      const hash = String(row?.record_hash || "");
      if (!hash) continue;
      const previous = latestByHash.get(hash);
      if (!previous || rowOrder(row, previous) > 0) latestByHash.set(hash, row);
    }

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
    let heldCount = 0;
    let duplicateGroups = 0;
    let duplicateRecords = 0;
    let rejudgedCount = 0;
    let newCount = 0;
    let skippedAlready = 0;
    let skippedNotReady = 0;
    let timedOut = false;
    const startedAt = Date.now();
    const bump = (reason: string) => { heldByReason[reason] = (heldByReason[reason] || 0) + 1; };

    for (const list of groups.values()) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) { timedOut = true; break; }
      // 集計単位: レース×段階。2件以上ある場合は最初の1件も含めて全件を重複保留とする
      const ordered = [...list].sort(rowOrder);
      const record = ordered[0];
      const raceRows = raceRowsByKey.get(record.race_key) || [];
      const resolved = resolveRace(raceRows, record);
      const race = resolved.race || null;
      const hashes = ordered.map((row: any) => String(row.record_hash));

      // 1) 重複したレース×段階は全件 DUPLICATE(代表を決めず、的中率・回収率から除外)
      if (ordered.length > 1) {
        for (const row of ordered) {
          const hash = String(row.record_hash);
          const known = latestByHash.get(hash) || null;
          const knownStatus = judgmentOf(known);
          // 旧方式の記録は動かさない。同じ重複保留なら増やさない(別の判定から変わったときだけ追記)
          if (known && known.verification_version !== NEW_VERSION) continue;
          if (!judgmentChanged(known, "HELD_DUPLICATE")) continue;
          const doc = heldDoc(row, race, "DUPLICATE", ["DUPLICATE"], {
            duplicate_count: ordered.length,
            duplicate_hashes: hashes.slice(0, 10),
            result_finished: !!(race ? resultByRace.get(race.id) : null),
          }, nowIso);
          docs.push(doc);
          latestByHash.set(hash, doc);
          duplicateRecords += 1;
          heldCount += 1;
          if (known) rejudgedCount += 1; else newCount += 1;
          bump("DUPLICATE");
          samples.push({ race_key: record.race_key, stage: record.stage, status: "HELD_DUPLICATE", reasons: ["DUPLICATE"], duplicate_count: ordered.length });
        }
        duplicateGroups += 1;
        continue;
      }

      // 2) 判定。最新の記録と同じ判定なら追記しない(判定が変わったときだけ追記する)
      const previous = latestByHash.get(String(record.record_hash)) || null;
      // 旧方式の記録は書き換えない
      if (previous && previous.verification_version !== NEW_VERSION) { skippedAlready += 1; continue; }

      // 理由別の保留判定
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
      let evidence: any = null;

      if (result) {
        const finishedAt = dbMs(result.finished_at);
        if (finishedAt != null && savedAt != null && finishedAt < savedAt - IMMUTABLE_TOLERANCE_MS) reasons.push("TIME_CONFLICT");
        // 実取得の証跡が結果ID・三連単・取得元と一致することを確認できた結果だけを照合に使う。
        // 事後補完だけの結果は判定保留とする
        const evidenceRows = provenanceByRace.get(race.id) || [];
        const resolvedEvidence = resolveEvidence(evidenceRows, {
          combination: result.result_trifecta,
          source: result.source,
          resultId: result.id,
          raceId: String(race.id),
        });
        evidence = resolvedEvidence.status === "ok" ? resolvedEvidence.row : null;
        // 重複した実取得の証跡は削除も採用もしない
        const evidenceHold = evidenceHoldReason(resolvedEvidence.status);
        if (evidenceHold) reasons.push(evidenceHold);
        if (!provenanceComplete) reasons.push("PROVENANCE_INCOMPLETE");
        if (payout == null) reasons.push("PAYOUT_MISSING");
        if (!tickets.length) reasons.push("TICKETS_MISSING");
      }

      // 結果待ちは保留記録を作らず、未検証として残す(次回の照合で判定する)
      if (!result && !reasons.length) { skippedNotReady += 1; continue; }

      if (reasons.length) {
        const unique = [...new Set(reasons)];
        const priority = ["RACE_MISMATCH", "DEADLINE_UNKNOWN", "LATE", "TIME_CONFLICT", "PROVENANCE_INCOMPLETE", "PROVENANCE_MISSING", "PROVENANCE_DUPLICATE", "PROVENANCE_BACKFILL", "PAYOUT_MISSING", "TICKETS_MISSING"];
        const primary = priority.find((reason) => unique.includes(reason)) || unique[0];
        const nextStatus = `HELD_${primary}`;
        // 同じ保留のままなら記録を増やさない(補完後に判定が変わったときだけ追記する)
        if (previous && judgmentOf(previous) === nextStatus) { skippedAlready += 1; continue; }
        const doc = heldDoc(record, race, primary, unique, {
          result_status: result ? result.result_status || null : null,
          result_finished: !!result,
        }, nowIso);
        docs.push(doc);
        latestByHash.set(String(record.record_hash), doc);
        if (previous) rejudgedCount += 1; else newCount += 1;
        heldCount += 1;
        bump(primary);
        samples.push({ race_key: record.race_key, stage: record.stage, status: nextStatus, reasons: unique });
        continue;
      }

      // 3) 有効検証: 締切前のDB保存・記録固定・確定結果・払戻・買い目がすべて揃っている
      //    既に有効検証として記録済みなら追記しない
      if (!judgmentChanged(previous, "VERIFIED")) { skippedAlready += 1; continue; }
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
        result_provenance_id: evidence?.id || null,
        payout,
        verified_at: nowIso,
      });
      const verifiedDoc = docs[docs.length - 1];
      latestByHash.set(String(record.record_hash), verifiedDoc);
      if (previous) rejudgedCount += 1; else newCount += 1;
      verified += 1;
      samples.push({ race_key: record.race_key, stage: record.stage, status: "VERIFIED", reasons: [] });
    }

    const held = heldCount;

    // 画面と同じ定義(レース×段階=1組・2件以上は全件保留・最新の記録だけを採用)で4件数を数え、
    // 照合結果と並べて確認できるよう snapshot として返す。
    // 未保存(締切済みで予想が無いレース)はレース単位のため画面側が同じ条件で数える。
    const snapshotHolds: Record<string, number> = {};
    let snapshotVerified = 0, snapshotHeld = 0, snapshotUnverified = 0, snapshotLegacy = 0;
    let snapshotSingleGroups = 0, snapshotDuplicateGroups = 0, snapshotDuplicateRecords = 0;
    for (const list of groups.values()) {
      const ordered = [...list].sort(rowOrder);
      if (ordered.length > 1) {
        snapshotDuplicateGroups += 1;
        snapshotDuplicateRecords += ordered.length;
        snapshotHeld += 1;
        snapshotHolds.DUPLICATE = (snapshotHolds.DUPLICATE || 0) + 1;
        continue;
      }
      snapshotSingleGroups += 1;
      const row = latestByHash.get(String(ordered[0].record_hash)) || null;
      const status = judgmentOf(row);
      if (!status) { snapshotUnverified += 1; continue; }
      if (status === "VERIFIED") { snapshotVerified += 1; continue; }
      if (status === "LEGACY") { snapshotLegacy += 1; continue; }
      snapshotHeld += 1;
      const key = String((row && row.hold_reason) || status.replace(/^HELD_/, ""));
      snapshotHolds[key] = (snapshotHolds[key] || 0) + 1;
    }
    const snapshot = {
      records: limited.length,
      groups: groups.size,
      single_groups: snapshotSingleGroups,
      duplicate_groups: snapshotDuplicateGroups,
      duplicate_records: snapshotDuplicateRecords,
      verified: snapshotVerified,
      held: snapshotHeld,
      unverified: snapshotUnverified,
      legacy: snapshotLegacy,
      held_by_reason: snapshotHolds,
      dry_run: dryRun,
    };

    if (!dryRun) {
      for (let i = 0; i < docs.length; i += 100) {
        await sr.PredictionV7Verification.bulkCreate(docs.slice(i, i + 100));
      }
    }

    return Response.json({
      ok: true,
      dates,
      recheck_dates: recheckDates,
      dry_run: dryRun,
      version: NEW_VERSION,
      records: limited.length,
      groups: groups.size,
      duplicate_groups: duplicateGroups,
      duplicate_records: duplicateRecords,
      rejudged: rejudgedCount,
      new_records: newCount,
      would_write: docs.length,
      provenance_complete: provenanceComplete,
      snapshot,
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