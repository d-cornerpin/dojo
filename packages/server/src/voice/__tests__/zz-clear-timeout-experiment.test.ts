import { describe, it, expect, vi } from 'vitest';

describe('clearTimeout with fake timers', () => {
  it('clearTimeout removes a fake timer', () => {
    vi.useFakeTimers();
    const t = setTimeout(() => {}, 2000);
    expect(vi.getTimerCount()).toBe(1);
    clearTimeout(t);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('unref?. on a fake timer id is harmless and clearTimeout still works', () => {
    vi.useFakeTimers();
    const t = setTimeout(() => {}, 2000);
    (t as unknown as { unref?: () => void }).unref?.();
    expect(vi.getTimerCount()).toBe(1);
    clearTimeout(t);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
