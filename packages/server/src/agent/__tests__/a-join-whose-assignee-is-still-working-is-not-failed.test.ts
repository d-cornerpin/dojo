// A join past its deadline whose assignee still has its task for the job open is kept open and its deadline moves
// on, and the owner is told nothing; one with no open job is failed closed and the owner is told.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 15_000 });

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t114-u3', 'dojo.db'),
  };
});

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => { /* no-op */ },
  setLogBroadcast: () => { /* no-op */ },
  readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false, isPMAgent: () => false, isHealerAgent: () => false,
  isDreamerAgent: () => false, getOwnerName: () => 'Owner', getPrimaryAgentId: () => 'primary',
}));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }) }));

import { runMigrations } from '../../db/migrations.js';
import {
  openAsk, claimAsk, openDelegationJoin, joinState,
} from '../../work/store.js';
// Loaded ONCE, at file load, outside every clause's budget. This used to be a dynamic import
// after `vi.resetModules()` inside each clause, so every clause paid the whole cold a2a-transport
// module graph (~2.5 s idle; unbounded when vite-node wedges a cold import under a loaded box -
// the t119/t265 class) and the first one died at its pinned 15 s with the product call itself
// taking milliseconds. Nothing here needs a fresh module graph: the DB is reached only through
// the mocked `getDb` -> `mockDb.current`, which every `beforeEach` replaces.
import { sweepExpiredJoins } from '../a2a-transport.js';

const AGENT = 'quill';
const ASSIGNEE = 'tamsin';
const THREAD = 'thread-cccccccc-3333';
const MIN = 60_000;

/** Owner-visible rows on the asker's own lane: what the person actually gets told. */
const ownerFacing = (): Array<{ content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system')
        AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string; role: string }>;

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

/**
 * A LIVE delegating parent whose join is past its deadline — the first reaper arm's population
 * (`dueJoins` requires the parent NOT terminal). The ask is claimed and deliberately left
 * `claimed`: the turn delegated and is waiting, which is the real shape at minute 61.
 */
function seedLiveJoinPastTtl(opts: { openedMinutesAgo?: number; ttlMinutesAgo?: number } = {}): string {
  const db = mockDb.current!;
  const openedAt = Date.now() - (opts.openedMinutesAgo ?? 61) * MIN;
  const msgId = 'm-u3';
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'ask about the survey, then tell me', 'owner', 'dashboard',
             'conv-u3', ?, NULL)`,
  ).run(msgId, AGENT, openedAt);
  const parent = openAsk({
    agentId: AGENT, messageId: msgId, conversationId: 'conv-u3', requesterId: 'owner',
    openedAt, title: 'ask about the survey',
  });
  claimAsk(parent, AGENT);
  openDelegationJoin({
    parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-u3',
    // Past due by an hour — the deadline has genuinely expired in every clause here.
    ttlAt: Date.now() - (opts.ttlMinutesAgo ?? 60) * MIN,
    threads: [{ threadId: THREAD, assigneeAgent: ASSIGNEE }],
  });
  return parent;
}

/** Put the assignee in a given status. */
function setAssigneeStatus(status: string): void {
  mockDb.current!.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, ASSIGNEE);
}

/** The assignee's own task for the job on THREAD, still open: what the reaper reads as a job in progress. */
function seedAssigneeJob(): void {
  const at = Date.now();
  mockDb.current!.prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes,
      closes_thread, title, a2a_thread_id, opened_at, updated_at, provenance)
    VALUES ('task-u3', 'task', ?, 'agent', 'tracker', 'task-u3', 'claimed', 'tracker', 0, 0, 'the survey', ?, ?, ?, 'live')`)
    .run(ASSIGNEE, THREAD, at, at);
}

async function sweep(): Promise<{ failedClosed: number; relayedReplies: number }> {
  return sweepExpiredJoins();
}

beforeEach(() => {
  broadcast.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Quill', 'working', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Tamsin', 'idle', '1970-01-01')`).run(ASSIGNEE);
});

describe('§1 a healthy delegate past the deadline keeps its join', () => {
  it('THE RED: an assignee whose task for the job is open means the join is NOT failed closed', async () => {
    const parent = seedLiveJoinPastTtl();
    seedAssigneeJob();

    const out = await sweep();

    expect(out.failedClosed, 'a working delegate is not a missing answer').toBe(0);
    expect(joinState(parent)!.ttlAt!, 'the reaper kept it: its deadline moved on').toBeGreaterThan(Date.now());
    expect(workRow(parent).state, 'the join stays open, in exactly the state it was').toBe('claimed');
  });

  it('the deadline MOVES FORWARD, so the next sweep does not re-litigate the same row', async () => {
    const parent = seedLiveJoinPastTtl();
    seedAssigneeJob();
    const before = joinState(parent)!.ttlAt!;

    await sweep();

    const after = joinState(parent)!.ttlAt!;
    expect(after, 'the grant is counted from now, not from the expired deadline').toBeGreaterThan(Date.now() - 1_000);
    expect(after, 'and it is strictly later than the deadline that just expired').toBeGreaterThan(before);
  });

  it('the owner is NOT told a false story about a missing answer', async () => {
    const parent = seedLiveJoinPastTtl();
    seedAssigneeJob();

    await sweep();

    // A sweep that did nothing at all would also leave the owner un-told; the control is that the
    // reaper DID reach this row and chose to keep it.
    expect(joinState(parent)!.ttlAt!, 'the reaper reached the row and kept it').toBeGreaterThan(Date.now());
    const said = ownerFacing().map((m) => m.content).join('\n');
    expect(said, 'nothing came back YET is not the same as never answered').not.toMatch(/never answered/i);
    expect(said, 'and the platform has not "stopped waiting" — it is still waiting').not.toMatch(/stopped waiting/i);
  });
});

describe('§2 a dead delegate still fails the join, and the owner still hears about it', () => {
  it('THE OTHER DIRECTION: an idle assignee past the deadline is failed closed', async () => {
    const parent = seedLiveJoinPastTtl();
    setAssigneeStatus('idle');

    const out = await sweep();

    expect(out.failedClosed, 'the deadline must still bite when nothing is working').toBe(1);
    expect(workRow(parent).state).toBe('failed');
  });

  it('and the owner is told, in the platform\'s own voice, exactly as before', async () => {
    seedLiveJoinPastTtl();
    setAssigneeStatus('idle');

    await sweep();

    const said = ownerFacing();
    expect(said.length, 'the person is never left in silence').toBeGreaterThan(0);
    expect(said.map((m) => m.content).join('\n'), 'the platform says plainly that nothing answered')
      .toMatch(/nothing came back/i);
  });
});
