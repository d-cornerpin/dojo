// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T1 — THE SCAFFOLD FLOOR STOPS TAXING ANSWERED WORK. Written BEFORE the fix.
//
// THE DEFECT, MEASURED (investigation report, ISSUE 1, on the worn-in dev DB):
//   10 of 35 engine-floor firings in the current design era reported a per-turn count
//   BELOW the stated threshold of 6 (histogram 4x1, 4x2, 2x3). A firing that reports 1 or
//   2 is a PROOF that the cross-turn accumulator was >= 6, because the gate is
//   `Math.max(perTurn, crossTurn) >= 6` and there is no other path into that branch.
//
// WHY: the cross-turn accumulator (`turn-state.ts`, RC-19 item 3) had exactly three clear
// sites — a new session, a DISARMING tracker write, and the floor's own firing. NONE of
// them is "the turn ended and the person got their answer". So a turn that does real work,
// answers its human and closes cleanly leaves its work calls on the ledger forever, and the
// 6th one opens a phantom task on whatever trivial turn comes next.
//
// WHAT THE FIX MAY NOT COST (both driven below, not asserted in prose):
//   · THE WEAKEST-MODEL GUARANTEE (`tracker-floors.ts:4-5`) — a genuine >= 6-untracked-call
//     job still gets its row.
//   · THE RC-19 ANTI-DODGE REQUIREMENT (`turn-state.ts:115-131`) — "a turn BREAK can no
//     longer reset the floor". The dodge's own definition is that it EXITS WITHOUT
//     ANSWERING, so a clear keyed on ANSWERED+DELIVERED cannot reach it. Driven here as its
//     own case, because that is the requirement that outranks the cleanup.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(o.tmpdir(), 'dojo-t1-untracked-debt-test', 'dojo.db'),
  };
});

vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
}));

// The PM rename handoff is fire-and-forget and wakes a real runtime. Stub the wake; the
// ROW it writes (`origin_intent='pm_rename'`) is read below, so the handoff itself is real.
vi.mock('../../../../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => undefined }),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTurnContext, endTurnContext, type TurnContext } from '../../../../turn-context.js';
import {
  untrackedWorkAcrossTurns, getUntrackedWorkAcrossTurns,
} from '../../../../turn-state.js';
import { initState, advance, type AgentTurnState } from '../../../state.js';
import { nextSteer } from '../../../steer-queue.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import { countTrackerWorkThisIteration } from '../tracker-counting.js';
import { runTrackerFloors } from '../tracker-floors.js';
import { finalizeTurnRecord } from '../../teardown/finalize-record.js';
import type { ExecuteContext } from '../index.js';
import type { TeardownContext } from '../../teardown/index.js';

const AGENT = 'agent-t1';
const CONV = 'human:owner';
const CONVERSATION_ID = 'conv-t1-0001';

const SOURCE = fs.readFileSync(
  new URL('../tracker-floors.ts', import.meta.url), 'utf8',
);
const STATE_SOURCE = fs.readFileSync(
  new URL('../../../state.ts', import.meta.url), 'utf8',
);

/** Source with comment-only lines removed — a tombstone naming a deleted symbol is the
 *  point of a tombstone, so the "is it gone" checks below read executable lines. */
const codeLines = (src: string): string => src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .join('\n');

const USER: TurnCounterparty = {
  kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard',
  senderId: 'owner', threadId: null, senderIsAgent: false,
};

const db = (): Database.Database => mockDb.current!;

/** A model response carrying `n` REAL (non-tracker, non-trivial) work calls. */
const workCalls = (n: number): { toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } => ({
  toolCalls: Array.from({ length: n }, (_, i) => ({
    id: `tc-${uuidv4()}`, name: 'write_file', arguments: { path: `/tmp/f${i}.txt`, content: 'x' },
  })),
});

function freshState(turnNumber: number, prompt: string | null): AgentTurnState {
  return initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false,
    configuredModelId: 'floor-model', turnNumber, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: prompt,
    lastUserMessageId: prompt ? `msg-${turnNumber}` : null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  });
}

