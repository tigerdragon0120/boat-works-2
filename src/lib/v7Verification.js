// V7検証記録の集計ヘルパー。
// 新方式(verification_version='v2')と旧方式の記録を区別し、
// 有効検証(VERIFIED)だけを的中率・回収率の対象にする。

export const NEW_VERSION = 'v2';

export const HOLD_LABELS = {
  DUPLICATE: '同一レース×段階の重複',
  LATE: '締切後の保存',
  DEADLINE_UNKNOWN: '締切不明',
  TIME_CONFLICT: '時刻の矛盾',
  PAYOUT_MISSING: '払戻不足',
  TICKETS_MISSING: '買い目不足',
  RACE_MISMATCH: '参照先の不一致',
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