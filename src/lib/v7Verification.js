// V7検証記録の集計ヘルパー。
// 新方式(verification_version='v2')と旧方式の記録を区別し、
// 有効検証(VERIFIED)だけを的中率・回収率の対象にする。

export const NEW_VERSION = 'v2';

export const HOLD_LABELS = {
  DUPLICATE: '同一レース×段階の重複',
  LATE: '締切後の保存',
  DEADLINE_UNKNOWN: '締切不明',
  TIME_CONFLICT: '時刻の矛盾',
  PROVENANCE_MISSING: '公式取得経路の記録なし',
  PROVENANCE_DUPLICATE: '実取得の証跡が重複',
  PROVENANCE_INCOMPLETE: '証跡の全件取得が未完了',
  PROVENANCE_BACKFILL: '実取得の証跡なし（事後補完のみ）',
  PAYOUT_MISSING: '払戻不足',
  TICKETS_MISSING: '買い目不足',
  RACE_MISMATCH: '参照先の不一致',
  RESULT_CONFLICT: '公式確定結果の矛盾',
};

export const isNewFormat = (row) => row?.verification_version === NEW_VERSION;
export const isVerified = (row) => isNewFormat(row) && row?.verification_status === 'VERIFIED';
export const isHeld = (row) => isNewFormat(row)
  && typeof row?.verification_status === 'string'
  && row.verification_status.startsWith('HELD_');

export const holdKey = (row) => row?.hold_reason || String(row?.verification_status || '').replace(/^HELD_/, '');

export function holdBreakdown(rows) {
  const counts = {};
  for (const row of rows) {
    if (!isHeld(row)) continue;
    const key = holdKey(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// 旧方式: 同一レース・段階・モデルでは締切前の初回予想だけを代表として数える(従来の集計)
function firstPerRace(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.race_key}|${row.stage}|${row.model}`;
    const previous = map.get(key);
    if (!previous || String(row.generated_at) < String(previous.generated_at)) map.set(key, row);
  }
  return [...map.values()];
}

function summarize(list, { stage, mode, count }) {
  return ['OPEN', 'WOMENS'].map((model) => {
    const items = list.filter((row) => (row.model || 'OPEN') === model && row.stage === stage);
    const rank = [0, 0, 0];
    let n = 0, hits = 0, stake = 0, payout = 0;
    for (const row of items) {
      const plan = (row.plans || []).find((item) => item.key === `${mode}_${count}`);
      if (!plan) continue;
      n++;
      stake += Number(plan.investment || 0);
      (row.rank_hits || []).forEach((hit, i) => { if (hit && i < 3) rank[i]++; });
      if (!plan.hit) continue;
      hits++;
      payout += Number(plan.payout || 0);
    }
    return {
      model, n, hits, stake,
      hitRate: n ? hits / n : null,
      recovery: n && stake ? payout / stake : null,
      rank: rank.map((value) => (n ? value / n : null)),
    };
  });
}

export const summarizeVerified = (rows, options) => summarize(rows.filter(isVerified), options);

export const summarizeLegacy = (rows, options) => summarize(
  firstPerRace(rows.filter((row) => !isNewFormat(row)))
    .filter((row) => row.pre_deadline_verified === true && row.record_fixed === true && row.result_finished === true),
  options
);

export const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
export const yen = (value) => (value == null ? '—' : `${Number(value).toLocaleString('ja-JP')}円`);

export function jstDate(offsetDays = 0) {
  const base = new Date(Date.now() + offsetDays * 86400000);
  return base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ---- 集計単位: レース×段階ごとの代表予想 × 予想1件につき最新の記録 ----
// 照合処理(verifyV7Daily)と同じ規則で並べる: 保存時刻 → 照合時刻 → id
export const rowOrder = (a, b) => String(a?.created_date || '').localeCompare(String(b?.created_date || ''))
  || String(a?.verified_at || '').localeCompare(String(b?.verified_at || ''))
  || String(a?.id || '').localeCompare(String(b?.id || ''));

export const judgmentOf = (row) => {
  if (!row) return null;
  if (row.verification_status) return String(row.verification_status);
  const legacyValid = row.pre_deadline_verified === true && row.record_fixed === true && row.result_finished === true;
  return legacyValid ? 'VERIFIED' : 'LEGACY';
};

const raceTime = (value) => {
  const raw = String(value ?? '').trim().replace(/(\.\d{3})\d+/, '$1');
  if (!raw) return NaN;
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`);
};

// レース×段階ごとにまとめる。2件以上ある組は、最初の1件も含めて全件を重複保留として扱う
export function groupPredictions(predictions) {
  const groups = new Map();
  for (const row of predictions || []) {
    if (!row?.record_hash || !row?.race_key || !row?.stage) continue;
    const key = `${row.race_key}::${row.stage}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

// 予想1件につき最新の照合記録だけを現在の判定として採用する(再判定は追記されるため)
export function latestPerRecord(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const hash = row?.record_hash;
    if (!hash) continue;
    const previous = map.get(hash);
    if (!previous || rowOrder(row, previous) > 0) map.set(hash, row);
  }
  return map;
}

// 画面の4件数(未保存・未検証・保留・有効検証)を照合処理と同じ条件で数える。
// 数えるのはレース×段階の組(2件以上ある組は重複保留1組として数える)
export function reconcileV7({ predictions = [], verifications = [], races = [] }) {
  const groups = groupPredictions(predictions);
  const latest = latestPerRecord(verifications);
  const now = Date.now();
  const closed = (races || []).filter((race) => race?.status !== 'cancelled'
    && Number.isFinite(raceTime(race?.deadline)) && raceTime(race.deadline) <= now);
  const predicted = new Set(predictions.map((row) => row?.race_key).filter(Boolean));
  const unsaved = closed.filter((race) => !predicted.has(race.race_key)).length;

  const holds = {};
  const rows = [];
  let verified = 0, held = 0, unverified = 0, legacy = 0;
  let duplicateGroups = 0, duplicateRecords = 0, singleGroups = 0;

  for (const list of groups.values()) {
    const ordered = [...list].sort(rowOrder);
    // 2件以上ある組は代表を決めず、全件を的中率・回収率から除外する
    if (ordered.length > 1) {
      duplicateGroups++;
      duplicateRecords += ordered.length;
      held++;
      holds.DUPLICATE = (holds.DUPLICATE || 0) + 1;
      continue;
    }
    singleGroups++;
    const row = latest.get(ordered[0].record_hash) || null;
    const status = judgmentOf(row);
    if (!row) { unverified++; continue; }
    if (status === 'VERIFIED') { verified++; rows.push(row); continue; }
    if (status === 'LEGACY') { legacy++; rows.push(row); continue; }
    held++;
    rows.push(row);
    const key = row.hold_reason || String(status || '').replace(/^HELD_/, '');
    holds[key] = (holds[key] || 0) + 1;
  }

  return {
    closedRaces: closed.length,
    records: predictions.length,
    groups: groups.size,
    singleGroups,
    duplicateGroups,
    duplicateRecords,
    verified,
    held,
    unverified,
    legacy,
    unsaved,
    holds: Object.entries(holds).sort((a, b) => b[1] - a[1]),
    rows,
  };
}