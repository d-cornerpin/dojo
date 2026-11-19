// A context overflow never sets the owner's message aside (owner decision 12): a failure caused by the full
// window does not count against the message. Through the real runtime (`handleMessage`, the run's end and the one
// clock) on a migrated in-memory DB; only the turn is scripted, as the overflow door's forced condense with no
// answer. The real-turn proof of the same ruling is in `agent/v2/__tests__/integration.test.ts`.

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

const { script } = vi.hoisted(() => ({
  script: { run: async (): Promise<void> => undefined },
}));
vi.mock('../v2/loop.js', () => ({ runV2Turn: () => script.run() }));

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
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const askState = (): string =>
  (mockDb.current!.prepare("SELECT state FROM work WHERE kind = 'ask' AND root_id = 'msg-ask'").get() as { state: string }).state;
const setAside = (): WsEvent[] => events.filter((e) => (e as { code?: string }).code === 'STUCK_REPEATING');

/** One run, then every wake that follows it for a while. */
async function runUntilQuiet(bound = 12): Promise<void> {
  await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the ask');
  for (let i = 0; i < bound; i++) await vi.advanceTimersByTimeAsync(2_000);
}

describe('overflow is the window\'s failure, never the message\'s', { timeout: 120_000 }, () => {
  it('turns that fail on a full context, again and again, never write off the owner\'s ask', async () => {
    script.run = async () => {
      runs += 1;
      await m.compaction.checkAndCompact(AGENT, MODEL, 65_536, { force: true });   // the overflow door's own condense
    };
    await runUntilQuiet();
    expect(runs, 'non-vacuity: the ask was served').toBeGreaterThanOrEqual(1);
    expect(askState(), 'the owner\'s message is still waiting to be served').toBe('open');
    expect(setAside()).toEqual([]);
  });
});
