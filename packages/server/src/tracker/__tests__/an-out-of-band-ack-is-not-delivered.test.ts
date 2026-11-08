// v3.5 field fix 3, review round 2 (ruled, not an owner call): AN ACK NEVER COUNTS AS
// COMPLETION, ON ANY CHANNEL. The always-ack law requires a start ack AND a completion, and
// close-coaching in engine text is a defect (product law, "Finishing, not closing").
//
// Before: a turn whose only line was an iMessage "On it" stamped the task `via imessage`, which
// the tangibility standard counted as a handover, so the stamp line said "CLOSE if done" and the
// readers treated the work as delivered. Now the stamp line states facts only, and every
// "delivered" reading goes through `taskWorkOnRecord`: a delivered file, or THE task's answer
// under the ack-order rule (`resolveTaskAnswerPointer`), whatever the channel.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-oob-ack', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, askIdForMessage } from '../../work/store.js';
import { openTrackerTask, stampTicket } from '../../work/tracker-store.js';
import { renderTaskStamps } from '../task-stamps.js';
import { trackerGetStatus, trackerListActive, trackerUpdateStatus } from '../tools.js';

const AGENT = 'agent-primary';
const CONV = 'conv-imessage';
const TURN = 7001;
const db = (): Database.Database => mockDb.current!;
let clock = 0;

function seedAskAndTask(): { askId: string; taskId: string } {
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'imessage', 'owner')`).run(CONV, AGENT);
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES ('msg-ask', ?, 'user', 'book the table for friday and text me', 'owner', ?, ?)`,
  ).run(AGENT, CONV, Date.now() - 60_000);
  openAsk({ agentId: AGENT, messageId: 'msg-ask', conversationId: CONV, requesterId: 'owner', openedAt: Date.now() - 60_000, title: 'book the table' });
  const taskId = openTrackerTask({
    title: 'book the table', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: 'msg-ask', turn: null, convKey: null },
  });
  return { askId: askIdForMessage('msg-ask'), taskId };
}

/** An iMessage line the agent sent, as the out-of-band door records it (no message row). */
function imessage(id: string, text = 'Booked: a table for four on Friday at 7pm.'): string {
  clock += 2;
  db().prepare(`INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, sent_text) VALUES (?, ?, 'imessage_send', 3, 0, 'exit-code', ?)`)
    .run(`r-${id}`, AGENT, text);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, receipt_id, outcome, created_at)
     VALUES (?, ?, ?, 'imessage_send', 'imessage', ?, NULL, ?, 'delivered', datetime('now', ?))`,
  ).run(id, AGENT, TURN, CONV, `r-${id}`, `+${clock} seconds`);
  return id;
}

function settle(askId: string, deliveryId: string): void {
  db().prepare(`UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = ? WHERE id = ?`).run(Date.now(), deliveryId, askId);
}

function stamp(taskId: string): void {
  stampTicket(taskId, {
    activityTurn: TURN, activityAt: Date.now(), activityOutcome: 'answered',
    answeredTurn: TURN, answeredAt: Date.now(), deliverySummary: 'via imessage',
  });
}

const DELIVERED = /ALREADY DELIVERED|appears already delivered|its answer was delivered/;

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

describe('an iMessage start ack is not a completion', () => {
  it('THE RED: an iMessage "On it" (the ask settled on it, the task stamped via imessage): no delivered reading, no close coaching', () => {
    const { askId, taskId } = seedAskAndTask();
    settle(askId, imessage('d-onit'));
    stamp(taskId);
    const view = trackerGetStatus(AGENT, { taskId });
    expect(view).not.toMatch(DELIVERED);
    expect(view).not.toContain('CLOSE if done');
    const list = trackerListActive(AGENT, {});
    expect(list).not.toMatch(DELIVERED);
    expect(list).not.toContain('CLOSE if done');
  });



  it('the stamp line states facts only, on every channel (no "CLOSE if done")', () => {
    for (const summary of ['via imessage', 'file report.md; via email', 'via dashboard']) {
      const line = renderTaskStamps({
        last_activity_turn: TURN, last_activity_at: '2026-11-04 13:01:05', last_activity_outcome: 'answered',
        last_answered_turn: TURN, last_answered_at: '2026-11-04 13:01:05', last_delivery_summary: summary,
      });
      expect(line).toContain(`answered T${TURN}`);
      expect(line).toContain(summary);
      expect(line).not.toContain('CLOSE');
    }
  });
});
