// v3.5 field fix 3, review round 3: THE STRIKE-0 BOUNDARY CLOSE CLOSES ON A COMPLETION, NEVER AN ACK.
//
// Strike-0 (`finalize-record.ts`) closes, at the turn's end, the tasks that turn opened when the
// turn delivered their work. It used to read the TURN's delivery summary: any out-of-band line
// ("via imessage") counted, so a turn whose only line was an iMessage "On it" engine-closed the
// tasks it had just opened, and a real dashboard answer never did (owner ruling OR-FIELD3(b)).
// Owner law: an ack never closes a task; the start ack AND the completion are both required.
// Now each task is asked of its own record (`taskWorkOnRecord`): a delivered file, or THE task's
// answer under the ack-order rule.
//
// Driven through the real `finalizeTurnRecord` on a real migrated database: the real settlement
// closes the ask on the turn's answer line, then strike-0 runs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-strike0', 'dojo.db'),
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { finalizeTurnRecord } from '../finalize-record.js';
import { initState, type AgentTurnState } from '../../../state.js';
import type { TeardownContext } from '../index.js';
import { openAsk, claimAsk, stampClaimingTurn, askIdForMessage } from '../../../../../work/store.js';
import { openTrackerTask } from '../../../../../work/tracker-store.js';

const AGENT = 'agent-strike0';
const TURN = 812;
const db = (): Database.Database => mockDb.current!;
let clock = 0;

function ctxFor(conv: string, channel: string, answerRowId: string | null): TeardownContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, root: undefined, servedWork: undefined, convKey: `${channel}:owner`,
      startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
      engineStartAckDeliveredThisTurn: false, startAckSteersInjected: 0,
      anyToolStartedThisTurn: true, toolPhaseEndedBySpinBrake: false,
      turnInjectedTechniqueId: null, lastAssembledAtIso: null,
    } as never,
    turnNumber: TURN, db: db(),
    chosenConvKey: `${channel}:owner`, chosenConversationId: conv, lastAssembledAtIso: null,
    terminalAnswerRowId: answerRowId, triggerWorkId: null,
    toolPhaseEndedBySpinBrake: false, toolLoopCapReached: false, turnInjectedTechniqueId: null,
    counterparty: { kind: 'user', name: 'the owner', relation: 'owner', channel, senderId: 'owner', senderIsAgent: false } as never,
    isA2ATurn: false, isEngineTurn: false,
    turnStartedAt: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '),
    inboundChannel: channel, inboundContext: null,
    reArmIfStrandedNoAnswer: vi.fn(), stopStatusHeartbeat: vi.fn(),
  } as unknown as TeardownContext;
}

const freshState = (): AgentTurnState => initState({
  agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'model-1',
  turnNumber: TURN, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
  lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: 'dashboard',
  inboundContext: null, pendingTechniqueAck: null,
});

/** The owner asks on `channel`; the turn claims the ask and opens two tasks for it. */
function askAndTasks(channel: string): { conv: string; tasks: string[] } {
  const conv = `conv-${channel}`;
  db().prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES (?, ?, ?, ?, 'owner')`)
    .run(conv, AGENT, channel, channel);
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES ('msg-ask', ?, 'user', 'book the table and send me the confirmation', 'owner', ?, ?)`,
  ).run(AGENT, conv, Date.now() - 50_000);
  openAsk({ agentId: AGENT, messageId: 'msg-ask', conversationId: conv, requesterId: 'owner', openedAt: Date.now() - 50_000, title: 'book the table' });
  claimAsk(askIdForMessage('msg-ask'), AGENT);
  stampClaimingTurn(askIdForMessage('msg-ask'), TURN);
  const tasks = ['find a table', 'book it'].map((title) => openTrackerTask({
    title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: 'msg-ask', turn: TURN, convKey: `${channel}:owner` },
  }));
  return { conv, tasks };
}

/** A model line the turn delivered on `channel`, after the tasks opened. */
function line(id: string, channel: string, conv: string, content: string): string {
  clock += 2;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, display_kind, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, ?, 'agent-text', ?)`,
  ).run(`m-${id}`, AGENT, content, conv, TURN, Date.now() + clock * 1000);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', datetime('now', ?))`,
  ).run(id, AGENT, TURN, channel === 'dashboard' ? 'dashboard' : 'imessage_send', channel, conv, `m-${id}`, `+${clock} seconds`);
  return `m-${id}`;
}

function openTurn(): void {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, source_message_id, conv_key, answered, effectful_calls, started_at)
     VALUES (?, ?, 'user', 'conv', 'msg-ask', 'owner', 0, 1, datetime('now','-60 seconds'))`,
  ).run(AGENT, TURN);
}

const states = (ids: string[]): string[] =>
  ids.map((id) => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state);

beforeEach(() => {
  clock = 0;
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'A', 'idle')").run(AGENT);
  openTurn();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('(a) a turn whose only line is an ack does NOT engine-close the tasks it opened', () => {
  for (const channel of ['imessage', 'dashboard']) {
    it(`${channel}: "On it" is the answer key and the ask settles on it; both tasks stay open`, async () => {
      const { conv, tasks } = askAndTasks(channel);
      const ack = line('d-onit', channel, conv, "On it, I've opened two tasks and will book the table.");
      await finalizeTurnRecord(freshState(), ctxFor(conv, channel, ack));
      expect(states(tasks)).toEqual(['claimed', 'claimed']);
    });
  }
});

describe('(b) a turn that delivers the completion after its ack closes them', () => {
  for (const channel of ['imessage', 'dashboard']) {
    it(`${channel}: ack, then the booking confirmation; both tasks close on the confirmation`, async () => {
      const { conv, tasks } = askAndTasks(channel);
      line('d-ack', channel, conv, 'On it.');
      const answer = line('d-booked', channel, conv, 'Booked: a table for four on Friday at 7pm, confirmation 4471.');
      await finalizeTurnRecord(freshState(), ctxFor(conv, channel, answer));
      expect(states(tasks)).toEqual(['done', 'done']);
      const rd = tasks.map((t) => (db().prepare('SELECT result_delivery_id AS r FROM work WHERE id = ?').get(t) as { r: string }).r);
      expect(rd).toEqual(['d-booked', 'd-booked']);
    });
  }
});

describe('(c) a turn that delivers a file closes them', () => {
  it('a delivered file artifact (a work product is never an ack) closes both tasks', async () => {
    const { conv, tasks } = askAndTasks('dashboard');
    const only = line('d-file-line', 'dashboard', conv, 'Here is the confirmation.');
    db().prepare(
      `INSERT INTO turn_artifacts (agent_id, turn_number, kind, path, delivered_at) VALUES (?, ?, 'file', '/tmp/confirmation.pdf', datetime('now'))`,
    ).run(AGENT, TURN);
    await finalizeTurnRecord(freshState(), ctxFor(conv, 'dashboard', only));
    expect(states(tasks)).toEqual(['done', 'done']);
  });
});
