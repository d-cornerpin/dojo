// One provider of each form in `model.ts`, seeded into a test DB, with every request the real
// builders send captured as it leaves: an HTTP stub for OpenAI, OpenAI-compatible and Ollama,
// a fake Anthropic SDK client, and a fake subscription (Agent SDK) call.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';

export const db: { current: Database.Database | null } = { current: null };

export const FIXED_TOOLS = ['file_read', 'load_tool_docs', 'web_fetch'].map((name) => ({
  name,
  description: `The ${name} tool.`,
  input_schema: { type: 'object', properties: { arg: { type: 'string' } }, required: ['arg'] },
}));

/** What the next HTTP request is answered with. */
export type StubReply = { text: string } | { toolCall: { name: string; args: string } } | { status: number };

export const wire = {
  http: [] as Array<{ url: string; body: string }>,
  replies: [] as StubReply[],
  anthropic: [] as unknown[],
  anthropicReplies: [] as StubReply[],
  sdk: [] as Array<Record<string, unknown>>,
  url: '',
};

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });

function answer(res: http.ServerResponse, url: string, reply: StubReply): void {
  if ('status' in reply) {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'tool_choice is not supported', type: 'invalid_request_error' } }));
    return;
  }
  if (url.startsWith('/api/chat')) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'text' in reply ? reply.text : '' } })}\n`);
    res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 })}\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if ('text' in reply) res.write(chunk({ content: reply.text }));
  else res.write(chunk({ tool_calls: [{ index: 0, id: 'call_r', type: 'function', function: { name: reply.toolCall.name, arguments: reply.toolCall.args } }] }));
  res.write(chunk({}, 'text' in reply ? 'stop' : 'tool_calls'));
  res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
  res.end('data: [DONE]\n\n');
}

export async function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const url = req.url ?? '';
      if (!url.includes('/chat/completions') && !url.startsWith('/api/chat')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      wire.http.push({ url, body: raw });
      answer(res, url, wire.replies.shift() ?? { text: 'Plain answer.' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  wire.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return server;
}

/** The `@anthropic-ai/sdk` module, faked: `messages.stream` records its request and plays a reply. */
export function fakeAnthropicModule(): Record<string, unknown> {
  class APIError extends Error {
    constructor(readonly status: number) { super(`${status} tool_choice is not supported`); }
  }
  class FakeStream {
    private handlers: Record<string, Array<(x: unknown) => void>> = {};
    constructor(private reply: StubReply) {}
    on(ev: string, fn: (x: unknown) => void): FakeStream { (this.handlers[ev] ??= []).push(fn); return this; }
    async finalMessage(): Promise<unknown> {
      if ('status' in this.reply) throw new APIError(this.reply.status);
      if ('text' in this.reply) for (const fn of this.handlers.text ?? []) fn(this.reply.text);
      else {
        const block = { type: 'tool_use', id: 'toolu_r', name: this.reply.toolCall.name, input: JSON.parse(this.reply.toolCall.args) };
        for (const fn of this.handlers.contentBlock ?? []) fn(block);
      }
      return { content: [], stop_reason: 'text' in this.reply ? 'end_turn' : 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
    }
  }
  class FakeAnthropic {
    static APIError = APIError;
    messages = {
      stream: (params: unknown): FakeStream => {
        wire.anthropic.push(JSON.parse(JSON.stringify(params)));
        return new FakeStream(wire.anthropicReplies.shift() ?? { text: 'Plain answer.' });
      },
    };
  }
  return { default: FakeAnthropic, APIError };
}

/** `providers/anthropic-sdk.js`, faked: the subscription call records what it was given. */
export function fakeSdkModule(): Record<string, unknown> {
  return {
    AgentSdkVisionUnsupportedError: class extends Error {},
    AgentSdkPatienceExceededError: class extends Error {},
    callAnthropicViaSdk: async (p: Record<string, unknown>) => {
      wire.sdk.push({ apiModelId: p.apiModelId, systemPrompt: p.systemPrompt, messages: p.messages, tools: p.tools, timeoutMs: p.timeoutMs, idleTimeoutMs: p.idleTimeoutMs });
      return { content: 'Plain answer.', toolCalls: [], inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
    },
  };
}

export const PROVIDER_FORMS = ['anthropic', 'openai', 'compatible', 'deepseek', 'openrouter', 'ollama', 'sdk'] as const;
export type ProviderForm = typeof PROVIDER_FORMS[number];

/** One provider, one thinking model and one agent per form; agent id = `a-<form>`, model id = `m-<form>`. */
export function seedProviders(setCredential: (id: string, key: string, kind: 'api_key') => void): void {
  const d = db.current!;
  const rows: Array<[ProviderForm, string, string | null, string, string | null, string]> = [
    ['anthropic', 'anthropic', null, 'api_key', null, 'claude-x'],
    ['openai', 'openai', `${wire.url}/v1`, 'api_key', null, 'gpt-x'],
    ['compatible', 'openai-compatible', `${wire.url}/v1`, 'none', null, 'local-x'],
    ['deepseek', 'openai-compatible', `${wire.url}/v1`, 'none', 'deepseek-native', 'deepseek-v4-flash'],
    ['openrouter', 'openai-compatible', `${wire.url}/v1`, 'none', 'openrouter-proxy', 'vendor/model-x'],
    ['ollama', 'ollama', wire.url, 'none', null, 'local-ollama'],
    ['sdk', 'anthropic', null, 'agent-sdk', null, 'claude-sub'],
  ];
  for (const [form, type, base, auth, behaves, api] of rows) {
    d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, behaves_like, is_validated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`).run(`p-${form}`, form, type, base, auth, behaves);
    d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, thinking_enabled, is_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, '["text","tools","thinking"]', 65536, 4096, 1, 1, datetime('now'), datetime('now'))`).run(`m-${form}`, `p-${form}`, form, api);
    d.prepare(`INSERT INTO agents (id, name, model_id, status, config, always_loaded_tools, created_at, updated_at)
      VALUES (?, ?, ?, 'idle', '{}', '["file_read"]', datetime('now'), datetime('now'))`).run(`a-${form}`, `Agent ${form}`, `m-${form}`);
    if (auth === 'api_key') setCredential(`p-${form}`, 'sk-fake-test-key', 'api_key');
  }
}

/** A history with a finished tool round (and its reasoning) before the new message. */
export const HISTORY: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[]; reasoningContent?: string }> = [
  { role: 'user', content: 'Read the file please.' },
  { role: 'assistant', reasoningContent: 'I should read it.', content: [{ type: 'tool_use', id: 'call_1', name: 'file_read', input: { arg: '/x' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'The file says hello.' }] },
  { role: 'assistant', content: 'It says hello.' },
  { role: 'user', content: 'Thanks, and what does that mean?' },
];

/** Every request captured for the last call on this form, as the exact text that left. */
export function sentBodies(form: ProviderForm): string[] {
  if (form === 'anthropic') return wire.anthropic.map((p) => JSON.stringify(p, null, 1));
  if (form === 'sdk') return wire.sdk.map((p) => JSON.stringify(p, null, 1));
  return wire.http.map((r) => r.body);
}

export function resetWire(): void {
  wire.http = []; wire.replies = []; wire.anthropic = []; wire.anthropicReplies = []; wire.sdk = [];
}
