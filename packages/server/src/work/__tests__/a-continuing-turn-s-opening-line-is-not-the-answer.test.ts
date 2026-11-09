// ════════════════════════════════════════════════════════════════════════════════════════
// t139 round 3 — R-V333-8, AT THE SETTLEMENT AUTHORITY: which bubble of a CONTINUING turn is
// "the held-back opening line".
//
// The engine-driven RED and its B1 controls live in
// `t139-every-request-lands-on-the-task-list.test.ts`. This file pins the one discriminator a
// driven turn cannot easily reach: on a continuing turn, a model bubble that the turn named as
// its answer but that its OWN TOOL RESULTS FOLLOW (a live-ask answer delivered mid-turn, the
// round it was composed in) is a real answer and stays closed; only the bubble with no tool
// result after it — the line the finalize recovery delivered at the boundary — is handed back.
// Rows are written through the spine's own doors (openAsk / claimAsk / transition), the turn
// record and deliveries the way the doors write them. Fictional data (G1).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => { /* none */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, transition } from '../store.js';
import { settleAsksAtTurnFinalize } from '../ask-settlement.js';

const AGENT = 'agent-t139-r3';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'R3', 'idle', '{}')").run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES ('conv-r3', ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

let seq = 0;
function row(id: string, role: string, content: string, displayKind: string): void {
  seq++;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at, seq)
     VALUES (?, ?, 'conv-r3', ?, 'owner', ?, ?, 'user-visible', 1, 'live', 1, ?, ?)`,
  ).run(id, AGENT, role, content, displayKind, Date.now() + seq, 1000 + seq);
}

/** The owner's ask (turn 1 claims it), a bubble delivered and closing it, and the turn record
 *  naming that bubble as the turn's answer. `toolAfter` writes a tool result AFTER the bubble. */
function seedClosedOnBubble(toolAfter: boolean): string {
  const db = mockDb.current!;
  row('msg-ask', 'user', 'Research the cheapest venue near the station.', 'user-text');
  const askId = openAsk({ agentId: AGENT, messageId: 'msg-ask', conversationId: 'conv-r3', requesterId: 'owner',
    openedAt: Date.now(), title: 'venue' });
  expect(claimAsk(askId, AGENT).kind).toBe('applied');
  db.prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
                        source_message_id, conv_key, started_at, ended_at, exit_reason, answered,
                        effectful_calls, answer_message_id)
     VALUES (?, 1, 'user', 'conv', 'owner', 'ask', 'msg-ask', 'msg-ask', 'owner', datetime('now'),
             datetime('now'), 'budget', 1, 0, 'msg-line')`,
  ).run(AGENT);
  row('msg-tooluse', 'assistant', '[{"type":"tool_use","id":"t1","name":"web_search","input":{}}]', 'tool-turn');
  row('msg-toolres', 'tool', '[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]', 'tool-turn');
  row('msg-line', 'assistant', 'On it.', 'agent-text');
  if (toolAfter) row('msg-toolres-2', 'tool', '[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]', 'tool-turn');
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, message_id, conversation_id, created_at)
     VALUES ('dl-line', ?, 1, 'dashboard', 'dashboard', 'delivered', 'msg-line', 'conv-r3', datetime('now'))`,
  ).run(AGENT);
  expect(transition(askId, { to: 'done', by: 'agent', actorId: AGENT, resultDeliveryId: 'dl-line',
    expectedState: 'claimed', reason: 'delivered via dashboard' }).kind).toBe('applied');
  return askId;
}

const stateOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

describe('R-V333-8 — a continuing turn\'s held-back opening line is not the answer', () => {
  it('the bubble with NO tool result after it, on a continuing turn: handed back OWED', () => {
    const askId = seedClosedOnBubble(false);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1, continuing: true });
    expect(stateOf(askId)).toBe('open');
  });

  it('CONTROL: the same bubble on a turn that genuinely ENDED (no continuation) stays the answer', () => {
    const askId = seedClosedOnBubble(false);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1, continuing: false });
    expect(stateOf(askId)).toBe('done');
  });

  it('CONTROL: a bubble the turn\'s own tool results FOLLOW (an answer delivered mid-turn) stays the answer', () => {
    const askId = seedClosedOnBubble(true);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1, continuing: true });
    expect(stateOf(askId)).toBe('done');
  });
});
