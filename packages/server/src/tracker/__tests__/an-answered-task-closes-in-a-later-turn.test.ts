// v3.5 field fix 3, ranked fix #1 (G7 close floor) and #2 (the refusal states facts).
//
// THE FIELD SHAPE (diagnosis Problem 3): turn 6559 did a four-step project and answered the owner
// on the dashboard. The ask closed on delivery b2b026a7 and the engine stamped all four steps
// "answered". The primary then tried to close steps 2-4 in LATER turns (A2A turns from the PM),
// and `deliveryForTaskClose` only looked at deliveries made in the CURRENT turn, so every close
// was refused with "needs a delivery to point at", and the agent was coached to send the result
// again. The engine held the receipt the whole time.
//
// The T11 ack exclusion still holds: an ask that only got an acknowledgement has no
// `result_delivery_id`, so an earlier-turn ack is never a close receipt.

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
import {
  deliveryForTaskClose, openTrackerProject, openTrackerTask, stampTicket,
} from '../../work/tracker-store.js';
import { openAsk, claimAsk, stampClaimingTurn, askIdForMessage } from '../../work/store.js';
import { trackerCompleteStep } from '../tools.js';

const AGENT = 'agent-primary';
const CONV = 'conv-owner';
const ASK_TURN = 6559;
const CLOSE = { result: 'made the folder and the file', evidence: [{ kind: 'claim', claim: 'mkdir and echo ran, ls shows the file' }] };

const db = (): Database.Database => mockDb.current!;

function seedTurn(n: number, kind = 'user'): void {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, ?, 'conv', datetime('now'), datetime('now'), 'answered', 1)`,
  ).run(AGENT, n, kind);
}

function seedOwnerMessage(id: string): void {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at)
     VALUES (?, ?, 'user', 'make a folder, a file, list it and tell me', 'owner', ?, ?)`,
  ).run(id, AGENT, CONV, Date.now() - 60_000);
}

function seedReply(id: string, content: string, turn: number): void {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, ?, ?)`,
  ).run(id, AGENT, content, CONV, turn, Date.now());
}

function seedDelivery(id: string, turn: number, messageId: string): void {
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now', '+5 seconds'))`,
  ).run(id, AGENT, turn, CONV, messageId);
}

/** The owner's ask, claimed on turn 6559. */
function seedAsk(messageId: string): string {
  seedOwnerMessage(messageId);
  openAsk({
    agentId: AGENT, messageId, conversationId: CONV, requesterId: 'owner',
    openedAt: Date.now() - 60_000, title: 'make a folder and a file',
  });
  const askId = askIdForMessage(messageId);
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, ASK_TURN);
  return askId;
}

/** The ask settles on the answer, the way `compile_resolved` records it. */
function settleAsk(askId: string, messageId: string, deliveryId: string, turn: number): void {
  db().prepare(`UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = ? WHERE id = ?`)
    .run(Date.now(), deliveryId, askId);
  db().prepare('UPDATE messages SET served_by_turn = ? WHERE id = ?').run(turn, messageId);
}

function seedSteps(sourceMessageId: string | null): string[] {
  const origin = { kind: 'agent' as const, sourceMessageId, turn: null, convKey: null };
  const project = openTrackerProject({ title: 'folder and file', createdBy: AGENT, origin });
  return [1, 2, 3, 4].map((n) => openTrackerTask({
    projectId: project, title: `step ${n}`, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    stepNumber: n, totalSteps: 4, origin,
  } as Parameters<typeof openTrackerTask>[0]));
}

