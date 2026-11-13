// ============================================================
// 結果の証跡(ResultProvenance)の取得条件・保留条件の共通処理。
// レース詳細の画面と日次照合(verifyV7Daily)の両方がこの規則を使う。
//
// 判定に使える証跡:
//   evidence_type=LIVE ・ 実取得時刻あり ・ 結果ID一致 ・ 三連単と取得元一致 ・ レース一致
//   候補はすべて走査し、一致が2件以上ある場合は削除や恣意的な採用をせず保留する
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

// TXT取込はファイルを取り込んだ時刻を残すため「取込時刻」と表示する
export const evidenceTimeLabel = (source) => (String(source ?? '') === 'TXT' ? '取込時刻' : '実取得');

const matchesComboSource = (row, combo, src) =>
  String(row?.result_trifecta ?? '') === combo && String(row?.source ?? '') === src;

// 事後補完(BACKFILL)の記録。判定には使わない(保留理由の切り分けに使う)
export function findBackfillEvidence(rows, { combination, source }) {
  if (!isValidTrifecta(combination) || !isOfficialSource(source)) return null;
  const combo = String(combination);
  const src = String(source);
  return (rows || []).find((row) => String(row?.evidence_type ?? '') === 'BACKFILL'
    && matchesComboSource(row, combo, src)) || null;
}

// 有効な証跡を判定する。candidates は対象レースの証跡(全候補)を渡す。
//   ok        : 条件に一致する実取得の記録がちょうど1件
//   duplicate : 一致する実取得の記録が2件以上(削除も採用もしない)
//   backfill  : 実取得の記録が無く、事後補完の記録だけがある
//   missing   : 記録そのものが無い
export function resolveEvidence(rows, { combination, source, resultId, raceId }) {
  if (!isValidTrifecta(combination) || !isOfficialSource(source)) {
    return { status: 'missing', row: null, matches: [], count: 0 };
  }
  const combo = String(combination);
  const src = String(source);
  const id = resultId ? String(resultId) : null;
  const race = raceId ? String(raceId) : null;

  const matches = (rows || []).filter((row) => String(row?.evidence_type ?? '') === 'LIVE'
    && !!row?.fetched_at
    && matchesComboSource(row, combo, src)
    && !!id && String(row?.result_id ?? '') === id
    && (!race || String(row?.race_id ?? '') === race));

  if (matches.length > 1) return { status: 'duplicate', row: null, matches, count: matches.length };
  if (matches.length === 1) return { status: 'ok', row: matches[0], matches, count: 1 };
  const backfill = findBackfillEvidence(rows, { combination: combo, source: src });
  return { status: backfill ? 'backfill' : 'missing', row: null, matches: [], count: 0 };
}

// 証跡の状態から保留理由を返す(有効ならnull)
export function evidenceHoldReason(status) {
  if (status === 'ok') return null;
  if (status === 'duplicate') return 'PROVENANCE_DUPLICATE';
  if (status === 'backfill') return 'PROVENANCE_BACKFILL';
  return 'PROVENANCE_MISSING';
}