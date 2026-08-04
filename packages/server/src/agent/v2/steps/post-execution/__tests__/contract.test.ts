// ════════════════════════════════════════
// PHASE-6 T8 — THE `postExecution` STEP'S CONTRACT (one contract test per STEP,
// RULING P6-R1).
//
// This is the FIRST step cut out of the driver (RULING P6-R3(3): the cut order
// re-sequences by measured coupling and this span crosses nothing), so the
// clauses below are not only about `postExecution`. They are the shape the
// eight tranches behind it copy:
//
//   INPUTS      `(state, ctx)` — the turn's state, and everything else the span
//               read from the driver, passed explicitly. Measured, not guessed:
//               the span's free identifiers are `state`, `agentId`,
//               `turnNumber`, `result`, `turnToolResults` plus module imports.
//   OUTPUT      a `StepOutcome` — the advanced state and ONE directive.
//   TRANSITION  the driver advances `phase` INTO the step (through `advance`,
//               so `validate()` runs); the step never writes `phase` itself.
//   EXIT        the exit-request channel: the step ASKS to leave the loop by
//               RETURNING, never by writing a field a later step overwrites,
//               and a step that asks to leave STOPS — it does not run its
//               remaining gates on the way out.
//
// The failure mode these clauses exist to catch is the one `loop.ts` records
// about itself at the main loop's head: a mid-body `phase: 'done'` never
// survives to the next boundary check, because the next phase transition
// overwrites it. A returned directive cannot be overwritten by anything.
// ════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import type { WsEvent } from '@dojo/shared';
import { advance, initState, type AgentTurnState, type ToolResultRecord } from '../../../state.js';
import { enqueueSteer, steerFired, steerFireCount } from '../../../steer-queue.js';
import {
  runPostExecution,
  POST_EXECUTION_PHASE,
  type PostExecutionContext,
} from '../index.js';

// The spinning floor delivers through `persistEngineSteer`, which writes a
// dashboard row through the single message writer. This test is about the
// STEP's contract, not that row (RC-19's own test owns it), so the writer is
// stubbed rather than reached — a unit test must not open the dev database.
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/message-store.js')>()),
  insertMessageIfAbsent: () => null,
}));

function freshState(): AgentTurnState {
  return initState({
    agentId: 'primary',
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'deepseek-v4-flash',
    turnNumber: 3,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'hello',
    lastUserMessageId: 'msg-1',
    inboundChannel: 'dashboard',
    inboundContext: null,
    pendingTechniqueAck: null,
  });
}

/** The state as the DRIVER hands it over: phase already advanced, one loop in. */
function stateInStep(overrides: Partial<AgentTurnState> = {}): AgentTurnState {
  return advance(freshState(), { phase: POST_EXECUTION_PHASE, loopCount: 1, ...overrides });
}

