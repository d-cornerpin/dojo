// PHASE-2 T6 Step 1 — the obligation machinery, rekeyed onto the answered edge.
//
// Seven mechanisms in this tree each had their own answer to "has the person heard from
// us": a prose classifier, a turn-local boolean, a task-status scan, an in-memory latch, a
// message column, a `conv_key IS NULL` predicate and a `swept_at` stamp. Research 07's
// requirements table (rows 1a–2g) asks for ONE edge that serves every read, and this file
// is that edge's acceptance, written BEFORE the readers were re-pointed at it.
//
// Every test below names the requirement row it holds, and every one of them has a
// NEGATIVE control of the same shape — a reader that returns "answered" for everything is
// not a reader, it is a rubber stamp.
//
//   1a  did THIS turn already put the result in front of the person?   (receipt, not prose)
//   1b  did work close WITHOUT a delivery?                             (a join, not a scan)
//   1c  what work is still claimed by this agent at turn end?          (with identity)
//   1g  the delivery reference set only on a genuine user-facing send
//   2b  `abandoned` reachable from >= 3 causes, single-transition once-guard, re-openable
//   2c  the retry policy, carried VERBATIM
//   2d  the answered edge serves BOTH the answer-receipt and the closeout-owe read
//
// Plus the disposition the plan clause and the P2 drive boundary had to be reconciled on
// (PHASE-2 progress.md, T1 adjudication #2): a turn that SPOKE to the owner and left its
// work in the drive state hands the ball over — the work reconciles to `paused`, keyed on
// the ENGINE's own recorded turn outcome, never on the shape of the model's prose — and
// the owner's next message REOPENS it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-answered-edge-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import {
  answerReceiptForAsk,
  pauseDriveWorkWaitingOnOwner,
  stillClaimedWork,
  terminalDeliveryForTurn,
  turnDeliveredToPerson,
  turnOutcome,
} from '../answered-edge.js';
import {
  ENGINE_EVENT_BACKOFF_MINUTES,
  ENGINE_EVENT_EXPIRY_HOURS,
  ENGINE_EVENT_MAX_ATTEMPTS,
} from '../counterparty.js';
import { abandonUnservableAsks, openAsk, transition } from '../../../work/store.js';
import { insertMessage } from '../../../memory/message-store.js';
import { listTaskLog } from '../../../tracker/task-log.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { FX, FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const CONV = 'conv-1';

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
}