function executeCtx(
  turnCtx: TurnContext, turnNumber: number, result: ReturnType<typeof workCalls>,
): ExecuteContext {
  return {
    agentId: AGENT, turnCtx, turnNumber, db: db(),
    agent: { name: 'Agent' }, counterparty: USER, counterpartyIsAgentSender: false,
    chosenConvKey: turnCtx.convKey ?? null, hasUnansweredUser: false,
    triggerRow: null, triggerWorkId: null, triggerConversationId: CONVERSATION_ID,
    turnStartedAt: new Date().toISOString(), persistRoutingMarker: () => undefined,
    engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false,
    identicalCallState: {} as ExecuteContext['identicalCallState'],
    reminderLaneRefusedSigs: new Set<string>(),
    startAckArmed: false, startAckArmedAtMs: 0,
    fireStartAckIfOwed: async () => undefined,
    result: result as unknown as ExecuteContext['result'],
    messageId: `resp-${turnNumber}`, persistedContent: null, interAgentTurn: false,
    hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor-model',
    staleTaskWindowMinutes: 45, maxToolLoops: 40, engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 30_000, setAgentStatus: () => undefined,
  } as unknown as ExecuteContext;
}

function teardownCtx(
  turnCtx: TurnContext, turnNumber: number,
  opts: { answerRowId: string | null; convKey?: string | null },
): TeardownContext {
  return {
    agentId: AGENT, turnCtx, turnNumber, db: db(),
    chosenConvKey: opts.convKey === undefined ? CONV : opts.convKey,
    chosenConversationId: CONVERSATION_ID, lastAssembledAtIso: null,
    terminalAnswerRowId: opts.answerRowId, triggerWorkId: null,
    toolPhaseEndedBySpinBrake: false, turnInjectedTechniqueId: null,
    counterparty: USER, isA2ATurn: false, isEngineTurn: false,
    turnStartedAt: new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
    inboundChannel: 'dashboard', inboundContext: null,
    reArmIfStrandedNoAnswer: () => undefined, stopStatusHeartbeat: () => undefined,
  } as unknown as TeardownContext;
}

/** The message row a delivered answer points at. */
function seedAnswerRow(turnNumber: number): string {
  const id = `ans-${turnNumber}`;
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
     VALUES (?, ?, 'assistant', 'here is the answer', ?, ?)`,
  ).run(id, AGENT, turnNumber, Date.now());
  return id;
}

/** The RECEIPT that proves it left the building — what `turnDeliveredToPerson` reads. */
function seedDelivery(turnNumber: number, conversationId: string = CONVERSATION_ID): void {
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                             message_id, outcome, created_at, updated_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now'), datetime('now'))`,
  ).run(`del-${turnNumber}`, AGENT, turnNumber, conversationId, `ans-${turnNumber}`);
}

