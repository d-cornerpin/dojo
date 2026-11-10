import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiResponse } from '@dojo/shared';

// THE ONE RULE FOR EVERY EDITOR THAT READS A VALUE AND WRITES IT BACK: it may only save,
// generate over, or switch modes on top of a value that was successfully read for the thing
// on screen. A failed load, a load still in flight, and a late answer for a different key are
// all "not loaded", and none of them may be the base of a write.
// useGuardedLoad is that rule as a hook: it drops any answer that arrives after the key
// changed or a newer load started, and canSave() is the one question every save path asks.
// useRequestGuard is the same check for flows with their own state: a counter per start.

export const useRequestGuard = () => {
  const counter = useRef(0);
  const begin = useCallback((): number => ++counter.current, []);
  const isCurrent = useCallback((ticket: number): boolean => ticket === counter.current, []);
  const current = useCallback((): number => counter.current, []);
  return useMemo(() => ({ begin, isCurrent, current }), [begin, isCurrent, current]);
};

export type LoadStatus = 'loading' | 'ready' | 'failed';

export interface GuardedLoad<T> {
  status: LoadStatus;
  data: T | null;
  loadedKey: string | null;
  error: string | null;
  /** Counts every settled read (even one that returns the same value), so an editor can tell "loaded again" from "unchanged". */
  settled: number;
  reload: () => void;
  /** Re-read quietly: the editor stays up on the data it has; a good answer replaces it, a failed one changes nothing. */
  refresh: () => Promise<void>;
  /** True only when the data on hand was successfully loaded for exactly `forKey`, which is the current key. */
  canSave: (forKey: string | null | undefined) => boolean;
  /** After a successful save or generate: the saved value is now the loaded one. */
  adopt: (value: T) => void;
}

interface Slot<T> { key: string | null; status: LoadStatus; data: T | null; error: string | null; n?: number }

export function useGuardedLoad<T>(key: string | null, loader: (key: string) => Promise<ApiResponse<T>>): GuardedLoad<T> {
  const guard = useRequestGuard();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [slot, setSlot] = useState<Slot<T>>({ key: null, status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ticket = guard.begin();
    if (key === null) { setSlot((p) => ({ key: null, status: 'loading', data: null, error: null, n: p.n })); return; }
    setSlot((p) => ({ key, status: 'loading', data: null, error: null, n: p.n }));
    (async () => {
      let res: ApiResponse<T>;
      try { res = await loaderRef.current(key); } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : 'Could not load.' }; }
      if (!guard.isCurrent(ticket)) return;   // a late answer for something no longer on screen
      setSlot((prev) => res.ok
        ? { key, status: 'ready', data: res.data, error: null, n: (prev.n ?? 0) + 1 }
        : { key, status: 'failed', data: null, error: res.error || 'Could not load.', n: (prev.n ?? 0) + 1 });
    })();
  }, [key, tick, guard]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const refresh = useCallback(async () => {
    if (key === null) return;
    const ticket = guard.begin();
    let res: ApiResponse<T>;
    try { res = await loaderRef.current(key); } catch { return; }
    if (guard.isCurrent(ticket) && res.ok) setSlot((p) => ({ key, status: 'ready', data: res.data, error: null, n: p.n }));
  }, [key, guard]);
  const adopt = useCallback((value: T) => setSlot((s) => (s.status === 'ready' ? { ...s, data: value } : s)), []);
  const onScreen = slot.key === key;
  const ready = onScreen && slot.status === 'ready';
  const canSave = useCallback(
    (forKey: string | null | undefined) => ready && forKey != null && forKey === slot.key,
    [ready, slot.key],
  );
  return {
    status: onScreen ? slot.status : 'loading',
    data: ready ? slot.data : null,
    loadedKey: ready ? slot.key : null,
    error: onScreen ? slot.error : null,
    settled: slot.n ?? 0,
    reload,
    refresh,
    canSave,
    adopt,
  };
}
