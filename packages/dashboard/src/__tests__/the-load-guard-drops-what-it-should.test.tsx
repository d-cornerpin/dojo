// The shared load guard: failed and in-flight loads cannot be saved on; a late answer for a
// different key is dropped; reload recovers.
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGuardedLoad } from '../lib/load-guard';

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe('useGuardedLoad', () => {
  it('a failed load cannot be saved on, and reload recovers', async () => {
    let n = 0;
    const { result } = renderHook(() => useGuardedLoad('a', async () => (++n === 1 ? { ok: false as const, error: 'down' } : { ok: true as const, data: 'text' })));
    expect(result.current.canSave('a')).toBe(false);
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.canSave('a')).toBe(false);
    expect(result.current.error).toBe('down');
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.canSave('a')).toBe(true);
    expect(result.current.canSave('b')).toBe(false);
  });

  it('a late answer for the old key is dropped', async () => {
    const slow = deferred<{ ok: true; data: string }>();
    const loader = (k: string) => (k === 'a' ? slow.promise : Promise.resolve({ ok: true as const, data: 'B-text' }));
    const { result, rerender } = renderHook(({ k }) => useGuardedLoad(k, loader), { initialProps: { k: 'a' } });
    rerender({ k: 'b' });
    await waitFor(() => expect(result.current.data).toBe('B-text'));
    await act(async () => { slow.resolve({ ok: true, data: 'A-text' }); await slow.promise; });
    expect(result.current.data).toBe('B-text');
    expect(result.current.loadedKey).toBe('b');
  });

  it('nothing is savable while loading', () => {
    const { result } = renderHook(() => useGuardedLoad('a', () => new Promise<never>(() => {})));
    expect(result.current.canSave('a')).toBe(false);
  });
});
