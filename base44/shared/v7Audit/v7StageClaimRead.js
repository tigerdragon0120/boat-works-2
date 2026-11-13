// LOCAL AUDIT CANDIDATE ONLY. No runtime caller imports this module.
// Preparation is an administrator operation; this module only observes existing claims.
import { fetchAllPaged } from '../pagedFetch.js';
import { timeMs } from '../liveV7Time.js';

const STATES = new Set(['free', 'writing', 'written', 'claimed']);
const KEY_CHUNK = 25;

export function expectedStageClaims(races, nowMs = Date.now()) {
  const expected = new Map();
  for (const race of races || []) {
    if (!race?.race_key || ['finished', 'cancelled'].includes(race.status)) continue;
    const deadline = timeMs(race.deadline);
    if (deadline == null || deadline <= nowMs) continue;
    for (const stage of ['PRE', 'FINAL']) {
      const key = `${race.race_key}::${stage}`;
      expected.set(key, { claim_key: key, race_key: race.race_key, stage });
    }
  }
  return expected;
}

export async function inspectClaimRows(sr, expected) {
  const summary = {
    expected: expected.size, created: 0, ready: 0, creation_unconfirmed: 0,
    missing: [], duplicate: [], invalid: [], read_complete: true,
    uniqueness_guaranteed: false, readyPairs: new Set(),
  };
  const rowsByPair = new Map([...expected.keys()].map(key => [key, []]));
  const keys = [...expected.keys()];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK);
    const page = await fetchAllPaged(
      (query, options) => sr.V7StageClaim.filter(query, options),
      { claim_key: { $in: chunk } },
    );
    // A partial or out-of-scope response is not evidence of absence or uniqueness.
    if (!page.complete || page.rows.some(row => !chunk.includes(row.claim_key))) {
      return { ...summary, read_complete: false, all_ready: false };
    }
    for (const row of page.rows) rowsByPair.get(row.claim_key).push(row);
  }
  for (const [key, wanted] of expected) {
    const rows = rowsByPair.get(key);
    if (!rows.length) { summary.missing.push(key); continue; }
    if (rows.length > 1) { summary.duplicate.push(key); continue; }
    const row = rows[0];
    if (row.race_key !== wanted.race_key || row.stage !== wanted.stage || !STATES.has(row.state)) {
      summary.invalid.push(key);
      continue;
    }
    summary.readyPairs.add(key);
  }
  summary.ready = summary.readyPairs.size;
  return { ...summary, all_ready: summary.ready === summary.expected };
}

export function inspectStageClaims(sr, races, { nowMs = Date.now() } = {}) {
  return inspectClaimRows(sr, expectedStageClaims(races, nowMs));
}