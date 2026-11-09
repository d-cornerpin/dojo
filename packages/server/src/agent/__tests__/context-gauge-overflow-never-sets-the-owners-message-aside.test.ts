// ════════════════════════════════════════════════════════════════════════════════════════
// t194 (v3.4 D4) — A CONTEXT OVERFLOW NEVER SETS THE OWNER'S MESSAGE ASIDE.
//
// THE WITNESS (the owner's box, twice): "drain: quarantined a poisoned conversation". The human
// drain writes off the oldest waiting ask when it sees the SAME head for four consecutive passes.
// On a small window the likeliest cause was the context gate surrendering the turn: every pass
// failed because the WINDOW was full, not because anything was wrong with the message, and the
// owner's message went `abandoned` with "Couldn't process a message … set it aside".
//
// OWNER DECISION 12 (2026-10-17): a failure caused by context overflow does NOT count toward setting
// the owner's message aside. Only failures caused by the message itself count.
//
// And a defect found on the way (conversation lane item 9, path E): when the drain ladder cannot be
// written (a busy or locked database) `bumpDrainLadder` answers "stand down", but the human drain
// read that as "stuck past the bound" and wrote the ask off on its FIRST sighting.
//
// THE DOOR: the real runtime (`handleMessage`, the run's `finally`, the drains, the queued-wakeup
// timer) on a migrated in-memory DB; only the turn itself is scripted. An overflow turn is scripted
// as what every overflow door does — the forced condense (`checkAndCompact` with `force`), which the
// provider's "too long" recovery and the live-conversation refusal both run — and no answer.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { WsEvent } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
const events: WsEvent[] = [];
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: WsEvent) => { events.push(e); }, stampPersistedRow: (e: unknown) => e }));

const { script, ladder } = vi.hoisted(() => ({
  script: { run: async (): Promise<void> => undefined },
  ladder: { unreadable: false },
}));
vi.mock('../v2/loop.js', () => ({ runV2Turn: () => script.run() }));
vi.mock('../drain-state.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../drain-state.js')>();
  return {
    ...real,
    bumpDrainLadder: (...a: Parameters<typeof real.bumpDrainLadder>) =>
      (ladder.unreadable && a[1] === 'human_conversation' ? real.DRAIN_LADDER_UNREADABLE : real.bumpDrainLadder(...a)),
  };
});

const AGENT = 'worker-t194';
const MODEL = 'm-t194-small';

let m: { runtime: typeof import('../runtime.js'); compaction: typeof import('../../memory/compaction.js') };
let runs = 0;

beforeEach(async () => {
  vi.resetModules();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  m = { runtime: await import('../runtime.js'), compaction: await import('../../memory/compaction.js') };
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T09:00:00Z'));
  db.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Worker', 'idle', NULL)").run(AGENT);
  const { insertMessage } = await import('../../memory/message-store.js');
  insertMessage({
    id: 'msg-ask', agentId: AGENT, role: 'user', content: 'Pull the quarterly numbers and send me the summary.',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  events.length = 0;
  runs = 0;
  ladder.unreadable = false;
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const askState = (): string =>
  (mockDb.current!.prepare("SELECT state FROM work WHERE kind = 'ask' AND root_id = 'msg-ask'").get() as { state: string }).state;
const setAside = (): WsEvent[] => events.filter((e) => (e as { code?: string }).code === 'STUCK_REPEATING');

/** One run, then every wake it queued, until the agent goes quiet (or a bound standing for "for ever"). */
async function runUntilQuiet(bound = 12): Promise<void> {
  await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the ask');
  for (let i = 0; i < bound; i++) await vi.advanceTimersByTimeAsync(2_000);
}

describe('t194 D4 — overflow is the window\'s failure, never the message\'s', { timeout: 120_000 }, () => {
  it('RED on v3.3.3: turns that fail on a full context, again and again, never write off the owner\'s ask', async () => {
    script.run = async () => {
      runs += 1;
      await m.compaction.checkAndCompact(AGENT, MODEL, 65_536, { force: true });   // the overflow door's own condense
    };
    await runUntilQuiet();
    expect(runs, 'non-vacuity: the drain re-served the ask more than the bound').toBeGreaterThanOrEqual(1);
    expect(askState(), 'the owner\'s message is still waiting to be served').toBe('open');
    expect(setAside()).toEqual([]);
  });

  it('RED on v3.3.3: an unreadable drain ladder stands the drain down; it does not write the ask off on first sight', async () => {
    ladder.unreadable = true;
    script.run = async () => { runs += 1; };
    await runUntilQuiet();
    expect(runs).toBe(1);
    expect(askState()).toBe('open');
    expect(setAside()).toEqual([]);
  });

  it('CONTROL: a message the agent keeps failing on with room to spare is still set aside, so others get through', async () => {
    script.run = async () => { runs += 1; };   // no overflow: the window had room and the turn still produced nothing
    await runUntilQuiet();
    expect(runs, 'the head was served past the bound').toBeGreaterThan(4);
    expect(askState()).toBe('abandoned');
    expect(setAside()).toHaveLength(1);
  });
});
