// Share only in-flight reads. Completed data is never cached here.
export function stableReadKey(value) {
  const normalize = item => Array.isArray(item)
    ? item.map(normalize)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
      : item;
  return JSON.stringify(normalize(value));
}

export function createSharedReadRequests({ timeoutMs = 45000 } = {}) {
  const pending = new Map();
  let principal, principalKey, generation = 0;
  const scopeError = () => new Error('利用者が変わったため、表示を更新してください。');

  function scopeFor(user, authenticated) {
    const identity = authenticated ? user : null;
    const key = stableReadKey([!!authenticated, identity?.id || null, identity?.role || null]);
    if (identity !== principal || key !== principalKey) {
      principal = identity;
      principalKey = key;
      generation++;
      pending.clear();
    }
    return generation;
  }

  function request(scope, operation, parameters, read, { force = false } = {}) {
    if (scope !== generation) return Promise.reject(scopeError());
    const key = stableReadKey([scope, operation, parameters]);
    const previous = pending.get(key);
    if (previous && !force) return previous.promise;

    const entry = { promise: null, replacement: null, supersede: null };
    const superseded = new Promise(resolve => { entry.supersede = resolve; });
    let timer;
    const operationPromise = Promise.resolve().then(() => {
      if (scope !== generation) throw scopeError();
      return read(parameters);
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('読込が時間内に完了しませんでした。再読込してください。')), timeoutMs);
    });
    const resolveCurrent = (value, error) => {
      if (scope !== generation) throw scopeError();
      // A manual read after a save supersedes any older in-flight read.
      if (entry.replacement) return entry.replacement.promise;
      if (error) throw error;
      return value;
    };
    entry.promise = Promise.race([operationPromise, timeout, superseded])
      .then(value => resolveCurrent(value), error => resolveCurrent(null, error))
      .finally(() => {
        clearTimeout(timer);
        if (pending.get(key) === entry) pending.delete(key);
      });
    if (previous) {
      previous.replacement = entry;
      previous.supersede(entry.promise);
    }
    pending.set(key, entry);
    return entry.promise;
  }

  return { scopeFor, request };
}

export function shouldPollRead({ hidden, inFlight, requestedAt, now, interval }) {
  return !hidden && !inFlight && (requestedAt === 0 || now - requestedAt >= interval);
}

export const sharedReadRequests = createSharedReadRequests();