function seedTurn(turnNumber: number, over: Record<string, unknown> = {}): void {
  const row = {
    agent_id: AGENT, turn_number: turnNumber, kind: 'user', subject_kind: 'conv',
    subject_id: CONV, root_kind: 'ask', root_id: null, source_message_id: null,
    conv_key: 'owner', started_at: new Date().toISOString(), ended_at: null,
    exit_reason: null, answered: 0, effectful_calls: 0, answer_message_id: null, lane: null,
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(
    `INSERT INTO turns (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

/** A delivery row, written the way the doors write it (PHASE-2 T5). */
function seedDelivery(id: string, over: Record<string, unknown> = {}): string {
  const row = {
    id, agent_id: AGENT, turn_number: 1, tool: 'auto-route', channel: 'dashboard',
    recipient_id: 'owner', recipient_display: null, conversation_id: CONV,
    root_kind: null, root_id: null, message_id: null, receipt_id: null,
    outcome: 'delivered', detail: null,
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(
    `INSERT INTO deliveries (${cols.join(', ')}, created_at, updated_at)
     VALUES (${cols.map((c) => '@' + c).join(', ')}, datetime('now'), datetime('now'))`,
  ).run(row);
  return id;
}

/** A legacy tracker task in the drive state — where a task's live state STILL lives until
 *  PHASE-2 T8 moves the tracker onto the spine. */
function seedLegacyTask(id: string, over: Record<string, unknown> = {}): void {
  const { status, assigned_to: assignedTo, created_by: createdBy, project_id: projectId,
    ...rest } = over as Record<string, any>;
  seedTrackerTask(db(), {
    id, title: 'summarise the project', priority: 'normal',
    status: (status as string) ?? 'in_progress',
    agentId: (assignedTo as string) ?? AGENT, createdBy: (createdBy as string) ?? 'owner',
    projectId: (projectId as string) ?? null,
    is_paused: 0, repeat_interval: null, source_message_id: null, origin_turn: null,
    opened_at: Date.now(), updated_at: Date.now(),
    ...rest,
  });
}

function seedInbound(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    id, agent_id: AGENT, conversation_id: CONV, lane: 'owner', role: 'user',
    content: 'can you check the roof quote?', channel: 'dashboard', sender_id: 'owner',
    authorized: 1, created_at: Date.now(), provenance: 'live',
    display_kind: 'user-text', display_tier: 'user-visible',
    ...over,
  };
  const cols = Object.keys(row);
  db().prepare(
    `INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  seedAgent();
});

// ══════════════════════════════════════════════════════════════════════════════
describe('1a — "did THIS turn already put the result in front of the person" is a RECEIPT', () => {
  it('a recorded delivery on this turn and conversation says yes', () => {
    seedTurn(7);
    seedDelivery('d1', { turn_number: 7 });
    expect(turnDeliveredToPerson(AGENT, 7, CONV)).toBe(true);
  });

  it('NEGATIVE: a FAILED send is not a delivery', () => {
    seedTurn(7);
    seedDelivery('d1', { turn_number: 7, outcome: 'failed' });
    expect(turnDeliveredToPerson(AGENT, 7, CONV)).toBe(false);
  });

  it('NEGATIVE: the engine\'s own start-ack is not the answer', () => {
    seedTurn(7);
    seedDelivery('d1', { turn_number: 7, tool: 'engine-ack' });
    expect(turnDeliveredToPerson(AGENT, 7, CONV)).toBe(false);
  });

  it('NEGATIVE: a delivery from ANOTHER turn is not this turn\'s', () => {
    seedTurn(7); seedTurn(8);
    seedDelivery('d1', { turn_number: 8 });
    expect(turnDeliveredToPerson(AGENT, 7, CONV)).toBe(false);
  });

  it('NEGATIVE: a delivery into another conversation is not this one\'s answer', () => {
    seedTurn(7);
    db().prepare(
      `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
       VALUES ('conv-2', ?, 'imessage', 'imessage', '+15550000', datetime('now'))`,
    ).run(AGENT);
    seedDelivery('d1', { turn_number: 7, conversation_id: 'conv-2' });
    expect(turnDeliveredToPerson(AGENT, 7, CONV)).toBe(false);
  });

  it('the a2a lane is not a person: a peer hand-back never counts as telling the owner', () => {
    seedTurn(7);
    seedDelivery('d1', { turn_number: 7, channel: 'a2a', conversation_id: null });
    expect(turnDeliveredToPerson(AGENT, 7, null)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('1c — turn end enumerates still-claimed work, WITH the identity to escalate', () => {
  it('claimed work comes back carrying its conversation and its claiming turn', () => {
    seedInbound('m-1');
    seedTurn(4);
    const askId = openAsk({
      agentId: AGENT, messageId: 'm-1', conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'roof quote',
    });
    transition(askId, { to: 'claimed', by: 'agent', actorId: AGENT, claimedByTurn: 4, reason: 'pickup' });
    const rows = stillClaimedWork(AGENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workId: askId, conversationId: CONV, claimedByTurn: 4 });
  });

  it('NEGATIVE: settled work is not still claimed', () => {
    seedInbound('m-1');
    const askId = openAsk({
      agentId: AGENT, messageId: 'm-1', conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'roof quote',
    });
    transition(askId, { to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'gave up' });
    expect(stillClaimedWork(AGENT)).toEqual([]);
  });

  it('scoping to one turn returns only that turn\'s claims', () => {
    seedInbound('m-1'); seedInbound('m-2', { id: 'm-2' });
    seedTurn(4); seedTurn(5);
    const a = openAsk({ agentId: AGENT, messageId: 'm-1', conversationId: CONV, requesterId: 'owner', openedAt: Date.now(), title: 'a' });
    const b = openAsk({ agentId: AGENT, messageId: 'm-2', conversationId: CONV, requesterId: 'owner', openedAt: Date.now(), title: 'b' });
    transition(a, { to: 'claimed', by: 'agent', actorId: AGENT, claimedByTurn: 4, reason: 'pickup' });
    transition(b, { to: 'claimed', by: 'agent', actorId: AGENT, claimedByTurn: 5, reason: 'pickup' });
    expect(stillClaimedWork(AGENT, { turnNumber: 5 }).map((r) => r.workId)).toEqual([b]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('2d — ONE edge serves BOTH the answer-receipt read and the closeout-owe read', () => {
  it('an ask closed against a delivery reports the receipt AND stops owing', () => {
    seedInbound('m-1');
    seedTurn(3);
    const askId = openAsk({
      agentId: AGENT, messageId: 'm-1', conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'roof quote',
    });
    transition(askId, { to: 'claimed', by: 'agent', actorId: AGENT, claimedByTurn: 3, reason: 'pickup' });
    seedDelivery('d1', { turn_number: 3 });
    transition(askId, { to: 'done', by: 'agent', actorId: AGENT, resultDeliveryId: 'd1', reason: 'delivered' });

    const r = answerReceiptForAsk('m-1');
    expect(r.answered).toBe(true);
    expect(r.deliveryId).toBe('d1');
  });

  it('NEGATIVE: an ask with no delivery still OWES, and names no receipt', () => {
    seedInbound('m-1');
    openAsk({
      agentId: AGENT, messageId: 'm-1', conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'roof quote',
    });
    const r = answerReceiptForAsk('m-1');
    expect(r.answered).toBe(false);
    expect(r.deliveryId).toBeNull();
  });

  it('a row that predates the ticket falls back to the mig-113 stamp, and says so', () => {
    // No ask ticket at all — the shape of every message written before PHASE-2 T3.
    seedInbound('m-legacy', { id: 'm-legacy' });
    db().prepare('UPDATE messages SET answer_message_id = ? WHERE id = ?').run('a-1', 'm-legacy');
    const r = answerReceiptForAsk('m-legacy');
    expect(r.answered).toBe(true);
    expect(r.answerMessageId).toBe('a-1');
    expect(r.deliveryId).toBeNull();
  });

  it('NEGATIVE: an unknown message id is not silently "answered"', () => {
    expect(answerReceiptForAsk('nope').answered).toBe(false);
    expect(answerReceiptForAsk(null).answered).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('the turn-outcome reader (PHASE-2 T2 adjudication #3 — the orphan-gate debt)', () => {
  it('reads back what finalizeTurn recorded, instead of re-deriving it', () => {
    seedTurn(9, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-9', effectful_calls: 2,
    });
    expect(turnOutcome(AGENT, 9)).toMatchObject({
      exitReason: 'answered', answered: true, answerMessageId: 'a-9', effectfulCalls: 2,
    });
  });

  it('NEGATIVE: a turn that never happened has no outcome to read', () => {
    expect(turnOutcome(AGENT, 99)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The clarifying-question disposition (PHASE-2 progress.md, T1 adjudication #2).
// ══════════════════════════════════════════════════════════════════════════════
describe('a turn that SPOKE to the owner and closed nothing hands the ball over (paused)', () => {
  it('drive-state work reconciles to paused, keyed on the recorded turn outcome', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-6', effectful_calls: 0,
    });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1');

    const r = pauseDriveWorkWaitingOnOwner(AGENT, 6);
    expect(r.paused).toBe(1);
    expect(db().prepare('SELECT state, hold_kind FROM work WHERE id = ?').get('t-1')).toEqual({ state: 'claimed', hold_kind: 'paused' });
  });

  it('NEGATIVE (P2 drive boundary): a turn that ACTED is still working — nothing is paused', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-6', effectful_calls: 3,
    });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(0);
    expect((db().prepare("SELECT CASE state WHEN 'claimed' THEN 'in_progress' WHEN 'done' THEN 'complete' WHEN 'failed' THEN 'fallen' ELSE state END AS status FROM work WHERE id = ?").get('t-1') as { status: string }).status)
      .toBe('in_progress');
  });

  it('NEGATIVE: a turn that never spoke to the owner leaves the work DRIVING', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'no_reply_intended', answered: 0,
      effectful_calls: 0,
    });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(0);
  });

  it('NEGATIVE: "answered" with NO delivery on the ledger is not a receipt — nothing pauses', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-6', effectful_calls: 0,
    });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(0);
  });

  // ⚠ UX-REPAIR ROUND 4 T19 (D2) — THIS CALLER'S BEHAVIOUR DELTA, ARGUED WITH A TEST.
  // `turnDeliveredToPerson` now excludes the bubbles the platform has already declared
  // not-an-answer (`NON_ANSWERING_DISPLAY_KINDS`). This disposition's whole premise is "the
  // turn TALKED and did not ACT, so the work is now waiting on the person" — and a receipt
  // written for a TOOL-CALL CHIP is not the person having been talked to. The delta runs in
  // the owner-priority direction: one fewer false pause, i.e. the work keeps being driven
  // instead of being parked on a bubble the platform itself recorded as drafting.
  it('D2: a receipt pointing at a tool-call CHIP is not a reply — the work keeps driving', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-6', effectful_calls: 0,
    });
    insertMessage({
      id: 'chip-6', agentId: AGENT, role: 'assistant', conversationId: CONV,
      content: '[{"type":"tool_use","name":"work_update"}]', turnNumber: 6,
    });
    seedDelivery('d1', { turn_number: 6, message_id: 'chip-6' });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { conversationId: CONV }).paused).toBe(0);
  });

  it('CONTROL: the SAME turn with a receipt on the agent\'s own text still pauses', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-6', effectful_calls: 0,
    });
    insertMessage({
      id: 'text-6', agentId: AGENT, role: 'assistant', conversationId: CONV,
      content: 'Here is the roof quote.', turnNumber: 6,
    });
    seedDelivery('d1', { turn_number: 6, message_id: 'text-6' });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { conversationId: CONV }).paused).toBe(1);
  });

  it('NEGATIVE: a recurring schedule is never paused by a missed close-out', () => {
    seedTurn(6, {
      ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1,
      answer_message_id: 'a-6', effectful_calls: 0,
    });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1', { repeat_interval: 1 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(0);
  });

  it('it is keyed on the RECORD, not the prose: the reply text is never consulted', () => {
    // Two identical turns; only the recorded outcome differs. If the disposition were
    // prose-keyed these would agree, because there is no prose here at all.
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedTurn(7, { ended_at: new Date().toISOString(), exit_reason: 'brake', answered: 0, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedDelivery('d2', { turn_number: 7 });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 7).paused).toBe(0);
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(1);
  });

  it('THE SCOPE: work this turn never touched belongs to the poke ladder, not to this', () => {
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-fresh');
    seedLegacyTask('t-stale');
    db().prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(Date.now() - 2 * 3600_000, 't-stale');
    const since = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const r = pauseDriveWorkWaitingOnOwner(AGENT, 6, { touchedSince: since });
    expect(r.ids).toEqual(['t-fresh']);
    expect((db().prepare("SELECT CASE state WHEN 'claimed' THEN 'in_progress' WHEN 'done' THEN 'complete' WHEN 'failed' THEN 'fallen' ELSE state END AS status FROM work WHERE id = ?").get('t-stale') as { status: string }).status)
      .toBe('in_progress');
  });

  it('NEGATIVE: a ticket the model itself transitioned this turn is not second-guessed', () => {
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { transitionedThisTurn: true }).paused).toBe(0);
  });

  it('the pause is recorded where somebody can find it, not just applied', () => {
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1');
    pauseDriveWorkWaitingOnOwner(AGENT, 6);
    // Asserted through `listTaskLog`, the projection the owner's Activity panel reads.
    const log = listTaskLog('t-1');
    expect(log.some((e) => e.entryKind === 'hold_set' && e.toStatus === 'paused')).toBe(true);
    // The reason travels with it: an audit line with no why is the thing the spine replaced.
    expect(log.find((e) => e.toStatus === 'paused')!.reason).toBe('Waiting for a reply to its last message.');
  });
});

