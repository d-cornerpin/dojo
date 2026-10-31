// ════════════════════════════════════════════════════════════════════════════════════════
// B14 — THE CLAUDE SDK PATH REPORTS THE PROVIDER'S REAL STOP REASON.
//
// `callAnthropicViaSdk` read assistant text and token deltas and nothing else, then returned
// `toolCalls.length > 0 ? 'tool_use' : 'end_turn'`. A reply the provider CUT at its output limit
// was therefore reported as a normal finish, so the engine's cut ladder (which keys on the
// provider's own word) could never fire on this transport, and a half-written reply ran as whole.
//
// Driven with a fake `query()` async iterable shaped like the SDK's real messages.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

type Msg = Record<string, unknown>;
const stream = { messages: [] as Msg[] };
// The suite's ONE scripted SDK mock (vitest.setup.ts): a file whose subject is the transport sets
// `globalThis.__scriptedAgentSdk` and clears it after, never a per-file `vi.mock` of the package.
const script = globalThis as { __scriptedAgentSdk?: unknown };

import { callAnthropicViaSdk } from '../anthropic-sdk.js';
import { isOutputCut } from '../../agent/v2/classifiers/output.js';

const TOOL_TEXT = '<tool_call><name>file_read</name><arguments>{"path":"/tmp/a"}</arguments></tool_call>';

const assistant = (text: string, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Msg => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 }, ...extra },
  ...top,
});

const run = () => callAnthropicViaSdk({
  agentId: 'a1', apiModelId: 'claude-sonnet-4-5', systemPrompt: 's',
  messages: [{ role: 'user', content: 'go' }],
  tools: [{ name: 'file_read', description: 'd', input_schema: { type: 'object', properties: {} } }], // a call parses only for an offered tool
} as never);

beforeEach(() => {
  stream.messages = [];
  script.__scriptedAgentSdk = { query: () => (async function* () { for (const m of stream.messages) yield m; })() };
});
afterEach(() => { script.__scriptedAgentSdk = undefined; });

describe('B14 — the SDK transport reads the provider\'s stop reason', () => {
  it('a cut (max_tokens) with a parsed tool call is reported as max_tokens, never tool_use', async () => {
    stream.messages = [assistant(`Reading it. ${TOOL_TEXT}`, { stop_reason: 'max_tokens' })];
    const r = await run();
    expect(r.toolCalls).toHaveLength(1);
    expect(r.stopReason).toBe('max_tokens');
    expect(isOutputCut(r.stopReason)).toBe(true);
  });

  it('end_turn with no tool call stays end_turn', async () => {
    stream.messages = [assistant('All done.', { stop_reason: 'end_turn' })];
    expect((await run()).stopReason).toBe('end_turn');
  });

  it('a normal finish with a parsed tool call is still tool_use (the SDK says end_turn; the call count decides)', async () => {
    stream.messages = [assistant(`Reading it. ${TOOL_TEXT}`, { stop_reason: 'end_turn' })];
    expect((await run()).stopReason).toBe('tool_use');
  });

  it('a stream with no stop reason anywhere falls back to the call count, as before', async () => {
    stream.messages = [assistant('hi')];
    expect((await run()).stopReason).toBe('end_turn');
    stream.messages = [assistant(TOOL_TEXT)];
    expect((await run()).stopReason).toBe('tool_use');
  });

  it('a streamed message_delta stop reason is read', async () => {
    stream.messages = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'cut off mid-sen' } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } },
    ];
    expect((await run()).stopReason).toBe('max_tokens');
  });

  it('the result message\'s stop reason is read', async () => {
    stream.messages = [
      assistant('cut off mid-sen'),
      { type: 'result', subtype: 'success', stop_reason: 'max_tokens' },
    ];
    expect((await run()).stopReason).toBe('max_tokens');
  });

  it('the assistant message\'s max_output_tokens error is a cut even when no stop reason came with it', async () => {
    stream.messages = [assistant('cut off mid-sen', {}, { error: 'max_output_tokens' })];
    const r = await run();
    expect(r.stopReason).toBe('max_output_tokens');
    expect(isOutputCut(r.stopReason)).toBe(true);
  });

  it('the LAST stop reason seen wins (an early null placeholder does not hide the real one)', async () => {
    stream.messages = [
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: null } } },
      assistant('cut off mid-sen', { stop_reason: 'max_tokens' }),
    ];
    expect((await run()).stopReason).toBe('max_tokens');
  });

  it('a cut once seen survives a later ordinary end_turn (the closing result cannot hide it)', async () => {
    stream.messages = [
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn' },
    ];
    const r = await run();
    expect(r.stopReason).toBe('max_tokens');
  });

  it('a cut survives a later ordinary end_turn even when a tool call parsed', async () => {
    stream.messages = [
      assistant(`Reading it. ${TOOL_TEXT}`, { stop_reason: 'max_tokens' }),
      { type: 'result', subtype: 'success', stop_reason: 'end_turn' },
    ];
    expect((await run()).stopReason).toBe('max_tokens');
  });

  it('an ordinary end_turn together with the max_output_tokens error is still a cut', async () => {
    stream.messages = [assistant('cut off mid-sen', { stop_reason: 'end_turn' }, { error: 'max_output_tokens' })];
    expect((await run()).stopReason).toBe('max_output_tokens');
  });
});
