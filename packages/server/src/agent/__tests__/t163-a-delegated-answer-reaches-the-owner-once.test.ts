// t163 — RUN 9 S3: A DELEGATED ANSWER REACHES THE OWNER ONCE, AFTER THE TURN THAT DELEGATED IT.
//
// ── THE SHAPE, measured on the dev body (a fictional restatement) ───────────────────────────
//   * turn T runs on the owner's first ask (A);
//   * mid-turn the owner sends a second ask (B); the engine steers the model at it;
//   * the model delegates B to a helper — the join is opened under the turn's trigger, A;
//   * the helper answers WHILE T IS STILL RUNNING. The transport relayed "Heard back from …"
//     at once, then T's own reply (written before the answer landed, "nothing back from it
//     yet") was persisted ONE SECOND AFTER it: the owner saw a stale line under the answer;
//   * T ended owing B (`owed_interrupt`, with the delivery high-water AFTER the relay), so the
//     relay could never count as B's answer; B was re-served, the model — who could see the
//     relay — ended the turn with `[no-reply]`, the engine re-opened B, and a third turn
//     answered B again. Three messages to the owner for one answer.
//
// ── THE TWO FIXES, each a clause here ───────────────────────────────────────────────────────
//   1. ORDER. A single-piece relay never lands while the delegating agent's turn is running.
//      It is delivered when that turn ends — in the runtime's own teardown, so it still lands
//      if the turn dies — after the turn's own reply. No timer.
//   2. NO RE-SERVE INTO A DUPLICATE. The relay is the evidence for B when the join was opened
//      by the turn that owed B, the delegating send came after B reached the model, and the
//      relay reached B's conversation after B arrived. B is still re-served once (owner
//      priority: never silence); if the model then deliberately ends that turn with no reply,
//      B settles on the relay. If the model answers instead, that is its call — recorded as
//      today.
//
// Driven through the REAL runtime teardown, the REAL transport door, the REAL turn finalize and
// the REAL settlement authority; only the model loop (`runV2Turn`) is a script.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
const turnScript: Array<() => Promise<void>> = [];
let lastRunTouch = Date.now();
vi.mock('../v2/loop.js', () => ({
  runV2Turn: async () => {
    lastRunTouch = Date.now();
    try { const step = turnScript.shift(); if (step) await step(); } finally { lastRunTouch = Date.now(); }
  },
}));
vi.mock('../../services/imessage-bridge.js', () => ({
  sendAlert: vi.fn(), sendResponseViaIMessage: vi.fn(), maybeForwardToImessage: vi.fn(),
}));

const AGENT = 'desk-owner';
const HELPER = 'desk-helper';
const CONV = 'conv-1';
const THREAD = 'thread-t163aaaa-0001';
const ASK_A_MSG = 'm-ask-a';
const ASK_B_MSG = 'm-ask-b';
const ASK_A = `ask:${ASK_A_MSG}`;
const ASK_B = `ask:${ASK_B_MSG}`;
const HELPER_ANSWER = 'No record of that identifier; I cannot give three facts about it.';

const db = (): Database.Database => mockDb.current!;

beforeEach(async () => {
  // ONE module instance for the file (no `resetModules`): a queued-wakeup timer left over from an
  // earlier test then fires into that same instance, which `afterEach` waits out below.
  turnScript.length = 0;
  const shared = await import('../shared-state.js');
  shared.activeRuns.clear();
  shared.pendingWakeups.clear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
});
afterEach(async () => {
  // The runtime arms a 500 ms timer for a queued wakeup, and a run it starts can arm another. Let
  // the chain die out into THIS test's database (and the empty script), not the next test's: quiet
  // means no run started or ended for longer than the timer, and none in flight.
  const shared = await import('../shared-state.js');
  lastRunTouch = Date.now();
  while (Date.now() - lastRunTouch < 900 || shared.activeRuns.size > 0) await new Promise((r) => setTimeout(r, 100));
  mockDb.current?.close();
  mockDb.current = null;
});

async function boot(): Promise<void> {
  // The runtime first: it initialises the module graph in the order production does (the work
  // store sits in an import cycle that a cold `message-store` import trips).
  await import('../runtime.js');
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Desk', 'idle', '1970-01-01'), (?, 'Helper', 'idle', '1970-01-01')`,
  ).run(AGENT, HELPER);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
}

