// A decision call is given the measured time for its own size: 2.05 times the fitted warm time of
// 62 + 1.33 per state token + 94 per extra question, never under 2.5 s, plus 1.3 s to load a model that is not
// resident. A call past that clock is cut and the caller's rule answers, and so do the calls already waiting behind it,
// unsent. The decision model is a scripted fetch that never answers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { __forgetResidencyForTests, decideTimeoutMs } from '../decide.js';
import { deliverableJudged } from '../v2/classifiers/inbound-routing.js';
import { installDecisionModel } from './decision-fake.js';

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); installDecisionModel(mockDb.current); __forgetResidencyForTests(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a decision past its timeout', () => {
  it('a small cold call is given the floor plus the load time, and when that clock runs out the rule answers', async () => {
    const clocks: Array<{ ms: number; cut: () => void }> = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { const c = new AbortController(); clocks.push({ ms, cut: () => c.abort() }); return c.signal; });
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const asked = deliverableJudged('agent-t', 'Here is the finished report.', true);
    await vi.waitFor(() => expect(clocks).toHaveLength(1));
    expect(clocks[0].ms).toBe(3_800);
    clocks[0].cut();
    expect(await asked).toBe(true);
  });

  it('calls waiting behind a timed-out call are not sent and their rules answer; a later call is sent', async () => {
    const clocks: Array<() => void> = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { const c = new AbortController(); clocks.push(() => c.abort()); return c.signal; });
    const sent = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', sent);
    const first = deliverableJudged('agent-t', 'Here is the finished report.', true);
    const waiting = [deliverableJudged('agent-u', 'The post is live.', false), deliverableJudged('agent-v', 'Done, see the link.', true)];
    await vi.waitFor(() => expect(clocks).toHaveLength(1));
    clocks[0]();
    expect([await first, ...(await Promise.all(waiting))]).toEqual([true, false, true]);
    expect(sent).toHaveBeenCalledTimes(1);
    const later = deliverableJudged('agent-t', 'Another file is ready.', false);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    clocks[1]();
    expect(await later).toBe(false);
  });

  it('a small warm call gets the 2.5 s floor; the largest per-turn call: about 5.2 s cold, 3.9 s warm', () => {
    expect(decideTimeoutMs(0, 1, true)).toBe(2_500);
    expect(decideTimeoutMs(800, 9, false)).toBe(5_150);
    expect(decideTimeoutMs(800, 9, true)).toBe(3_850);
  });
});
