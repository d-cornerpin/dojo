// PHASE-2 T13 Step 0 — issues-log #19: the parent closing must not silence the deadline.
//
// The store half (the finder, the disjointness of the two arms, the child settle as the
// exactly-once guard) is proven in `work/__tests__/fanout-join.test.ts`. THIS file drives the
// real `sweepExpiredJoins` end to end, because the defect was never that a row was hard to
// find — it was that THE PERSON WAS NEVER TOLD. A finder with no delivery behind it would fix
// nothing, so what is asserted here is the owner's message existing, once.
//
// The 14 rows T11 measured sat `open` 8–13 hours past their TTL under 13 parents that were all
// `done`, and both timeout finders excluded a terminal parent, so `resolveOpenJoin` never ran
// and the fail-closed notice was never sent.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { isOwnerAlertSystemNote } from '@dojo/shared';

// ── PHASE-6 T-PROMISE: a TIMEOUT WITH ITS MEASURED REASON, not a re-run ──────────
// The second of the two files CUT 8 recorded (H6) as blowing vitest's 5,000 ms
// per-test default when the whole suite runs on a loaded machine — GREEN alone,
// GREEN in subsets, a TIMEOUT rather than an assertion failure.
//
// THE REASON, MEASURED on a settled machine (`npx vitest run <this file>
// --reporter=verbose`): the FIRST clause costs 2,458 ms and the seven after it cost
// 175–182 ms each. ~2,279 ms — 93% of the first clause — is one-time setup: the
// migration chain run over a fresh temp database plus the first dynamic import of
// `a2a-transport.js` and its graph. Real work, not a hang, and it expands past
// 5,000 ms under the load CUT 8 recorded.
//
// 15,000 ms is 6.1× the settled first-clause cost. Same three refusals as the
// teardown contract's twin note, and the same reason for pinning the FILE rather
// than the clause: which clause pays the setup is an ordering accident. The twin's
// note carries the two negative controls that proved the raise live and the 5,000 ms
// default binding; they were run once, on that file, and are cited rather than
// duplicated here.
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-join-closed-parent-test', 'dojo.db'),
  };
});

const broadcast = vi.fn();
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
  openAsk, claimAsk, transition, openDelegationJoin, findJoinChildByThread,
  landPiece, joinPieces, dueJoins, dueJoinsUnderClosedParent,
} from '../../work/store.js';

const AGENT = 'kevin';
const T1 = 'thread-aaaaaaaa-1111';
const T2 = 'thread-bbbbbbbb-2222';

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

/** Messages the owner can actually see: assistant rows on the owner lane. */
/** Everything the OWNER can see on their own lane from this sweep, whatever voice it is in.
 *
 *  ⚠ PHASE-4 T4 (OR2) — THIS READ USED TO BE `role = 'assistant'`, AND THAT WAS THE DEFECT IT
 *  COULD NOT SEE. The fail-closed notice was engine-composed prose in the AGENT's first person
 *  ("I asked Ana about this but could not get an answer"), delivered as an assistant bubble, so
 *  a clause scoped to assistant rows scored the engine speaking as the agent a clean GREEN.
 *  The notice is the PLATFORM's now — third person, owner-alert prefixed, `role='system'` — so
 *  the read follows the requirement (the owner is told) rather than the old mechanism, and the
 *  clause below asserts the voice separately instead of assuming it. */
const ownerFacing = (): Array<{ id: string; content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT id, content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system')
        AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ id: string; content: string; role: string }>;

/** The agent's own copy — the events-lane note that lets it decide whether to say more. */
const agentToldRows = (): Array<{ content: string }> =>
  mockDb.current!.prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND lane = 'events'
        AND origin_intent = 'fanout_join' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string }>;

function seedDelivery(id: string, over: Record<string, unknown> = {}): string {
  const r = {
    id, agent_id: AGENT, turn_number: 7, tool: 'send_to_agent', channel: 'a2a',
    conversation_id: null, outcome: 'delivered', ...over,
  };
  const cols = Object.keys(r);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(r);
  return id;
}

/**
 * The exact shape T11 measured, built through the product's own calls: the owner asks, the turn
 * claims the ask, the turn delegates (opening the countdown), and the turn answers the owner —
 * which closes the ask. `join_opened` before or after the close makes no difference to the
 * defect; what matters is that both are true at the end of one turn.
 */
