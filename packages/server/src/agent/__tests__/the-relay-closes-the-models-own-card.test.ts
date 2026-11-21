// The cards the agent opened for a request (its own tracker tasks linked to the request's message) are handed in
// by the engine on the delivery that answered the request, the Dojo's relay included; never set done, never
// decided. Cards with no link, the engine's scaffold, another agent's cards and the join's own pieces are untouched.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The first clause pays the migration chain plus `a2a-transport.js`'s whole import graph.
vi.setConfig({ testTimeout: 20_000 });

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-relay-closes-card-test', 'dojo.db'),
  };
});

const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../../gateway/ws.js', () => ({ broadcast }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false, isPMAgent: () => false, isHealerAgent: () => false,
  isDreamerAgent: () => false, isSystemServiceAgent: () => false, getOwnerName: () => 'Owner', getPrimaryAgentId: () => 'primary',
}));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }) }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece } from '../../work/store.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { setHold } from '../../work/done/hold.js';
import { relayPiecesWhole } from '../a2a-transport.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const OTHER_AGENT = FXID.n5;
const PEER_A = FXID.n5;
const PEER_B = 'kayla';
const CONV = 'conv-1';
const MSG = 'm-1';

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

const handInsOf = (id: string): Array<{ actor: string; note: string }> => (mockDb.current!.prepare(
  "SELECT actor, json_extract(payload, '$.note') AS note FROM work_events WHERE work_id = ? AND kind = 'handed_in'",
).all(id) as Array<{ actor: string; note: string }>);

/** The Dojo relays the request's answer; its verdict, and the hand-ins after it, land before this returns. */
const relay = async (askId: string): Promise<void> => {
  await relayPiecesWhole(askId, 'compile', null);
  await new Promise((r) => setImmediate(r));
};

/** A two-piece join under the owner's request, both pieces back with content. */
function seedTwoPieceJoin(): string {
  const db = mockDb.current!;
  const openedAt = Date.now() - 20 * 60_000;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'anniversary dinner: a place out, and a backup at home', 'owner', 'dashboard', ?, ?, NULL)`,
  ).run(MSG, AGENT, CONV, openedAt);
  const askId = openAsk({ agentId: AGENT, messageId: MSG, conversationId: CONV, requesterId: 'owner', openedAt, title: 'Anniversary dinner' });
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, 4984);
  const kids = openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 60 * 60_000,
    threads: [
      { threadId: 'thread-a', assigneeAgent: PEER_A, intent: 'ASSIGN' as const, hopCount: 0 },
      { threadId: 'thread-b', assigneeAgent: PEER_B, intent: 'ASSIGN' as const, hopCount: 0 },
    ],
  });
  for (const [i, kid] of kids.entries()) {
    db.prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`).run(`piece-d-${i}`, AGENT);
    landPiece(kid, { deliveryId: `piece-d-${i}`, content: `piece ${i} for ${FX.n11}`, messageId: null, actorId: i === 0 ? PEER_A : PEER_B });
  }
  return askId;
}

/** A card the agent opened, as `work_open(kind="task")` records one; `linked` ties it to the request's message. */
function card(opts: { linked: boolean; agentId?: string; originKind?: string; blocked?: boolean }): string {
  const id = openTrackerTask({
    title: 'Combine the dinner plan and deliver it', description: null, priority: 'normal',
    createdBy: opts.agentId ?? AGENT, assignedTo: opts.agentId ?? AGENT,
    origin: { kind: (opts.originKind ?? 'model') as 'model', sourceMessageId: opts.linked ? MSG : null, turn: 4985, convKey: null },
  });
  if (opts.blocked) setHold(id, 'blocked', 'waiting on the delegated pieces', opts.agentId ?? AGENT);
  return id;
}

beforeEach(() => {
  broadcast.mockClear();
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, '${FX.n4}', 'idle', '1970-01-01'), (?, '${FX.n5}', 'idle', '1970-01-01'), (?, 'Kayla', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER_A, PEER_B);
  mockDb.current.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('the relay hands in the cards the agent opened for the request', () => {
  it('a blocked card linked to the request is handed in on the relay\'s delivery, with no decision', async () => {
    const askId = seedTwoPieceJoin();
    const linked = card({ linked: true, blocked: true });
    await relay(askId);
    expect(workRow(askId).state, 'premise: the request closed on the relay').toBe('done');
    expect(workRow(linked).state).toBe('handed_in');
    expect(handInsOf(linked)).toEqual([{ actor: 'engine', note: expect.stringMatching(/the request this task was opened for was answered/) }]);
    const record = JSON.parse((mockDb.current!.prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'handed_in'").get(linked) as { payload: string }).payload) as
      { outcome: string; items: Array<{ kind: string; ref: string }> };
    expect(record.outcome).toBe('finished');
    expect(record.items).toEqual([expect.objectContaining({ kind: 'delivery', ref: workRow(askId).result_delivery_id })]);
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = 'decided'").get(linked)).toEqual({ c: 0 });
  });

  it('CONTROLS: an unlinked card, the engine\'s scaffold, another agent\'s card and the pieces are untouched; nothing twice', async () => {
    const askId = seedTwoPieceJoin();
    const linked = card({ linked: true });
    const untied = card({ linked: false, blocked: true });
    const scaffold = card({ linked: true, originKind: 'engine_scaffold' });
    const theirs = card({ linked: true, agentId: OTHER_AGENT });
    const before = [workRow(scaffold).state, workRow(theirs).state];
    await relay(askId);
    await relay(askId);
    expect(workRow(untied).hold_kind).toBe('blocked');
    expect([workRow(scaffold).state, workRow(theirs).state]).toEqual(before);
    expect(handInsOf(linked)).toHaveLength(1);
    expect((mockDb.current!.prepare('SELECT state FROM work WHERE parent_id = ? ORDER BY id').all(askId) as Array<{ state: string }>)
      .map((p) => p.state)).toEqual(['done', 'done']);
  });

  it('NO ANSWER, NO RELEASE: while the request waits for its answer the card is left for the agent', async () => {
    seedTwoPieceJoin();
    const linked = card({ linked: true, blocked: true });
    expect(workRow(linked).hold_kind).toBe('blocked');
    expect(handInsOf(linked)).toHaveLength(0);
  });
});
