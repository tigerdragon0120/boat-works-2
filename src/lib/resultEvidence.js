// 結果の証跡(ResultProvenance)の取得条件・保留条件。
// 日次照合(base44/shared/resultEvidenceRules.js)と同じ規則を持つ画面用の写し。
// 判定に使える証跡: evidence_type=LIVE ・実取得時刻あり・結果ID一致・三連単と取得元一致・レース一致
// 候補はすべて走査し、一致が2件以上ある場合は削除や恣意的な採用をせず保留する。

export const OFFICIAL_RESULT_SOURCES = ['BOATCAST', 'LOCAL', 'TXT'];

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

// 有効な証跡を判定する。rows は対象レースの証跡(全候補)を渡す。
//   ok / duplicate / backfill / missing
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

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

// SDKのページ形式({items, next_cursor, has_more})に沿って、対象レースの証跡を全件読み切る。
// 取得が途中で止まった場合(例外・カーソル欠落・ページ上限)は complete=false を返す
export async function loadRaceEvidence(entity, raceId) {
  if (!entity || !raceId) return { rows: [], complete: false };
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result = null;
    try {
      result = await entity.filter(
        { race_id: raceId, evidence_type: { $in: ['LIVE', 'BACKFILL'] } },
        { sort: '-recorded_at', limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      );
    } catch {
      return { rows, complete: false };
    }
    const items = result?.items || [];
    rows.push(...items);
    const more = result?.has_more === true;
    const next = result?.next_cursor;
    if (!more) return { rows, complete: true };
    // 続きがあるのにカーソルが無い・空ページの場合は読み切れていない
    if (!next || !items.length) return { rows, complete: false };
    cursor = next;
  }
  // ページ上限に達した場合も読み切れていない
  return { rows, complete: false };
}