// ============================================================
// 結果の公式取得経路の記録(ResultProvenance)
//
// 目的:
//   保存したRaceResultが「どの公式取得経路から・いつ取得されたか」を結果とセットで残し、
//   的中判定の前にその記録と結果が一致することを確認する。
//
// ルール:
//   - 公式ソース(BOATCAST / LOCAL / TXT)と三連単の形式(1〜6の異なる3艇)が
//     正しい結果だけを記録する
//   - 結果の保存時に記録する(LIVE)のが原則
//   - 取得時の記録が無い過去分は、保存済み結果から事後補完(BACKFILL)として作成する
//   - race_id × evidence_hash × 種類 を目安に同じ記録は増やさない(DBに一意制約は無いため、
//     同時保存で重複した場合は判定側で保留する。削除や恣意的な採用はしない)
//   - 判定に使える証跡の条件・保留条件は resultEvidenceRules に集約する
// ============================================================
import {
  OFFICIAL_RESULT_SOURCES,
  RESULT_ENDPOINTS,
  isValidTrifecta,
  isOfficialSource,
  findBackfillEvidence,
  resolveEvidence,
  evidenceHoldReason,
} from './resultEvidenceRules.js';
import { fetchAllPaged } from './pagedFetch.js';

export { OFFICIAL_RESULT_SOURCES, RESULT_ENDPOINTS, isValidTrifecta, isOfficialSource, resolveEvidence, evidenceHoldReason };

function digest(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash * 33) ^ input.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

export function evidenceHash({ raceId, combination, source, finishedAt }) {
  return digest([raceId, combination, source, finishedAt || ''].join('|'));
}

// 記録できる結果か(公式ソース・三連単の形式・レースの特定)
export function canRecordProvenance(race, result) {
  return !!race?.id && !!result && isOfficialSource(result.source) && isValidTrifecta(result.result_trifecta);
}

export function buildProvenanceDoc(race, result, endpoint, evidenceType = 'LIVE', fetchedAt = null) {
  if (!canRecordProvenance(race, result)) return null;
  const combination = String(result.result_trifecta);
  const source = String(result.source);
  // 実取得(LIVE)の記録は、実取得時刻と結果IDが揃っているときだけ作る
  const acquired = evidenceType === 'LIVE' && fetchedAt ? String(fetchedAt) : null;
  if (evidenceType === 'LIVE' && (!acquired || !result.id)) return null;
  return {
    race_id: race.id,
    race_key: race.race_key || null,
    race_date: race.race_date || null,
    venue_code: race.venue_code != null ? String(race.venue_code) : null,
    race_number: race.race_number != null ? Number(race.race_number) : null,
    result_id: result.id || null,
    result_trifecta: combination,
    source,
    endpoint: endpoint || RESULT_ENDPOINTS[source] || null,
    finished_at: result.finished_at || null,
    fetched_at: acquired,
    recorded_at: new Date().toISOString(),
    evidence_type: evidenceType,
    evidence_hash: evidenceHash({
      raceId: race.id,
      combination,
      source,
      finishedAt: result.finished_at,
    }),
  };
}

// 判定に使える証跡(実取得の記録がちょうど1件のときだけ)。重複時はnull
export function findProvenanceEvidence(rows, criteria) {
  const resolved = resolveEvidence(rows, criteria);
  return resolved.status === 'ok' ? resolved.row : null;
}

// 事後補完(BACKFILL)の記録。判定には使わない
export function findBackfillProvenance(rows, criteria) {
  return findBackfillEvidence(rows, criteria);
}

// 対象レースの証跡を全件読み切る。取得が途中で止まった場合は complete=false を返し、
// 呼び出し側は証跡を使った判定を行わず保留する。
export async function loadProvenanceByRace(sr, raceIds) {
  const byRace = new Map();
  const ids = [...new Set((raceIds || []).filter(Boolean))];
  if (!ids.length) return { byRace, complete: true };
  const { rows, complete } = await fetchAllPaged(
    (query, options) => sr.ResultProvenance.filter(query, options),
    {
      race_id: { $in: ids },
      evidence_type: { $in: ['LIVE', 'BACKFILL'] },
    },
    { sort: '-recorded_at' },
  );
  for (const row of rows) {
    if (!row?.race_id) continue;
    const list = byRace.get(row.race_id) || [];
    list.push(row);
    byRace.set(row.race_id, list);
  }
  return { byRace, complete };
}

// 結果の保存時に呼ぶ。同じ記録は増やさない(同時保存で重複した場合は判定側で保留する)
export async function recordResultProvenance(sr, { race, result, endpoint, evidenceType = 'LIVE', fetchedAt = null }) {
  const doc = buildProvenanceDoc(race, result, endpoint, evidenceType, fetchedAt);
  if (!doc) return null;
  const existing = await sr.ResultProvenance
    .filter({ race_id: race.id, evidence_hash: doc.evidence_hash }, '-recorded_at', 20)
    .catch(() => []);
  // 同じ種類の記録が既にあれば増やさない。旧い事後補完(BACKFILL)は
  // 新しい実取得(LIVE)の保存を妨げない(種類ごとに重複を判定する)
  const sameType = (existing || []).find((row) => String(row?.evidence_type ?? '') === doc.evidence_type);
  if (sameType) return sameType;
  return await sr.ResultProvenance.create(doc);
}