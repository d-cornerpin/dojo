import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiResponse } from '@dojo/shared';

// ════════════════════════════════════════════════════════════════════════════
// THE ONE RULE FOR EVERY EDITOR THAT READS A VALUE AND WRITES IT BACK:
//   it may only save, generate over, or switch modes on top of a value that was
//   successfully read FOR THE THING ON SCREEN. A failed load, a load still in
//   flight, and a late answer for a different agent / technique / list are all
//   "not loaded", and none of them may be the base of a write.
//
// `useGuardedLoad(key, loader)` is that rule as a hook. `key` names the thing
// being edited (an agent id, a technique id, a config key). It reports
// 'loading' | 'ready' | 'failed', keeps the data only while it belongs to the
// current key, drops any answer that arrives after the key changed or a newer
// load started, and offers `canSave(key)`: the one question every save path asks.
// `useRequestGuard` is the same stale-answer check for flows that already hold
// their own state (a ticket per start; an answer is dropped if the ticket is old).
// `the-editors-that-save-consult-the-load-guard.test.ts` lists the editors.
// ════════════════════════════════════════════════════════════════════════════

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
  /** The loaded value, only while it belongs to the current key; otherwise null. */
  data: T | null;
  /** The key the data was loaded for (null until a load succeeds). */
  loadedKey: string | null;
  error: string | null;
  reload: () => void;
  /** Re-read quietly: the editor stays up on the data it has; a good answer replaces it, a failed one changes nothing. */
  refresh: () => Promise<void>;
  /** True only when the data on hand was successfully loaded for exactly `forKey`, which is the current key. */
  canSave: (forKey: string | null | undefined) => boolean;
  /** After a successful save or generate: the saved value is now the loaded one. */
  adopt: (value: T) => void;
}

interface Slot<T> { key: string | null; status: LoadStatus; data: T | null; error: string | null }

export function useGuardedLoad<T>(key: string | null, loader: (key: string) => Promise<ApiResponse<T>>): GuardedLoad<T> {
  const guard = useRequestGuard();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [slot, setSlot] = useState<Slot<T>>({ key: null, status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ticket = guard.begin();
    if (key === null) { setSlot({ key: null, status: 'loading', data: null, error: null }); return; }
    setSlot({ key, status: 'loading', data: null, error: null });
    (async () => {
      let res: ApiResponse<T>;
      try { res = await loaderRef.current(key); } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : 'Could not load.' }; }
      if (!guard.isCurrent(ticket)) return;   // a late answer for something no longer on screen
      setSlot(res.ok
        ? { key, status: 'ready', data: res.data, error: null }
        : { key, status: 'failed', data: null, error: res.error || 'Could not load.' });
    })();
  }, [key, tick, guard]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const refresh = useCallback(async () => {
    if (key === null) return;
    const ticket = guard.begin();
    let res: ApiResponse<T>;
    try { res = await loaderRef.current(key); } catch { return; }
    if (guard.isCurrent(ticket) && res.ok) setSlot({ key, status: 'ready', data: res.data, error: null });
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
    reload,
    refresh,
    canSave,
    adopt,
  };
}