function seedTurnRow(turnNumber: number): void {
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, started_at, conv_key, answered)
     VALUES (?, ?, datetime('now'), ?, 0)`,
  ).run(AGENT, turnNumber, CONV);
}

/** One whole turn: N real work calls, then the turn ends — answered+delivered or not. */
async function runTurn(
  turnNumber: number,
  opts: { calls: number; prompt: string | null; answered: boolean },
): Promise<{ scaffoldsAfter: number; steer: string | null }> {
  const turnCtx = openTurnContext(AGENT);
  turnCtx.convKey = CONV;
  turnCtx.conversationId = CONVERSATION_ID;
  turnCtx.turnNumber = turnNumber;
  seedTurnRow(turnNumber);

  let state = freshState(turnNumber, opts.prompt);
  const result = workCalls(opts.calls);
  const ectx = executeCtx(turnCtx, turnNumber, result);
  state = countTrackerWorkThisIteration(state, ectx);
  state = await runTrackerFloors(state, ectx);

  let answerRowId: string | null = null;
  if (opts.answered) {
    answerRowId = seedAnswerRow(turnNumber);
    seedDelivery(turnNumber);
  }
  await finalizeTurnRecord(state, teardownCtx(turnCtx, turnNumber, { answerRowId }));
  endTurnContext(AGENT);

  const n = db().prepare(
    `SELECT COUNT(*) AS n FROM work WHERE root_kind = 'engine_scaffold' AND agent_id = ?`,
  ).get(AGENT) as { n: number };
  // T53: the queue is the floor's one model-facing channel, so the turn hands back what it
  // filed there — the clauses below read the delivery instead of inferring it from a row.
  return { scaffoldsAfter: n.n, steer: nextSteer(state.steerQueue)?.content ?? null };
}

const scaffoldRows = (): Array<{ id: string; title: string }> =>
  db().prepare(
    `SELECT id, title FROM work WHERE root_kind = 'engine_scaffold' AND agent_id = ?`,
  ).all(AGENT) as Array<{ id: string; title: string }>;

/** The floor's scaffold note as it is RECORDED.
 *
 *  T53 (owner ruling 5) re-pointed this reader. It used to read the events-lane row the
 *  floor wrote beside its steer — the second model-facing channel, which the floor no longer
 *  writes. The note is still recorded, in the durable `role='system'` row `persistEngineSteer`
 *  writes, and every assertion below is about the note's WORDS, so they are unchanged. */
const engineNote = (): string | null => {
  const r = db().prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND role = 'system'
        AND content LIKE '[System] The engine opened tracker task%'
      ORDER BY rowid DESC LIMIT 1`,
  ).get(AGENT) as { content: string } | undefined;
  return r?.content ?? null;
};

