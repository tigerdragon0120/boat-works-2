// ============================================================
// 本番オッズ解決レイヤー
// 優先順位: 1. BOATCAST OD3  2. LOCAL OddsSnapshot  3. 欠損
//
// すべての本番オッズ取得はこのモジュールを通す。
// 予想エンジンは oddsMap (combination -> odds) だけを受け取る。
// ============================================================

import { fetchBoatcastText } from "./boatcastClient.js";
import { normalizeOd3 } from "./boatcastNormalizer.js";

// 締切直前オッズの鮮度しきい値(秒)
// 10分超過はSTALEとみなし、BUY判定に使用しない
const STALE_THRESHOLD_SECONDS = 600;

// ============================================================
// BOATCAST OD3取得
// kakutei(確定)を優先、失敗時smt(リアルタイム)へフォールバック
// ============================================================
export async function fetchBoatcastOdds3(race) {
  const venueCode = String(race?.venue_code || '').padStart(2, '0');
  const raceDate = String(race?.race_date || '').replace(/-/g, '');
  const raceNumber = Number(race?.race_number || 0);
  if (!venueCode || !raceDate || !raceNumber) {
    return { ok: false, error: 'missing race identity', http_access_count: 0 };
  }

  let httpCount = 0;
  let normalizedOdds = null;
  let subtype = null;
  let fetchedAt = null;

  // 1. kakutei_od3(確定オッズ)を優先
  const kakuteiResult = await fetchBoatcastText({
    venueCode, raceDate, raceNumber, dataType: 'KAKUTEI_OD3'
  });
  httpCount++;
  if (kakuteiResult.ok) {
    normalizedOdds = normalizeOd3(kakuteiResult.text, {
      race_date: race.race_date,
      venue_code: venueCode,
      race_number: raceNumber,
      fetched_at: kakuteiResult.metadata.fetched_at,
    });
    if (normalizedOdds?.ok) {
      subtype = 'kakutei_od3';
      fetchedAt = kakuteiResult.metadata.fetched_at;
    }
  }

  // 2. smt_od3(リアルタイムオッズ)へフォールバック
  if (!normalizedOdds?.ok) {
    const smtResult = await fetchBoatcastText({
      venueCode, raceDate, raceNumber, dataType: 'SMT_OD3'
    });
    httpCount++;
    if (smtResult.ok) {
      normalizedOdds = normalizeOd3(smtResult.text, {
        race_date: race.race_date,
        venue_code: venueCode,
        race_number: raceNumber,
        fetched_at: smtResult.metadata.fetched_at,
      });
      if (normalizedOdds?.ok) {
        subtype = 'smt_od3';
        fetchedAt = smtResult.metadata.fetched_at;
      }
    }
  }

  if (!normalizedOdds?.ok) {
    return { ok: false, error: 'BOATCAST OD3 fetch failed', http_access_count: httpCount };
  }

  // レース識別情報の照合(別レース混入防止)
  const identityMatch =
    String(normalizedOdds.race_date) === String(race.race_date) &&
    String(normalizedOdds.venue_code) === String(venueCode) &&
    Number(normalizedOdds.race_number) === Number(raceNumber);

  if (!identityMatch) {
    return {
      ok: false,
      error: 'race identity mismatch',
      expected: { race_date: race.race_date, venue_code: venueCode, race_number: raceNumber },
      actual: { race_date: normalizedOdds.race_date, venue_code: normalizedOdds.venue_code, race_number: normalizedOdds.race_number },
      http_access_count: httpCount,
    };
  }

  const integrity = validateOddsIntegrity(normalizedOdds);

  return {
    ok: true,
    source: 'BOATCAST',
    subtype,
    odds: normalizedOdds,
    integrity,
    fetched_at: fetchedAt,
    http_access_count: httpCount,
  };
}

// ============================================================
// 120通り完全性チェック
// ============================================================
export function validateOddsIntegrity(normalizedOdds, activeBoatCount = 6) {
  const expectedCount = activeBoatCount * (activeBoatCount - 1) * (activeBoatCount - 2);
  const total = normalizedOdds.odds.length;
  const uniqueCombos = new Set(normalizedOdds.odds.map(o => o.combination));
  const duplicates = total - uniqueCombos.size;
  const nullOdds = normalizedOdds.odds.filter(o => o.odds == null).length;
  const withdrawCount = normalizedOdds.odds.filter(o => o.is_withdraw).length;
  const invalidCombos = normalizedOdds.odds.filter(o =>
    o.first === o.second || o.first === o.third || o.second === o.third
  ).length;

  return {
    status: (duplicates === 0 && total === expectedCount && nullOdds === 0 && invalidCombos === 0)
      ? 'OK' : 'ERROR',
    total,
    unique: uniqueCombos.size,
    duplicates,
    null_odds: nullOdds,
    invalid_combos: invalidCombos,
    withdraw: withdrawCount,
    expected: expectedCount,
  };
}

