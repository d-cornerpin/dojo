// A call that requires the reply names the `reply` tool where the transport can force a tool
// choice (OpenAI and compatible), with thinking off; the answer comes back as plain text.
// Elsewhere the call goes out exactly as an ordinary one: the plain try.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type http from 'node:http';

vi.mock('@anthropic-ai/sdk', async () => (await import('./fixtures/provider-wire.js')).fakeAnthropicModule());
vi.mock('../../providers/anthropic-sdk.js', async () => (await import('./fixtures/provider-wire.js')).fakeSdkModule());
vi.mock('../tools/surface.js', async () => {
  const { FIXED_TOOLS } = await import('./fixtures/provider-wire.js');
  return { getFilteredTools: () => FIXED_TOOLS };
});
vi.mock('../../db/connection.js', async () => {
  const { db } = await import('./fixtures/provider-wire.js');
  return { getDb: () => db.current!, closeDb: () => {}, getDbPath: () => ':memory:' };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { markToolsLoaded } from '../../tools/tool-docs.js';
import { callModel, clearClientCache } from '../model.js';
import { db, wire, HISTORY, PROVIDER_FORMS, resetWire, seedProviders, sentBodies, startStub } from './fixtures/provider-wire.js';

let server: http.Server;
beforeAll(async () => { server = await startStub(); });
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  clearSecretsCache();
  clearClientCache();
  db.current = new Database(':memory:');
  runMigrations();
  seedProviders(setProviderCredential);
  resetWire();
});
afterEach(() => { db.current?.close(); db.current = null; });

const call = (form: string, forceReply: boolean) => callModel({
  agentId: `a-${form}`, modelId: `m-${form}`, messages: structuredClone(HISTORY), systemPrompt: 'You are a helpful agent.', forceReply,
});
const body = (i: number): Record<string, unknown> => JSON.parse(wire.http[i].body) as Record<string, unknown>;
const names = (b: Record<string, unknown>): string[] => (b.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);

describe('a forced call requires the reply', () => {
  it.each(['openai', 'compatible', 'deepseek', 'openrouter'])('%s: the ordinary tools, then reply, named as the choice', async (form) => {
    await call(form, false);
    wire.replies.push({ toolCall: { name: 'reply', args: '{"text":"  It means hello.  "}' } });
    const r = await call(form, true);
    const [ordinary, forced] = [body(0), body(1)];
    expect(names(forced)).toEqual([...names(ordinary), 'reply']);
    expect((forced.tools as unknown[]).slice(0, -1)).toEqual(ordinary.tools);
    expect(forced.tool_choice).toEqual({ type: 'function', function: { name: 'reply' } });
    expect(forced.messages).toEqual(ordinary.messages);
    expect(r.content).toBe('It means hello.');
    expect(r.toolCalls).toEqual([]);
  });

  it('deepseek: the forced call is sent with thinking off', async () => {
    await call('deepseek', false);
    await call('deepseek', true);
    expect(body(0).thinking).toEqual({ type: 'enabled' });
    expect(body(1).thinking).toEqual({ type: 'disabled' });
    expect(body(1).reasoning_effort).toBeUndefined();
  });

  it('openrouter: the forced call is sent with reasoning off', async () => {
    await call('openrouter', true);
    expect(body(0).extra_body).toEqual({ reasoning: { enabled: false } });
  });

  it('a provider that ignored the choice keeps its ordinary answer whole', async () => {
    wire.replies.push({ toolCall: { name: 'file_read', args: '{"arg":"/y"}' } });
    const r = await call('compatible', true);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['file_read']);
  });

  it.each(['anthropic', 'ollama', 'sdk'] as const)('%s: the forced call goes out as the ordinary one', async (form) => {
    await call(form, false);
    await call(form, true);
    const bodies = sentBodies(form);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
});
