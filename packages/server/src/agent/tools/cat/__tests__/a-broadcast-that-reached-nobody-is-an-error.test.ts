// ════════════════════════════════════════════════════════════════════════════════════════
// A BROADCAST THAT REACHED NOBODY SAID "sent to 0 agent(s)".
//
// `broadcast_to_group` skips `error`/`paused` members up front and drops any member whose
// transport answer came back `delivered: false` — then reports the attempt as the success
// sentence regardless. A group where every member was paused, or every delivery was dropped,
// returned `isError: false` and "Broadcast sent to 0 agent(s): ", the sender read it as a
// delivered broadcast and told the owner it was sent, and the engine's failure counter never
// saw a failure. And when SOME members were reached, the skipped ones were never named, so the
// sender could not tell who missed it.
//
// Set-up is the one from `a-peer-hand-off-is-a-recorded-delivery.test.ts` §3: in-memory DB,
// the transport as a dial whose answer the test chooses, the ws door stubbed. Three agents in
// one group: the sender, one idle member, one `paused` member — so both ways of missing a
// member (pre-filter and transport drop) are live in every case.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-bc-nobody', 'dojo.db'),
  };
});

/** THE TRANSPORT, under the test's control — the two shapes the handler branches on. */
const deliverSpy = vi.fn();
vi.mock('../../../a2a-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../a2a-transport.js')>()),
  deliverA2AMessage: (...a: unknown[]) => deliverSpy(...(a as [])),
  isNoWakeIntent: () => false,
}));

vi.mock('../../../../gateway/ws.js', () => ({
  broadcast: () => undefined,
  stampPersistedRow: (e: unknown) => e,
}));

import { agentsHandlers } from '../agents.js';
import { runMigrations } from '../../../../db/migrations.js';
import { FX, FXID } from '../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const SENDER = FXID.n4;
const MEMBER = FXID.n5;       // idle — the one the transport is asked to reach
const PAUSED = FXID.n6;       // `paused` — skipped before the transport is called
const GROUP = 'group-fictional-1';

/** The tool, through the door the model actually calls. Returns BOTH halves of the answer:
 *  the sentence and the error flag are the two faces of the same lie. */
async function broadcast(): Promise<{ content: string; isError: boolean }> {
  const h = agentsHandlers['broadcast_to_group'];
  const r = await h({
    agentId: SENDER,
    args: { group_id: GROUP, payload: 'hi', intent: 'FYI' },
  } as unknown as Parameters<typeof h>[0]);
  return { content: r.content, isError: r.isError };
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agent_groups (id, name, created_by) VALUES (?, 'The Fictional Lane', ?)`,
  ).run(GROUP, SENDER);
  const insert = db.prepare(
    `INSERT INTO agents (id, name, status, group_id, session_started_at)
     VALUES (?, ?, ?, ?, '1970-01-01')`,
  );
  insert.run(SENDER, FX.n4, 'idle', GROUP);
  insert.run(MEMBER, FX.n5, 'idle', GROUP);
  insert.run(PAUSED, FX.n6, 'paused', GROUP);
});

describe('a broadcast that reached nobody is an error', () => {
  it('⚠ THE RED: every delivery dropped → isError, and the sentence names who missed it', async () => {
    deliverSpy.mockResolvedValue({ delivered: false, reason: 'MALFORMED_ENVELOPE', threadId: '' });

    const r = await broadcast();

    expect(r.isError, 'the engine still sees no failure — its failure counter stays at zero').toBe(true);
    expect(r.content.startsWith('Error: the broadcast reached nobody'),
      'nothing reached anybody and the tool still opened with its success sentence').toBe(true);
    // Both halves of "nobody": the member the transport dropped and the member the
    // pre-filter skipped. The sender cannot tell anybody who missed it unless both are named.
    expect(r.content).toContain(FX.n5);
    expect(r.content).toContain(FX.n6);
  });

  it('⚠ the ones who DID reach hear it, the ones who did not are NAMED', async () => {
    deliverSpy.mockResolvedValue({ delivered: true, threadId: 't', messageId: 'x' });

    const r = await broadcast();

    expect(r.isError, 'a partial fan-out is a success with a caveat, not a failure').toBe(false);
    // The success sentence keeps its exact start — existing readers match on it.
    expect(r.content.startsWith(`Broadcast sent to 1 agent(s): ${FX.n5}`)).toBe(true);
    expect(r.content.endsWith(`Not reached: ${FX.n6}.`),
      'the paused member vanished from the report; the sender cannot tell who missed the broadcast')
      .toBe(true);
  });

  it('a fan-out that reached everyone says exactly that — no trailer appears', async () => {
    // Non-vacuity in the other direction: the fix must not start appending "Not reached" to a
    // broadcast that missed nobody. The paused member is the only other member, so with it
    // gone the group is sender + the one idle member.
    mockDb.current!.prepare('DELETE FROM agents WHERE id = ?').run(PAUSED);
    deliverSpy.mockResolvedValue({ delivered: true, threadId: 't', messageId: 'x' });

    const r = await broadcast();

    expect(r.content).toBe(`Broadcast sent to 1 agent(s): ${FX.n5}`);
    expect(r.content).not.toContain('Not reached');
  });
});
