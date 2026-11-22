// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2e), MERGER 1 — THE START-ACK IS ONE DOOR.
//
// W26 handed this up and W27's census ranked it the lowest-risk merger in the tree, with
// the reason that makes it low-risk: the observable behaviour is ALREADY single-door,
// because the latch makes whichever opener runs second a no-op. What was not single was
// the CODE — two copies of the same three-flag write, two enqueues of the same constant,
// and a reminder rung that reads the first steer's own queue entry from a third place.
// The census also corrected W26's count: it is not "two doors", it is six sites — three
// upstream REQUEST sites, two arming sites and the checkpoint that converts a request into
// a steer.
//
// THE MERGER IS A DELETION. One module owns the text, the flag triple, the arming gate and
// the hold rung; the openers keep ONLY their own opening predicate, which is the one
// thing that genuinely differs between them (a wall-clock/tracker REQUEST versus a routed
// channel or a multistep verdict). Nothing about when the door opens moves.
//
// §1 is the RED and it is structural, because "one door" is a claim about the code: at
// `20d199a` the flag triple has TWO writers and the steer constant has TWO enqueues.
// §2 and §3 are the preservation clauses, driven, and they are the reason this is safe.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: vi.fn(),
}));
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => emptyStmt }) }));
vi.mock('../../../classifiers/inbound-routing.js', () => ({ inboundIsWork: async () => true }));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runSteerCheckpoint } from '../steer-checkpoint.js';
import { START_ACK_STEER_TEXT } from '../start-ack-door.js';
import { detectMultistepAndScaffold } from '../multistep-detection.js';
import { FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';
const AGENT = FXID.n4;

// ── The checkpoint's own inputs, at the one moment it runs: assemble, mid-array. ──
type Bag = Record<string, unknown>;
const bag = (over: Bag = {}): Bag => ({
  startAckTimer: {},   // a person waits on the turn
  startAckSteerRequested: false,
  startAckSteerArmedThisTurn: false,
  startAckSteersInjected: 0,
  startAckSteerInjectedAtLoop: 0,
  ...over,
});

function runCheckpoint(over: {
  turnCtx?: Bag; loopCount?: number; delivered?: boolean; replied?: boolean;
  state?: AgentTurnState;
} = {}): { state: AgentTurnState; turnCtx: Bag } {
  const turnCtx = over.turnCtx ?? bag();
  const state = over.state ?? advance(
    initState({ agentId: AGENT } as Parameters<typeof initState>[0]),
    { loopCount: over.loopCount ?? 1 },
  );
  const out = runSteerCheckpoint(state, {
    agentId: AGENT,
    turnCtx: turnCtx as never,
    turnNumber: 9,
    engineStartAckDeliveredThisTurn: over.delivered ?? false,
    startAckRepliedNow: () => over.replied ?? false,
    // The drain's own two arguments. An empty array and a bare context are enough: this
    // suite is about the DOOR, and the drain has its own clauses in `contract.test.ts`.
    mctx: {} as never,
    messages: [] as never,
  });
  return { state: out.state, turnCtx };
}

const fired = (s: AgentTurnState): Array<{ floor: string; content: string; atLoop: number }> =>
  s.steerQueue.fired as unknown as Array<{ floor: string; content: string; atLoop: number }>;

beforeEach(() => { vi.clearAllMocks(); });

// ════════════════════════════════════════════════════════════════════
// §2 — THE LADDER IS BYTE-IDENTICAL THROUGH THE DOOR
// ════════════════════════════════════════════════════════════════════

describe('§2 the checkpoint opener still arms exactly as it did', () => {
  it('a REQUESTED steer arms loop-synchronously and records which loop it rode', () => {
    const { state, turnCtx } = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 4 });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
    expect(turnCtx.startAckSteersInjected).toBe(1);
    expect(turnCtx.startAckSteerInjectedAtLoop).toBe(4);
    expect(fired(state).map((e) => e.floor)).toEqual(['start-ack']);
    expect(fired(state)[0].content).toBe(START_ACK_STEER_TEXT);
  });

  it('T41-B: a DELIVERED ack disarms the door — the model is not asked to say hello twice', () => {
    const { state, turnCtx } = runCheckpoint({
      turnCtx: bag({ startAckSteerRequested: true }), delivered: true,
    });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(fired(state)).toEqual([]);
  });

  it('F10: a reply that landed in flight disarms it too, and the flag order is preserved', () => {
    const { state, turnCtx } = runCheckpoint({
      turnCtx: bag({ startAckSteerRequested: true }), replied: true,
    });
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(fired(state)).toEqual([]);
  });

  it('a request on a turn nobody waits on (a run or a clock turn) arms no steer, so no hold follows', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true, startAckTimer: null }), loopCount: 2 });
    const next = runCheckpoint({ turnCtx: first.turnCtx, state: advance(first.state, { loopCount: 3 }) });
    expect([next.turnCtx.startAckSteersInjected, fired(next.state)]).toEqual([0, []]);
  });

  it('no request, no steer — the door does not open itself', () => {
    const { state, turnCtx } = runCheckpoint();
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
    expect(fired(state)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// §3 — RUNG 2 (THE HOLD), AND ITS BOUND
// ════════════════════════════════════════════════════════════════════

describe('§3 the hold is rung 2 of the same ladder, and it stops at two', () => {
  it('the first steer was ignored on a LATER loop: the hold is armed for that loop, with no second steer', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    // Same bag, same queue, a later loop: the gate is `loopCount > steerFiredAtLoop`.
    const second = runCheckpoint({ turnCtx: first.turnCtx, state: advance(first.state, { loopCount: 3 }) });
    expect(second.turnCtx).toMatchObject({ startAckSteersInjected: 2, startAckSteerInjectedAtLoop: 3 });
    expect(fired(second.state).map((e) => e.floor)).toEqual(['start-ack']);
  });

  it('NOT on the same loop the first steer rode: the model has not been asked yet', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    const second = runCheckpoint({ turnCtx: first.turnCtx, state: first.state });
    expect(second.turnCtx.startAckSteersInjected).toBe(1);
  });

  it('HARD BOUND: never a second hold, the loop it holds stays the first one', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    const second = runCheckpoint({ turnCtx: first.turnCtx, state: advance(first.state, { loopCount: 3 }) });
    const third = runCheckpoint({ turnCtx: second.turnCtx, state: advance(second.state, { loopCount: 4 }) });
    expect(third.turnCtx).toMatchObject({ startAckSteersInjected: 2, startAckSteerInjectedAtLoop: 3 });
  });

  it('a delivered ack arms no hold', () => {
    const first = runCheckpoint({ turnCtx: bag({ startAckSteerRequested: true }), loopCount: 2 });
    const second = runCheckpoint({
      turnCtx: first.turnCtx, state: advance(first.state, { loopCount: 3 }), delivered: true,
    });
    expect(second.turnCtx.startAckSteersInjected).toBe(1);
  });
});

describe('the work opener says the start line once', () => {
  it('on the first loop only, once per turn, and not when one was already delivered', async () => {
    const opened = async (turnCtx: Bag, loopCount: number, delivered = false): Promise<string[]> => (await detectMultistepAndScaffold(
      advance(initState({ agentId: AGENT } as Parameters<typeof initState>[0]), { loopCount }), {
        agentId: AGENT, turnNumber: 9, turnCtx: turnCtx as never, db: {} as never,
        counterparty: {
          kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null,
        } as never,
        counterpartyIsAgentSender: false, lastUserMessageContent: 'Book the flights for Friday.',
        engineStartAckDeliveredThisTurn: delivered, staleTaskWindowMinutes: 45,
      })).steerQueue.pending.map((e) => e.floor);
    expect(await opened(bag(), 2)).toEqual([]);
    const turnCtx = bag();
    expect(await opened(turnCtx, 1)).toEqual(['start-ack']);
    expect(await opened(turnCtx, 1)).toEqual([]);
    expect(await opened(bag(), 1, true)).toEqual([]);
  });
});
