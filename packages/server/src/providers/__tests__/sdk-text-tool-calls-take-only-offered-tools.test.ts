// A <tool_call> tag in an SDK-transport answer is a call only for a tool this call offered; one
// rule shared with the OpenAI text fallback (agent/text-tool-fallback.ts). Fake data only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { callAnthropicViaSdk } from '../anthropic-sdk.js';

const script = globalThis as { __scriptedAgentSdk?: unknown };
const TAG = (name: string) => `<tool_call><name>${name}</name><arguments>{"path":"/tmp/a"}</arguments></tool_call>`;
let text = '';
const tool = (name: string) => ({ name, description: 'd', input_schema: { type: 'object', properties: {} } });
const run = (tools?: unknown[]) => callAnthropicViaSdk({
  agentId: 'a1', apiModelId: 'claude-sonnet-4-5', systemPrompt: 's',
  messages: [{ role: 'user', content: 'go' }], tools,
} as never);

beforeEach(() => {
  script.__scriptedAgentSdk = { query: () => (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } };
  })() };
});
afterEach(() => { script.__scriptedAgentSdk = undefined; });

describe('SDK transport text tool calls', () => {
  it('an offered tool is taken and its tag removed', async () => {
    text = `Reading. ${TAG('file_read')}`;
    const r = await run([tool('file_read')]);
    expect(r.toolCalls.map(c => c.name)).toEqual(['file_read']);
    expect(r.content).toBe('Reading.');
  });
  it('a tag naming a tool that was not offered stays in the reply', async () => {
    text = `Example: ${TAG('shell')}`;
    const r = await run([tool('file_read')]);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.content).toBe(text);
  });
  it('with no tools offered nothing is taken', async () => {
    text = `Example: ${TAG('file_read')}`;
    const r = await run();
    expect(r.toolCalls).toHaveLength(0);
    expect(r.content).toBe(text);
  });
});