describe('t139 round 2 — the engine pause fires only on work linked to the request the turn answered', () => {
  // With the reopen edge deleted, a pause is undone only by the agent, so a misfire strands work.
  const answeredTurn = (): void => {
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
  };
  const stateOf = (id: string): string =>
    (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

  it('POSITIVE (requirement preserved): work linked to the served request, opened earlier, is paused', () => {
    answeredTurn();
    seedLegacyTask('t-1', { source_message_id: 'msg-x', origin_turn: 2 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { servedSourceMessageId: 'msg-x' }).paused).toBe(1);
    expect(stateOf('t-1')).toBe('claimed');
  });

  it('work linked to a DIFFERENT request is not paused (a status question never parks the job)', () => {
    answeredTurn();
    seedLegacyTask('t-1', { source_message_id: 'msg-x', origin_turn: 2 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { servedSourceMessageId: 'msg-status' }).paused).toBe(0);
    expect(stateOf('t-1')).toBe('claimed');
  });

  it('a turn that served no request pauses nothing', () => {
    answeredTurn();
    seedLegacyTask('t-1', { source_message_id: 'msg-x', origin_turn: 2 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { servedSourceMessageId: null }).paused).toBe(0);
  });

  it('a task this very turn opened is never parked by its own turn', () => {
    answeredTurn();
    seedLegacyTask('t-1', { source_message_id: 'msg-x', origin_turn: 6 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { servedSourceMessageId: 'msg-x' }).paused).toBe(0);
  });

  it('a turn that wrote to the tracker, or only said it was starting engine-judged work, pauses nothing', () => {
    answeredTurn();
    seedLegacyTask('t-1', { source_message_id: 'msg-x', origin_turn: 2 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { servedSourceMessageId: 'msg-x', trackerWriteThisTurn: true }).paused).toBe(0);
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6, { servedSourceMessageId: 'msg-x', startLineOnly: true }).paused).toBe(0);
    expect(stateOf('t-1')).toBe('claimed');
  });

  it('a turn whose record says it served nothing (subject none) pauses nothing', () => {
    seedTurn(7, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0,
      kind: null, subject_kind: 'none', subject_id: null, root_kind: null, conv_key: null });
    seedDelivery('d2', { turn_number: 7 });
    seedLegacyTask('t-1', { source_message_id: 'msg-x', origin_turn: 2 });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 7, {}).paused).toBe(0);
  });
});

