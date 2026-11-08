// ════════════════════════════════════════════════════════════════════════════════
// SHUTDOWN STOPS THE TWO BACKGROUND CLOCKS: the work reaper (`work/work-reaper.ts`) and the scheduler
// (`scheduler/clock.ts`), through `stopBackgroundClocks()`, the first action of shutdown. The stop
// functions are mocked so no real interval is ever created.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Shared record: each mocked stop function pushes its own name, so the ORDER is asserted by
// the array. `vi.hoisted` because the mock factories are hoisted above the imports.
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../work/work-reaper.js', () => ({
  stopReaper: vi.fn(() => { calls.push('reaper'); }),
}));
vi.mock('../scheduler/clock.js', () => ({
  stopScheduler: vi.fn(() => { calls.push('scheduler'); }),
}));

import { stopBackgroundClocks } from '../shutdown-clocks.js';
import { stopReaper } from '../work/work-reaper.js';
import { stopScheduler } from '../scheduler/clock.js';

describe('shutdown stops the two background clocks', () => {
  beforeEach(() => { calls.length = 0; });
  afterEach(() => {
    vi.mocked(stopReaper).mockRestore();
    vi.mocked(stopScheduler).mockRestore();
  });

  it('calls the work reaper and the scheduler, each exactly once, in that order', () => {
    stopBackgroundClocks();
    expect(calls).toEqual(['reaper', 'scheduler']);
  });

  it('a throwing reaper stop does not skip the scheduler, and the function does not throw', () => {
    vi.mocked(stopReaper).mockImplementation(() => {
      calls.push('reaper');
      throw new Error('reaper stop failed');
    });
    expect(() => stopBackgroundClocks()).not.toThrow();
    expect(calls).toEqual(['reaper', 'scheduler']);
  });

  it('calling it twice does not throw', () => {
    expect(() => stopBackgroundClocks()).not.toThrow();
    expect(() => stopBackgroundClocks()).not.toThrow();
    expect(calls).toEqual(['reaper', 'scheduler', 'reaper', 'scheduler']);
  });
});
