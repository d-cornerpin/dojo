// ════════════════════════════════════════════════════════════════════════════════════
// HL1 — THE REQUEST-SHAPE PIN, ONE ROW PER CONFIGURED MODEL CLASS.
//
// HL1 relocates the model client's provider-name branches onto a declared per-model
// capability contract. A relocation that changes a byte on the wire is not a
// relocation, so the wire shape is PINNED first (this file + its golden), the branches
// move second, and the golden is the proof: it is recorded from the pre-migration code
// and must not move by one byte when the contract lands.
//
// This is the W15 roster precedent — pin, migrate, compare.
//
// WHAT A ROW PINS, for one configured model:
//   • `baseUrl`  — what the OpenAI SDK is pointed at (the bare-host `/v1` rule).
//   • `messages` — the whole `openaiMessages` array, including every `reasoning_content`
//                  key and the system message's cache marker.
//   • `extras`   — the provider-shaped request knobs (`thinking`, `extra_body.reasoning`).
//
// THE GOLDEN HAS MOVED EXACTLY ONCE, and this is the record of it. HL8 (C) adopted dsh's
// drop-on-plain replay rule, so every `reasoning_content` key on a PLAIN assistant message
// (`tool_calls` empty) left the wire — 6,536 -> 6,028 bytes across the roster. Nothing else
// changed on any row: same base URLs, same request knobs, same message count, and every
// tool-call message kept its reasoning INCLUDING the `''` 400-guard. The golden is what
// proved that scope rather than asserting it.
//
// THE ROSTER is every model class configured on a real box, taken from the dev box's
// own `models` table (2026-08-15): DeepSeek Flash and Pro behind `api.deepseek.com`,
// OpenRouter models with and without the `thinking` capability, a generic
// openai-compatible provider, and the bare OpenAI default with no base URL.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { buildOpenAIMessages, resolveOpenAIBaseUrl, applyProviderRequestParams } from '../model.js';
import { contractForModel } from '../model-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(__dirname, '__goldens__', 'request-shape-per-configured-model.json');

/** One configured model, in exactly the fields `getModelInfo` hands the dispatcher. */
interface RosterEntry {
  readonly label: string;
  readonly apiModelId: string;
  readonly providerBaseUrl: string | null;
  readonly thinkingEnabled: boolean;
  readonly capabilities: string[];
}

const ROSTER: RosterEntry[] = [
  { label: 'deepseek-v4-flash (thinking on)', apiModelId: 'deepseek-v4-flash', providerBaseUrl: 'https://api.deepseek.com', thinkingEnabled: true, capabilities: ['chat', 'code', 'tools', 'thinking'] },
  { label: 'deepseek-v4-pro (thinking off)', apiModelId: 'deepseek-v4-pro', providerBaseUrl: 'https://api.deepseek.com', thinkingEnabled: false, capabilities: ['chat', 'code', 'tools', 'thinking'] },
  { label: 'openrouter minimax/minimax-m2.7 (thinking capable)', apiModelId: 'minimax/minimax-m2.7', providerBaseUrl: 'https://openrouter.ai/api', thinkingEnabled: true, capabilities: ['tools', 'thinking'] },
  { label: 'openrouter google/gemini-2.5-flash-image (no thinking capability)', apiModelId: 'google/gemini-2.5-flash-image', providerBaseUrl: 'https://openrouter.ai/api', thinkingEnabled: true, capabilities: ['vision', 'image_generation'] },
  { label: 'generic openai-compatible', apiModelId: 'some-local-model', providerBaseUrl: 'https://api.example.com', thinkingEnabled: true, capabilities: ['tools', 'thinking'] },
  { label: 'openai default (no base url)', apiModelId: 'gpt-5-mini', providerBaseUrl: null, thinkingEnabled: false, capabilities: ['tools'] },
];

/**
 * The fixture conversation. Every assistant arm the builder has is represented, with
 * and without stored reasoning, because the `reasoning_content` key is exactly what
 * HL1 relocates and what HL8-C later narrows.
 */
