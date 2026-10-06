// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U3) — A JOIN WHOSE ASSIGNEE IS STILL WORKING IS NOT FAILED.
//
// `JOIN_TTL_MINUTES = 60` is the one row of the work-reaper's thirteen declared deadlines that
// KILLED work rather than expiring an obligation. `dueJoins` selects on `ttl_at` alone, and
// `resolveOpenJoin` went straight from "nothing landed" to `failJoinClosed`. So a sub-agent
// healthily grinding its delegated piece at minute 61 — well inside its own creator-set
// `max_runtime` — had its join declared dead, the owner was told the answer never came back, and
// the delegate's eventual reply arrived at a terminal join. No assignee liveness was ever read.
// It is the direct contradiction of row 33's spawn-timeout contract one file over, where every
// expiry lands on a DECISION POINT rather than a kill.
//
// Pinned before this? No. `join-closed-parent-reaper.test.ts` and `work/fanout-join.test.ts` pin
// the closed-parent arm and the fan-out landing. Nothing pinned the 60-minute bound against
// healthy work — which is how it survived a release ritual.
//
// THE BACKWARDS LIFECYCLE, both directions:
//
//   §1 HEALTHY WORK IN THE WINDOW SURVIVES. A join an hour past its deadline whose assignee is
//      `working` is kept open, its deadline moved forward by a PATIENCE-SCALED grant (the
//      assignee's own declared model speed, via `patienceFloorFor` — not a number invented
//      here), and the owner is NOT told a false story about a missing answer.
//
//   §2 DEAD WORK STILL DIES, LOUDLY. The same join with an idle assignee is failed closed and
//      the owner is told, exactly as before — the behaviour this fix must not cost.
//
//   §3 THE CEILING, which is what keeps §1 from being an unbounded renewal: an agent that looks
//      busy for ever cannot hold a join open for ever. Past `JOIN_LIVENESS_MAX_TOTAL_MS` the
//      join fails closed whatever the assignee looks like, and the exit reason says the ceiling
//      ended it rather than claiming silence.
// ════════════════════════════════════════════════════════════════════════════════════

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

const broadcast = vi.fn();
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
  openAsk, claimAsk, openDelegationJoin, joinState, JOIN_LIVENESS_MAX_TOTAL_MS,
} from '../../work/store.js';

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

/** Put the assignee in a given status — the cross-restart liveness fact the reaper reads. */
function setAssigneeStatus(status: string): void {
  mockDb.current!.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, ASSIGNEE);
}

async function sweep(): Promise<{
  failedClosed: number; relayedReplies: number; extendedForLiveAssignee: number;
}> {
  const { sweepExpiredJoins } = await import('../a2a-transport.js');
  return sweepExpiredJoins();
}

beforeEach(() => {
  broadcast.mockClear();
  vi.resetModules();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Quill', 'working', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Tamsin', 'idle', '1970-01-01')`).run(ASSIGNEE);
});

describe('§1 a healthy delegate past the deadline keeps its join', () => {
  it('THE RED: an assignee still `working` means the join is NOT failed closed', async () => {
    const parent = seedLiveJoinPastTtl();
    setAssigneeStatus('working');

    const out = await sweep();

    expect(out.failedClosed, 'a working delegate is not a missing answer').toBe(0);
    expect(out.extendedForLiveAssignee, 'the reaper recorded the refusal to kill').toBe(1);
    expect(workRow(parent).state, 'the join stays open, in exactly the state it was').toBe('claimed');
  });

  it('the deadline MOVES FORWARD, so the next sweep does not re-litigate the same row', async () => {
    const parent = seedLiveJoinPastTtl();
    setAssigneeStatus('working');
    const before = joinState(parent)!.ttlAt!;

    await sweep();

    const after = joinState(parent)!.ttlAt!;
    expect(after, 'the grant is counted from now, not from the expired deadline').toBeGreaterThan(Date.now() - 1_000);
    expect(after, 'and it is strictly later than the deadline that just expired').toBeGreaterThan(before);
  });

  it('the owner is NOT told a false story about a missing answer', async () => {
    seedLiveJoinPastTtl();
    setAssigneeStatus('working');

    await sweep();

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
    expect(out.extendedForLiveAssignee, 'nothing was extended').toBe(0);
    expect(workRow(parent).state).toBe('failed');
  });

  it('and the owner is told, in the platform\'s own voice, exactly as before', async () => {
    seedLiveJoinPastTtl();
    setAssigneeStatus('idle');

    await sweep();

    const said = ownerFacing();
    expect(said.length, 'the person is never left in silence').toBeGreaterThan(0);
    expect(said.map((m) => m.content).join('\n'), 'the platform says plainly that nothing answered')
      .toMatch(/never answered/i);
  });
});

describe('§3 the ceiling — proof of life buys time, not an unbounded renewal', () => {
  it('a join past JOIN_LIVENESS_MAX_TOTAL_MS fails closed even with a working assignee', async () => {
    // One minute past the ceiling, measured from when the join OPENED — which is why `openedAt`
    // is read rather than the deadline the extension itself moves.
    const ceilingMinutes = JOIN_LIVENESS_MAX_TOTAL_MS / MIN;
    const parent = seedLiveJoinPastTtl({ openedMinutesAgo: ceilingMinutes + 1 });
    setAssigneeStatus('working');

    const out = await sweep();

    expect(out.failedClosed, 'a permanently busy-looking agent cannot hold a join for ever').toBe(1);
    expect(out.extendedForLiveAssignee, 'the grant was refused at the ceiling').toBe(0);
    expect(workRow(parent).state).toBe('failed');
  });

  it('the ceiling kill is HONEST: it says the wait ran out, not that the delegate was silent', async () => {
    const ceilingMinutes = JOIN_LIVENESS_MAX_TOTAL_MS / MIN;
    const parent = seedLiveJoinPastTtl({ openedMinutesAgo: ceilingMinutes + 1 });
    setAssigneeStatus('working');

    await sweep();

    const reason = (mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? ORDER BY rowid DESC`,
    ).all(parent) as Array<{ payload: string | null }>)
      .map((r) => r.payload ?? '')
      .join('\n');
    expect(reason, 'the exit reason names the ceiling, because that is what happened')
      .toMatch(/hard ceiling/i);
  });

  it('CONTROL: the ceiling is well clear of the ordinary deadline — a 61-minute join is inside it', () => {
    // Guards against a ceiling so tight it would swallow §1: the extension must have real room.
    expect(JOIN_LIVENESS_MAX_TOTAL_MS, 'the ceiling is a multiple of the declared TTL')
      .toBeGreaterThan(61 * MIN);
  });
});
