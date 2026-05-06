import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import {
  a2aReplyEnforcer,
  a2aIntentValidator,
  parseA2ATrigger,
  REPLY_NEEDED_INTENTS,
  TERMINAL_INTENTS,
  REOPEN_INTENTS,
  A2A_HOP_LIMIT,
} from '../classifiers/a2a.js';

function tc(args: Record<string, unknown>, name = 'send_to_agent'): ToolCall {
  return { id: 'tc_a2a', name, arguments: args };
}

describe('a2aReplyEnforcer', () => {
  const base = {
    triggeredByReplyNeededIntent: true,
    sentToAgentThisTurn: false,
    alreadyNudgedForMissedReply: false,
    agentProducedText: true,
    intent: 'QUESTION',
    threadShort: 'a1b2c3d4',
    fromName: 'Sensei',
  };

  it('does not nudge if not triggered by reply-needed intent', () => {
    const r = a2aReplyEnforcer({ ...base, triggeredByReplyNeededIntent: false });
    expect(r.decision).toBe('no_action');
  });

  it('does not nudge if already replied via send_to_agent', () => {
    const r = a2aReplyEnforcer({ ...base, sentToAgentThisTurn: true });
    expect(r.decision).toBe('no_action');
  });

  it('does not nudge twice (fire-once policy)', () => {
    const r = a2aReplyEnforcer({ ...base, alreadyNudgedForMissedReply: true });
    expect(r.decision).toBe('no_action');
  });

  it('does not nudge if agent produced no text', () => {
    const r = a2aReplyEnforcer({ ...base, agentProducedText: false });
    expect(r.decision).toBe('no_action');
  });

  it('NUDGES when all conditions met', () => {
    const r = a2aReplyEnforcer(base);
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') {
      expect(r.nudgeText).toContain('Sensei');
      expect(r.nudgeText).toContain('a1b2c3d4');
      expect(r.nudgeText).toContain('QUESTION');
      expect(r.nudgeText).toContain('send_to_agent');
    }
  });
});

describe('a2aIntentValidator', () => {
  const base = {
    call: tc({ agent: 'b', intent: 'QUESTION', message: 'hi' }),
    threadIsClosed: false,
    hopCount: 0,
  };

  it('returns ok for non-A2A tool calls', () => {
    const r = a2aIntentValidator({ ...base, call: tc({ path: '/x' }, 'file_read') });
    expect(r.decision).toBe('ok');
  });

  it('rejects send_to_agent without intent', () => {
    const r = a2aIntentValidator({ ...base, call: tc({ agent: 'b', message: 'hi' }) });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') {
      expect(r.reason).toContain('intent');
    }
  });

  it('rejects send_to_agent with empty intent', () => {
    const r = a2aIntentValidator({ ...base, call: tc({ agent: 'b', intent: '', message: 'hi' }) });
    expect(r.decision).toBe('reject');
  });

  it('accepts valid send_to_agent', () => {
    const r = a2aIntentValidator(base);
    expect(r.decision).toBe('ok');
  });

  it('rejects terminal intent on closed thread', () => {
    const r = a2aIntentValidator({
      ...base,
      call: tc({ agent: 'b', intent: 'ANSWER', thread_id: 'thr-1', message: 'k' }),
      threadIsClosed: true,
    });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') {
      expect(r.reason).toContain('closed');
    }
  });

  it('allows QUESTION/BLOCK/ASSIGN to reopen a closed thread', () => {
    for (const intent of ['QUESTION', 'BLOCK', 'ASSIGN']) {
      const r = a2aIntentValidator({
        ...base,
        call: tc({ agent: 'b', intent, thread_id: 'thr-1', message: 'k' }),
        threadIsClosed: true,
      });
      expect(r.decision).toBe('ok');
    }
  });

  it('rejects when hop count reaches the limit', () => {
    const r = a2aIntentValidator({ ...base, hopCount: A2A_HOP_LIMIT });
    expect(r.decision).toBe('reject');
    if (r.decision === 'reject') {
      expect(r.reason).toContain('hop limit');
    }
  });

  it('accepts when hop count is just under the limit', () => {
    const r = a2aIntentValidator({ ...base, hopCount: A2A_HOP_LIMIT - 1 });
    expect(r.decision).toBe('ok');
  });

  it('also validates broadcast_to_group', () => {
    const r = a2aIntentValidator({
      ...base,
      call: tc({ group_id: 'g1', message: 'hi' }, 'broadcast_to_group'),
    });
    expect(r.decision).toBe('reject');
  });
});

describe('parseA2ATrigger', () => {
  it('returns null for null input', () => {
    expect(parseA2ATrigger(null)).toBeNull();
  });

  it('returns null for non-A2A messages', () => {
    expect(parseA2ATrigger('Just a regular user message')).toBeNull();
  });

  it('parses a QUESTION intent', () => {
    const r = parseA2ATrigger('[A2A:QUESTION thread:abcd1234 from:Sensei] Can you check this?');
    expect(r).not.toBeNull();
    expect(r!.intent).toBe('QUESTION');
    expect(r!.threadShort).toBe('abcd1234');
    expect(r!.fromName).toBe('Sensei');
  });

  it('parses ASSIGN and BLOCK', () => {
    expect(parseA2ATrigger('[A2A:ASSIGN thread:11112222 from:PM] Take this on')).toMatchObject({ intent: 'ASSIGN' });
    expect(parseA2ATrigger('[A2A:BLOCK thread:33334444 from:Apprentice] I am stuck')).toMatchObject({ intent: 'BLOCK' });
  });

  it('returns null for terminal intents (no reply expected)', () => {
    expect(parseA2ATrigger('[A2A:ANSWER thread:55556666 from:Bot] here you go')).toBeNull();
    expect(parseA2ATrigger('[A2A:DELIVERABLE thread:77778888 from:Bot] done')).toBeNull();
    expect(parseA2ATrigger('[A2A:FYI thread:99990000 from:Bot] heads up')).toBeNull();
    expect(parseA2ATrigger('[A2A:COMPLETE thread:aaaa1111 from:Bot] finished')).toBeNull();
    expect(parseA2ATrigger('[A2A:FAIL thread:bbbb2222 from:Bot] gave up')).toBeNull();
  });

  it('exposes intent constants', () => {
    expect(REPLY_NEEDED_INTENTS.has('QUESTION')).toBe(true);
    expect(REPLY_NEEDED_INTENTS.has('ASSIGN')).toBe(true);
    expect(REPLY_NEEDED_INTENTS.has('BLOCK')).toBe(true);
    expect(REPLY_NEEDED_INTENTS.has('FYI')).toBe(false);
    expect(TERMINAL_INTENTS.has('ANSWER')).toBe(true);
    expect(REOPEN_INTENTS.has('QUESTION')).toBe(true);
  });
});
