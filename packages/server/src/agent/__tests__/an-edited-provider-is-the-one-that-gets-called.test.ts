// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T66b — AN EDIT REACHES THE NEXT CALL, NOT A CACHED CLIENT.
//
// The edit door writes a row and a secrets file. Neither is what a model call reads: the call
// reads an `OpenAI` client that was BUILT from them and then cached.
//
//   `getOpenAIClient` (model.ts) caches on `${providerId}:${baseUrl}` and closes over the
//   credential it read at construction time. Change the key while the base URL stays the
//   same — which is exactly what "rotate my API key" is — and the cache key is UNCHANGED, so
//   every later call keeps sending the OLD key until the process restarts. The user watches
//   an edit they made succeed and their calls keep failing with the key they just replaced.
//
// `setProviderCredential` does not save them either: it writes through `saveSecrets`, which
// records its own post-write mtime, so `invalidateIfStale`'s "the file changed under us" path
// (loader.ts:63-84, the one place that clears the client cache on its own) deliberately does
// NOT fire for our own writes. `POST /providers` knows this and calls `clearClientCache(id)`
// by hand after every credential write. The PATCH must do the same, and this file is what
// makes deleting that line fail loudly instead of quietly.
//
// ── WHY A REAL SERVER AND A REAL `callModel` ──
// The cache is module-private; there is no honest way to look at it. What CAN be observed is
// the only thing that matters — the bytes that reach the endpoint. So this drives the real
// door and the real model path against a real HTTP server and reads the `authorization`
// header off the request, in T64b's `the-patience-carries-a-real-call.test.ts` idiom.
//
// ── CONTROLS ──
// A rename does not disturb the call (same key, same URL, still answers), and a base-URL edit
// is followed to the new endpoint.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t66b-call');
  return { ...real, homedir, default: { ...real, homedir } };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t66b-call', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { callModel, clearClientCache, type ModelCallResult } from '../model.js';
import { configRouter } from '../../gateway/routes/config.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t66b-call', '.dojo');

// ── Two stub endpoints, so "which URL was called" is answerable as well as "which key" ──
interface Stub { server: http.Server; url: string; seen: string[] }
const stubs: Stub[] = [];

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

const makeStub = async (label: string): Promise<Stub> => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    seen.push(String(req.headers.authorization ?? '(absent)'));
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null): string => sse({
        id: 'chatcmpl-t66b', object: 'chat.completion.chunk', created: 0, model: 'local-ds4',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write(chunk({ role: 'assistant', content: `answered by ${label}` }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const stub: Stub = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
  stubs.push(stub);
  return stub;
};

let first: Stub;
let second: Stub;

beforeAll(async () => {
  first = await makeStub('first');
  second = await makeStub('second');
});

afterAll(async () => {
  for (const s of stubs) await new Promise<void>(r => s.server.close(() => r()));
});

const patch = (p: string, body: unknown): Promise<Response> =>
  configRouter.request(p, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const seed = (): void => {
  const db = mockDb.current!;
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', ?, 'api_key', 1, datetime('now'), datetime('now'))
  `).run(first.url);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text"]', 32768, 4096, 1, datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run();
  setProviderCredential('local', 'sk-first-key', 'api_key');
};

const call = (): Promise<ModelCallResult> => callModel({
  agentId: 'kevin',
  modelId: 'm-local',
  messages: [{ role: 'user', content: 'Are you there?' }],
  systemPrompt: 'You are a local model.',
  tools: false,
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  first.seen.length = 0;
  second.seen.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T66b — a rotated credential is the one the next call sends', () => {
  it('THE STALE-CLIENT CASE: same base URL, new key, and the new key goes on the wire', async () => {
    await call();
    expect(first.seen).toEqual(['Bearer sk-first-key']);

    const res = await patch('/providers/local', { credential: 'sk-second-key' });
    expect(res.status).toBe(200);

    await call();
    // Without the cache invalidation this reads 'Bearer sk-first-key' a second time: the cache
    // key `local:<url>` never moved, so the client built with the old key is still served.
    expect(first.seen).toEqual(['Bearer sk-first-key', 'Bearer sk-second-key']);
  });

  it('a base-URL edit sends the next call to the new endpoint', async () => {
    await call();
    expect(first.seen).toHaveLength(1);

    const res = await patch('/providers/local', { baseUrl: second.url });
    expect(res.status).toBe(200);

    const result = await call();
    expect(second.seen).toEqual(['Bearer sk-first-key']);
    expect(first.seen).toHaveLength(1);
    expect(JSON.stringify(result.content)).toContain('answered by second');
  });

  it('CONTROL: a rename changes nothing about the call', async () => {
    await call();
    const res = await patch('/providers/local', { name: 'The Basement Box' });
    expect(res.status).toBe(200);

    const result = await call();
    expect(first.seen).toEqual(['Bearer sk-first-key', 'Bearer sk-first-key']);
    expect(JSON.stringify(result.content)).toContain('answered by first');
  });
});
