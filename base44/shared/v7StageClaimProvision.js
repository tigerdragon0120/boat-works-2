// ============================================================
// V7 予想保存に必要な登録枠(V7StageClaim)を、未来の対象レース×PRE/FINALについて
// 冪等に用意し、必ず再読取で存在を確認する。
//
// Base44 DBには一意制約が無いため、初回作成の一意性は保証できない。
// したがって「作成できたこと」ではなく「再読取で1行だけ存在すること」を準備済みの条件とし、
// 0行(未作成・不可視)と2行以上(重複)は未準備として返し、呼び出し側で保存を止める。
// 既存の登録枠は削除も更新もしない。
// ============================================================
import { fetchAllPaged } from './pagedFetch.js';
import { timeMs } from './liveV7Time.js';

const CLAIM_ENTITY = 'V7StageClaim';
const STAGES = ['PRE', 'FINAL'];
// $in の件数を抑え、1回あたりの読み取り量を一定に保つ
const KEY_CHUNK = 25;

const pairOf = (raceKey, stage) => `${raceKey}::${stage}`;

async function loadClaims(sr, claimKeys) {
  const rows = [];
  for (let i = 0; i < claimKeys.length; i += KEY_CHUNK) {
    const page = await fetchAllPaged(
      (query, options) => sr[CLAIM_ENTITY].filter(query, options),
      { claim_key: { $in: claimKeys.slice(i, i + KEY_CHUNK) } },
    );
    // 読み切れない場合は件数を判断できないため、その組は準備済みとしない
    if (!page.complete) return { rows: [], complete: false };
    rows.push(...page.rows);
  }
  return { rows, complete: true };
}

const countByPair = (rows, expected) => {
  const counts = new Map();
  for (const row of rows) if (expected.has(row.claim_key)) counts.set(row.claim_key, (counts.get(row.claim_key) || 0) + 1);
  return counts;
};

// races: 生成対象(未来のレースのみを内部で選ぶ)
// allowCreate: false のときは既存行の確認だけを行う(作成はしない)
export async function provisionStageClaims(sr, races, { nowMs = Date.now(), allowCreate = true } = {}) {
  const expected = new Map();
  for (const race of races || []) {
    if (!race || !race.race_key) continue;
    // 締切済み・終了レースの登録枠は作らない(事後生成・遡及確定を前提にしない)
    if (['finished', 'cancelled'].includes(race.status)) continue;
    const deadline = timeMs(race.deadline);
    if (deadline == null || deadline <= nowMs) continue;
    for (const stage of STAGES) {
      const pair = pairOf(race.race_key, stage);
      if (!expected.has(pair)) expected.set(pair, { claim_key: pair, race_key: race.race_key, stage });
    }
  }

  const summary = {
    expected: expected.size, created: 0, ready: 0,
    missing: [], duplicate: [], read_complete: true, creation_unconfirmed: 0,
  };
  if (!expected.size) return { ...summary, readyPairs: new Set() };

  const before = await loadClaims(sr, [...expected.keys()]);
  if (!before.complete) {
    summary.read_complete = false;
    return { ...summary, readyPairs: new Set() };
  }
  const beforeCounts = countByPair(before.rows, expected);
  const missingKeys = [...expected.keys()].filter((key) => !beforeCounts.has(key));

  if (allowCreate && missingKeys.length) {
    for (let i = 0; i < missingKeys.length; i += KEY_CHUNK) {
      const docs = missingKeys.slice(i, i + KEY_CHUNK).map((key) => ({
        ...expected.get(key), state: 'free', owner: null, record_hash: null, claimed_at: null,
      }));
      // 作成の成否はここでは判断しない。下の再読取だけで確定させる
      await sr[CLAIM_ENTITY].bulkCreate(docs).catch(() => null);
    }
  }

  // 作成後も必ず全件を読み直す。作成応答は存在の証明にしない
  // (作成していない場合は、直前の読み取り結果をそのまま確認結果として使う)
  const after = missingKeys.length ? await loadClaims(sr, [...expected.keys()]) : { rows: before.rows, complete: true };
  if (!after.complete) {
    summary.read_complete = false;
    return { ...summary, readyPairs: new Set() };
  }
  const afterCounts = countByPair(after.rows, expected);
  const readyPairs = new Set();
  for (const key of expected.keys()) {
    const count = afterCounts.get(key) || 0;
    if (count === 1) { readyPairs.add(key); summary.ready += 1; continue; }
    if (count > 1) summary.duplicate.push(key); else summary.missing.push(key);
  }
  summary.created = allowCreate ? missingKeys.filter((key) => afterCounts.get(key) === 1).length : 0;
  // 作成を試みたが再読取で確認できなかった組だけを「作成未確認」とする
  summary.creation_unconfirmed = allowCreate ? missingKeys.length - summary.created : 0;
  return { ...summary, readyPairs };
}