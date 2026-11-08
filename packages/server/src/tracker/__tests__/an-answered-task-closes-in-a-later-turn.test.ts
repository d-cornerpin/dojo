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
import { trackerCompleteStep, trackerGetStatus, trackerUpdateStatus } from '../tools.js';

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

/** A model line delivered on the dashboard in `turn`, `clock` seconds after now. */
function line(id: string, content: string, turn: number): string {
  clock += 2;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, turn_number, display_kind, created_at)
     VALUES (?, ?, 'assistant', ?, 'owner', ?, ?, 'agent-text', ?)`,
  ).run(`m-${id}`, AGENT, content, CONV, turn, Date.now() + clock * 1000);
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now', ?))`,
  ).run(id, AGENT, turn, CONV, `m-${id}`, `+${clock} seconds`);
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
  it('THE FIELD SHAPE: ack, work, answer on the dashboard in turn N; complete_step in an A2A turn N+1 files Key 1 on the answer', () => {
    const askId = seedOwnerAsk('msg-ask');
    stampClaimingTurn(askId, ASK_TURN);
    const steps = seedSteps('msg-ask');
    line('d-ack', 'On it, setting up the folder now.', ASK_TURN);
    const answer = line('b2b026a7', 'Done: the folder holds hello.txt, and ls lists it.', ASK_TURN);
    endTurnAndSettle(askId, 'msg-ask', answer);
    expect(askRow(askId)).toEqual({ state: 'done', result_delivery_id: 'b2b026a7' });
    laterA2ATurn();

    const out = trackerCompleteStep(AGENT, { task_id: steps[1], ...CLOSE });
    expect(out, out).toMatch(/^\[FILED\]/);
    expect(closeRequest(steps[1])?.result_delivery_id).toBe('b2b026a7');
    // The request the PM reads names the same delivery the close filed on.
    expect(proofDelivery(steps[1])).toBe('b2b026a7');
  });

  it('work_update status="complete" (the other worker door) files on the same answer', () => {
    const askId = seedOwnerAsk('msg-ask-s');
    stampClaimingTurn(askId, ASK_TURN);
    const steps = seedSteps('msg-ask-s');
    line('d-ack-s', 'On it.', ASK_TURN);
    endTurnAndSettle(askId, 'msg-ask-s', line('d-ans-s', 'All four steps are done.', ASK_TURN));
    laterA2ATurn();
    const out = trackerUpdateStatus(AGENT, { taskId: steps[2], status: 'complete', ...CLOSE });
    expect(out, out).toMatch(/\[FILED\]/);
    expect(closeRequest(steps[2])?.result_delivery_id).toBe('d-ans-s');
  });

  it('the ANSWERED STAMP edge: a task with no ask edge, stamped answered on the turn that settled the ask', () => {
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
    expect(proofDelivery(t)).toBe('d-ans-st');
  });
});

const markAck = (deliveryId: string): void => {
  // The engine's own marking of its start line (`terminal-text.ts`).
  db().prepare("UPDATE messages SET origin_intent = 'engine_start_ack' WHERE id = ?").run(`m-${deliveryId}`);
};

