import { describe, it, expect } from 'vitest';
import {
  initState,
  advance,
  validate,
  bumpRecoveryStreak,
  bumpLoopSignature,
  nextOutputEscalation,
  StateValidationError,
  type AgentTurnState,
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
    shouldNudgeTracker: false,
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
      shouldNudgeTracker: false,
    });
    expect(s.modelId).toBe('__auto__');
  });

  it('all counters start at zero', () => {
    const s = freshState();
    expect(s.loopCount).toBe(0);
    expect(s.toolCallsExecutedThisTurn).toBe(0);
    expect(s.outputTokensEscalated).toBe(0);
    expect(s.consecutivePermissionDenials).toBe(0);
    expect(s.spinningNudgeCount).toBe(0);
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
    expect(() => advance(s, { outputTokensEscalated: 999999 }))
      .toThrow(StateValidationError);
  });
});

describe('validate', () => {
  it('passes for a fresh state', () => {
    expect(() => validate(freshState())).not.toThrow();
  });

  it('throws on outputTokensEscalated > 64000', () => {
    const s = { ...freshState(), outputTokensEscalated: 70000 };
    expect(() => validate(s)).toThrow(/outputTokensEscalated overflow/);
  });

  it('throws on runaway tool count', () => {
    const s = { ...freshState(), toolCallsExecutedThisTurn: 250 };
    expect(() => validate(s)).toThrow(/runaway tool count/);
  });

  it('throws on runaway loop count', () => {
    const s = { ...freshState(), loopCount: 600 };
    expect(() => validate(s)).toThrow(/runaway loop count/);
  });

  it('throws on runaway permission denials', () => {
    const s = { ...freshState(), consecutivePermissionDenials: 25 };
    expect(() => validate(s)).toThrow(/permission denials/);
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

describe('bumpRecoveryStreak', () => {
  it('starts a fresh streak when prev is null', () => {
    expect(bumpRecoveryStreak(null, 'vision_mismatch'))
      .toEqual({ kind: 'vision_mismatch', count: 1 });
  });

  it('increments same-kind streak', () => {
    expect(bumpRecoveryStreak({ kind: 'vision_mismatch', count: 2 }, 'vision_mismatch'))
      .toEqual({ kind: 'vision_mismatch', count: 3 });
  });

  it('resets on different kind', () => {
    expect(bumpRecoveryStreak({ kind: 'vision_mismatch', count: 2 }, 'context_overflow'))
      .toEqual({ kind: 'context_overflow', count: 1 });
  });
});

describe('bumpLoopSignature', () => {
  it('appends the new signature', () => {
    const result = bumpLoopSignature(['a', 'b'], 'c', 8);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('windows to size when overflowing', () => {
    const result = bumpLoopSignature(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'i', 8);
    expect(result).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(result.length).toBe(8);
  });
});

describe('nextOutputEscalation', () => {
  it('returns 8000 when not yet escalated', () => {
    expect(nextOutputEscalation(0)).toBe(8000);
  });

  it('escalates 8000 → 16000', () => {
    expect(nextOutputEscalation(8000)).toBe(16000);
  });

  it('escalates 16000 → 32000', () => {
    expect(nextOutputEscalation(16000)).toBe(32000);
  });

  it('escalates 32000 → 64000', () => {
    expect(nextOutputEscalation(32000)).toBe(64000);
  });

  it('returns null when exhausted at 64000', () => {
    expect(nextOutputEscalation(64000)).toBeNull();
  });
});