function toolResult(overrides: Partial<ToolResultRecord> = {}): ToolResultRecord {
  return {
    toolCallId: 'tc-1',
    name: 'history_search',
    content: 'Found 3 matching messages: ...',
    isError: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PostExecutionContext> = {}): PostExecutionContext {
  const events: WsEvent[] = [];
  return {
    agentId: 'primary',
    turnNumber: 3,
    result: { content: 'here you go', toolCalls: [] },
    turnToolResults: [toolResult()],
    broadcast: (event: WsEvent) => { events.push(event); },
    ...overrides,
  };
}

/** Captures what the step broadcast, since three of its paths are user-visible. */
function ctxWithEvents(overrides: Partial<PostExecutionContext> = {}) {
  const events: WsEvent[] = [];
  const ctx = makeCtx({ broadcast: (e: WsEvent) => { events.push(e); }, ...overrides });
  return { ctx, events };
}

function errorCodes(events: WsEvent[]): string[] {
  return events
    .filter((e): e is Extract<WsEvent, { type: 'chat:error' }> => e.type === 'chat:error')
    .map((e) => e.code ?? '');
}

describe('postExecution step — inputs, output, and the recorded transition', () => {
  it('takes (state, ctx) and returns the advanced state with exactly one directive', () => {
    const before = stateInStep();
    const outcome = runPostExecution(before, makeCtx());

    expect(outcome.directive).toBe('proceed');
    expect(outcome.state.lastResponseSig).not.toBeNull();
    // The input state is not mutated — every transition is a replacement.
    expect(before.lastResponseSig).toBeNull();
  });

  it('runs in the phase the driver advanced into, and NEVER writes `phase` itself', () => {
    // The exit-request channel exists because a mid-body `phase` write does not
    // survive the next transition. The step therefore has no business writing it,
    // on ANY path — including the three that ask to leave the loop.
    const paths: Array<[string, AgentTurnState, PostExecutionContext]> = [
      ['proceed', stateInStep(), makeCtx()],
      [
        'continue (repetition nudge)',
        stateInStep({ lastResponseSig: 'same|' }),
        makeCtx({ result: { content: 'same', toolCalls: [] } }),
      ],
      [
        'exit (repetition)',
        advance(stateInStep({ lastResponseSig: 'same|' }), {
          steerQueue: enqueueSteer(freshState().steerQueue, { floor: 'repetition', content: 'x', atLoop: 1 }),
        }),
        makeCtx({ result: { content: 'same', toolCalls: [] } }),
      ],
    ];

    for (const [label, state, ctx] of paths) {
      const outcome = runPostExecution(state, ctx);
      expect(outcome.state.phase, label).toBe(POST_EXECUTION_PHASE);
    }
  });
});

describe('postExecution step — the exit-request channel', () => {
  it('asks to CONTINUE on the repetition floor\'s one-shot nudge, and the nudge is queued', () => {
    const state = stateInStep({ lastResponseSig: 'same|' });
    const outcome = runPostExecution(state, makeCtx({ result: { content: 'same', toolCalls: [] } }));

    expect(outcome.directive).toBe('continue');
    expect(steerFired(outcome.state.steerQueue, 'repetition')).toBe(true);
    // `continue` skipped the rest of the body, so the signature was NOT re-recorded.
    expect(outcome.state.lastResponseSig).toBe('same|');
  });

  it('asks to EXIT once the repetition nudge has already fired, and names why', () => {
    const nudged = advance(stateInStep({ lastResponseSig: 'same|' }), {
      steerQueue: enqueueSteer(freshState().steerQueue, { floor: 'repetition', content: 'x', atLoop: 1 }),
    });
    const { ctx, events } = ctxWithEvents({ result: { content: 'same', toolCalls: [] } });
    const outcome = runPostExecution(nudged, ctx);

    expect(outcome.directive).toBe('exit');
    if (outcome.directive !== 'exit') throw new Error('unreachable');
    expect(outcome.reason).toBe('stuck-repeating');
    expect(errorCodes(events)).toEqual(['STUCK_REPEATING']);
  });

  it('A STEP THAT ASKS TO EXIT STOPS — it does not run its remaining gates on the way out', () => {
    // The failure mode in one clause. The inputs below would move BOTH later
    // counters if the step kept going: five blocked results drive
    // `consecutivePermissionDenials`, and the same batch would reset
    // `consecutiveNoResultTools`. The repetition floor exits before either.
    const nudged = advance(
      stateInStep({ lastResponseSig: 'same|', consecutivePermissionDenials: 2, consecutiveNoResultTools: 1 }),
      { steerQueue: enqueueSteer(freshState().steerQueue, { floor: 'repetition', content: 'x', atLoop: 1 }) },
    );
    const blocked = Array.from({ length: 5 }, (_, i) =>
      toolResult({ toolCallId: `tc-${i}`, content: '[BLOCKED] not permitted', isError: true }),
    );

    const outcome = runPostExecution(nudged, makeCtx({
      result: { content: 'same', toolCalls: [] },
      turnToolResults: blocked,
    }));

    expect(outcome.directive).toBe('exit');
    expect(outcome.state.consecutivePermissionDenials).toBe(2);
    expect(outcome.state.consecutiveNoResultTools).toBe(1);
    expect(steerFireCount(outcome.state.steerQueue, 'spinning')).toBe(0);
  });

  it('asks to CONTINUE on the no-results floor, then to EXIT when it fires again', () => {
    const empty = [toolResult({ content: 'No results found for "x".' })];

    const first = runPostExecution(
      stateInStep({ consecutiveNoResultTools: 1 }),
      makeCtx({ turnToolResults: empty }),
    );
    expect(first.directive).toBe('continue');
    expect(steerFired(first.state.steerQueue, 'no-results')).toBe(true);
    // The floor resets its own counter when it nudges.
    expect(first.state.consecutiveNoResultTools).toBe(0);

    const { ctx, events } = ctxWithEvents({ turnToolResults: empty });
    const second = runPostExecution(
      advance(stateInStep({ consecutiveNoResultTools: 1 }), { steerQueue: first.state.steerQueue }),
      ctx,
    );
    expect(second.directive).toBe('exit');
    if (second.directive !== 'exit') throw new Error('unreachable');
    expect(second.reason).toBe('no-results');
    expect(errorCodes(events)).toEqual(['NO_RESULTS']);
  });

  it('nudges on the spinning floor WITHOUT asking to exit — a nudge is not an exit', () => {
    // Four denials carried in plus one blocked result this batch = 5, the
    // classifier's PERMISSION_DENIAL_THRESHOLD. The engine asks the model before
    // it breaks: the steer goes out and the loop keeps running.
    const outcome = runPostExecution(
      stateInStep({ consecutivePermissionDenials: 4 }),
      makeCtx({ turnToolResults: [toolResult({ content: '[BLOCKED] not permitted', isError: true })] }),
    );

    expect(outcome.directive).toBe('proceed');
    expect(outcome.state.consecutivePermissionDenials).toBe(5);
    expect(steerFireCount(outcome.state.steerQueue, 'spinning')).toBe(1);
  });

  it('asks to EXIT when the spinning nudge cap is reached, and names why', () => {
    let queue = freshState().steerQueue;
    for (const atLoop of [1, 2, 3]) {
      queue = enqueueSteer(queue, { floor: 'spinning', content: 'n', key: `loop-${atLoop}`, atLoop });
    }
    const capped = advance(stateInStep({ consecutivePermissionDenials: 4 }), { steerQueue: queue });
    expect(steerFireCount(capped.steerQueue, 'spinning')).toBe(3);

    const outcome = runPostExecution(
      capped,
      makeCtx({ turnToolResults: [toolResult({ content: '[BLOCKED] not permitted', isError: true })] }),
    );

    expect(outcome.directive).toBe('exit');
    if (outcome.directive !== 'exit') throw new Error('unreachable');
    expect(outcome.reason).toBe('spinning-nudge-cap');
    // No fourth nudge was queued on the way out.
    expect(steerFireCount(outcome.state.steerQueue, 'spinning')).toBe(3);
  });
});

describe('postExecution step — the counters it owns', () => {
  it('adds the whole blocked batch to the denial counter, and zeroes it on any non-blocked batch', () => {
    const blocked = Array.from({ length: 3 }, (_, i) =>
      toolResult({ toolCallId: `tc-${i}`, content: '[BLOCKED] not permitted', isError: true }),
    );
    const up = runPostExecution(stateInStep({ consecutivePermissionDenials: 1 }), makeCtx({ turnToolResults: blocked }));
    expect(up.state.consecutivePermissionDenials).toBe(4);

    const down = runPostExecution(stateInStep({ consecutivePermissionDenials: 4 }), makeCtx());
    expect(down.state.consecutivePermissionDenials).toBe(0);
  });

  it('counts a no-result batch up and a real result back to zero', () => {
    const empty = runPostExecution(
      stateInStep(),
      makeCtx({ turnToolResults: [toolResult({ content: 'not in memory' })] }),
    );
    expect(empty.state.consecutiveNoResultTools).toBe(1);
    expect(empty.directive).toBe('proceed');

    const real = runPostExecution(stateInStep({ consecutiveNoResultTools: 1 }), makeCtx());
    expect(real.state.consecutiveNoResultTools).toBe(0);
  });

  it('records the response signature from text AND tool calls, order-independently', () => {
    const twoCalls = {
      content: 'checking',
      toolCalls: [
        { id: 'b', name: 'file_read', arguments: { path: '/b' } },
        { id: 'a', name: 'file_read', arguments: { path: '/a' } },
      ],
    };
    const first = runPostExecution(stateInStep(), makeCtx({ result: twoCalls }));
    const reordered = {
      content: 'checking',
      toolCalls: [twoCalls.toolCalls[1], twoCalls.toolCalls[0]],
    };
    const second = runPostExecution(
      stateInStep({ lastResponseSig: first.state.lastResponseSig }),
      makeCtx({ result: reordered }),
    );
    // Same two calls in the other order IS the same response — the signature sorts.
    expect(second.directive).toBe('continue');
    expect(steerFired(second.state.steerQueue, 'repetition')).toBe(true);
  });
});