const FIXTURE_MESSAGES: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }> = [
  { role: 'user', content: 'What is the weather and then summarise it?' },
  { role: 'assistant', content: 'On it — checking now.', reasoningContent: 'R-PLAIN-STRING' },
  { role: 'assistant', content: 'A plain line with no stored reasoning at all.' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Looking it up.' },
      { type: 'tool_use', id: 'call_1', name: 'web_search', input: { q: 'weather' } },
    ] as unknown as Anthropic.ContentBlockParam[],
    reasoningContent: 'R-TOOLCALL',
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'It is 18C and raining.' }] as unknown as Anthropic.ContentBlockParam[],
  },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_2', name: 'get_current_time', input: {} }] as unknown as Anthropic.ContentBlockParam[],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_2', content: '12:05' }] as unknown as Anthropic.ContentBlockParam[],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Block content, text only, no tool call.' }] as unknown as Anthropic.ContentBlockParam[],
    reasoningContent: 'R-BLOCK-TEXT-ONLY',
  },
  { role: 'user', content: 'Thanks.' },
];

const SYSTEM_PROMPT = 'You are a test agent.\nBe brief.';

// Before HL1's migration this function reproduced `callOpenAIModel`'s own two
// provider-name checks (`baseUrl.includes('deepseek.com')` /
// `baseUrl.includes('openrouter.ai')`) and handed them to the builder as booleans; the
// golden was recorded from THAT. It now takes the same two decisions through the
// contract, and the golden file did not move — which is the whole claim of HL1.
async function shapeFor(entry: RosterEntry): Promise<unknown> {
  const contract = contractForModel(entry);
  const messages = await buildOpenAIMessages(
    SYSTEM_PROMPT,
    FIXTURE_MESSAGES,
    'test-agent',
    contract,
    '',
  );
  const requestParams = {
    model: entry.apiModelId,
    messages: [],
    stream: true,
  } as unknown as OpenAI.ChatCompletionCreateParams;
  applyProviderRequestParams(requestParams, contract, {
    supportsThinking: entry.capabilities.includes('thinking'),
    thinkingEnabled: entry.thinkingEnabled,
  });
  const { model: _m, messages: _msgs, stream: _s, ...extras } = requestParams as unknown as Record<string, unknown>;
  return {
    label: entry.label,
    baseUrl: resolveOpenAIBaseUrl(entry.providerBaseUrl) ?? null,
    messages,
    extras,
  };
}

describe('HL1 — the request shape is byte-identical per configured model', () => {
  it('matches the recorded golden for every configured model class', async () => {
    const shapes = [];
    for (const entry of ROSTER) shapes.push(await shapeFor(entry));
    const actual = JSON.stringify(shapes, null, 2) + '\n';

    if (process.env.HL1_RECORD_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, actual, 'utf-8');
    }

    const expected = fs.readFileSync(GOLDEN, 'utf-8');
    expect(actual).toBe(expected);
  });

  it('covers every branch the golden is meant to hold still', async () => {
    const shapes = (await Promise.all(ROSTER.map(shapeFor))) as Array<{
      label: string; baseUrl: string | null;
      messages: Array<Record<string, unknown>>;
      extras: Record<string, unknown>;
    }>;
    const byLabel = new Map(shapes.map((s) => [s.label, s]));

    // The bare-host rule: DeepSeek keeps its root, everyone else gets /v1.
    expect(byLabel.get('deepseek-v4-flash (thinking on)')!.baseUrl).toBe('https://api.deepseek.com');
    expect(byLabel.get('generic openai-compatible')!.baseUrl).toBe('https://api.example.com/v1');
    expect(byLabel.get('openai default (no base url)')!.baseUrl).toBeNull();

    // The thinking toggles.
    expect(byLabel.get('deepseek-v4-flash (thinking on)')!.extras).toEqual({ thinking: { type: 'enabled' } });
    expect(byLabel.get('deepseek-v4-pro (thinking off)')!.extras).toEqual({ thinking: { type: 'disabled' } });
    expect(byLabel.get('openrouter minimax/minimax-m2.7 (thinking capable)')!.extras)
      .toEqual({ extra_body: { reasoning: { enabled: true } } });
    expect(byLabel.get('openrouter google/gemini-2.5-flash-image (no thinking capability)')!.extras).toEqual({});
    expect(byLabel.get('generic openai-compatible')!.extras).toEqual({});

    // The system message's cache marker: OpenRouter gets the explicit block form.
    expect(byLabel.get('openrouter minimax/minimax-m2.7 (thinking capable)')!.messages[0].content)
      .toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(byLabel.get('deepseek-v4-flash (thinking on)')!.messages[0].content).toBe(SYSTEM_PROMPT);
  });
});
