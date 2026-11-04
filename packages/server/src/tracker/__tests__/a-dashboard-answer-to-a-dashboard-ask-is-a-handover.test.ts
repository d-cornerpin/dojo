// v3.5 field fix 3, ranked fix #8. OWNER RULING OR-FIELD3(b), 2026-11-04:
// "A dashboard answer to a dashboard ask COUNTS as a tangible delivery for closing a task."
// (And, by the same channel-identity law, a voice answer to a voice ask.)
//
// REVIEW ROUND (H1): the first cut made every dashboard line on the ask's thread a handover
// through the per-turn delivery SUMMARY, and an "On it" final line therefore read as delivered.
// The ruling is now carried by THE task's answer (`resolveTaskAnswerPointer`), where an ack is
// never the answer: the first line that reached the asking thread after the task opened is its
// start ack, and only a later line is its completion. The per-turn summary is back to its base
// meaning, so a stored "via dashboard" stamp is never re-read as a handover.

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
import { resolveTaskAnswerPointer, taskWorkOnRecord } from '../delivery-evidence.js';
import { isTangibleDeliverySummary } from '../task-stamps.js';

const AGENT = 'agent-primary';
const TURN = 6559;
const db = (): Database.Database => mockDb.current!;
let clock = 0;

function seedConversation(id: string, channel: string): void {
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, ?, 'owner')`).run(id, AGENT, channel);
}

/** The owner's ask on `conv`, and the task opened for it. */
function seedAskAndTask(messageId: string, conv: string): { askId: string; taskId: string } {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES (?, ?, 'user', 'make the folder and tell me', 'owner', ?, ?)`,
  ).run(messageId, AGENT, conv, Date.now() - 60_000);
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
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', datetime('now', ?))`,
  ).run(id, AGENT, TURN, channel, channel, conv, `m-${id}`, `+${clock} seconds`);
  return id;
}

/** The ask settles on `deliveryId`, the way the settlement authority records it. */
const settle = (askId: string, deliveryId: string): void => {
  db().prepare(`UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = ? WHERE id = ?`).run(Date.now(), deliveryId, askId);
};

beforeEach(() => {
  mockDb.current?.close();
  clock = 0;
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Primary', 'idle', '1970-01-01')`).run(AGENT);
});

describe('OR-FIELD3(b): an answer on the channel that asked is the task\'s answer', () => {
  it('THE FIELD SHAPE: ack, then the answer, both on the dashboard thread of a dashboard ask', () => {
    seedConversation('conv-dash', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask', 'conv-dash');
    line('d-ack', 'dashboard', 'conv-dash');
    settle(askId, line('b2b026a7', 'dashboard', 'conv-dash'));
    const p = resolveTaskAnswerPointer(taskId);
    expect(p?.deliveryId).toBe('b2b026a7');
    expect(p?.channel).toBe('dashboard');
    expect(taskWorkOnRecord(taskId, null)).toContain('b2b026a7'.slice(0, 8));
  });

  it('a voice answer to a voice ask counts the same way', () => {
    seedConversation('conv-voice', 'voice');
    const { askId, taskId } = seedAskAndTask('msg-ask-v', 'conv-voice');
    line('d-ack-v', 'voice', 'conv-voice');
    settle(askId, line('d-voice', 'voice', 'conv-voice'));
    expect(resolveTaskAnswerPointer(taskId)?.channel).toBe('voice');
  });
});

describe('what never counts', () => {
  it('the ask settled on its FIRST line after the task opened (the start ack) is not the answer', () => {
    seedConversation('conv-dash', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask-a', 'conv-dash');
    settle(askId, line('d-onit', 'dashboard', 'conv-dash'));
    expect(resolveTaskAnswerPointer(taskId)).toBeNull();
    expect(taskWorkOnRecord(taskId, null)).toBeNull();
  });

  it('an ack on ANOTHER conversation does not make the asking thread\'s first line a completion', () => {
    seedConversation('conv-dash', 'dashboard');
    seedConversation('conv-other', 'dashboard');
    const { askId, taskId } = seedAskAndTask('msg-ask-o', 'conv-dash');
    line('d-elsewhere', 'dashboard', 'conv-other');
    settle(askId, line('d-first-here', 'dashboard', 'conv-dash'));
    expect(resolveTaskAnswerPointer(taskId)).toBeNull();
  });

  it('a line recorded BEFORE the task opened is not its answer', () => {
    seedConversation('conv-dash', 'dashboard');
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
       VALUES ('d-old', ?, ?, 'dashboard', 'dashboard', 'conv-dash', NULL, 'delivered', datetime('now', '-1 hour'))`,
    ).run(AGENT, TURN - 3);
    const { askId, taskId } = seedAskAndTask('msg-ask-b', 'conv-dash');
    settle(askId, 'd-old');
    expect(resolveTaskAnswerPointer(taskId)).toBeNull();
  });

  it('OLD DATA: a stored "via dashboard" stamp is not a handover (the summary keeps its base meaning)', () => {
    expect(isTangibleDeliverySummary('via dashboard')).toBe(false);
    expect(isTangibleDeliverySummary('via voice')).toBe(false);
    expect(isTangibleDeliverySummary('via imessage')).toBe(true);
  });
});
