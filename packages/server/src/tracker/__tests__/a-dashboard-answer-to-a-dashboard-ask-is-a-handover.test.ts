// v3.5 field fix 3, ranked fix #8 — OWNER RULING OR-FIELD3(b), 2026-11-04:
// "A dashboard answer to a dashboard ask COUNTS as a tangible delivery for closing a task."
// (And, by the same channel-identity law, a voice answer to a voice ask.)
//
// THE FIELD SHAPE (diagnosis Problem 3, point 2): turn 6559 answered the owner's dashboard ask on
// the dashboard. The strike-0 boundary close skipped steps 2-4 because `'via dashboard'` was
// declared non-tangible, so the engine's own close refused the very answer the owner read.
//
// What stays non-tangible: a dashboard (or voice) bubble on a turn that was NOT answering an ask
// on that thread, e.g. a status line on an engine wake. That bubble is still NAMED in the summary
// so the state line tells the truth, as T19 (D7) required.

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
import { openAsk } from '../../work/store.js';
import {
  composeTurnDeliverySummary, isTangibleDeliverySummary, renderTaskStamps, NON_TANGIBLE_DELIVERY_SUMMARIES,
  ASK_THREAD_DELIVERY_SUMMARIES,
} from '../task-stamps.js';

const AGENT = 'agent-primary';
const TURN = 6559;
const db = (): Database.Database => mockDb.current!;

function seedConversation(id: string, channel: string): void {
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, ?, 'owner')`).run(id, AGENT, channel);
}

/** The owner's ask on `conv`, and the turn that served it. */
function seedAskTurn(messageId: string, conv: string): void {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES (?, ?, 'user', 'make the folder and tell me', 'owner', ?, ?)`,
  ).run(messageId, AGENT, conv, Date.now() - 60_000);
  openAsk({ agentId: AGENT, messageId, conversationId: conv, requesterId: 'owner', openedAt: Date.now() - 60_000, title: 'make the folder' });
  seedTurnRow(messageId);
}

function seedTurnRow(sourceMessageId: string | null): void {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered, source_message_id)
     VALUES (?, ?, 'user', 'conv', datetime('now'), datetime('now'), 'answered', 1, ?)`,
  ).run(AGENT, TURN, sourceMessageId);
}

function seedReplyDelivery(id: string, channel: string, conv: string): void {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', 'Done: the folder holds hello.txt.', 'owner', ?, ?, ?)`,
  ).run(`m-${id}`, AGENT, conv, TURN, Date.now());
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', datetime('now'))`,
  ).run(id, AGENT, TURN, channel, channel, conv, `m-${id}`);
}

const stampLine = (summary: string): string => renderTaskStamps({
  last_activity_turn: TURN, last_activity_at: '2026-11-04 13:01:05', last_activity_outcome: 'answered',
  last_answered_turn: TURN, last_answered_at: '2026-11-04 13:01:05', last_delivery_summary: summary,
});

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Primary', 'idle', '1970-01-01')`).run(AGENT);
});

describe('OR-FIELD3(b): an answer on the channel that asked is a handover', () => {
  it('THE FIELD SHAPE: a dashboard answer to a dashboard ask is tangible and the stamp says CLOSE if done', () => {
    seedConversation('conv-dash', 'dashboard');
    seedAskTurn('msg-ask', 'conv-dash');
    seedReplyDelivery('b2b026a7', 'dashboard', 'conv-dash');
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(summary).toBe('via dashboard, answering the ask');
    expect(ASK_THREAD_DELIVERY_SUMMARIES).toContain(summary);
    expect(isTangibleDeliverySummary(summary)).toBe(true);
    expect(stampLine(summary)).toContain('CLOSE if done');
  });

  it('a voice answer to a voice ask is tangible the same way', () => {
    seedConversation('conv-voice', 'voice');
    seedAskTurn('msg-ask-v', 'conv-voice');
    seedReplyDelivery('d-voice', 'voice', 'conv-voice');
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(summary).toBe('via voice, answering the ask');
    expect(isTangibleDeliverySummary(summary)).toBe(true);
  });
});

describe('what stays non-tangible, and is still named truthfully', () => {
  it('a dashboard line on a turn that answered no ask (an engine wake) is named, not a handover', () => {
    seedConversation('conv-dash', 'dashboard');
    seedTurnRow(null);
    seedReplyDelivery('d-wake', 'dashboard', 'conv-dash');
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(summary).not.toBe('');
    expect(summary).toContain('dashboard');
    expect(NON_TANGIBLE_DELIVERY_SUMMARIES).toContain(summary);
    expect(isTangibleDeliverySummary(summary)).toBe(false);
    expect(stampLine(summary)).not.toContain('CLOSE if done');
  });

  it('a dashboard line to a DIFFERENT conversation than the ask\'s (an iMessage ask) is not that ask\'s handover', () => {
    seedConversation('conv-im', 'imessage');
    seedConversation('conv-dash', 'dashboard');
    seedAskTurn('msg-ask-im', 'conv-im');
    seedReplyDelivery('d-elsewhere', 'dashboard', 'conv-dash');
    const summary = composeTurnDeliverySummary(AGENT, TURN);
    expect(isTangibleDeliverySummary(summary)).toBe(false);
  });

  it('OLD DATA: a stored "via dashboard" stamp (written before this build, any dashboard bubble) is not re-read as a handover', () => {
    expect(isTangibleDeliverySummary('via dashboard')).toBe(false);
    expect(isTangibleDeliverySummary('via voice')).toBe(false);
  });

  it('CONTROL: an out-of-band channel is still tangible, and nothing is still nothing', () => {
    expect(isTangibleDeliverySummary('via imessage')).toBe(true);
    expect(isTangibleDeliverySummary(null)).toBe(false);
    expect(isTangibleDeliverySummary('')).toBe(false);
  });
});