// ============================================================
// 正規化済みOD3 → oddsMap (combination -> odds)
// 欠場艇を含む組み合わせは除外
// ============================================================
export function buildOddsMap(normalizedOdds) {
  const map = {};
  for (const o of normalizedOdds.odds) {
    if (o.odds != null && o.odds > 0 && !o.is_withdraw) {
      map[o.combination] = o.odds;
    }
  }
  return map;
}

// ============================================================
// オッズ鮮度判定
// ============================================================
export function getOddsAge(fetchedAt) {
  if (!fetchedAt) return null;
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return Math.round(ageMs / 1000);
}

export function isOddsStale(fetchedAt) {
  const age = getOddsAge(fetchedAt);
  if (age == null) return true;
  return age > STALE_THRESHOLD_SECONDS;
}

// ============================================================
// 本番オッズ解決(メイン)
// 1. BOATCAST OD3(第一優先)
// 2. LOCAL OddsSnapshot(fallback)
// 3. 欠損
// ============================================================
export async function resolveProductionOdds(race, client) {
  // 1. BOATCAST OD3
  const boatcastResult = await fetchBoatcastOdds3(race);
  if (boatcastResult.ok && boatcastResult.integrity.status === 'OK') {
    const oddsMap = buildOddsMap(boatcastResult.odds);
    if (Object.keys(oddsMap).length > 0) {
      return {
        source: 'BOATCAST',
        subtype: boatcastResult.subtype,
        odds_map: oddsMap,
        fetched_at: boatcastResult.fetched_at,
        age_seconds: getOddsAge(boatcastResult.fetched_at),
        is_stale: false, // BOATCASTは取得直後なので非STALE
        integrity: boatcastResult.integrity,
        http_access_count: boatcastResult.http_access_count,
      };
    }
  }

  // 2. LOCAL OddsSnapshot fallback
  const sr = client.asServiceRole.entities;
  const snapshots = await sr.OddsSnapshot.filter({ race_id: race.id }, '-captured_at', 5).catch(() => []);
  const localSnap = snapshots?.[0];
  if (localSnap?.odds_map && typeof localSnap.odds_map === 'object' && Object.keys(localSnap.odds_map).length > 0) {
    const ageSeconds = localSnap.captured_at ? getOddsAge(localSnap.captured_at) : null;
    const stale = ageSeconds != null && ageSeconds > STALE_THRESHOLD_SECONDS;
    return {
      source: 'LOCAL',
      odds_map: localSnap.odds_map,
      fetched_at: localSnap.captured_at,
      age_seconds: ageSeconds,
      is_stale: stale,
      integrity: { status: 'OK', total: Object.keys(localSnap.odds_map).length },
      http_access_count: boatcastResult.http_access_count || 0,
    };
  }

  // 3. 欠損
  return {
    source: null,
    odds_map: {},
    fetched_at: null,
    age_seconds: null,
    is_stale: true,
    integrity: { status: 'MISSING' },
    http_access_count: boatcastResult.http_access_count || 0,
  };
}

// ============================================================
// 締切タイミング判定
// 締切5分前〜締切前のみ取得可能。締切後は新規取得しない。
// ============================================================
export function shouldFetchOdds(race) {
  if (!race?.deadline) return { should: false, reason: 'no deadline' };
  const deadlineMs = new Date(race.deadline).getTime();
  if (!Number.isFinite(deadlineMs)) return { should: false, reason: 'invalid deadline' };
  const nowMs = Date.now();

  if (nowMs > deadlineMs) return { should: false, reason: 'past deadline' };

  const fiveMinBefore = deadlineMs - 5 * 60 * 1000;
  if (nowMs >= fiveMinBefore) return { should: true, reason: 'within 5 min window' };

  return { should: false, reason: 'not yet 5 min before deadline' };
}

export { STALE_THRESHOLD_SECONDS };