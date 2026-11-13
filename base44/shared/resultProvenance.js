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

// 三連単・取得元が一致する記録(事後補完を含む)
export function findAnyProvenance(rows, { combination, source }) {
  if (!isValidTrifecta(combination) || !isOfficialSource(source)) return null;
  const combo = String(combination);
  const src = String(source);
  return (rows || []).find(
    (row) => String(row?.result_trifecta ?? '') === combo && String(row?.source ?? '') === src,
  ) || null;
}

// 事後補完(BACKFILL)の記録。判定には使わない(保留理由の切り分けに使う)
export function findBackfillProvenance(rows, { combination, source }) {
  const found = findAnyProvenance(rows, { combination, source });
  return found && String(found.evidence_type ?? '') === 'BACKFILL' ? found : null;
}

// 判定に使える証跡の条件: 実取得時の記録(LIVE)で、結果ID・三連単・取得元が一致し、
// 実取得時刻が記録されているもの。候補すべてを走査して探す。
// 事後補完(BACKFILL)だけの結果は証跡として扱わない
export function findProvenanceEvidence(rows, { combination, source, resultId }) {
  if (!resultId || !isValidTrifecta(combination) || !isOfficialSource(source)) return null;
  const combo = String(combination);
  const src = String(source);
  const id = String(resultId);
  return (rows || []).find(
    (row) => String(row?.evidence_type ?? '') === 'LIVE'
      && String(row?.result_trifecta ?? '') === combo
      && String(row?.source ?? '') === src
      && String(row?.result_id ?? '') === id
      && !!row?.fetched_at,
  ) || null;
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

const CLAIM_ENTITY = 'ResultProvenanceClaim';
const CLAIM_LEASE_MS = 60000;
const WRITTEN = 'written';

const leaseExpired = (row) => {
  const at = Date.parse(String(row?.claimed_at || ''));
  return !Number.isFinite(at) || Date.now() - at > CLAIM_LEASE_MS;
};

// 登録権の行を「証跡キーごとに1行」へ揃える(DBに一意制約が無いため)
async function ensureClaimRow(sr, key, doc) {
  const load = () => sr[CLAIM_ENTITY].filter({ claim_key: key }, 'created_date', 50).catch(() => null);
  let rows = await load();
  if (rows === null) return null;
  if (!rows.length) {
    await sr[CLAIM_ENTITY].create({
      claim_key: key,
      race_id: doc.race_id,
      evidence_hash: doc.evidence_hash,
      evidence_type: doc.evidence_type,
      state: 'free',
      owner: null,
      provenance_id: null,
      claimed_at: null,
    }).catch(() => null);
    rows = await load();
    if (!rows || !rows.length) return null;
  }
  const sorted = [...rows].sort((a, b) =>
    String(a.created_date || '').localeCompare(String(b.created_date || '')) || String(a.id).localeCompare(String(b.id)));
  const canonical = sorted.find((row) => row.state === WRITTEN) || sorted[0];
  for (const row of sorted) {
    if (row.id === canonical.id || row.state === WRITTEN || row.state === 'writing') continue;
    await sr[CLAIM_ENTITY].delete(row.id).catch(() => null);
  }
  return canonical;
}

// 同じ証跡(evidence_hash×種類)の登録権を条件付き書込で取得する。
// 遷移が成立した1つの呼び出しだけが保存できるため、同じ証跡は1件に保たれる
async function acquireEvidenceClaim(sr, key, doc) {
  const row = await ensureClaimRow(sr, key, doc);
  if (!row) return null;
  if (row.state === WRITTEN) return null;
  if (row.state === 'writing' && !leaseExpired(row)) return null;
  const owner = `${doc.evidence_hash}:${Math.random().toString(36).slice(2, 10)}`;
  const condition = row.state === 'writing'
    ? { id: row.id, state: 'writing', claimed_at: { $lt: new Date(Date.now() - CLAIM_LEASE_MS).toISOString() } }
    : { id: row.id, state: 'free' };
  const result = await sr[CLAIM_ENTITY]
    .updateMany(condition, { $set: { state: 'writing', owner, provenance_id: null, claimed_at: new Date().toISOString() } })
    .catch(() => null);
  if (!result || Number(result.updated) !== 1) return null;
  return { id: row.id, owner };
}

async function finalizeEvidenceClaim(sr, claim, provenanceId) {
  await sr[CLAIM_ENTITY]
    .updateMany({ id: claim.id, state: 'writing', owner: claim.owner },
      { $set: { state: WRITTEN, provenance_id: provenanceId || null, claimed_at: new Date().toISOString() } })
    .catch(() => null);
}

async function releaseEvidenceClaim(sr, claim) {
  await sr[CLAIM_ENTITY]
    .updateMany({ id: claim.id, state: 'writing', owner: claim.owner },
      { $set: { state: 'free', owner: null, provenance_id: null, claimed_at: null } })
    .catch(() => null);
}

// 結果の保存時に呼ぶ。同じ証跡の記録は1件だけ保存する
export async function recordResultProvenance(sr, { race, result, endpoint, evidenceType = 'LIVE', fetchedAt = null }) {
  const doc = buildProvenanceDoc(race, result, endpoint, evidenceType, fetchedAt);
  if (!doc) return null;

  const readSameType = async () => {
    const rows = await sr.ResultProvenance
      .filter({ race_id: race.id, evidence_hash: doc.evidence_hash }, '-recorded_at', 20)
      .catch(() => []);
    // 旧い事後補完(BACKFILL)は新しい実取得(LIVE)の保存を妨げない(種類ごとに重複を判定する)
    return (rows || []).find((row) => String(row?.evidence_type ?? '') === doc.evidence_type) || null;
  };

  const same = await readSameType();
  if (same) return same;

  // 同時に同じ証跡を保存しようとしても、登録権を取れた1つだけが書き込む
  const claim = await acquireEvidenceClaim(sr, `${doc.evidence_hash}:${doc.evidence_type}`, doc);
  if (!claim) return await readSameType();

  try {
    const created = await sr.ResultProvenance.create(doc);
    await finalizeEvidenceClaim(sr, claim, created?.id);
    return created;
  } catch (error) {
    await releaseEvidenceClaim(sr, claim);
    throw error;
  }
}