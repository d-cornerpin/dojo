import { describe, it, expect } from 'vitest';
import {
  initState, advance, validate, StateValidationError, type AgentTurnState,
} from '../state.js';

function freshState(): AgentTurnState {
  return initState({
    agentId: 'test-agent',
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'claude-sonnet-4-6',
    turnNumber: 0,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    imFlagSetAtRunStart: false,
    lastUserMessageContent: null,
  });
}

describe('initState', () => {
  it('creates a state with phase=preflight', () => {
    const s = freshState();
    expect(s.phase).toBe('preflight');
    expect(s.agentId).toBe('test-agent');
    expect(s.modelId).toBe('claude-sonnet-4-6');
  });

  it('uses __auto__ placeholder for auto-routed agents', () => {
    const s = initState({
      agentId: 'a',
      contextWindow: 200000,
      isAutoRouted: true,
      configuredModelId: 'auto',
      turnNumber: 0,
      triggeredByIMessage: false,
      triggeredByA2AReplyIntent: null,
      imFlagSetAtRunStart: false,
      lastUserMessageContent: null,
    });
    expect(s.modelId).toBe('__auto__');
  });

  it('all counters start at zero', () => {
    const s = freshState();
    expect(s.loopCount).toBe(0);
    expect(s.toolCallsExecutedThisTurn).toBe(0);
    expect(s.outputTokensEscalated).toBe(0);
    expect(s.deadEndPasses).toBe(0);
    expect(s.steerQueue.pending.length).toBe(0);
    expect(s.steerQueue.fired.length).toBe(0);
    expect(s.steerQueue.delivered.length).toBe(0);
    expect(s.steerQueue.seq).toBe(0);
  });
});

describe('advance', () => {
  it('returns a new object (no mutation of input)', () => {
    const s = freshState();
    const next = advance(s, { phase: 'preCallGates' });
    expect(s.phase).toBe('preflight');         // original unchanged
    expect(next.phase).toBe('preCallGates');   // new state advanced
    expect(next).not.toBe(s);                  // different reference
  });

  it('preserves untouched fields', () => {
    const s = freshState();
    const next = advance(s, { loopCount: 5 });
    expect(next.agentId).toBe(s.agentId);
    expect(next.modelId).toBe(s.modelId);
    expect(next.loopCount).toBe(5);
  });

  it('runs validation on the new state', () => {
    const s = freshState();
    expect(() => advance(s, { outputTokensEscalated: -1 }))
      .toThrow(StateValidationError);
  });
});

describe('validate', () => {
  it('passes for a fresh state', () => {
    expect(() => validate(freshState())).not.toThrow();
  });

  // t195: the fixed 64,000 wall is gone (the room ask is bounded where it is spent); only a nonsense value throws.
  it('throws on a negative outputTokensEscalated', () => {
    const s = { ...freshState(), outputTokensEscalated: -5 };
    expect(() => validate(s)).toThrow(/outputTokensEscalated invalid/);
  });

  it('a long moving job has no step or call ceiling', () => {
    expect(() => validate({ ...freshState(), toolCallsExecutedThisTurn: 250, loopCount: 600 })).not.toThrow();
  });

  it('throws on recovery streak runaway', () => {
    const s = { ...freshState(), recoveryStreak: { kind: 'vision_mismatch', count: 15 } };
    expect(() => validate(s)).toThrow(/recovery streak runaway/);
  });

  it('throws on excessive tool batch', () => {
    const longBatch = Array.from({ length: 150 }, (_, i) => ({
      id: `tc_${i}`, name: 'file_read', arguments: {} as Record<string, unknown>,
    }));
    const s = { ...freshState(), toolCalls: longBatch };
    expect(() => validate(s)).toThrow(/unreasonable tool call batch/);
  });
});
