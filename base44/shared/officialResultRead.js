// Resolve a race only after all result pages for its batch have been read.
import { fetchAllPaged } from './pagedFetch.js';
import { resolveOfficialResults } from './resultEvidenceRules.js';

const BATCH_SIZE = 80;
const READ_BUDGET_MS = 45000;

export async function loadOfficialResultsByRace(sr, raceIds, { batched = false } = {}) {
  const ids = [...new Set((raceIds || []).filter(Boolean).map(String))];
  const byRace = new Map();
  const failures = [];
  const failedRaceIds = new Set();
  // Daily verification opts in. Existing generation and save gates keep one read scope.
  const batchSize = batched ? BATCH_SIZE : ids.length;
  const deadlineMs = batched ? Date.now() + READ_BUDGET_MS : undefined;

  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const rowsByRace = new Map(batch.map(id => [id, []]));
    let unexpectedRacePage;
    let pageNumber = 0;
    const read = await fetchAllPaged(
      async (query, options) => {
        const page = ++pageNumber;
        const response = await sr.RaceResult.filter(query, options);
        if (Array.isArray(response?.items) && response.items.some(row => !rowsByRace.has(row?.race_id))) {
          unexpectedRacePage ??= page;
        }
        return response;
      },
      { race_id: { $in: batch } },
      { sort: '-created_date', deadlineMs },
    );
    const failure = !read.complete
      ? { reason: read.error, page: read.page, race_ids: batch }
      : unexpectedRacePage != null
        ? { reason: 'unexpected_race_id', page: unexpectedRacePage, race_ids: batch }
        : null;
    if (failure) {
      failures.push(failure);
      batch.forEach(id => failedRaceIds.add(id));
      for (const id of batch) byRace.set(id, resolveOfficialResults([], { raceId: id, complete: false }));
      continue;
    }
    for (const row of read.rows) rowsByRace.get(row.race_id).push(row);
    for (const id of batch) byRace.set(id, resolveOfficialResults(rowsByRace.get(id), { raceId: id, complete: true }));
  }

  return { byRace, complete: !failures.length, error: failures[0]?.reason ?? null, failures, failedRaceIds };
}