// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T63 — THE MANUAL OPENAI-COMPATIBLE DOOR.
//
// The owner's case is a local DeepSeek V4 install behind an ollama / vLLM / LM-Studio-style
// OpenAI-compatible server: a URL he types, usually NO API key, and a dialect the URL cannot
// tell anyone about. This file drives the real routes against a real HTTP server, because a
// picker that renders and a provider that cannot be validated are the same defect.
//
// ── THE THREE THINGS STEP-0 FOUND SHUT AT HEAD, each with its own case below ──
//  1. NO KEY, NO ENTRY. `POST /providers/:id/validate` 400s with "No credential found for
//     this provider" for everything that is not Ollama or the Agent SDK, and
//     `GET /providers/:id/browse-models` 400s with "No credential found". `auth_type='none'`
//     has been a legal provider value since migration 005 — no door read it.
//  2. THE DOUBLE `/v1`. Both routes built their models URL as `${baseUrl}/v1/models` with one
//     hand-rolled exception for DeepSeek's bare host. The base URL a local server prints for
//     you to paste ALREADY ends in `/v1`, so the typed URL produced `…/v1/v1/models` and a
//     404 the owner would have read as "my server is broken". `resolveOpenAIBaseUrl` — the
//     rule the model client itself uses to point the SDK — is now the single answer, and it
//     is byte-identical for OpenRouter (`/api` → `/api/v1`) and DeepSeek (bare host).
//  3. NOTHING CARRIED THE DIALECT. The provider row had nowhere to say what it behaves like.
//
// The `Authorization` header is sent when there IS a key and omitted when there is not:
// `Bearer null` is a header that means nothing to a server that checks and breaks one that
// does not. The stub asserts both arms.
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
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t63-manual-provider');
  return { ...real, homedir, default: { ...real, homedir } };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t63-manual-provider', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

/** The fake `~/.dojo` this file's secrets land in. Wiped per case — a key that leaked
 *  across cases would make the no-key arm pass for the wrong reason. */
const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t63-manual-provider', '.dojo');

// ── The stub: an OpenAI-compatible server with no auth, rooted at /v1 ──

interface StubHit { path: string; authorization: string | undefined }

let server: http.Server;
let stubUrl = '';
const hits: StubHit[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push({ path: req.url ?? '', authorization: req.headers.authorization });
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4', object: 'model', owned_by: 'local' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  hits.length = 0;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const post = (path: string, body?: unknown): Promise<Response> =>
  configRouter.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (r: Response): Promise<Record<string, unknown>> =>
  await r.json() as Record<string, unknown>;

/** The body the NEW picker choice sends: typed name, typed URL, no key, a declared dialect. */
const MANUAL_BODY = {
  id: 'local-ds4',
  name: 'Local DS4',
  type: 'openai-compatible',
  authType: 'none',
  behavesLike: 'deepseek-native',
};

describe('T63 — a manual OpenAI-compatible provider, with no key at all', () => {
  it('is created, and the row carries what it behaves like', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, baseUrl: stubUrl });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect((body.data as Record<string, unknown>).behavesLike).toBe('deepseek-native');

    const row = mockDb.current!.prepare('SELECT * FROM providers WHERE id = ?').get('local-ds4') as Record<string, unknown>;
    expect(row.behaves_like).toBe('deepseek-native');
    expect(row.auth_type).toBe('none');
    expect(row.base_url).toBe(stubUrl);
  });

  it('DEFECT 1 + 2 — it validates against the typed URL: no key required, no double /v1', async () => {
    await post('/providers', { ...MANUAL_BODY, baseUrl: stubUrl });
    const res = await post('/providers/local-ds4/validate');
    expect(await json(res)).toEqual({ ok: true, data: { valid: true } });

    expect(hits.map(h => h.path)).toEqual(['/v1/models']);
    expect(hits[0].authorization).toBeUndefined();

    const row = mockDb.current!.prepare('SELECT is_validated FROM providers WHERE id = ?').get('local-ds4') as { is_validated: number };
    expect(row.is_validated).toBe(1);
  });

  it('DEFECT 1 + 2 — and its catalog can be browsed, so a model can be attached', async () => {
    await post('/providers', { ...MANUAL_BODY, baseUrl: stubUrl });
    const res = await configRouter.request('/providers/local-ds4/browse-models');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.data as Array<{ apiModelId: string }>).map(m => m.apiModelId)).toEqual(['deepseek-v4']);
    expect(hits[0].path).toBe('/v1/models');
    expect(hits[0].authorization).toBeUndefined();
  });

  it('a base URL typed WITHOUT the /v1 reaches the same endpoint', async () => {
    await post('/providers', { ...MANUAL_BODY, baseUrl: stubUrl.replace(/\/v1$/, '') });
    expect((await json(await post('/providers/local-ds4/validate'))).ok).toBe(true);
    expect(hits.map(h => h.path)).toEqual(['/v1/models']);
  });

  it('a manual provider WITH a key still sends it', async () => {
    await post('/providers', { ...MANUAL_BODY, baseUrl: stubUrl, authType: 'api_key', credential: 'sk-local-secret' });
    await post('/providers/local-ds4/validate');
    expect(hits[0].authorization).toBe('Bearer sk-local-secret');
  });

  it('CONTROL — a keyed provider that has no key stored is still refused', async () => {
    await post('/providers', { id: 'keyed', name: 'Keyed', type: 'openai-compatible', baseUrl: stubUrl, authType: 'api_key' });
    const res = await post('/providers/keyed/validate');
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('No credential found for this provider');
    expect(hits).toHaveLength(0);
  });

  it('CONTROL — an existing provider declares nothing, and reads back as nothing', async () => {
    const res = await post('/providers', { id: 'openrouter', name: 'OpenRouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api', authType: 'api_key', credential: 'sk-or-x' });
    expect((await json(res)).data).toMatchObject({ behavesLike: null });
    const row = mockDb.current!.prepare('SELECT behaves_like FROM providers WHERE id = ?').get('openrouter') as { behaves_like: string | null };
    expect(row.behaves_like).toBeNull();
  });

  it('CONTROL — an unknown profile name is refused at the door, not stored', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, baseUrl: stubUrl, behavesLike: 'llama.cpp' });
    expect(res.status).toBe(400);
    expect(mockDb.current!.prepare('SELECT id FROM providers WHERE id = ?').get('local-ds4')).toBeUndefined();
  });
});
