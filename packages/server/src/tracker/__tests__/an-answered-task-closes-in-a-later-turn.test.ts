// A task answered in turn N closes on that answer in a later turn.
//
// THE FIELD SHAPE: a turn did a four-step project and answered the owner on the dashboard; the ask
// closed on that answer. The primary then tried to close steps 2-4 in LATER turns (A2A turns from the
// PM), and every close was refused "needs a delivery". The engine held the receipt the whole time.
//
// Owner law: an ack never closes a task. The close points at the newest message to the asker that the
// one proof check accepts (`work/done/proof.ts:proofDelivery`): never the engine's marked start ack,
// never a bare status claim ("Done."), never a line from before the task was opened. A text line is the
// worker's to file on, for the PM; the engine itself never reads one as delivered work.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-later-turn-close', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerProject, openTrackerTask, stampTicket } from '../../work/tracker-store.js';
import { openAsk, claimAsk, stampClaimingTurn, askIdForMessage } from '../../work/store.js';
import { settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { engineProofLine, proofDelivery } from '../../work/done/proof.js';
import { trackerGetStatus, trackerUpdateStatus } from '../tools.js';

const AGENT = 'agent-primary';
const CONV = 'conv-owner';
const ASK_TURN = 6559;
const CLOSE = { result: 'made the folder and the file', evidence: [{ kind: 'claim', claim: 'mkdir and echo ran, ls shows the file' }] };

const db = (): Database.Database => mockDb.current!;
let clock = 0;

function seedOwnerAsk(messageId: string): string {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES (?, ?, 'user', 'make a folder, a file, list it and tell me', 'owner', ?, ?)`,
  ).run(messageId, AGENT, CONV, Date.now() - 60_000);
  openAsk({
    agentId: AGENT, messageId, conversationId: CONV, requesterId: 'owner',
    openedAt: Date.now() - 60_000, title: 'make a folder and a file',
  });
  const askId = askIdForMessage(messageId);
  claimAsk(askId, AGENT);
  return askId;
}

/** A model line delivered on the dashboard in `turn`, `clock` seconds after now, in a turn serving `askMessage`. */
function line(id: string, content: string, turn: number, askMessage: string | null = null): string {
  clock += 2;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, display_kind, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, ?, 'agent-text', ?)`,
  ).run(`m-${id}`, AGENT, content, CONV, turn, Date.now() + clock * 1000);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at, root_kind, root_id)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now', ?), ?, ?)`,
  ).run(id, AGENT, turn, CONV, `m-${id}`, `+${clock} seconds`, askMessage ? 'ask' : null, askMessage);
  return `m-${id}`;
}

/** Turn N ends with `answerMessageId` as its answer key, and the REAL settlement runs. */
function endTurnAndSettle(askId: string, sourceMessageId: string, answerMessageId: string): void {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered, answer_message_id, source_message_id)
     VALUES (?, ?, 'user', 'conv', datetime('now', '-30 seconds'), datetime('now', '+60 seconds'), 'answered', 1, ?, ?)`,
  ).run(AGENT, ASK_TURN, answerMessageId, sourceMessageId);
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: ASK_TURN });
}

function laterA2ATurn(): void {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'a2a', 'conv', datetime('now', '+90 seconds'), NULL, NULL, 0)`,
  ).run(AGENT, ASK_TURN + 1);
}

function seedSteps(sourceMessageId: string): string[] {
  const origin = { kind: 'agent' as const, sourceMessageId, turn: null, convKey: null };
  const project = openTrackerProject({ title: 'folder and file', createdBy: AGENT, origin });
  return [1, 2, 3, 4].map((n) => openTrackerTask({
    projectId: project, title: `step ${n}`, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    stepNumber: n, totalSteps: 4, origin,
  }));
}

function stampAnswered(taskId: string): void {
  stampTicket(taskId, {
    activityTurn: ASK_TURN, activityAt: Date.now(), activityOutcome: 'answered',
    answeredTurn: ASK_TURN, answeredAt: Date.now(), deliverySummary: 'via dashboard',
  });
}

const askRow = (askId: string): { state: string; result_delivery_id: string | null } =>
  db().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(askId) as { state: string; result_delivery_id: string | null };
const closeRequest = (id: string): Record<string, unknown> | undefined => {
  const r = db().prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'validation_requested' ORDER BY id DESC LIMIT 1`,
  ).get(id) as { payload: string } | undefined;
  return r ? JSON.parse(r.payload) as Record<string, unknown> : undefined;
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
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('a task answered in turn N closes on that answer in a later turn', () => {


  it('a task with no ask edge is not tied to the answer of a request it was never linked to', () => {
    const askId = seedOwnerAsk('msg-ask-st');
    stampClaimingTurn(askId, ASK_TURN);
    const t = openTrackerTask({
      title: 'tidy the folder', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    db().prepare('UPDATE work SET source_message_id = NULL WHERE id = ?').run(t);
    line('d-ack-st', 'On it.', ASK_TURN);
    endTurnAndSettle(askId, 'msg-ask-st', line('d-ans-st', 'Tidied: two files moved.', ASK_TURN));
    db().prepare('UPDATE messages SET served_by_turn = ? WHERE id = ?').run(ASK_TURN, 'msg-ask-st');
    stampAnswered(t);
    expect(proofDelivery(t)).toBeNull();
  });
});

const markAck = (deliveryId: string): void => {
  // The engine's own marking of its start line (`terminal-text.ts`).
  db().prepare("UPDATE messages SET origin_intent = 'engine_start_ack' WHERE id = ?").run(`m-${deliveryId}`);
};


describe('every close door reads the one proof check', () => {
  it('a bare "Done." to the owner is a status claim, never the task\'s delivery', () => {
    const askId = seedOwnerAsk('msg-ask-h2');
    stampClaimingTurn(askId, ASK_TURN);
    const steps = seedSteps('msg-ask-h2');
    line('d-ack-h2', 'On it.', ASK_TURN);
    endTurnAndSettle(askId, 'msg-ask-h2', line('d-ans-h2', 'Done.', ASK_TURN));
    laterA2ATurn();
    expect(proofDelivery(steps[0])).toBeNull();
  });

  it('a delivery in the close\'s own turn resolves', () => {
    seedOwnerAsk('msg-ask-own');
    const steps = seedSteps('msg-ask-own');
    laterA2ATurn();
    line('d-now', 'the follow-up result', ASK_TURN + 1, 'msg-ask-own');
    expect(proofDelivery(steps[2])).toBe('d-now');
  });
});