const closeRequest = (id: string): Record<string, unknown> | undefined => {
  const r = db().prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'validation_requested' ORDER BY id DESC LIMIT 1`,
  ).get(id) as { payload: string } | undefined;
  return r ? JSON.parse(r.payload) as Record<string, unknown> : undefined;
};

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Primary', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('fix #1: a task whose ask has a recorded answer closes on it in a later turn', () => {
  it('THE FIELD SHAPE: answered on the dashboard in turn N, complete_step in an A2A turn N+1 files Key 1 on that answer', () => {
    const askId = seedAsk('msg-ask');
    seedTurn(ASK_TURN);
    const steps = seedSteps('msg-ask');
    seedReply('msg-answer', 'Done: the folder holds hello.txt, and ls lists it.', ASK_TURN);
    seedDelivery('b2b026a7', ASK_TURN, 'msg-answer');
    settleAsk(askId, 'msg-ask', 'b2b026a7', ASK_TURN);
    // the PM's A2A turn: no new delivery to the owner exists in it
    seedTurn(ASK_TURN + 1, 'a2a');

    expect(deliveryForTaskClose(steps[1])).toBe('b2b026a7');
    const out = trackerCompleteStep(AGENT, { task_id: steps[1], ...CLOSE });
    expect(out, out).toMatch(/^\[FILED\]/);
    expect(out).not.toContain('needs a delivery');
    expect(closeRequest(steps[1])?.result_delivery_id).toBe('b2b026a7');
  });

  it('a step with no ask edge of its own closes on its PROJECT\'s ask receipt', () => {
    const askId = seedAsk('msg-ask-p');
    seedTurn(ASK_TURN);
    const origin = { kind: 'agent' as const, sourceMessageId: 'msg-ask-p', turn: null, convKey: null };
    const project = openTrackerProject({ title: 'plan', createdBy: AGENT, origin });
    const step = openTrackerTask({
      projectId: project, title: 'step 2', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    db().prepare('UPDATE work SET source_message_id = NULL WHERE id = ?').run(step);
    seedReply('msg-answer-p', 'All four steps are done.', ASK_TURN);
    seedDelivery('d-proj', ASK_TURN, 'msg-answer-p');
    settleAsk(askId, 'msg-ask-p', 'd-proj', ASK_TURN);
    seedTurn(ASK_TURN + 1, 'a2a');
    expect(deliveryForTaskClose(step)).toBe('d-proj');
  });

  it('the ANSWERED STAMP: a task stamped answered on the turn that settled an ask closes on that ask\'s receipt', () => {
    const askId = seedAsk('msg-ask-s');
    seedTurn(ASK_TURN);
    const step = openTrackerTask({
      title: 'tidy the folder', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    db().prepare('UPDATE work SET source_message_id = NULL WHERE id = ?').run(step);
    seedReply('msg-answer-s', 'Tidied: two files moved.', ASK_TURN);
    seedDelivery('d-stamp', ASK_TURN, 'msg-answer-s');
    settleAsk(askId, 'msg-ask-s', 'd-stamp', ASK_TURN);
    stampTicket(step, {
      activityTurn: ASK_TURN, activityAt: Date.now(), activityOutcome: 'answered',
      answeredTurn: ASK_TURN, answeredAt: Date.now(), deliverySummary: 'via dashboard',
    });
    seedTurn(ASK_TURN + 1, 'a2a');
    expect(deliveryForTaskClose(step)).toBe('d-stamp');
  });

  it('A DELIVERY IN THE CLOSE\'S OWN TURN STILL WINS (the ordinary "answered then closed" shape)', () => {
    const askId = seedAsk('msg-ask-c');
    seedTurn(ASK_TURN);
    const steps = seedSteps('msg-ask-c');
    seedReply('msg-answer-c', 'first answer', ASK_TURN);
    seedDelivery('d-old', ASK_TURN, 'msg-answer-c');
    settleAsk(askId, 'msg-ask-c', 'd-old', ASK_TURN);
    seedTurn(ASK_TURN + 3);
    seedReply('msg-new', 'the follow-up result', ASK_TURN + 3);
    seedDelivery('d-new', ASK_TURN + 3, 'msg-new');
    expect(deliveryForTaskClose(steps[2])).toBe('d-new');
  });

  it('NEGATIVE CONTROL (T11): an ask that only got an ack has no receipt, and the later close still refuses', () => {
    seedAsk('msg-ask-ack');
    seedTurn(ASK_TURN);
    const steps = seedSteps('msg-ask-ack');
    seedReply('msg-ack', "On it, I'll get the folder made.", ASK_TURN);
    seedDelivery('a133f5e1', ASK_TURN, 'msg-ack');
    seedTurn(ASK_TURN + 1, 'a2a');

    expect(deliveryForTaskClose(steps[1])).toBeNull();
    const out = trackerCompleteStep(AGENT, { task_id: steps[1], ...CLOSE });
    expect(out).toMatch(/^Error:/);
    expect(closeRequest(steps[1])).toBeUndefined();
  });
});

describe('fix #2: the G7 refusal states facts, never coaching', () => {
  it('with nothing on record it says nothing has reached the owner yet, and gives no "send it first" order', () => {
    seedAsk('msg-ask-none');
    seedTurn(ASK_TURN);
    const steps = seedSteps('msg-ask-none');
    seedTurn(ASK_TURN + 1, 'a2a');
    const out = trackerCompleteStep(AGENT, { task_id: steps[0], ...CLOSE });
    expect(out).toMatch(/nothing has reached the owner for this task yet/i);
    expect(out).not.toMatch(/send the result first/i);
    expect(out).not.toMatch(/hand it back on the thread/i);
    expect(out).not.toMatch(/then set status/i);
  });

  it('with an answer on record it says so and names the delivery id', () => {
    seedAsk('msg-ask-rec');
    const steps = seedSteps('msg-ask-rec');
    // the turn that answered this task's own ask, with its answer delivered, and nothing since
    db().prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered, answer_message_id, source_message_id)
       VALUES (?, ?, 'user', 'conv', datetime('now', '+1 seconds'), datetime('now', '+2 seconds'), 'answered', 1, 'msg-rec', 'msg-ask-rec')`,
    ).run(AGENT, ASK_TURN);
    seedReply('msg-rec', 'The folder is made and holds hello.txt.', ASK_TURN);
    seedDelivery('d0c0ffee11', ASK_TURN, 'msg-rec');
    db().prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered)
       VALUES (?, ?, 'a2a', 'conv', datetime('now', '+3 seconds'), datetime('now', '+4 seconds'), 'answered', 0)`,
    ).run(AGENT, ASK_TURN + 1);
    const out = trackerCompleteStep(AGENT, { task_id: steps[0], ...CLOSE });
    expect(out).toMatch(/^Error:/);
    expect(out).toContain('An answer for this task is on record');
    expect(out).toContain('d0c0ffee');
    expect(out).not.toMatch(/nothing has reached/i);
    expect(out).not.toMatch(/send the result first/i);
  });
});
