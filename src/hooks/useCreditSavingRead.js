import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { sharedReadRequests, shouldPollRead, stableReadKey } from '@/lib/sharedReadRequests';

// Read-only calls only: mutations must never be coalesced by this hook.
export function useCreditSavingRead({ operation, parameters = {}, read, enabled = true, interval = 300000 }) {
  const { user, isAuthenticated, isLoadingAuth } = useAuth();
  const active = enabled && !isLoadingAuth;
  const scope = sharedReadRequests.scopeFor(user, isAuthenticated);
  const serialized = stableReadKey(parameters);
  const key = stableReadKey([scope, operation, JSON.parse(serialized)]);
  const sequence = useRef(0), alive = useRef(false), currentKey = useRef(key);
  const polling = useRef({ data: null, error: null, requestedAt: 0, inFlight: null });
  const intervalRef = useRef(interval);
  currentKey.current = key;
  intervalRef.current = interval;
  const [state, setState] = useState({ key, data: null, loading: active, error: null });

  const load = useCallback(async (force = false) => {
    if (!active || !alive.current || currentKey.current !== key) return null;
    const request = ++sequence.current;
    polling.current = { ...polling.current, requestedAt: Date.now(), inFlight: request };
    setState(old => ({ ...(old.key === key ? old : { data: null }), key, loading: true, error: null }));
    try {
      const data = await sharedReadRequests.request(scope, operation, JSON.parse(serialized), read, { force });
      if (alive.current && currentKey.current === key && request === sequence.current) {
        polling.current = { ...polling.current, data, error: null };
        setState({ key, data, loading: false, error: null });
        return data;
      }
      return null;
    } catch (error) {
      if (alive.current && currentKey.current === key && request === sequence.current) {
        polling.current = { ...polling.current, data: null, error: true };
        setState({ key, data: null, loading: false, error: error?.response?.data?.message || error?.message || '読込に失敗しました' });
      }
      return null;
    } finally {
      if (polling.current.inFlight === request) polling.current.inFlight = null;
    }
  }, [active, key, scope, operation, serialized, read]);

  useEffect(() => {
    alive.current = true;
    polling.current = { data: null, error: null, requestedAt: 0, inFlight: null };
    setState({ key, data: null, loading: active, error: null });
    const poll = () => {
      if (!active) return;
      const current = polling.current, now = Date.now();
      const period = typeof intervalRef.current === 'function'
        ? intervalRef.current(JSON.parse(serialized), current.data, current.error, now)
        : intervalRef.current;
      if (shouldPollRead({ hidden: document.hidden, inFlight: current.inFlight != null, requestedAt: current.requestedAt, now, interval: period })) void load();
    };
    poll(); // Hidden tabs must not issue an initial request either.
    const timer = setInterval(poll, 30000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      alive.current = false;
      sequence.current++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [active, key, serialized, load]);

  const refresh = useCallback(() => load(true), [load]);
  const current = active && state.key === key ? state : { data: null, loading: active, error: null };
  return { data: current.data, loading: current.loading, error: current.error, refresh };
}
