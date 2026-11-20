// A call that does not require the reply sends, on every provider form, exactly the request it
// sent before the required-reply option existed: the snapshot was taken by running the code
// before that change, and the prompt cache depends on these bytes staying put.
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
import { db, HISTORY, PROVIDER_FORMS, resetWire, seedProviders, sentBodies, startStub } from './fixtures/provider-wire.js';

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

describe('an ordinary call sends the same request as before', () => {
  it.each(PROVIDER_FORMS)('%s', async (form) => {
    markToolsLoaded(`a-${form}`, ['web_fetch']);
    await callModel({ agentId: `a-${form}`, modelId: `m-${form}`, messages: structuredClone(HISTORY), systemPrompt: 'You are a helpful agent.', systemVolatile: 'Now: a fixed moment.' });
    const bodies = sentBodies(form);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchSnapshot();
  });
});
