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
//   - 取得時の記録が無い過去分は、保存済み結果から事後補完(BACKFILL)として1件だけ作成する
//   - race_id × evidence_hash で冪等(同じ記録を増やさない)
// ============================================================

export const OFFICIAL_RESULT_SOURCES = ['BOATCAST', 'LOCAL', 'TXT'];

export const RESULT_ENDPOINTS = {
  BOATCAST: 'boatcast:RS1+RS2',
  LOCAL: 'boatrace.jp:result-html',
  TXT: 'official_file:import',
  BACKFILL: 'backfill:stored_result',
};

export const isValidTrifecta = (value) => {
  const combo = String(value ?? '');
  return /^[1-6]-[1-6]-[1-6]$/.test(combo) && new Set(combo.split('-')).size === 3;
};

export const isOfficialSource = (value) => OFFICIAL_RESULT_SOURCES.includes(String(value ?? ''));

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

export function buildProvenanceDoc(race, result, endpoint, evidenceType = 'LIVE') {
  if (!canRecordProvenance(race, result)) return null;
  const combination = String(result.result_trifecta);
  const source = String(result.source);
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

// 三連単・取得元が一致する記録(事後補完を含む)
export function findAnyProvenance(rows, { combination, source }) {
  if (!isValidTrifecta(combination) || !isOfficialSource(source)) return null;
  const combo = String(combination);
  const src = String(source);
  return (rows || []).find(
    (row) => String(row?.result_trifecta ?? '') === combo && String(row?.source ?? '') === src,
  ) || null;
}

// 判定に使える裏付け: 実取得時の記録(LIVE)で、対象の結果IDと三連単・取得元が一致するもの。
// 事後補完(BACKFILL)だけの結果は証跡として扱わない
export function findProvenanceEvidence(rows, { combination, source, resultId }) {
  const found = findAnyProvenance(rows, { combination, source });
  if (!found) return null;
  if (String(found.evidence_type ?? '') !== 'LIVE') return null;
  if (resultId && String(found.result_id ?? '') !== String(resultId)) return null;
  return found;
}

export async function loadProvenanceByRace(sr, raceIds) {
  const map = new Map();
  const ids = [...new Set((raceIds || []).filter(Boolean))];
  if (!ids.length) return map;
  const rows = await sr.ResultProvenance.filter({ race_id: { $in: ids } }, '-recorded_at', 2000).catch(() => []);
  for (const row of rows || []) {
    if (!row?.race_id) continue;
    const list = map.get(row.race_id) || [];
    list.push(row);
    map.set(row.race_id, list);
  }
  return map;
}

// 結果の保存時に呼ぶ。同じ結果の記録は増やさない
export async function recordResultProvenance(sr, { race, result, endpoint, evidenceType = 'LIVE' }) {
  const doc = buildProvenanceDoc(race, result, endpoint, evidenceType);
  if (!doc) return null;
  const existing = await sr.ResultProvenance
    .filter({ race_id: race.id, evidence_hash: doc.evidence_hash }, '-recorded_at', 1)
    .catch(() => []);
  if (existing && existing[0]) return existing[0];
  return await sr.ResultProvenance.create(doc);
}