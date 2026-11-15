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
//               `turnNumber`, `turnToolResults` plus module imports.
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
import { steerFired } from '../../../steer-queue.js';
import {
  runPostExecution,
  POST_EXECUTION_PHASE,
  type PostExecutionContext,
} from '../index.js';

// The dead-end floor delivers through `persistEngineSteer`, which writes a
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
  it('runs in the phase the driver advanced into, and NEVER writes `phase` itself', () => {
    const empty = [toolResult({ content: 'No results found for "x".' })];
    const nudged = runPostExecution(stateInStep({ deadEndPasses: 1 }), makeCtx({ turnToolResults: empty }));
    const paths: Array<[string, AgentTurnState, PostExecutionContext]> = [
      ['proceed', stateInStep(), makeCtx()],
      ['continue (dead-end nudge)', stateInStep({ deadEndPasses: 1 }), makeCtx({ turnToolResults: empty })],
      ['exit (dead-end)', advance(stateInStep({ deadEndPasses: 1 }), { steerQueue: nudged.state.steerQueue }), makeCtx({ turnToolResults: empty })],
    ];
    for (const [label, state, ctx] of paths) {
      expect(runPostExecution(state, ctx).state.phase, label).toBe(POST_EXECUTION_PHASE);
    }
  });
});

describe('postExecution step — the dead-end floor', () => {
  const empty = [toolResult({ content: 'No results found for "x".' })];
  const refused = [toolResult({ content: '[BLOCKED] not permitted', isError: true })];

  it('asks to CONTINUE on the second dead-end pass, then to EXIT when it comes again', () => {
    const first = runPostExecution(stateInStep({ deadEndPasses: 1 }), makeCtx({ turnToolResults: empty }));
    expect(first.directive).toBe('continue');
    expect(steerFired(first.state.steerQueue, 'dead-end')).toBe(true);
    // The floor resets its own counter when it nudges.
    expect(first.state.deadEndPasses).toBe(0);

    const { ctx, events } = ctxWithEvents({ turnToolResults: refused });
    const second = runPostExecution(advance(stateInStep({ deadEndPasses: 1 }), { steerQueue: first.state.steerQueue }), ctx);
    expect(second.directive).toBe('exit');
    if (second.directive !== 'exit') throw new Error('unreachable');
    expect(second.reason).toBe('dead-end');
    expect(errorCodes(events)).toEqual(['NO_RESULTS']);
  });

  it('a refused call and an empty one in the same pass are one dead end; a real result resets it', () => {
    const mixed = runPostExecution(stateInStep(), makeCtx({ turnToolResults: [...empty, ...refused] }));
    expect(mixed.state.deadEndPasses).toBe(1);
    expect(mixed.directive).toBe('proceed');

    const real = runPostExecution(stateInStep({ deadEndPasses: 1 }), makeCtx({ turnToolResults: [...empty, toolResult()] }));
    expect(real.state.deadEndPasses).toBe(0);
  });

  it('the steer never names complete_task, which most agents cannot call', () => {
    const out = runPostExecution(stateInStep({ deadEndPasses: 1 }), makeCtx({ turnToolResults: refused }));
    const steer = out.state.steerQueue.fired.find((e) => e.floor === 'dead-end');
    expect(steer?.content).toContain('empty or refused');
    expect(steer?.content).not.toContain('complete_task');
  });
});
