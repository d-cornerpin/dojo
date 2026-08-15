// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2b) — A GIVE-UP RUNG STOPS BURNING STRANGERS.
//
// W27's census finding 3, and it is the one undeclared thing in the tree that outranks an
// ordering problem: the empty-response ladder has two give-up rungs, and BOTH of them
// called `clearSteerQueue`, which drops the WHOLE pending list. Not the ladder's own
// entries — everybody's. A truth guard that fired at priority 10 earlier in the same turn
// ("the reply claims a delivery the ledger has no record of"), still waiting its turn at
// the one-per-call drain, was abandoned undelivered because a LATER model call came back
// empty twice.
//
// The two mechanisms have nothing to do with each other. The truth guard's subject is
// something the person was already told and that is not true; the ladder's subject is that
// this model call produced nothing. One is not evidence about the other, and the census
// counted this as an UNDECLARED KILL rather than an ordering — the queue's whole promise
// is "a steer must not be silently destroyed by a peer firing in the same beat", and this
// was that destruction, one rung down.
//
// THE FIX IS SCOPE, NOT POLICY. The ladder still gives up, still abandons what it filed,
// still records it. What it may no longer do is speak for floors it knows nothing about:
// the clear takes the FAMILY it is giving up on, and `clearSteerQueue`'s unscoped spelling
// no longer exists, so the next rung cannot re-acquire the reach by accident.
//
// RED at `4fe4916`: clauses §1.1 and §1.2 fail — the priority-10 guard is abandoned by
// both rungs. §2 and §3 are GREEN before and after and are the controls that keep the fix
// from being an over-correction.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import type { ModelContract } from '../../../../model-contract.js';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

// The steer rows go through the single message writer; this suite has no DB, and the row
// is not its subject — the QUEUE is. `persistEngineSteer` is best-effort about the row by
// design and always enqueues, which is the property this stub leans on.
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: vi.fn(),
}));

let CONTRACT: ModelContract;
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  contractForConfiguredModel: () => CONTRACT,
}));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { enqueueSteer } from '../../../steer-queue.js';
import { runEmptyResponse } from '../empty-response.js';
import type { PostCallClassifyContext } from '../index.js';

const PLAIN: ModelContract = {
  id: 'test-model',
  requiresReasoningReplay: false,
  answersInReasoning: false,
  thinkingToggle: 'none',
  rejectsSamplingParamsWhenThinking: false,
  emptyRetryBudget: 1,
  supportsParallelToolCalls: true,
  apiRootIsBareHost: false,
  systemPromptCacheMarker: 'none',
} as unknown as ModelContract;

