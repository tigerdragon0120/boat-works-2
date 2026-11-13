// 公式結果の実取得証跡(ResultProvenance)の判定条件。
// 画面と日次照合(verifyV7Daily)で同じ条件を使う:
//   実取得(LIVE)・結果ID一致・三連単と取得元の一致・実取得時刻あり
// 事後補完(BACKFILL)だけの結果は証跡として扱わない。

const COMBO_RE = /^[1-6]-[1-6]-[1-6]$/;
const OFFICIAL_SOURCES = ['BOATCAST', 'LOCAL', 'TXT'];

export const validTrifecta = (value) => COMBO_RE.test(String(value ?? '')) && new Set(String(value).split('-')).size === 3;
export const officialSource = (value) => OFFICIAL_SOURCES.includes(String(value ?? ''));

// 三連単・取得元が一致する記録(事後補完を含む)
function findAnyEvidence(rows, { combination, source }) {
  if (!validTrifecta(combination) || !officialSource(source)) return null;
  const combo = String(combination);
  const src = String(source);
  return (rows || []).find(
    (row) => String(row?.result_trifecta ?? '') === combo && String(row?.source ?? '') === src,
  ) || null;
}

export function findResultEvidence(rows, { combination, source, resultId }) {
  if (!resultId || !validTrifecta(combination) || !officialSource(source)) return null;
  const combo = String(combination);
  const src = String(source);
  const id = String(resultId);
  return (rows || []).find((row) => String(row?.evidence_type ?? '') === 'LIVE'
    && String(row?.result_trifecta ?? '') === combo
    && String(row?.source ?? '') === src
    && String(row?.result_id ?? '') === id
    && !!row?.fetched_at) || null;
}

export function findBackfillEvidence(rows, { combination, source }) {
  const found = findAnyEvidence(rows, { combination, source });
  return found && String(found.evidence_type ?? '') === 'BACKFILL' ? found : null;
}

// TXT取込はファイルを取り込んだ時刻を残すため「取込時刻」と表示する
export const evidenceTimeLabel = (source) => (String(source ?? '') === 'TXT' ? '取込時刻' : '実取得');