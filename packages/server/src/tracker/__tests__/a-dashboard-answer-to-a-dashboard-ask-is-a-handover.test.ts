// OWNER RULING OR-FIELD3(b), 2026-11-04: "A dashboard answer to a dashboard ask COUNTS as a tangible
// delivery for closing a task." (And, by the same law, a voice answer to a voice ask.)
//
// The answer is the newest message to the asker the one proof check accepts
// (`work/done/proof.ts:proofDelivery`). The ack is identified STRUCTURALLY, by the engine's own marking
// (`origin_intent = engine_start_ack` on its row, the `engine-ack` lane on its channel push), never by
// "the first line". The engine itself never closes on a text answer: only a file or a measure counts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-dash-handover', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, askIdForMessage } from '../../work/store.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { engineProofLine, proofDelivery, proofFor } from '../../work/done/proof.js';
import { isTangibleDeliverySummary } from '../task-stamps.js';

const AGENT = 'agent-primary';
const TURN = 6559;
const db = (): Database.Database => mockDb.current!;
let clock = 0;
/** The owner message the lines' turn serves: the root the engine stamps on each delivery. */
let serving: string | null = null;

function seedConversation(id: string, channel: string): void {
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, ?, 'owner')`).run(id, AGENT, channel);
}

/** The owner's ask on `conv`, and the task opened for it. */
function seedAskAndTask(messageId: string, conv: string): { askId: string; taskId: string } {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES (?, ?, 'user', 'make the folder and tell me', 'owner', ?, ?)`,
  ).run(messageId, AGENT, conv, Date.now() - 60_000);
  serving = messageId;
  openAsk({ agentId: AGENT, messageId, conversationId: conv, requesterId: 'owner', openedAt: Date.now() - 60_000, title: 'make the folder' });
  const taskId = openTrackerTask({
    title: 'make the folder', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: messageId, turn: null, convKey: null },
  });
  return { askId: askIdForMessage(messageId), taskId };
}

function line(id: string, channel: string, conv: string): string {
  clock += 2;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, display_kind, created_at)
     VALUES (?, ?, 'assistant', 'a line', 'owner', ?, ?, 'agent-text', ?)`,
  ).run(`m-${id}`, AGENT, conv, TURN, Date.now() + clock * 1000);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at, root_kind, root_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', datetime('now', ?), ?, ?)`,
  ).run(id, AGENT, TURN, channel, channel, conv, `m-${id}`, `+${clock} seconds`, serving ? 'ask' : null, serving);
  return id;
}

/** The ask settles on `deliveryId`, the way the settlement authority records it. */
const settle = (askId: string, deliveryId: string): void => {
  db().prepare(`UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = ? WHERE id = ?`).run(Date.now(), deliveryId, askId);
};

beforeEach(() => {
  mockDb.current?.close();
  clock = 0;
  serving = null;
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Primary', 'idle', '1970-01-01')`).run(AGENT);
});

const markAck = (id: string): void => {
  db().prepare("UPDATE messages SET origin_intent = 'engine_start_ack' WHERE id = ?").run(`m-${id}`);
};

describe('OR-FIELD3(b): an answer on the channel that asked is the task\'s answer', () => {
  it('THE FIELD SHAPE: the marked ack, then the answer, on the dashboard thread of a dashboard ask', () => {
    seedConversation('conv-dash', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask', 'conv-dash');
    line('d-ack', 'dashboard', 'conv-dash');
    markAck('d-ack');
    settle(askId, line('b2b026a7', 'dashboard', 'conv-dash'));
    expect(proofDelivery(taskId)).toBe('b2b026a7');
    expect(proofFor(taskId).map((i) => i.facts.channel)).toEqual(['dashboard']);
  });

  it('a voice answer to a voice ask counts the same way', () => {
    seedConversation('conv-voice', 'voice');
    const { askId, taskId } = seedAskAndTask('msg-ask-v', 'conv-voice');
    settle(askId, line('d-voice', 'voice', 'conv-voice'));
    expect(proofDelivery(taskId)).toBe('d-voice');
  });

  it('an answer with no ack before it counts (the ack is marked, not inferred from order)', () => {
    seedConversation('conv-dash', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask-1', 'conv-dash');
    settle(askId, line('d-only', 'dashboard', 'conv-dash'));
    expect(proofDelivery(taskId)).toBe('d-only');
  });

  it('a text answer is never "work on record" for the engine (only a file or a measure is)', () => {
    seedConversation('conv-dash', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask-w', 'conv-dash');
    settle(askId, line('d-text', 'dashboard', 'conv-dash'));
    expect(engineProofLine(taskId)).toBeNull();
  });
});

describe('what never counts', () => {
  it('the marked start ack is never the answer, even when it is the ask\'s receipt', () => {
    seedConversation('conv-dash', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask-a', 'conv-dash');
    const ack = line('d-onit', 'dashboard', 'conv-dash');
    markAck('d-onit');
    settle(askId, ack);
    expect(proofDelivery(taskId)).toBeNull();
  });

  it('the engine-ack lane (the start line pushed to a channel) is never the answer', () => {
    seedConversation('conv-im', 'imessage');
    const { askId, taskId } = seedAskAndTask('msg-ask-e', 'conv-im');
    const d = line('d-eack', 'imessage', 'conv-im');
    db().prepare("UPDATE deliveries SET tool = 'engine-ack' WHERE id = ?").run(d);
    settle(askId, d);
    expect(proofDelivery(taskId)).toBeNull();
  });

  it('a line written BEFORE the task was opened is not its answer', () => {
    seedConversation('conv-dash', 'dashboard');
    const early = line('d-early', 'dashboard', 'conv-dash');
    db().prepare("UPDATE deliveries SET created_at = datetime('now', '-60 seconds') WHERE id = ?").run(early);
    const { askId, taskId } = seedAskAndTask('msg-ask-b', 'conv-dash');
    settle(askId, early.replace(/^m-/, ''));
    expect(proofDelivery(taskId)).toBeNull();
  });

  it('OLD DATA: a stored "via dashboard" stamp is not a handover (the summary keeps its base meaning)', () => {
    expect(isTangibleDeliverySummary('via dashboard')).toBe(false);
    expect(isTangibleDeliverySummary('via voice')).toBe(false);
    expect(isTangibleDeliverySummary('via imessage')).toBe(true);
  });
});
