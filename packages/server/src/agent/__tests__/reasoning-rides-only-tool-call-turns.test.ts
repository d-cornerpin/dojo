// ════════════════════════════════════════════════════════════════════════════════════════
// HL8 (C) — REASONING RIDES TOOL-CALL TURNS ONLY.
//
// dsh's official passback rule, from their own source
// (`packages/llm/llm-deepseek/src/serialize.ts:96-100`, quoting `guides/thinking_mode.mdx`):
//
//     reasoning_content must return on tool-call turns; it is ignored on plain
//     turns, so we drop it there to save tokens.
//
// We did the opposite: `reasoning_content` was attached to every assistant message we had
// it for, and NOTHING anywhere checked whether the message had tool calls. W23 measured
// the waste on a live 32,367-token request: 3,535 characters ≈ 884 tokens (2.7%) across
// six plain assistant messages. The dollars are trivial; the window occupancy is not, and
// it grows without bound — 3,191 stored plain assistant rows on the dev box carry
// reasoning, mean 652 chars.
//
// RED clauses 1 and 2 fail at `07434e0` (and at `514f3af`); clause 3 and the controls pass
// before and after, because the REQUIREMENT — reasoning on tool-call turns, and the 400
// guard behind it — must not regress.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildOpenAIMessages } from '../model.js';
import { contractForModel, type ModelContract } from '../model-contract.js';

const REPLAYS: ModelContract = contractForModel({ providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-v4-flash' });
const NO_REPLAY: ModelContract = contractForModel({ providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'minimax/minimax-m2.7' });

const blocks = (b: unknown[]): Anthropic.ContentBlockParam[] => b as unknown as Anthropic.ContentBlockParam[];
const TEXT_BLOCK = { type: 'text', text: 'Here is the answer.' };
const TOOL_BLOCK = { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'x' } };

const build = (
  msgs: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }>,
  contract: ModelContract,
): Promise<Array<Record<string, unknown>>> =>
  buildOpenAIMessages('SYS', msgs, 'kevin', contract, '') as unknown as Promise<Array<Record<string, unknown>>>;

describe('HL8 (C) — the drop-on-plain replay rule', () => {
  it('RED 1 — a plain STRING-content assistant message carries no reasoning_content key at all', async () => {
    const [, msg] = await build([{ role: 'assistant', content: 'On it.', reasoningContent: 'R' }], REPLAYS);
    expect('reasoning_content' in msg).toBe(false);
    expect(msg.content).toBe('On it.');
  });

  it('RED 1b — and the `\'\'` fallback is gone from the string arm too', async () => {
    const [, msg] = await build([{ role: 'assistant', content: 'On it.' }], REPLAYS);
    expect('reasoning_content' in msg).toBe(false);
  });

  it('RED 2 — a BLOCK-content assistant message with text blocks only carries none either', async () => {
    const [, msg] = await build([{ role: 'assistant', content: blocks([TEXT_BLOCK]), reasoningContent: 'R' }], REPLAYS);
    expect('reasoning_content' in msg).toBe(false);
    expect(msg.tool_calls).toBeUndefined();
  });

  it('GREEN 3 — THE REQUIREMENT: a tool-call turn still replays its reasoning', async () => {
    const [, msg] = await build([{ role: 'assistant', content: blocks([TEXT_BLOCK, TOOL_BLOCK]), reasoningContent: 'R' }], REPLAYS);
    expect(msg.reasoning_content).toBe('R');
    expect((msg.tool_calls as unknown[]).length).toBe(1);
  });

  it('CONTROL 1 — the 400 guard survives: a tool-call turn with no stored reasoning still gets `\'\'`', async () => {
    const [, msg] = await build([{ role: 'assistant', content: blocks([TOOL_BLOCK]) }], REPLAYS);
    expect(msg.reasoning_content).toBe('');
  });

  it('CONTROL 2 — a contract that does not require replay is unchanged on both arms', async () => {
    const [, withReasoning] = await build([{ role: 'assistant', content: blocks([TOOL_BLOCK]), reasoningContent: 'R' }], NO_REPLAY);
    expect(withReasoning.reasoning_content).toBe('R');
    const [, without] = await build([{ role: 'assistant', content: blocks([TOOL_BLOCK]) }], NO_REPLAY);
    expect('reasoning_content' in without).toBe(false);
    const [, plain] = await build([{ role: 'assistant', content: 'hi', reasoningContent: 'R' }], NO_REPLAY);
    expect('reasoning_content' in plain).toBe(false);
  });

  it('CONTROL 3 — nothing else about the messages moved', async () => {
    const wire = await build([
      { role: 'user', content: 'ask' },
      { role: 'assistant', content: blocks([TEXT_BLOCK, TOOL_BLOCK]), reasoningContent: 'R' },
      { role: 'user', content: blocks([{ type: 'tool_result', tool_use_id: 'call_1', content: 'result' }]) },
      { role: 'assistant', content: 'done' },
    ], REPLAYS);
    expect(wire.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(wire[2].content).toBe('Here is the answer.');
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result' });
    expect(wire[4]).toEqual({ role: 'assistant', content: 'done' });
  });
});