describe('an ack never closes a task; a text line is the worker\'s to file on, for the PM', () => {
  it('NEGATIVE CONTROL, driven: the MARKED start ack is the turn\'s only line; no receipt, the later close is refused, nothing reads as delivered', () => {
    const askId = seedOwnerAsk('msg-ask-ack');
    stampClaimingTurn(askId, ASK_TURN);
    const steps = seedSteps('msg-ask-ack');
    const ack = line('d-onit', "On it, I've opened a project with 4 steps and will work through them.", ASK_TURN);
    markAck('d-onit');
    endTurnAndSettle(askId, 'msg-ask-ack', ack);
    expect(askRow(askId).result_delivery_id, 'the settlement never takes the marked ack as a receipt').toBeNull();
    for (const s of steps) stampAnswered(s);
    laterA2ATurn();

    expect(proofDelivery(steps[1])).toBeNull();
    expect(engineProofLine(steps[1])).toBeNull();
    const out = trackerCompleteStep(AGENT, { task_id: steps[1], ...CLOSE });
    expect(out).toMatch(/^Error:/);
    expect(out).toMatch(/No completion for this task has reached the owner yet/);
    expect(closeRequest(steps[1])).toBeUndefined();
    const view = trackerGetStatus(AGENT, { taskId: steps[1] });
    expect(view).not.toContain('ALREADY DELIVERED');
    expect(view).not.toContain('CLOSE if done');
  });

  it('THE PROBE (R1): ack, then a PROGRESS line the ask settles on; the worker\'s close FILES for the PM and does not close by itself', () => {
    const askId = seedOwnerAsk('msg-ask-pr');
    stampClaimingTurn(askId, ASK_TURN);
    const steps = seedSteps('msg-ask-pr');
    line('d-ack-pr', 'On it.', ASK_TURN);
    markAck('d-ack-pr');
    endTurnAndSettle(askId, 'msg-ask-pr', line('d-progress', 'Found three tables that fit; I will book one next and send you the confirmation.', ASK_TURN));
    expect(askRow(askId).result_delivery_id).toBe('d-progress');
    laterA2ATurn();
    // The engine never reads a text line as delivered work.
    expect(engineProofLine(steps[1])).toBeNull();
    expect(trackerGetStatus(AGENT, { taskId: steps[1] })).not.toContain('ALREADY DELIVERED');
    // The worker's own close files Key 1 on the line the owner read; the PM judges it.
    const out = trackerCompleteStep(AGENT, { task_id: steps[1], ...CLOSE });
    expect(out).toMatch(/^\[FILED\]/);
    expect(closeRequest(steps[1])?.result_delivery_id).toBe('d-progress');
    expect((db().prepare('SELECT state FROM work WHERE id = ?').get(steps[1]) as { state: string }).state).toBe('claimed');
  });

  it('R2: "On it." delivered BEFORE work_open, then the real answer; the worker\'s close is accepted and G7 never says nothing reached the owner', () => {
    const askId = seedOwnerAsk('msg-ask-r2');
    stampClaimingTurn(askId, ASK_TURN);
    line('d-ack-r2', 'On it.', ASK_TURN);
    markAck('d-ack-r2');
    db().prepare('UPDATE deliveries SET created_at = datetime(\'now\', \'-2 seconds\') WHERE id = ?').run('d-ack-r2');
    const steps = seedSteps('msg-ask-r2');
    endTurnAndSettle(askId, 'msg-ask-r2', line('d-booked-r2', 'Booked: a table for four on Friday at 7pm, confirmation 4471.', ASK_TURN));
    laterA2ATurn();
    expect(proofDelivery(steps[0])).toBe('d-booked-r2');
    const out = trackerCompleteStep(AGENT, { task_id: steps[0], ...CLOSE });
    expect(out, out).toMatch(/^\[FILED\]/);
    expect(out).not.toMatch(/No completion|nothing has reached/i);
    expect(closeRequest(steps[0])?.result_delivery_id).toBe('d-booked-r2');
  });
});

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
    line('d-now', 'the follow-up result', ASK_TURN + 1);
    expect(proofDelivery(steps[2])).toBe('d-now');
  });
});

describe('the G7 refusal states facts, never coaching', () => {
  it('with nothing on record: no completion has reached the owner, and no "send it first" order', () => {
    const askId = seedOwnerAsk('msg-ask-none');
    stampClaimingTurn(askId, ASK_TURN);
    const steps = seedSteps('msg-ask-none');
    laterA2ATurn();
    const out = trackerCompleteStep(AGENT, { task_id: steps[0], ...CLOSE });
    expect(out).toMatch(/No completion for this task has reached the owner yet/);
    expect(out).not.toMatch(/send the result first/i);
    expect(out).not.toMatch(/hand it back on the thread/i);
    expect(out).not.toMatch(/then set status/i);
  });
});