const reArmSpy = vi.fn();

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[]; stopReason: string }> = {},
): PostCallClassifyContext['result'] => ({
  content: '', toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 300, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

const ctxFor = (over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext => ({
  agentId: 'kevin',
  turnNumber: 11,
  configuredModelId: 'test-model',
  result: modelResult(),
  reArmIfStrandedNoAnswer: reArmSpy,
  turnCtx: {
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    engineStartAckDeliveredThisTurn: false,
  },
  isA2ATurn: false,
  isEngineTurn: false,
  counterpartyIsAgentSender: false,
  hasUnansweredUser: false,
  triggerRow: null,
  ...over,
} as unknown as PostCallClassifyContext);

/** The truth guard's own words, so a survivor is identifiable by content and not by luck. */
const GUARD_STEER =
  '[Engine correction: your reply says you texted Michael. The ledger holds no such send. '
  + 'Either send it now or tell them plainly that it has not gone out.]';

/**
 * A turn on which a priority-10 truth guard ALREADY fired and is still waiting: the drain
 * is one entry per model call, so a guard filed on pass N sits pending while pass N+1 is
 * in flight. That is not an exotic shape — it is the ordinary consequence of the queue's
 * one-per-call drain, which is why the census called this reachable.
 */
function stateWithPendingGuard(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: 'kevin', contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 11, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'did you text Michael?',
  } as Parameters<typeof initState>[0]);
  const withGuard = advance(base, {
    phase: 'postCallClassify', loopCount: 3, modelId: 'test-model',
    steerQueue: enqueueSteer(base.steerQueue, {
      floor: 'ungrounded-claim', content: GUARD_STEER, key: 'obligation-77', atLoop: 2,
    }),
  });
  return advance(withGuard, over);
}

const pendingFloors = (s: AgentTurnState): string[] => s.steerQueue.pending.map((e) => e.floor);
const abandonedFloors = (s: AgentTurnState): string[] => s.steerQueue.abandoned.map((e) => e.floor);

beforeEach(() => {
  vi.clearAllMocks();
  CONTRACT = { ...PLAIN };
});

// ════════════════════════════════════════════════════════════════════
// §1 — THE RED: THE STRANGER SURVIVES
// ════════════════════════════════════════════════════════════════════

describe('§1 a give-up rung abandons its own family and nobody else\'s', () => {
  it('THE GRIND RUNG (rung 2) leaves the pending priority-10 truth guard alone', () => {
    // The grind rung's own floor already fired, so this second truncation is its give-up.
    const start = stateWithPendingGuard({
      steerQueue: enqueueSteer(
        stateWithPendingGuard().steerQueue,
        { floor: 'output-grind', content: '[System: grind]', atLoop: 3 },
      ),
    });

    const out = runEmptyResponse(start, ctxFor({
      result: modelResult({ content: 'half a sen', stopReason: 'max_tokens' }),
    }));

    expect(out.directive).toBe('exit');
    // The ladder gave up on ITS OWN entry…
    expect(abandonedFloors(out.state)).toEqual(['output-grind']);
    // …and the truth guard is still waiting to be delivered. It was filed about something
    // the person was already told and that is not true; a later empty call is not evidence
    // about it, and burning it means the false claim stands.
    expect(pendingFloors(out.state)).toContain('ungrounded-claim');
    expect(out.state.steerQueue.pending.find((e) => e.floor === 'ungrounded-claim')!.content)
      .toBe(GUARD_STEER);
  });

  it('THE EMPTY RUNG (rung 3) leaves it alone too — both give-up sites, not just the one', () => {
    const start = stateWithPendingGuard({
      retriedEmptyResponse: true,
      steerQueue: enqueueSteer(
        stateWithPendingGuard().steerQueue,
        { floor: 'empty-response', content: '[System: empty]', atLoop: 3 },
      ),
    });

    const out = runEmptyResponse(start, ctxFor());

    expect(out.directive).toBe('exit');
    expect(abandonedFloors(out.state)).toEqual(['empty-response']);
    expect(pendingFloors(out.state)).toContain('ungrounded-claim');
  });
});

// ════════════════════════════════════════════════════════════════════
// §2 — THE LADDER STILL GIVES UP, AND STILL SAYS SO
// ════════════════════════════════════════════════════════════════════

describe('§2 giving up is unchanged in everything except its reach', () => {
  it('the grind rung still toasts, still re-arms the ask, and still exits', () => {
    const start = stateWithPendingGuard({
      steerQueue: enqueueSteer(
        stateWithPendingGuard().steerQueue,
        { floor: 'output-grind', content: '[System: grind]', atLoop: 3 },
      ),
    });
    const out = runEmptyResponse(start, ctxFor({
      result: modelResult({ content: 'half a sen', stopReason: 'max_tokens' }),
    }));
    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBe('output-grind-gave-up');
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'MODEL_FAILED' }));
    expect(reArmSpy).toHaveBeenCalled();
  });

  it('the empty rung still toasts, still re-arms, and still exits', () => {
    const start = stateWithPendingGuard({
      retriedEmptyResponse: true,
      steerQueue: enqueueSteer(
        stateWithPendingGuard().steerQueue,
        { floor: 'empty-response', content: '[System: empty]', atLoop: 3 },
      ),
    });
    const out = runEmptyResponse(start, ctxFor());
    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBe('empty-response-gave-up');
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ code: 'MODEL_FAILED' }));
    expect(reArmSpy).toHaveBeenCalled();
  });

  it('ABANDONED IS A RECORD, NOT A DELETION: what the ladder dropped is still on the queue\'s books', () => {
    // The queue's own promise, kept at the narrower scope: `fired` without `delivered` is
    // exactly "written, never seen by the model", and the fix must not quietly turn a
    // burned entry into a forgotten one.
    const start = stateWithPendingGuard({
      retriedEmptyResponse: true,
      steerQueue: enqueueSteer(
        stateWithPendingGuard().steerQueue,
        { floor: 'empty-response', content: '[System: empty]', atLoop: 3 },
      ),
    });
    const out = runEmptyResponse(start, ctxFor());
    expect(out.state.steerQueue.abandoned.map((e) => e.content)).toEqual(['[System: empty]']);
    expect(out.state.steerQueue.fired.map((e) => e.floor))
      .toEqual(['ungrounded-claim', 'empty-response']);
  });
});

// ════════════════════════════════════════════════════════════════════
// §3 — CONTROLS
// ════════════════════════════════════════════════════════════════════

describe('§3 the rungs below the give-ups are untouched', () => {
  it('the FIRST grind rung still steers instead of giving up, and touches nothing pending', () => {
    const out = runEmptyResponse(stateWithPendingGuard(), ctxFor({
      result: modelResult({ content: 'half a sen', stopReason: 'max_tokens' }),
    }));
    expect(out.directive).toBe('continue');
    expect(out.state.steerQueue.abandoned).toEqual([]);
    expect(pendingFloors(out.state)).toEqual(['ungrounded-claim', 'output-grind']);
  });

  it('the silent retry still spends no steer and abandons nothing', () => {
    const out = runEmptyResponse(stateWithPendingGuard(), ctxFor());
    expect(out.directive).toBe('continue');
    expect(out.state.retriedEmptyResponse).toBe(true);
    expect(out.state.steerQueue.abandoned).toEqual([]);
    expect(pendingFloors(out.state)).toEqual(['ungrounded-claim']);
  });

  it('the nudge rung still files its own steer beside the waiting guard, both pending', () => {
    const out = runEmptyResponse(stateWithPendingGuard({ retriedEmptyResponse: true }), ctxFor());
    expect(out.directive).toBe('continue');
    expect(pendingFloors(out.state)).toEqual(['ungrounded-claim', 'empty-response']);
    expect(out.state.steerQueue.abandoned).toEqual([]);
  });
});
