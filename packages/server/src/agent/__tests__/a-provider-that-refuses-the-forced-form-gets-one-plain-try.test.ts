// A provider that refuses the required-reply form (HTTP 400) gets one ordinary call in its
// place: no tool choice, the model's own thinking setting, the same messages.
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
import { db, wire, HISTORY, resetWire, seedProviders, startStub } from './fixtures/provider-wire.js';

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

describe('a provider that refuses the forced form gets one plain try', () => {
  it('the refused call is followed by exactly one ordinary call, whose answer is returned', async () => {
    await callModel({ agentId: 'a-deepseek', modelId: 'm-deepseek', messages: structuredClone(HISTORY), systemPrompt: 'S' });
    wire.replies.push({ status: 400 }, { text: 'It means hello.' });
    const r = await callModel({ agentId: 'a-deepseek', modelId: 'm-deepseek', messages: structuredClone(HISTORY), systemPrompt: 'S', forceReply: true });
    expect(wire.http).toHaveLength(3);
    expect(JSON.parse(wire.http[1].body).tool_choice).toEqual({ type: 'function', function: { name: 'reply' } });
    expect(wire.http[2].body).toBe(wire.http[0].body);
    expect(r.content).toBe('It means hello.');
  });

  it('any other failure is not retried', async () => {
    wire.replies.push({ status: 401 });
    const err = await callModel({ agentId: 'a-compatible', modelId: 'm-compatible', messages: structuredClone(HISTORY), systemPrompt: 'S', forceReply: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(wire.http).toHaveLength(1);
  });
});