function seedClosedParentJoin(
  msgId: string, opts: { ttlMinutesAgo?: number; threads?: string[] } = {},
): string {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'ask Ana and Bo about the roof, then tell me', 'owner', 'dashboard',
             'conv-1', ?, NULL)`,
  ).run(msgId, AGENT, Date.now() - 60 * 60_000);
  const parent = openAsk({
    agentId: AGENT, messageId: msgId, conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now() - 60 * 60_000, title: 'ask about the roof',
  });
  claimAsk(parent, AGENT);
  openDelegationJoin({
    parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
    ttlAt: Date.now() - (opts.ttlMinutesAgo ?? 600) * 60_000,
    threads: (opts.threads ?? [T1]).map((threadId, i) => ({
      threadId, assigneeAgent: i === 0 ? 'ana' : 'bo',
    })),
  });
  const owner = seedDelivery('d-owner-' + msgId, { channel: 'dashboard', tool: 'send_message' });
  const closed = transition(parent, {
    to: 'done', by: 'engine', actorId: 'engine',
    reason: 'delivered via dashboard', evidenceRef: owner, resultDeliveryId: owner,
  });
  expect(closed.kind).toBe('applied');
  return parent;
}

async function sweep(): Promise<{ failedClosed: number; relayedReplies: number; noticedUnderClosedParent: number }> {
  const { sweepExpiredJoins } = await import('../a2a-transport.js');
  return sweepExpiredJoins();
}

beforeEach(() => {
  broadcast.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, 'Kevin', 'idle', '1970-01-01'), ('ana', 'Ana', 'idle', '1970-01-01'),
       ('bo', 'Bo', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
});

describe('#19: the reaper reaches a join whose parent has already closed', () => {
  it('POSITIVE: the owner is told the delegated half never came back, and the piece stops '
    + 'being outstanding', async () => {
    const parent = seedClosedParentJoin('m-1');
    const child = findJoinChildByThread(AGENT, T1)!.id;
    expect(ownerFacing()).toHaveLength(0);

    const r = await sweep();

    expect(r.noticedUnderClosedParent).toBe(1);
    expect(workRow(child).state).toBe('abandoned');
    expect(workRow(parent).remaining_children).toBe(0);
    const msgs = ownerFacing();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toMatch(/could not get an answer/i);
    expect(msgs[0].content).toContain('Ana');
    // OR2, and this is the half the old clause could not express: the owner is told, and the
    // PLATFORM is what tells them. Not an assistant bubble, not the first person, and it
    // carries the owner-alert prefix that puts it on the dashboard's allowlist.
    expect(msgs[0].role).toBe('system');
    expect(isOwnerAlertSystemNote(msgs[0].content)).toBe(true);
    expect(msgs[0].content).toContain('your agent');
    expect(/\bI\b/.test(msgs[0].content.replace(/\(Your question was:[\s\S]*$/, ''))).toBe(false);
    // …and the AGENT is told too, with the 2026-07-30 ruling's nudge, so it can add whatever
    // the platform's one-liner cannot say.
    const told = agentToldRows();
    expect(told).toHaveLength(1);
    expect(told[0].content).toMatch(/WRITE it to them in your own words/);
    // The relay is a real outbound and records one — this is what makes it a delivery rather
    // than a log line.
    const rows = mockDb.current!.prepare(
      `SELECT count(*) c FROM deliveries WHERE tool = 'a2a-join-failed'`,
    ).get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('POSITIVE: the parent\'s delivered answer is not disturbed — no state move, no re-close', async () => {
    const parent = seedClosedParentJoin('m-2');
    const before = workRow(parent);
    await sweep();
    const after = workRow(parent);
    expect(after.state).toBe('done');
    expect(after.result_delivery_id).toBe(before.result_delivery_id);
    expect(after.closed_at).toBe(before.closed_at);
    // No transition was recorded against the parent by the reaper.
    const moves = mockDb.current!.prepare(
      `SELECT count(*) c FROM work_events WHERE work_id = ? AND kind = 'transition' AND actor = 'work-reaper'`,
    ).get(parent) as { c: number };
    expect(moves.c).toBe(0);
  });

  it('NEGATIVE: exactly once — a second sweep tells the owner nothing further', async () => {
    seedClosedParentJoin('m-3');
    const first = await sweep();
    const second = await sweep();
    expect(first.noticedUnderClosedParent).toBe(1);
    expect(second.noticedUnderClosedParent).toBe(0);
    expect(ownerFacing()).toHaveLength(1);
  });

  it('POSITIVE: a PARTIAL fan-out says what arrived and who did not — never a bare failure '
    + 'notice on top of a real answer', async () => {
    seedClosedParentJoin('m-4', { threads: [T1, T2] });
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-t1'), content: 'The roof quote is 4,200.', messageId: null,
    });
    await sweep();
    const msgs = ownerFacing();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('4,200');       // what DID arrive
    expect(msgs[0].content).toContain('Bo');          // who did not
    expect(msgs[0].content).not.toMatch(/could not get an answer/i);
    expect(joinPieces(findJoinChildByThread(AGENT, T2)?.id ?? '')).toEqual([]);
  });

  it('NEGATIVE: a join under a closed parent whose deadline has NOT passed is left alone, and '
    + 'the owner hears nothing', async () => {
    seedClosedParentJoin('m-5', { ttlMinutesAgo: -60 });   // ttl an hour in the FUTURE
    const r = await sweep();
    expect(r.noticedUnderClosedParent).toBe(0);
    expect(ownerFacing()).toHaveLength(0);
  });

  it('NEGATIVE: the first arm is untouched — a LIVE parent past TTL still fails closed exactly '
    + 'as before', async () => {
    const db = mockDb.current!;
    db.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
       VALUES ('m-live', ?, 'user', 'ask Ana', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
    ).run(AGENT, Date.now() - 60 * 60_000);
    const parent = openAsk({
      agentId: AGENT, messageId: 'm-live', conversationId: 'conv-1', requesterId: 'owner',
      openedAt: Date.now() - 60 * 60_000, title: 'ask Ana',
    });
    claimAsk(parent, AGENT);
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 600 * 60_000, threads: [{ threadId: T1, assigneeAgent: 'ana' }],
    });
    expect(dueJoins(Date.now()).map((j) => j.id)).toContain(parent);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);

    const r = await sweep();

    expect(r.failedClosed).toBe(1);
    expect(r.noticedUnderClosedParent).toBe(0);
    expect(workRow(parent).state).toBe('failed');
    expect(ownerFacing()).toHaveLength(1);
  });

  it('NEGATIVE: the first arm\'s own fail-closed is NOT noticed a second time — this clause is '
    + 'why the finder scopes to `done` rather than to any terminal state', async () => {
    const db = mockDb.current!;
    db.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
       VALUES ('m-twice', ?, 'user', 'ask Ana', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
    ).run(AGENT, Date.now() - 60 * 60_000);
    const parent = openAsk({
      agentId: AGENT, messageId: 'm-twice', conversationId: 'conv-1', requesterId: 'owner',
      openedAt: Date.now() - 60 * 60_000, title: 'ask Ana',
    });
    claimAsk(parent, AGENT);
    openDelegationJoin({
      parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
      ttlAt: Date.now() - 600 * 60_000, threads: [{ threadId: T1, assigneeAgent: 'ana' }],
    });

    // Pass 1: the first arm fails it closed and delivers ONE notice. That leaves the parent
    // `failed` with `remaining_children` still 1 — the exact shape the second arm hunts, which
    // is how the first draft of this fix produced a duplicate notice on every pass.
    const one = await sweep();
    expect(one.failedClosed).toBe(1);
    expect(workRow(parent).state).toBe('failed');
    expect(Number(workRow(parent).remaining_children)).toBeGreaterThan(0);
    expect(ownerFacing()).toHaveLength(1);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);

    // Pass 2 and 3: silence. The person is told once about one join.
    await sweep();
    await sweep();
    expect(ownerFacing()).toHaveLength(1);
  });

  it('NEGATIVE: an ABANDONED parent is deliberately out of scope — the abandon paths own their '
    + 'own honesty and this arm does not add a new voice', async () => {
    const parent = seedClosedParentJoin('m-aband');
    // Force the parent terminal-by-abandon rather than done. (`done -> abandoned` is not a legal
    // move, so the row is rewritten directly: the point of the clause is the FINDER's scope.)
    mockDb.current!.prepare(
      `UPDATE work SET state = 'abandoned', result_delivery_id = NULL WHERE id = ?`,
    ).run(parent);
    expect(dueJoinsUnderClosedParent(Date.now()).map((j) => j.id)).not.toContain(parent);
    const r = await sweep();
    expect(r.noticedUnderClosedParent).toBe(0);
    expect(ownerFacing()).toHaveLength(0);
  });
});