describe('THE REOPEN EDGE IS DELETED (R-V333-5, t139) — the paused work stays paused and visible', () => {

  it('an engine-paused task is left paused when nothing resumes it (no hidden reopen)', () => {
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1');
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(1);
    expect(db().prepare('SELECT hold_kind FROM work WHERE id = ?').get('t-1')).toEqual({ hold_kind: 'paused' });
  });

  it('NEGATIVE: another agent\'s paused work is untouched', () => {
    db().prepare(
      `INSERT INTO agents (id, name, status, session_started_at)
       VALUES ('other', 'Other', 'idle', '1970-01-01')`,
    ).run();
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1', { assigned_to: 'other' });
    expect(pauseDriveWorkWaitingOnOwner(AGENT, 6).paused).toBe(0);
  });

  it('paused work stays VISIBLE to the aging surface (it keeps its own clock)', () => {
    seedTurn(6, { ended_at: new Date().toISOString(), exit_reason: 'answered', answered: 1, effectful_calls: 0 });
    seedDelivery('d1', { turn_number: 6 });
    seedLegacyTask('t-1');
    pauseDriveWorkWaitingOnOwner(AGENT, 6);
    const row = db().prepare(
      `SELECT state AS status, updated_at FROM work WHERE id = ? AND hold_kind = 'paused'`,
    ).get('t-1') as { status: string; updated_at: string } | undefined;
    expect(row?.updated_at).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('2b — `abandoned` is reachable from >= 3 causes with a single-transition once-guard', () => {
  const openOne = (mid: string): string => {
    seedInbound(mid, { id: mid });
    return openAsk({
      agentId: AGENT, messageId: mid, conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: mid,
    });
  };

  it('cause 1 — a quarantined conversation gives up on its ask', () => {
    const id = openOne('m-q');
    expect(transition(id, {
      to: 'abandoned', by: 'agent', actorId: AGENT,
      reason: 'quarantined: this conversation was served again and again and never produced a reply',
    }).kind).toBe('applied');
  });

  it('cause 2 — a delegated piece the peer never answered', () => {
    const id = openOne('m-p');
    expect(transition(id, {
      to: 'abandoned', by: 'agent', actorId: 'a2a', reason: 'the peer abandoned the thread',
    }).kind).toBe('applied');
  });

  it('cause 3 — an ask nobody can ever serve or close (no identity)', () => {
    seedInbound('m-x', { id: 'm-x', conversation_id: null });
    const id = openAsk({
      agentId: AGENT, messageId: 'm-x', conversationId: null, requesterId: null,
      openedAt: Date.now(), title: 'orphan',
    });
    expect(transition(id, {
      to: 'abandoned', by: 'agent', actorId: 'work-reaper',
      reason: 'no conversation identity: nothing delivered can ever match this ask',
    }).kind).toBe('applied');
  });

  it('cause 3, THE REAPER: an unservable ticket is abandoned with the reason on the row', () => {
    seedInbound('m-x', { id: 'm-x', conversation_id: null });
    const noIdentity = openAsk({
      agentId: AGENT, messageId: 'm-x', conversationId: null, requesterId: null,
      openedAt: Date.now(), title: 'orphan',
    });
    seedInbound('m-y', { id: 'm-y' });
    const goneRoot = openAsk({
      agentId: AGENT, messageId: 'm-y', conversationId: CONV, requesterId: 'owner',
      openedAt: Date.now(), title: 'root about to vanish',
    });
    db().prepare("DELETE FROM messages WHERE id = 'm-y'").run();
    const servable = openOne('m-ok');

    const r = abandonUnservableAsks(AGENT);
    expect(new Set(r.ids)).toEqual(new Set([noIdentity, goneRoot]));
    // NEGATIVE: a servable ask is untouched.
    expect((db().prepare('SELECT state FROM work WHERE id = ?').get(servable) as { state: string }).state)
      .toBe('open');
    // The reason travels with the row, not in a log line.
    const ev = db().prepare(
      "SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition'",
    ).all(noIdentity) as Array<{ payload: string }>;
    expect(ev.some((e) => e.payload.includes('no conversation identity'))).toBe(true);
    // ...and it is idempotent: a second sweep finds nothing left to do.
    expect(abandonUnservableAsks(AGENT).abandoned).toBe(0);
  });

  it('THE PRODUCER IS CLOSED: a platform-authored user row opens no ticket at all', () => {
    // OR4: a person's message names the door it came through. Three engine paths wrote
    // `role='user'` rows with no channel and each one opened an owner ask nobody could ever
    // serve. Measured on the dev box: 55 such tickets, every one of them identity-less.
    insertMessage({
      agentId: AGENT, role: 'user', content: 'Tracker review -- 0 active tasks:',
    } as never);
    expect(db().prepare("SELECT count(*) AS c FROM work WHERE kind = 'ask'").get())
      .toEqual({ c: 0 });
    // NEGATIVE CONTROL: the same content through a real door DOES open one.
    insertMessage({
      agentId: AGENT, role: 'user', content: 'Tracker review -- 0 active tasks:',
      lane: 'owner', channel: 'dashboard', senderId: 'owner', conversationId: CONV,
      inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
    } as never);
    expect(db().prepare("SELECT count(*) AS c FROM work WHERE kind = 'ask'").get())
      .toEqual({ c: 1 });
  });

  it('THE ONCE-GUARD: the second transition is refused, so exactly one caller acts', () => {
    const id = openOne('m-1');
    const first = transition(id, { to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'first', expectedState: 'open' });
    const second = transition(id, { to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'second', expectedState: 'open' });
    expect(first.kind).toBe('applied');
    expect(second.kind).toBe('refused');
  });

  it('THE REOPEN AUTHORITY covers a quarantine-abandoned ask (T3 adjudication #4)', () => {
    const id = openOne('m-1');
    transition(id, { to: 'abandoned', by: 'agent', actorId: AGENT, reason: 'quarantined' });
    // NEGATIVE first: a worker agent cannot resurrect its own abandonment.
    expect(transition(id, { to: 'open', by: 'agent', actorId: AGENT, reason: 'try again' }).kind).toBe('refused');
    // The owner can, and that is the late-answer path.
    expect(transition(id, {
      to: 'open', by: 'owner', actorId: 'owner', claim: 'authoritative',
      reason: 'the owner asked again on the same conversation',
    }).kind).toBe('applied');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('1g — the truthful-answer key names the DELIVERY that proves it', () => {
  it('resolves the turn\'s own delivery, newest first', () => {
    seedTurn(4);
    seedDelivery('d-old', { turn_number: 4 });
    seedDelivery('d-new', { turn_number: 4 });
    expect(terminalDeliveryForTurn(AGENT, 4, CONV)).toBe('d-new');
  });

  it('NEGATIVE: a start-ack, a failed send and a peer hand-back are not the answer', () => {
    seedTurn(4);
    seedDelivery('d-ack', { turn_number: 4, tool: 'engine-ack' });
    seedDelivery('d-fail', { turn_number: 4, outcome: 'failed' });
    seedDelivery('d-a2a', { turn_number: 4, channel: 'a2a', conversation_id: null });
    expect(terminalDeliveryForTurn(AGENT, 4, CONV)).toBeNull();
  });

  it('NEGATIVE: a turn with nothing on the ledger names no receipt', () => {
    seedTurn(4);
    expect(terminalDeliveryForTurn(AGENT, 4, CONV)).toBeNull();
  });
});

// R-2 (the directive gate's content-shape ban) retired with the gate itself: t145 deleted the
// pin, so there is no second reader of answeredness left to police.

// ══════════════════════════════════════════════════════════════════════════════
describe('2c — the engine-event retry policy, carried VERBATIM', () => {
  it('5 attempts, a 6-hour horizon, and the exact backoff ladder', () => {
    expect(ENGINE_EVENT_MAX_ATTEMPTS).toBe(5);
    expect(ENGINE_EVENT_EXPIRY_HOURS).toBe(6);
    expect(ENGINE_EVENT_BACKOFF_MINUTES).toEqual([1, 5, 15, 30, 60]);
  });
});
