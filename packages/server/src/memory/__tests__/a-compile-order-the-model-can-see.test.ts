// THE ORDER THE MODEL CAN SEE: once a delegated request's pieces are back, the turn serving that request (its root
// is the request) is handed every piece whole, with what was asked, through the one turn-scoped steer, keyed by
// the put-back; no other turn is. The stored row is the order's first line only, and the queue entry carries the
// request and put-back it shows, so the delivery can be recorded.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece } from '../../work/store.js';
import { resolveJoinsAtBoot } from '../../agent/a2a-transport.js';
import { withHandBackFacts } from '../../agent/v2/steps/assemble/hand-back-steer.js';
import { initState } from '../../agent/v2/state.js';
import { markSteerDelivered, nextSteer } from '../../agent/v2/steer-queue.js';
import { newestPutBack } from '../../work/ask-settlement.js';

const AGENT = 'agent-order';
const CONV = 'conv-owner';
const ASK_TEXT = 'Have your helpers find a dinner spot and a Saturday plan for my parents';
const PIECE_1 = `Duke's Seafood, Green Lake: a big free lot behind the building. ${'More detail. '.repeat(80)}`;
const PIECE_2 = 'Saturday: 9am Ballard market, 12pm lunch at the Locks, 3pm Gas Works.';

function seedPutBack(msgId = 'm-ask'): string {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
    VALUES (?, ?, 'user', ?, 'owner', 'dashboard', ?, ?, NULL)`).run(msgId, AGENT, ASK_TEXT, CONV, Date.now() - 60_000);
  const askId = openAsk({ agentId: AGENT, messageId: msgId, conversationId: CONV, requesterId: 'owner', openedAt: Date.now() - 60_000, title: 'plan' });
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, 1);
  const kids = openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 3_600_000,
    threads: [{ threadId: 'thread-1', assigneeAgent: 'helper', intent: 'ASSIGN' }, { threadId: 'thread-2', assigneeAgent: 'helper', intent: 'ASSIGN' }],
  });
  for (const [i, kid] of kids.entries()) {
    db.prepare(`INSERT INTO deliveries (id, agent_id, tool, channel, outcome, created_at) VALUES (?, ?, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`).run(`d-${msgId}-${i}`, AGENT);
    landPiece(kid, { deliveryId: `d-${msgId}-${i}`, content: i === 0 ? PIECE_1 : PIECE_2, actorId: 'helper' });
  }
  return askId;
}

const turnOf = (rootMessageId: string | null) => ({
  root: rootMessageId ? { kind: 'ask', id: rootMessageId, sourceMessageId: rootMessageId, conversationId: CONV } : undefined,
}) as never;
const steersOf = (s: ReturnType<typeof initState>) => s.steerQueue.pending.filter((e) => e.floor === 'handed-back-ask');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Desk', 'idle'), ('helper', 'Helper', 'idle')").run(AGENT);
});

describe('the order reaches only the turn that serves the request', () => {
  it('the serving turn is handed what was asked and every piece whole; the stored row is one line', async () => {
    const askId = seedPutBack();
    await resolveJoinsAtBoot();
    const putBack = newestPutBack(askId)!;
    const state = withHandBackFacts(initState({ agentId: AGENT } as never), turnOf('m-ask'), AGENT, 2);
    const [entry] = steersOf(state);
    expect(entry.content).toContain(`They asked: "${ASK_TEXT}"`);
    expect(entry.content).toContain(PIECE_1.trim());
    expect(entry.content).toContain(PIECE_2);
    expect(entry.key).toBe(String(putBack.id));
    expect(entry.shown).toEqual({ askId, putBackId: putBack.id });
    const stored = mockDb.current!.prepare("SELECT content FROM messages WHERE agent_id = ? AND role = 'system'").all(AGENT);
    expect(stored).toEqual([{ content: "All 2 delegated pieces for the owner's request are back." }]);
    // Fired once per put-back: the next step of the same turn is not handed it again.
    expect(steersOf(withHandBackFacts(state, turnOf('m-ask'), AGENT, 2))).toHaveLength(1);
  });

  it('another request\'s turn, and a turn with no request, are handed nothing', async () => {
    seedPutBack();
    mockDb.current!.prepare(`INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
      VALUES ('m-other', ?, 'user', 'thanks', 'owner', 'dashboard', ?, ?, NULL)`).run(AGENT, CONV, Date.now());
    await resolveJoinsAtBoot();
    expect(steersOf(withHandBackFacts(initState({ agentId: AGENT } as never), turnOf('m-other'), AGENT, 2))).toEqual([]);
    expect(steersOf(withHandBackFacts(initState({ agentId: AGENT } as never), turnOf(null), AGENT, 2))).toEqual([]);
  });

  it('before the answer is back nothing is handed; once delivered, the entry keeps what it showed', async () => {
    const askId = seedPutBack();
    expect(steersOf(withHandBackFacts(initState({ agentId: AGENT } as never), turnOf('m-ask'), AGENT, 2))).toEqual([]);
    await resolveJoinsAtBoot();
    const state = withHandBackFacts(initState({ agentId: AGENT } as never), turnOf('m-ask'), AGENT, 2);
    const delivered = markSteerDelivered(state.steerQueue, nextSteer(state.steerQueue)!);
    expect(delivered.delivered[0].shown).toEqual({ askId, putBackId: newestPutBack(askId)!.id });
  });
});