/** An owner message through the real writer — which also opens the ask row, as in production. */
async function ownerSays(msgId: string, text: string): Promise<void> {
  const { insertMessage } = await import('../../memory/message-store.js');
  insertMessage({
    id: msgId, agentId: AGENT, role: 'user', content: text, channel: 'dashboard', senderId: 'owner',
    conversationId: CONV, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
}

/** What the OWNER can see in his conversation, oldest first: the agent's bubbles and the
 *  platform's relay. (Engine steers and tool rows are not his.) */
const ownerFacing = (): string[] =>
  (db().prepare(
    `SELECT content FROM messages
      WHERE agent_id = ? AND conversation_id = ? AND role = 'assistant'
        AND display_kind = 'agent-text'
      ORDER BY rowid`,
  ).all(AGENT, CONV) as Array<{ content: string }>).map((r) => r.content);

const workState = (id: string): string =>
  (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const workRow = (id: string): { state: string; result_delivery_id: string | null } =>
  db().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(id) as never;
const relayDeliveries = (): Array<{ id: string }> =>
  db().prepare(`SELECT id FROM deliveries WHERE agent_id = ? AND tool = 'a2a-join-relay' AND outcome = 'delivered' ORDER BY rowid`).all(AGENT) as never;
const reServes = (id: string): number =>
  (db().prepare(
    `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = 'ct0_ask_re_served'`,
  ).get(id) as { n: number }).n;

/** The helper's ANSWER, through the REAL transport door. */
async function helperAnswers(): Promise<void> {
  const { deliverA2AMessage } = await import('../a2a-transport.js');
  const r = await deliverA2AMessage({
    intent: 'ANSWER' as never, threadId: THREAD, requiresResponse: false,
    payload: HELPER_ANSWER, toAgent: AGENT, fromAgent: HELPER,
  } as never);
  expect(r.delivered).toBe(true);
}

interface TurnOpts {
  /** The delegating send came BEFORE the steer pointed the model at ask B (the "B never reached
   *  the model" control). Default: after, as measured. */
  sendBeforeSteer?: boolean;
  /** Skip the delegation altogether (control iii). */
  noDelegation?: boolean;
  /** The helper answers while the turn runs (default) or never in this turn. */
  helperAnswersMidTurn?: boolean;
}

/** TURN T — the turn that owes ask B. Returns the turn number it ran as. */
function scriptOwingTurn(out: { turn: number }, opts: TurnOpts = {}): () => Promise<void> {
  return async () => {
    const { openTurnContext, endTurnContext } = await import('../turn-context.js');
    const { startTurn, finalizeTurn } = await import('../v2/turn-record.js');
    const { claimAsk, stampClaimingTurn, openDelegationJoin } = await import('../../work/store.js');
    const { recordDelivery } = await import('../v2/deliveries.js');
    const { recordOwedInterruptSubjects, settleAsksAtTurnFinalize } = await import('../../work/ask-settlement.js');
    const { recordOwedAskShown } = await import('../../work/delegated-relay-evidence.js');
    const { insertMessage } = await import('../../memory/message-store.js');

    const ctx = openTurnContext(AGENT);
    const turn = startTurn({
      agentId: AGENT, kind: 'user', subjectKind: 'conv', subjectId: CONV, rootKind: 'ask',
      rootId: ASK_A_MSG, sourceMessageId: ASK_A_MSG, convKey: CONV,
    });
    out.turn = turn;
    ctx.turnNumber = turn;
    claimAsk(ASK_A, AGENT);
    stampClaimingTurn(ASK_A, turn);
    try {
      // The owner's second ask arrives mid-turn.
      await ownerSays(ASK_B_MSG, 'Ask the helper for three facts about the second topic and bring them back to me');

      const sendDelegation = (): void => {
        const sendId = 'm-delegation-send';
        insertMessage({
          id: sendId, agentId: HELPER, role: 'user', lane: 'a2a', content: '[A2A:QUESTION] three facts please',
          sourceAgentId: AGENT, a2aThreadId: THREAD, a2aIntent: 'QUESTION', a2aRequiresResponse: true,
        });
        recordDelivery({
          agentId: AGENT, tool: 'send_to_agent', channel: 'a2a', messageId: sendId,
          outcome: 'delivered', detail: 'A2A QUESTION',
        });
        openDelegationJoin({
          parentWorkId: ASK_A, agentId: AGENT, replyConversationId: CONV,
          ttlAt: Date.now() + 60 * 60_000,
          threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }],
        });
      };
      const steer = (): void => {
        // The owed-interrupt step's steer: the engine points the model at ask B.
        recordOwedAskShown(AGENT, [ASK_B_MSG], turn);
        insertMessage({
          id: 'm-steer', agentId: AGENT, role: 'system', turnNumber: turn,
          content: '[System] While you are working, the user also sent: "Ask the helper …"',
        });
      };

      if (!opts.noDelegation && opts.sendBeforeSteer) sendDelegation();
      steer();
      if (!opts.noDelegation && !opts.sendBeforeSteer) sendDelegation();

      if (!opts.noDelegation && opts.helperAnswersMidTurn !== false) await helperAnswers();

      // The turn's own reply — written from what the model knew BEFORE the helper answered.
      insertMessage({
        id: 'm-reply-1', agentId: AGENT, role: 'assistant', content: 'The facts are with the helper now — nothing back from it yet.',
        conversationId: CONV, turnNumber: turn, displayKind: 'agent-text',
      });
      recordDelivery({
        agentId: AGENT, tool: 'dashboard', channel: 'dashboard', conversationId: CONV,
        messageId: 'm-reply-1', outcome: 'delivered',
      });
      // The owed-interrupt step records ask B as owed once a reply exists; then the real finalize.
      recordOwedInterruptSubjects(AGENT, [ASK_B_MSG], turn);
      finalizeTurn(AGENT, turn, 'answered', true, 'm-reply-1');
      settleAsksAtTurnFinalize({
        agentId: AGENT, turnNumber: turn,
        assembled: [{ workId: ASK_B, rowid: 1 }],
      });
    } finally {
      endTurnContext(AGENT);
    }
  };
}

/** THE RE-SERVE TURN — ask B served again. `answer` = the model writes to the owner. */
function scriptReServeTurn(out: { turn: number; done: boolean; ownerAtStart: string[] }, answer: boolean): () => Promise<void> {
  return async () => {
    // What the owner holds at the moment the re-serve turn begins: the owing turn has torn down.
    out.ownerAtStart = ownerFacing();
    const { openTurnContext, endTurnContext } = await import('../turn-context.js');
    const { startTurn, finalizeTurn } = await import('../v2/turn-record.js');
    const { claimAsk, stampClaimingTurn } = await import('../../work/store.js');
    const { recordDelivery } = await import('../v2/deliveries.js');
    const { settleAsksAtTurnFinalize } = await import('../../work/ask-settlement.js');
    const { insertMessage } = await import('../../memory/message-store.js');
    const ctx = openTurnContext(AGENT);
    const turn = startTurn({
      agentId: AGENT, kind: 'user', subjectKind: 'conv', subjectId: CONV, rootKind: 'ask',
      rootId: ASK_B_MSG, sourceMessageId: ASK_B_MSG, convKey: CONV,
    });
    out.turn = turn;
    ctx.turnNumber = turn;
    claimAsk(ASK_B, AGENT);
    stampClaimingTurn(ASK_B, turn);
    try {
      if (answer) {
        insertMessage({
          id: 'm-reply-2', agentId: AGENT, role: 'assistant', content: 'The helper came back: no record of it.',
          conversationId: CONV, turnNumber: turn, displayKind: 'agent-text',
        });
        recordDelivery({
          agentId: AGENT, tool: 'dashboard', channel: 'dashboard', conversationId: CONV,
          messageId: 'm-reply-2', outcome: 'delivered',
        });
        finalizeTurn(AGENT, turn, 'answered', true, 'm-reply-2');
      } else {
        finalizeTurn(AGENT, turn, 'no_reply_intended', false, null);
      }
      settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
    } finally {
      endTurnContext(AGENT);
      out.done = true;
    }
  };
}

async function runOwingTurnThenWaitForReServe(opts: TurnOpts, reServeAnswers: boolean) {
  await boot();
  await ownerSays(ASK_A_MSG, 'First topic: draft me a short note');
  const owing = { turn: 0 };
  const reServe = { turn: 0, done: false, ownerAtStart: [] as string[] };
  turnScript.push(scriptOwingTurn(owing, opts));
  turnScript.push(scriptReServeTurn(reServe, reServeAnswers));
  const { getAgentRuntime } = await import('../runtime.js');
  await getAgentRuntime().handleMessage(AGENT, '');
  return { owing, reServe };
}

/** The queued wakeup that serves the re-serve turn fires on the runtime's own short timer. */
async function waitForReServe(reServe: { done: boolean }): Promise<void> {
  await vi.waitFor(() => { expect(reServe.done).toBe(true); }, { timeout: 8_000, interval: 50 });
  // let the runtime's teardown of that second run finish
  await new Promise((r) => setTimeout(r, 200));
}

describe('t163 (i) — the measured shape: the relay lands AFTER the turn\'s own reply, once, and ask B is not re-asked', () => {
  it('the owner sees the turn\'s reply first, then exactly one relay, and nothing more about B', async () => {
    const { reServe } = await runOwingTurnThenWaitForReServe({}, false);

    // The turn's own reply is on his screen, and the relay follows it — in that order.
    await waitForReServe(reServe);
    expect(reServe.ownerAtStart).toHaveLength(2);
    expect(reServe.ownerAtStart[0]).toContain('nothing back from it yet');
    expect(reServe.ownerAtStart[1]).toContain('Heard back from');
    expect(reServe.ownerAtStart[1]).toContain(HELPER_ANSWER);

    // The re-serve turn ended with no reply, and ask B did NOT re-open: it settles on the relay.
    const relays = relayDeliveries();
    expect(relays).toHaveLength(1);
    expect(workRow(ASK_B)).toEqual({ state: 'done', result_delivery_id: relays[0].id });
    expect(reServes(ASK_B), 'B was handed back for its one re-serve and not again').toBe(0);
    // Ask A (the root) settles on the relay exactly as it does today.
    expect(workRow(ASK_A)).toEqual({ state: 'done', result_delivery_id: relays[0].id });
    // The owner heard exactly two things: the turn's reply and the relay. Nothing about B again.
    expect(ownerFacing()).toHaveLength(2);
  });

  it('the relay is deferred, not dropped: nothing reaches the owner while the turn runs, and the join is still complete', async () => {
    await boot();
    await ownerSays(ASK_A_MSG, 'First topic: draft me a short note');
    const seenMidTurn: { owner: string[]; relays: number } = { owner: [], relays: -1 };
    const owing = { turn: 0 };
    const inner = scriptOwingTurn(owing, {});
    turnScript.push(async () => {
      await inner();
      seenMidTurn.owner = ownerFacing();
      seenMidTurn.relays = relayDeliveries().length;
    });
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(AGENT, '');
    // Inside the turn (after the helper answered and the reply was written) there was no relay.
    expect(seenMidTurn.relays).toBe(0);
    expect(seenMidTurn.owner).toHaveLength(1);
    expect(seenMidTurn.owner[0]).toContain('nothing back from it yet');
    // And when the turn tore down, the relay went out.
    expect(relayDeliveries()).toHaveLength(1);
  });

  it('a turn that DIES still delivers the relay on teardown', async () => {
    await boot();
    await ownerSays(ASK_A_MSG, 'First topic: draft me a short note');
    const owing = { turn: 0 };
    const inner = scriptOwingTurn(owing, {});
    turnScript.push(async () => { await inner(); throw new Error('the model loop crashed after the helper answered'); });
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(AGENT, '');
    expect(relayDeliveries()).toHaveLength(1);
    expect(ownerFacing().at(-1)).toContain('Heard back from');
  });
});

describe('t163 (ii) — the model answers ask B on the re-serve turn: that is its call, recorded as today, no loop', () => {
  it('one more owner row, ask B closes on the model\'s own delivery, and nothing is served a third time', async () => {
    const { reServe } = await runOwingTurnThenWaitForReServe({}, true);
    await waitForReServe(reServe);
    expect(reServe.ownerAtStart).toHaveLength(2);
    expect(reServe.ownerAtStart[0]).toContain('nothing back from it yet');
    expect(reServe.ownerAtStart[1]).toContain('Heard back from');

    const rows = ownerFacing();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('no record of it');
    const bRow = workRow(ASK_B);
    expect(bRow.state).toBe('done');
    const answerDelivery = db().prepare(`SELECT id FROM deliveries WHERE message_id = 'm-reply-2'`).get() as { id: string };
    expect(bRow.result_delivery_id, 'closed on the model\'s own answer, not on the relay').toBe(answerDelivery.id);
    expect(reServes(ASK_B)).toBe(0);
    expect(relayDeliveries()).toHaveLength(1);
  });
});

describe('t163 (iii) — a mid-turn ask with NO delegation: today\'s re-serve ladder is unchanged', () => {
  it('the re-serve turn ends silent: ask B re-opens, one rung spent, with today\'s reason', async () => {
    const { reServe } = await runOwingTurnThenWaitForReServe({ noDelegation: true }, false);
    await waitForReServe(reServe);
    expect(reServe.ownerAtStart).toHaveLength(1);

    expect(workState(ASK_B)).toBe('open');
    expect(reServes(ASK_B)).toBe(1);
    const reopen = db().prepare(
      `SELECT json_extract(payload, '$.reason') AS reason FROM work_events
        WHERE work_id = ? AND kind = 'transition' AND json_extract(payload, '$.to') = 'open' ORDER BY id DESC LIMIT 1`,
    ).get(ASK_B) as { reason: string };
    expect(reopen.reason).toContain('finalized with no delivery that answers this ask');
    expect(reopen.reason).toContain('serve 2 of 4');
    expect(relayDeliveries()).toHaveLength(0);
    expect(ownerFacing()).toHaveLength(1);
  });
});

describe('t163 (iv) — a relay with the agent IDLE is delivered at once, as today', () => {
  it('no turn is running: the helper\'s answer reaches the owner during the delivery itself', async () => {
    await boot();
    await ownerSays(ASK_A_MSG, 'First topic: draft me a short note');
    const { claimAsk, stampClaimingTurn, openDelegationJoin } = await import('../../work/store.js');
    claimAsk(ASK_A, AGENT);
    stampClaimingTurn(ASK_A, 1);
    openDelegationJoin({
      parentWorkId: ASK_A, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }],
    });
    await helperAnswers();
    expect(relayDeliveries()).toHaveLength(1);
    expect(ownerFacing().at(-1)).toContain('Heard back from');
    expect(workState(ASK_A)).toBe('done');
  });
});

