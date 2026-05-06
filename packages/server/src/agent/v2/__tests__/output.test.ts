import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { outputTruncationClassifier, outputPersistenceClassifier, sanitizeAssistantText } from '../classifiers/output.js';

describe('outputTruncationClassifier', () => {
  it('returns not truncated when stop_reason is end_turn', () => {
    const r = outputTruncationClassifier({ stopReason: 'end_turn', contentLength: 500, currentBudget: 8000 });
    expect(r.truncated).toBe(false);
  });

  it('returns not truncated when stop_reason is null', () => {
    const r = outputTruncationClassifier({ stopReason: null, contentLength: 500, currentBudget: 8000 });
    expect(r.truncated).toBe(false);
  });

  it('detects max_tokens (Anthropic)', () => {
    const r = outputTruncationClassifier({ stopReason: 'max_tokens', contentLength: 8000, currentBudget: 8000 });
    expect(r.truncated).toBe(true);
    if (r.truncated) {
      expect(r.escalateTo).toBe(16000);
    }
  });

  it('detects length (OpenAI)', () => {
    const r = outputTruncationClassifier({ stopReason: 'length', contentLength: 8000, currentBudget: 8000 });
    expect(r.truncated).toBe(true);
  });

  it('escalates 8K → 16K', () => {
    const r = outputTruncationClassifier({ stopReason: 'max_tokens', contentLength: 8000, currentBudget: 8000 });
    if (r.truncated) expect(r.escalateTo).toBe(16000);
  });

  it('escalates 16K → 32K', () => {
    const r = outputTruncationClassifier({ stopReason: 'max_tokens', contentLength: 16000, currentBudget: 16000 });
    if (r.truncated) expect(r.escalateTo).toBe(32000);
  });

  it('escalates 32K → 64K', () => {
    const r = outputTruncationClassifier({ stopReason: 'max_tokens', contentLength: 32000, currentBudget: 32000 });
    if (r.truncated) expect(r.escalateTo).toBe(64000);
  });

  it('returns null escalation when budget already at 64K', () => {
    const r = outputTruncationClassifier({ stopReason: 'max_tokens', contentLength: 64000, currentBudget: 64000 });
    if (r.truncated) {
      expect(r.escalateTo).toBeNull();
      expect(r.reason).toContain('exhausted');
    }
  });

  it('starts escalation from 8K when budget is 0 (not yet escalated)', () => {
    const r = outputTruncationClassifier({ stopReason: 'max_tokens', contentLength: 4000, currentBudget: 0 });
    if (r.truncated) expect(r.escalateTo).toBe(8000);
  });
});

describe('outputPersistenceClassifier', () => {
  function call(name: string): ToolCall {
    return { id: name, name, arguments: {} };
  }

  it('suppresses empty text', () => {
    const r = outputPersistenceClassifier({
      responseText: '',
      toolCallsThisTurn: [],
      isInterAgentTrigger: false,
      sentToAgentThisTurn: false,
    });
    expect(r.decision).toBe('suppress');
  });

  it('suppresses whitespace-only text', () => {
    const r = outputPersistenceClassifier({
      responseText: '   \n  ',
      toolCallsThisTurn: [],
      isInterAgentTrigger: false,
      sentToAgentThisTurn: false,
    });
    expect(r.decision).toBe('suppress');
  });

  it('persists normal text on user-triggered turn', () => {
    const r = outputPersistenceClassifier({
      responseText: 'Here is the answer.',
      toolCallsThisTurn: [],
      isInterAgentTrigger: false,
      sentToAgentThisTurn: false,
    });
    expect(r.decision).toBe('persist');
  });

  it('SUPPRESSES trailing text on inter-agent turn after send_to_agent', () => {
    const r = outputPersistenceClassifier({
      responseText: 'Done, I sent the message.',
      toolCallsThisTurn: [call('send_to_agent')],
      isInterAgentTrigger: true,
      sentToAgentThisTurn: true,
    });
    expect(r.decision).toBe('suppress');
    if (r.decision === 'suppress') {
      expect(r.reason).toContain('inter-agent');
    }
  });

  it('persists text on inter-agent turn when send_to_agent NOT called', () => {
    const r = outputPersistenceClassifier({
      responseText: 'I cannot help with that.',
      toolCallsThisTurn: [],
      isInterAgentTrigger: true,
      sentToAgentThisTurn: false,
    });
    expect(r.decision).toBe('persist');
  });
});

describe('sanitizeAssistantText (#39)', () => {
  it('returns null and empty unchanged', () => {
    expect(sanitizeAssistantText(null)).toBeNull();
    expect(sanitizeAssistantText('')).toBe('');
    expect(sanitizeAssistantText('   ')).toBe('   ');
  });

  it('replaces literal \\n with real newlines', () => {
    expect(sanitizeAssistantText('line1\\nline2\\nline3')).toBe('line1\nline2\nline3');
  });

  it('collapses 3+ consecutive newlines to 2', () => {
    expect(sanitizeAssistantText('a\n\n\n\nb')).toBe('a\n\nb');
    expect(sanitizeAssistantText('a\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves 1 and 2 newlines alone', () => {
    expect(sanitizeAssistantText('a\nb')).toBe('a\nb');
    expect(sanitizeAssistantText('a\n\nb')).toBe('a\n\nb');
  });

  it('combines literal \\n replacement with collapse', () => {
    expect(sanitizeAssistantText('hello\\n\\n\\n\\nworld')).toBe('hello\n\nworld');
  });

  it('skips JSON content (object)', () => {
    const json = '{"key":"value\\nwith\\nliteral"}';
    expect(sanitizeAssistantText(json)).toBe(json);
  });

  it('skips JSON content (array)', () => {
    const json = '[{"a":"\\n"}]';
    expect(sanitizeAssistantText(json)).toBe(json);
  });

  it('trims surrounding whitespace from sanitized output', () => {
    expect(sanitizeAssistantText('  \n  hello  \n  ')).toBe('hello');
  });
});
