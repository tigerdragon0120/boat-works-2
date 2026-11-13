// 画面・日次照合・保存ゲートが同じ全候補取得と判定を使う。
import { fetchAllPaged } from './pagedFetch.js';
import { resolveOfficialResults } from './resultEvidenceRules.js';

export async function loadOfficialResultsByRace(sr, raceIds) {
  const ids = [...new Set((raceIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { byRace: new Map(), complete: true };
  const page = await fetchAllPaged(
    (query, options) => sr.RaceResult.filter(query, options),
    { race_id: { $in: ids } },
    { sort: '-created_date' },
  );
  const rowsByRace = new Map(ids.map(id => [id, []]));
  let complete = page.complete;
  for (const row of page.rows) {
    if (!rowsByRace.has(row.race_id)) { complete = false; continue; }
    rowsByRace.get(row.race_id).push(row);
  }
  const byRace = new Map(ids.map(id => [id, resolveOfficialResults(rowsByRace.get(id), { raceId: id, complete })]));
  return { byRace, complete, error: page.error || null };
}