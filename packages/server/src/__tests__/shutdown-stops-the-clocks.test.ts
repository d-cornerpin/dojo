// ════════════════════════════════════════════════════════════════════════════════
// SHUTDOWN STOPS THE THREE BACKGROUND CLOCKS.
//
// `shutdown()` in `index.ts` used to clear only `timeoutInterval`, stop the FTS repair, the
// reader pool, the video poller and the tunnel, then wait for `server.close(cb)`. The three
// clocks started at boot — the work reaper (`work/work-reaper.ts`), the scheduler
// (`scheduler/clock.ts`) and the PM poke loop (`tracker/pm-agent.ts`) — were never stopped,
// and `server.close` waits for open connections, so the window between SIGTERM and exit can be
// long; during it those clocks keep waking agents, sending owner notices and writing rows.
//
// This test pins the one function that stops them: `stopBackgroundClocks()`, called as the
// FIRST action of shutdown, before anything the clocks depend on is torn down. The three stop
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
vi.mock('../tracker/pm-agent.js', () => ({
  stopPokeLoop: vi.fn(() => { calls.push('poke'); }),
}));

import { stopBackgroundClocks } from '../shutdown-clocks.js';
import { stopReaper } from '../work/work-reaper.js';
import { stopScheduler } from '../scheduler/clock.js';
import { stopPokeLoop } from '../tracker/pm-agent.js';

describe('shutdown stops the three background clocks', () => {
  beforeEach(() => { calls.length = 0; });
  afterEach(() => {
    vi.mocked(stopReaper).mockRestore();
    vi.mocked(stopScheduler).mockRestore();
    vi.mocked(stopPokeLoop).mockRestore();
  });

  it('calls the work reaper, scheduler and PM poke loop, each exactly once, in that order', () => {
    stopBackgroundClocks();
    expect(calls).toEqual(['reaper', 'scheduler', 'poke']);
  });

  it('a throwing reaper stop does not skip the other two, and the function does not throw', () => {
    vi.mocked(stopReaper).mockImplementation(() => {
      calls.push('reaper');
      throw new Error('reaper stop failed');
    });
    expect(() => stopBackgroundClocks()).not.toThrow();
    expect(calls).toEqual(['reaper', 'scheduler', 'poke']);
  });

  it('calling it twice does not throw', () => {
    expect(() => stopBackgroundClocks()).not.toThrow();
    expect(() => stopBackgroundClocks()).not.toThrow();
    expect(calls).toEqual(['reaper', 'scheduler', 'poke', 'reaper', 'scheduler', 'poke']);
  });
});