const pmRenameRequest = (): string | null => {
  const r = db().prepare(
    `SELECT content FROM messages WHERE origin_intent = 'pm_rename' ORDER BY rowid DESC LIMIT 1`,
  ).get() as { content: string } | undefined;
  return r?.content ?? null;
};

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [AGENT, 'pm']) {
    db().prepare(
      `INSERT OR IGNORE INTO agents (id, name, status, session_started_at)
       VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
  untrackedWorkAcrossTurns.clear();
});

afterEach(() => {
  endTurnContext(AGENT);
  untrackedWorkAcrossTurns.clear();
});

describe('T1 — an answered, delivered turn clears its untracked-work debt', () => {
  it('RED (the S3 replay): three answered work-call turns then a trivial 2-call request opens NO engine_scaffold row', async () => {
    // Three ordinary turns in ONE conversation, each doing real work and each ANSWERING
    // the person. Two calls apiece = 6 on the ledger, which is exactly the S1+S2 debt S3
    // inherited.
    await runTurn(4497, { calls: 2, prompt: 'research the top note-taking apps', answered: true });
    await runTurn(4498, { calls: 2, prompt: 'add a small section for gym stuff', answered: true });
    await runTurn(4499, { calls: 2, prompt: 'summarize what you found', answered: true });

    // ...then the trivial request S3 actually was: two work calls, answered in 18 seconds.
    const { scaffoldsAfter } = await runTurn(4500, {
      calls: 2, prompt: 'set up calendar and vet reminders', answered: true,
    });

    expect(scaffoldsAfter, 'a finished, delivered turn must not leave permanent untracked debt for the next trivial turn to pay').toBe(0);
    expect(engineNote(), 'no engine floor note should exist at all').toBeNull();
  });

  it('negative control (weakest-model guarantee preserved): one turn with >= 6 untracked calls and no tracker write FIRES the floor', async () => {
    const { scaffoldsAfter } = await runTurn(5001, {
      calls: 6, prompt: 'go through my inbox and put together a list of everything outstanding',
      answered: true,
    });
    expect(scaffoldsAfter, 'a genuine 6-call untracked job still gets its row').toBe(1);
    expect(scaffoldRows()[0].title.length).toBeGreaterThan(0);
  });

  it('negative control: the engine note and the PM rename request carry BOTH counters and cannot contradict each other', async () => {
    await runTurn(5002, { calls: 7, prompt: 'build me a comparison write-up', answered: true });
    const note = engineNote();
    expect(note, 'the floor fired, so it wrote its note').not.toBeNull();
    // The note used to print ONLY the per-turn counter — the one that did not decide
    // anything — which is why a firing could read "you made 2 work calls".
    expect(note).toMatch(/this turn: 7/);
    expect(note).toMatch(/total untracked in this conversation: 7/);

    const rename = pmRenameRequest();
    expect(rename, 'the floor dispatched its PM rename handoff').not.toBeNull();
    // `scaffold-title.ts` used to hardcode the prose "6+ work calls". A hardcoded number
    // beside a printed counter is how the two strings contradicted each other.
    expect(rename).not.toMatch(/6\+ work calls/);
    expect(rename).toMatch(/7/);
  });

  // ── T53 (owner ruling 5): ONE MODEL-FACING CHANNEL ──────────────────────────────────
  // The floor used to hand the note to the model twice: the queue entry (this turn, verbatim)
  // and an events-lane row lifted into `lane.events` a turn LATER as a <=400-char gist. The
  // gist is where `task_id` survives and the closing instruction does not, which is the half
  // of the note a continuing agent actually needs. The queue keeps the whole note; the second
  // channel is gone; the record is the durable `role='system'` row asserted above.
  it('T53: the scaffold note reaches the model on the QUEUE, and no events-lane row is written', async () => {
    const { scaffoldsAfter, steer } = await runTurn(5003, {
      calls: 7, prompt: 'build me a comparison write-up', answered: true,
    });
    expect(scaffoldsAfter, 'the floor fired, or this clause proves nothing').toBe(1);

    // CHANNEL 1, unchanged: the model gets the whole note, on the very next iteration.
    expect(steer, 'the floor still files its steer').not.toBeNull();
    expect(steer).toContain('[System] The engine opened tracker task');
    expect(steer).toMatch(/task_id: /);
    expect(steer).toContain('close it with work_update(action="status", complete)');
    // …and it IS the recorded note, byte for byte, so record and delivery cannot drift.
    expect(steer).toBe(engineNote());

    // CHANNEL 2, gone.
    const riders = db().prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'auto_scaffold'`,
    ).get(AGENT) as { n: number };
    expect(riders.n, 'the scaffold note must not reach the model a second time next turn').toBe(0);
  });

  it('anti-dodge control (RC-19 item 3 preserved): turns that EXIT WITHOUT ANSWERING keep accumulating, and the floor fires at the 6th', async () => {
    // The A2A dodge: work, break the turn, work, break the turn... Never an answer, so the
    // new clear can never reach it and the count survives every turn break.
    await runTurn(6001, { calls: 2, prompt: 'start the research', answered: false });
    expect(getUntrackedWorkAcrossTurns(AGENT, CONV)).toBe(2);
    await runTurn(6002, { calls: 2, prompt: 'keep going', answered: false });
    expect(getUntrackedWorkAcrossTurns(AGENT, CONV)).toBe(4);

    const { scaffoldsAfter } = await runTurn(6003, { calls: 2, prompt: 'keep going', answered: false });
    expect(scaffoldsAfter, 'the dodge still hits the floor on the 6th untracked call').toBe(1);
    expect(engineNote()).toMatch(/this turn: 2/);
    expect(engineNote()).toMatch(/total untracked in this conversation: 6/);
  });

  it('unit: the clear fires on an answered+DELIVERED finalize', async () => {
    const turnCtx = openTurnContext(AGENT);
    turnCtx.convKey = CONV;
    turnCtx.conversationId = CONVERSATION_ID;
    seedTurnRow(7001);
    let state = freshState(7001, 'do the thing');
    state = countTrackerWorkThisIteration(state, executeCtx(turnCtx, 7001, workCalls(3)));
    expect(getUntrackedWorkAcrossTurns(AGENT, CONV)).toBe(3);

    const answerRowId = seedAnswerRow(7001);
    seedDelivery(7001);
    await finalizeTurnRecord(state, teardownCtx(turnCtx, 7001, { answerRowId }));

    expect(getUntrackedWorkAcrossTurns(AGENT, CONV)).toBe(0);
  });

  it('unit: a turn that ANSWERED but delivered NOTHING (no receipt) does NOT clear', async () => {
    const turnCtx = openTurnContext(AGENT);
    turnCtx.convKey = CONV;
    turnCtx.conversationId = CONVERSATION_ID;
    seedTurnRow(7002);
    let state = freshState(7002, 'do the thing');
    state = countTrackerWorkThisIteration(state, executeCtx(turnCtx, 7002, workCalls(3)));

    const answerRowId = seedAnswerRow(7002);
    // deliberately NO seedDelivery: the answered edge has only one of its two halves
    await finalizeTurnRecord(state, teardownCtx(turnCtx, 7002, { answerRowId }));

    expect(getUntrackedWorkAcrossTurns(AGENT, CONV), 'no receipt, no clear').toBe(3);
  });

  it('unit: a turn with no answer at all does NOT clear', async () => {
    const turnCtx = openTurnContext(AGENT);
    turnCtx.convKey = CONV;
    turnCtx.conversationId = CONVERSATION_ID;
    seedTurnRow(7003);
    let state = freshState(7003, 'do the thing');
    state = countTrackerWorkThisIteration(state, executeCtx(turnCtx, 7003, workCalls(4)));

    await finalizeTurnRecord(state, teardownCtx(turnCtx, 7003, { answerRowId: null }));

    expect(getUntrackedWorkAcrossTurns(AGENT, CONV)).toBe(4);
  });

  it('unit: the clear is SCOPED to the answered conversation — a different stored convKey is left alone', async () => {
    // The accumulator holds ONE {convKey, count} per agent. A turn answering conversation B
    // must not wipe conversation A's running total.
    const turnCtx = openTurnContext(AGENT);
    turnCtx.convKey = 'human:someone-else';
    turnCtx.conversationId = 'conv-other';
    seedTurnRow(7004);
    let state = freshState(7004, 'do the thing');
    state = countTrackerWorkThisIteration(state, executeCtx(turnCtx, 7004, workCalls(5)));
    expect(getUntrackedWorkAcrossTurns(AGENT, 'human:someone-else')).toBe(5);

    // ...and now a DIFFERENT conversation's turn answers and delivers.
    const answerRowId = seedAnswerRow(7004);
    seedDelivery(7004);
    await finalizeTurnRecord(state, teardownCtx(turnCtx, 7004, { answerRowId, convKey: CONV }));

    expect(
      getUntrackedWorkAcrossTurns(AGENT, 'human:someone-else'),
      'clearing on conversation A must not wipe conversation B',
    ).toBe(5);
  });

  it('the write-only `autoScaffoldedTaskIdThisTurn` field is gone, and neither stale comment still promises the deleted close', () => {
    // `d00f270` deleted the same-turn scaffold close. The field it fed has had ZERO readers
    // since; two committed comments still promised the deleted path. A TOMBSTONE naming the
    // deleted field is the point, so this reads CODE lines only.
    expect(codeLines(STATE_SOURCE), 'no declaration, no initializer').not.toMatch(/autoScaffoldedTaskIdThisTurn/);
    expect(codeLines(SOURCE), 'no write site').not.toMatch(/autoScaffoldedTaskIdThisTurn/);
    // The two stale promises themselves.
    expect(SOURCE).not.toMatch(/lets natural turn-end close JUST this/);
    expect(STATE_SOURCE).not.toMatch(/Recorded here so natural turn-end can/);
  });
});