describe('t163 — the three conditions are each load-bearing (controls: the engine still answers again rather than fall silent)', () => {
  it('the delegating send came BEFORE ask B reached the model: the relay is not B\'s answer, B re-opens', async () => {
    const { reServe } = await runOwingTurnThenWaitForReServe({ sendBeforeSteer: true }, false);
    await waitForReServe(reServe);
    expect(workState(ASK_B)).toBe('open');
    expect(reServes(ASK_B)).toBe(1);
  });

  it('the re-serve turn ended because the ENGINE cut it (not the model\'s silence): the relay does not close B', async () => {
    await boot();
    await ownerSays(ASK_A_MSG, 'First topic: draft me a short note');
    const owing = { turn: 0 };
    turnScript.push(scriptOwingTurn(owing, {}));
    const reServe = { turn: 0, done: false };
    turnScript.push(async () => {
      const { openTurnContext, endTurnContext } = await import('../turn-context.js');
      const { startTurn, finalizeTurn } = await import('../v2/turn-record.js');
      const { claimAsk, stampClaimingTurn } = await import('../../work/store.js');
      const { settleAsksAtTurnFinalize } = await import('../../work/ask-settlement.js');
      const ctx = openTurnContext(AGENT);
      const turn = startTurn({
        agentId: AGENT, kind: 'user', subjectKind: 'conv', subjectId: CONV, rootKind: 'ask',
        rootId: ASK_B_MSG, sourceMessageId: ASK_B_MSG, convKey: CONV,
      });
      ctx.turnNumber = turn;
      claimAsk(ASK_B, AGENT);
      stampClaimingTurn(ASK_B, turn);
      try {
        finalizeTurn(AGENT, turn, 'iteration_cap', false, null);
        settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
      } finally { endTurnContext(AGENT); reServe.done = true; }
    });
    const { getAgentRuntime } = await import('../runtime.js');
    await getAgentRuntime().handleMessage(AGENT, '');
    await waitForReServe(reServe);
    expect(workState(ASK_B)).toBe('open');
    expect(reServes(ASK_B), 'an engine cut spends no rung (today\'s rule)').toBe(0);
  });

  it('the relay reached the conversation BEFORE ask B arrived: it is not B\'s answer', async () => {
    const { reServe } = await runOwingTurnThenWaitForReServe({}, false);
    await waitForReServe(reServe);
    // Move ask B\'s arrival to after the relay and replay the re-serve verdict.
    const relay = db().prepare(`SELECT created_at FROM deliveries WHERE tool = 'a2a-join-relay'`).get() as { created_at: string };
    expect(relay.created_at).toBeTruthy();
    // Re-open B as the ladder would have, with B\'s arrival stamped a minute after the relay.
    db().prepare(`UPDATE work SET state = 'claimed', closed_at = NULL, result_delivery_id = NULL, opened_at = ? WHERE id = ?`)
      .run(Date.parse(relay.created_at.replace(' ', 'T') + 'Z') + 60_000, ASK_B);
    const { settleAsk } = await import('../../work/ask-settlement.js');
    const turn = (db().prepare(`SELECT MAX(turn_number) AS t FROM turns WHERE agent_id = ?`).get(AGENT) as { t: number }).t;
    const verdict = settleAsk(ASK_B, { agentId: AGENT, turnNumber: turn, at: 'finalize' });
    expect(verdict.verdict).toBe('reopened');
  });
});
