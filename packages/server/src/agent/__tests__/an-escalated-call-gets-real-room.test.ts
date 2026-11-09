// ════════════════════════════════════════════════════════════════════════════════════════
// t195 (D2) — THE MODEL THAT RAN OUT OF ROOM GETS ROOM, AND THE LEVEL IT THINKS AT IS SENT.
//
// THE DEFECT, from the code at the v3.3.3 base: `outputTokensEscalated` was set by the
// truncation rung and read by NOBODY, so the "escalated retry" went out at the SAME
// `max_tokens`. The owner's "ran out of room, twice" is that: two identical budgets.
//
// What this file pins, at the two pure doors (`resolveOutputBudget` and
// `applyProviderRequestParams`) that decide the wire:
//   1. an ASK for more room (the escalation) is honoured, bounded by what the model can hold:
//      the window's room, and the contract's own ceiling, never the provider maximum as the
//      everyday number (owner ruling 10);
//   2. an ask never LOWERS the everyday budget;
//   3. DeepSeek's native contract sends its `reasoning_effort` (low | high | max, official
//      docs); a contract with no level support never gets the parameter (owner ruling 8/9).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { resolveOutputBudget, applyProviderRequestParams } from '../model.js';
import { contractForModel } from '../model-contract.js';

const thinkingRow = {
  contextWindow: 1_000_000,
  maxOutputTokens: 16_384,
  thinkingEnabled: true,
  capabilities: ['text', 'thinking'],
  outputEscalationCeiling: 384_000 as number | null,
};

describe('t195 (a) — an escalated ask is real room on the wire', () => {
  it('the everyday number is the modest stored cap, with no ask', () => {
    expect(resolveOutputBudget(thinkingRow, 5_000)).toBe(16_384);
  });

  it('an ask above the everyday cap is honoured (the retry is NOT the same budget)', () => {
    expect(resolveOutputBudget(thinkingRow, 5_000, 32_768)).toBe(32_768);
    expect(resolveOutputBudget(thinkingRow, 5_000, 32_768)).toBeGreaterThan(resolveOutputBudget(thinkingRow, 5_000));
  });

  it('the ask is bounded by the contract ceiling', () => {
    expect(resolveOutputBudget(thinkingRow, 5_000, 900_000)).toBe(384_000);
  });

  it('the ask is bounded by the window room, whatever the ceiling says', () => {
    const tight = { ...thinkingRow, contextWindow: 100_000 };
    // 100,000 - 90,000 input - 1,000 headroom = 9,000 of room; nothing may be asked beyond it.
    expect(resolveOutputBudget(tight, 90_000, 500_000)).toBe(9_000);
    // and with room for it, the window term is the bound, not the ceiling.
    expect(resolveOutputBudget(tight, 10_000, 500_000)).toBe(89_000);
  });

  it('with no declared ceiling an ask never exceeds the stored cap (nothing is invented about a provider)', () => {
    const unknown = { ...thinkingRow, outputEscalationCeiling: null };
    expect(resolveOutputBudget(unknown, 5_000, 40_000)).toBe(16_384);
  });

  it('an ask never lowers the everyday budget', () => {
    expect(resolveOutputBudget(thinkingRow, 5_000, 100)).toBe(16_384);
    expect(resolveOutputBudget(thinkingRow, 5_000, 0)).toBe(16_384);
  });
});

describe('t195 — the contract declares what escalation and levels each family supports', () => {
  it("DeepSeek's native contract: a documented ceiling and its three levels", () => {
    const c = contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-v4-pro' });
    expect(c.outputEscalationCeiling).toBe(384_000);
    expect([...c.thinkingLevels]).toEqual(['low', 'high', 'max']);
  });

  it('every other family declares no levels and no ceiling beyond the stored cap', () => {
    for (const entry of [
      { providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'deepseek/deepseek-v4-pro' },
      { providerBaseUrl: 'https://api.example.com', apiModelId: 'some-model' },
    ]) {
      const c = contractForModel(entry);
      expect(c.thinkingLevels.length).toBe(0);
      expect(c.outputEscalationCeiling).toBeNull();
    }
  });
});

describe('t195 (b) — the thinking level reaches the wire only where the contract supports levels', () => {
  const fresh = () => ({ model: 'm', messages: [], stream: true }) as unknown as OpenAI.ChatCompletionCreateParams;
  const read = (p: OpenAI.ChatCompletionCreateParams) => p as unknown as Record<string, unknown>;
  const ds = contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-v4-pro' });

  it('sends reasoning_effort beside the thinking toggle, for each level', () => {
    for (const level of ['low', 'high', 'max'] as const) {
      const p = fresh();
      applyProviderRequestParams(p, ds, { supportsThinking: true, thinkingEnabled: true, thinkingLevel: level });
      expect(read(p).thinking).toEqual({ type: 'enabled' });
      expect(read(p).reasoning_effort).toBe(level);
    }
  });

  it('sends no effort when thinking is off', () => {
    const p = fresh();
    applyProviderRequestParams(p, ds, { supportsThinking: true, thinkingEnabled: false, thinkingLevel: 'max' });
    expect(read(p).thinking).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in read(p)).toBe(false);
  });

  it('sends no effort when the model cannot think at all', () => {
    const p = fresh();
    applyProviderRequestParams(p, ds, { supportsThinking: false, thinkingEnabled: true, thinkingLevel: 'high' });
    expect('reasoning_effort' in read(p)).toBe(false);
  });

  it('NEVER sends the parameter on a contract without level support', () => {
    for (const entry of [
      { providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'minimax/minimax-m2.7' },
      { providerBaseUrl: 'https://api.example.com', apiModelId: 'some-model' },
    ]) {
      const p = fresh();
      applyProviderRequestParams(p, contractForModel(entry), { supportsThinking: true, thinkingEnabled: true, thinkingLevel: 'max' });
      expect('reasoning_effort' in read(p)).toBe(false);
      expect(JSON.stringify(read(p).extra_body ?? {})).not.toContain('effort');
    }
  });

  it('a stored level the contract does not offer is not sent (never an unsupported value)', () => {
    const p = fresh();
    applyProviderRequestParams(p, ds, { supportsThinking: true, thinkingEnabled: true, thinkingLevel: 'ultra' as never });
    expect('reasoning_effort' in read(p)).toBe(false);
  });
});
