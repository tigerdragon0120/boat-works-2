// 日付単位で完了した一覧だけを共有する。通信失敗や未完了ページは開催なしに変換しない。
export const RACE_LIST_TTL_MS = 12000;
export const RACE_LIST_TIMEOUT_MS = 20000;
const PAGE_SIZE = 500;
const MAX_PAGES = 10;

function readError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function raceIdentity(race) {
  const venue = Number(race?.venue_code), number = Number(race?.race_number);
  if (!validDate(race?.race_date) || !Number.isInteger(venue) || venue < 1 || venue > 24 ||
      !Number.isInteger(number) || number < 1 || number > 12) return null;
  return `${race.race_date}_${String(venue).padStart(2, '0')}_${String(number).padStart(2, '0')}`;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const text = value.trim();
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? text + 'Z' : text);
  return Number.isFinite(at) ? at : 0;
}

const terminalRank = race => race.status === 'finished' ? 2 : race.status === 'cancelled' ? 1 : 0;
const freshness = race => timestamp(race.updated_date) || timestamp(race.created_date);
const displayScore = race => (race.has_final ? 40 : 0) + (race.exhibition_ready ? 30 : 0) +
  (race.has_pre ? 20 : 0) + (race.prediction_grade ? 5 : 0) + (race.deadline ? 2 : 0);

export function dedupeRacesForDisplay(races) {
  const byKey = new Map();
  for (const race of races) {
    const key = raceIdentity(race);
    if (!key) throw readError('RACE_LIST_INVALID', 'レース一覧の応答を確認できませんでした。更新を再試行してください。');
    const current = byKey.get(key);
    // 確定結果を中止情報で消さない。予想の多い古い行で開催状態や締切訂正を戻さない。
    const rankDiff = current ? terminalRank(race) - terminalRank(current) : 0;
    const timeDiff = current ? freshness(race) - freshness(current) : 0;
    if (!current || rankDiff > 0 || (rankDiff === 0 &&
        (timeDiff > 0 || (timeDiff === 0 && displayScore(race) > displayScore(current))))) {
      byKey.set(key, race);
    }
  }
  return [...byKey.values()];
}

// filterRaces は既存SDKの filter(query, sort, limit, skip) -> array 契約。
// SDK・時刻・タイマーを注入し、遅延完了や日付変更も副作用なしに検証できる。
export function createRaceListCache({ filterRaces, retry = operation => operation(), now = Date.now,
  ttlMs = RACE_LIST_TTL_MS, timeoutMs = RACE_LIST_TIMEOUT_MS, pageSize = PAGE_SIZE, maxPages = MAX_PAGES,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof filterRaces !== 'function') throw new TypeError('filterRaces is required');
  const byDate = new Map();

  async function readAll(raceDate, assertActive) {
    const rows = [], seenRecords = new Set();
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      assertActive();
      const page = await retry(() => {
        assertActive();
        return filterRaces({ race_date: raceDate }, '-deadline', pageSize, pageIndex * pageSize);
      });
      assertActive();
      if (!Array.isArray(page) || page.length > pageSize || page.some(race =>
        !race || typeof race !== 'object' || Array.isArray(race) || race.race_date !== raceDate || !raceIdentity(race))) {
        throw readError('RACE_LIST_INVALID', 'レース一覧の応答を確認できませんでした。更新を再試行してください。');
      }
      let added = 0;
      for (const race of page) {
        const recordKey = race.id ? String(race.id) : JSON.stringify(race);
        if (!seenRecords.has(recordKey)) { seenRecords.add(recordKey); added++; }
      }
      if (page.length && !added) {
        throw readError('RACE_LIST_INCOMPLETE', 'レース一覧を最後まで取得できませんでした。更新を再試行してください。');
      }
      rows.push(...page);
      if (page.length < pageSize) return dedupeRacesForDisplay(rows);
    }
    throw readError('RACE_LIST_INCOMPLETE', 'レース一覧を最後まで取得できませんでした。更新を再試行してください。');
  }

  function startRead(entry, raceDate) {
    const request = { active: true, promise: null };
    entry.pending = request;
    const timeoutError = () => readError('RACE_LIST_TIMEOUT', 'レース一覧の取得がタイムアウトしました。更新を再試行してください。');
    const assertActive = () => { if (!request.active) throw timeoutError(); };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => { request.active = false; reject(timeoutError()); }, timeoutMs);
    });
    const load = Promise.resolve().then(() => readAll(raceDate, assertActive));
    request.promise = Promise.race([load, timeout]).then(value => {
      assertActive();
      entry.value = value;
      entry.at = now();
      return value;
    }).finally(() => {
      request.active = false;
      clearTimer(timer);
      if (entry.pending === request) entry.pending = null;
    });
    return request.promise;
  }

  return async function listRaces({ raceDate, includeFinished = false, force = false } = {}) {
    if (!validDate(raceDate)) throw readError('RACE_LIST_DATE', 'レース一覧の日付を確認できませんでした。');
    let entry = byDate.get(raceDate);
    if (!entry) { entry = { at: 0, value: null, pending: null }; byDate.set(raceDate, entry); }
    // 手動更新も、同じ日に既に進行中の取得があればその取得を共有する。
    // 失敗時はentry.value/atを変更せず、例外でUIへ前回表示の維持を依頼する。
    const age = now() - entry.at;
    const unique = entry.pending ? await entry.pending.promise
      : !force && entry.value !== null && age >= 0 && age < ttlMs ? entry.value
        : await startRead(entry, raceDate);
    return includeFinished ? unique : unique.filter(race => race.status !== 'finished' && race.status !== 'cancelled');
  };
}
