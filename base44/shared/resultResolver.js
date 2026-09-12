// ============================================================
// 結果解決レイヤー(BOATCAST優先 / LOCAL fallback)
//
// 優先順位:
//   1. BOATCAST (bc_rs1 + bc_rs2) — 着順・ST・進入・決まり手・天候・全券種払戻
//   2. LOCAL (boatrace.jp 公式HTML) — result_trifecta + payout のみ
//   3. 欠損
//
// 保護ルール:
//   - 既存RaceResultがFINAL確定済みの場合、新データがPARTIAL/WAITINGなら上書きしない
//   - BOATCASTとLOCALでresult_trifectaが異なる場合はCONFLICTログを記録しBOATCAST優先
//   - データ取得失敗時は既存データを保持(空データで上書きしない)
// ============================================================

import { fetchBoatcastText } from "./boatcastClient.js";
import { normalizeRs1, normalizeRs2, normalizeRaceResult } from "./boatcastNormalizer.js";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30分以内なら鮮度OK

// BOATCASTから結果を取得(rs1 + rs2 を並列取得 → 正規化 → 統合)
export async function fetchBoatcastResult(race) {
  try {
    const venueCode = String(race?.venue_code || '').padStart(2, '0');
    const raceDate = String(race?.race_date || '').replace(/-/g, '');
    const raceNumber = Number(race?.race_number || 0);
    if (!venueCode || !raceDate || !raceNumber) {
      return { ok: false, reason: 'invalid_race_params' };
    }

    const metadata = {
      race_date: race.race_date,
      venue_code: venueCode,
      race_number: raceNumber,
      fetched_at: new Date().toISOString(),
    };

    const [rs1Raw, rs2Raw] = await Promise.all([
      fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'RS1' }),
      fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'RS2' }),
    ]);

    // rs1が未公開の場合は結果確定前
    if (!rs1Raw.ok) {
      return { ok: false, reason: 'rs1_not_available', http_access_count: rs1Raw.http_access_count || 0 };
    }

    const rs1Result = normalizeRs1(rs1Raw.text, metadata);
    if (!rs1Result.ok) {
      return { ok: false, reason: `rs1_normalize: ${rs1Result.error}`, status: rs1Result.status };
    }

    // rs2は失敗してもrs1だけで部分結果として扱う(payoutなし)
    let rs2Result = null;
    if (rs2Raw.ok) {
      rs2Result = normalizeRs2(rs2Raw.text, metadata);
    }

    const integrated = normalizeRaceResult(rs1Result, rs2Result, metadata);
    if (!integrated.ok) {
      return { ok: false, reason: integrated.error };
    }

    return {
      ok: true,
      source: 'BOATCAST',
      result: integrated,
      rs1_status: rs1Result.status,
      rs2_status: rs2Result?.status || null,
      http_access_count: (rs1Raw.http_access_count || 0) + (rs2Raw.http_access_count || 0),
      fetched_at: metadata.fetched_at,
    };
  } catch (e) {
    return { ok: false, reason: `exception: ${e.message}` };
  }
}

// 既存RaceResultと新BOATCAST結果をマージ(保護付き)
// 既存がFINAL確定済みで新データがPARTIAL/WAITINGの場合は上書きしない
export function mergeResultProtect(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingIsFinal = existing.result_status === 'RESULT_FINAL' || existing.is_finished === true;
  const incomingIsFinal = incoming.result_status === 'RESULT_FINAL';

  // 既存FINAL + 新PARTIAL → 既存保持
  if (existingIsFinal && !incomingIsFinal) return existing;

  // 既存FINAL + 新FINAL → CONFLICTチェック
  if (existingIsFinal && incomingIsFinal) {
    const conflictLog = checkConflict(existing, incoming);
    if (conflictLog) {
      // BOATCAST優先だがCONFLICTログを保持
      return { ...incoming, conflict_log: conflictLog };
    }
    return incoming;
  }

  // 既存PARTIAL + 新FINAL → 新データで上書き
  // 既存PARTIAL + 新PARTIAL → より完全な方
  return incoming;
}

// BOATCASTとLOCALの不整合を検出
function checkConflict(existing, incoming) {
  const conflicts = [];
  if (existing.result_trifecta && incoming.result_trifecta && existing.result_trifecta !== incoming.result_trifecta) {
    conflicts.push(`result_trifecta: ${existing.result_trifecta}(existing/${existing.source}) vs ${incoming.result_trifecta}(incoming/${incoming.source})`);
  }
  if (existing.payout && incoming.payout && existing.payout !== incoming.payout) {
    conflicts.push(`payout: ${existing.payout} vs ${incoming.payout}`);
  }
  return conflicts.length ? conflicts.join('; ') : null;
}

// 結果解決メイン: BOATCAST優先、失敗時はnull(LOCAL fallbackは呼出側で処理)
export async function resolveRaceResult(race) {
  const boatcastResult = await fetchBoatcastResult(race);

  if (boatcastResult.ok) {
    return {
      source: 'BOATCAST',
      result: boatcastResult.result,
      rs1_status: boatcastResult.rs1_status,
      rs2_status: boatcastResult.rs2_status,
      fetched_at: boatcastResult.fetched_at,
      http_access_count: boatcastResult.http_access_count,
    };
  }

  return {
    source: null,
    reason: boatcastResult.reason,
    rs1_status: boatcastResult.status || null,
  };
}