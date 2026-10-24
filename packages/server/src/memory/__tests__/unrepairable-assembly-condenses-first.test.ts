// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 — AN OVER-BUDGET ASSEMBLY WITH NOTHING TO DROP CONDENSES FIRST.
//
// The witness (the dev log, 2026-10-19): the provider boundary refused an assembly of 99,462 tokens
// against 98,703 "after dropping every droppable lane (none)" — UNREPAIRABLE. Only the other size
// refusal (LIVE_CONVERSATION_PROTECTED) started a condense, so the UNREPAIRABLE one went to the injury
// path, which re-ran the IDENTICAL assembly three times, 5 s apart, and texted the owner "stuck".
//
// Here, through the real boundary door (`validateAtProviderBoundary`): an over-budget array whose rows
// carry no droppable lane takes the same door as the live-conversation refusal — a forced condense for
// the dialed window — and the refusal carries that condense so recovery can wait for it before the one
// re-assembly. An array whose system prompt alone leaves no room is the case no condense can help: it
// is refused with nothing condensed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';

const compaction = vi.hoisted(() => ({ calls: [] as Array<{ agentId: string; modelId: string; contextWindow: number; options: Record<string, unknown> }> }));
vi.mock('../compaction.js', () => ({
  checkAndCompact: async (agentId: string, modelId: string, contextWindow: number, options: Record<string, unknown>) => {
    compaction.calls.push({ agentId, modelId, contextWindow, options });
    return { compacted: true };
  },
  forcedCompactionOptions: () => ({ force: true }),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => ({ model_id: 'm-configured' }) }) }),
}));
vi.mock('../turn-patience.js', () => ({ turnPatienceMs: () => 60_000 }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 0 }));

import {
  validateAtProviderBoundary, AssemblyValidationError, assemblyTokens, type ValidatedMessage,
} from '../assembly-validation.js';
import { contextWindowPolicy, estimateTokens } from '../budget.js';

const AGENT = 'agent-d18-boundary';
const DIALED = 'm-dialed';
const WINDOW = 128_000;
const OUTPUT = 4_096;
const SYSTEM = 'You keep the dock ledger. '.repeat(40);

/** Rows with no lane tag (the in-turn rows a loop appends): nothing the repair may drop. Sized to be
 *  over the boundary's budget by a few hundred tokens, the witness's shape. */
function overBudgetRows(): ValidatedMessage[] {
  const budget = contextWindowPolicy(WINDOW, { toolPayloadTokens: 0, maxOutputTokens: OUTPUT }).assemblyBudgetTokens
    - estimateTokens(SYSTEM);
  const line = 'Counted another stack of crates on the north dock and wrote the total on the board. ';
  const rows: ValidatedMessage[] = [{ role: 'user', content: 'keep counting' }, { role: 'assistant', content: 'counting' }];
  let body = '';
  while (assemblyTokens([...rows, { role: 'user', content: body }]) <= budget + 700) body += line;
  return [...rows, { role: 'user', content: body }];
}

async function refusalFor(messages: ValidatedMessage[], systemPrompt: string): Promise<AssemblyValidationError> {
  try {
    await validateAtProviderBoundary({
      agentId: AGENT, modelId: DIALED, messages, systemPrompt, contextWindow: WINDOW, maxOutputTokens: OUTPUT,
      laneIds: messages.map(() => null),
    });
  } catch (e) {
    if (e instanceof AssemblyValidationError) return e;
    throw e;
  }
  throw new Error('the boundary did not refuse an over-budget array');
}

beforeEach(() => { compaction.calls.length = 0; });

describe('D18: an over-budget assembly with nothing to drop condenses first', () => {
  it('the witness shape is refused UNREPAIRABLE, with nothing dropped (precondition)', async () => {
    const err = await refusalFor(overBudgetRows(), SYSTEM);
    expect(err.code).toBe('UNREPAIRABLE');
    expect(err.message).toContain('after dropping every droppable lane (none)');
  });

  it('the refusal starts ONE forced condense for the dialed model and its window', async () => {
    const err = await refusalFor(overBudgetRows(), SYSTEM);
    await err.refusedDial?.condensed;
    expect(compaction.calls).toHaveLength(1);
    expect(compaction.calls[0]).toMatchObject({ agentId: AGENT, modelId: 'm-configured', contextWindow: WINDOW });
    expect(compaction.calls[0].options).toMatchObject({ force: true, dialedModelId: DIALED });
  });

  it('the refusal carries what was dialed and the condense, so recovery can wait for it', async () => {
    const err = await refusalFor(overBudgetRows(), SYSTEM);
    expect(err.refusedDial).toMatchObject({ modelId: DIALED, systemPromptTokens: estimateTokens(SYSTEM) });
    expect(err.refusedDial?.condensed).toBeInstanceOf(Promise);
  });

  it('a system prompt that alone leaves no room is refused with NOTHING condensed (no condense can help it)', async () => {
    const huge = 'You keep the dock ledger and every rule of the yard. '.repeat(12_000);
    const err = await refusalFor([{ role: 'user', content: 'keep counting' }], huge);
    expect(err.refusedDial).toMatchObject({ modelId: DIALED, condensed: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(compaction.calls).toHaveLength(0);
  });
});
