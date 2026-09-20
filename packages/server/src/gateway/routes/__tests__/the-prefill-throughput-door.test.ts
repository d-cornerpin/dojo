// ════════════════════════════════════════════════════════════════════════════════════
// NO-DOOMED-DIALS T81b — THE PREFILL-THROUGHPUT DOOR.
//
// Mirrors `the-unattended-budget-door.test.ts` exactly, one door over. The owner's local box
// is already a configured provider; he is not going to delete it and re-add it to raise a
// number, so the throughput has to be settable on a provider that exists:
//
//   POST  /providers                            — the manual form's create, carrying the field
//   PATCH /providers/:id/prefill-throughput     — the edit, on any provider, changing ONLY it
//
// ── THE BOUNDS ──
// 1 – 100,000 tokens per second — `PREFILL_THROUGHPUT_MIN_TOK_PER_SEC` /
// `PREFILL_THROUGHPUT_MAX_TOK_PER_SEC`, the SAME constants `resolveDoomCeiling` trusts,
// imported from the one module that owns them. Unlike the unattended-budget door, there is no
// legal value below the floor: zero tokens/sec is not a real speed, not a "no cap" sentinel.
//
// ── CONTROL ──
// Every provider that exists stores NULL, reads back null on the wire, and a create that
// omits the field leaves it NULL.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t81b-throughput-door');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t81b-throughput-door', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';
import { PREFILL_THROUGHPUT_MIN_TOK_PER_SEC, PREFILL_THROUGHPUT_MAX_TOK_PER_SEC } from '../../../agent/stream-patience.js';

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t81b-throughput-door', '.dojo');

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const send = (method: string, p: string, body?: unknown): Promise<Response> =>
  configRouter.request(p, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const post = (p: string, body?: unknown): Promise<Response> => send('POST', p, body);
const patch = (p: string, body?: unknown): Promise<Response> => send('PATCH', p, body);
const get = (p: string): Promise<Response> => send('GET', p);

const json = async (r: Response): Promise<Record<string, unknown>> =>
  await r.json() as Record<string, unknown>;

const data = async (r: Response): Promise<Record<string, unknown>> =>
  (await json(r)).data as Record<string, unknown>;

const MANUAL_BODY = {
  id: 'local-ds4',
  name: 'Local DS4',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:8123/v1',
  authType: 'none',
  behavesLike: 'deepseek-native',
};

const row = (id = 'local-ds4'): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;

describe('T81b — the manual form creates a provider carrying its own prefill throughput', () => {
  it('stores a declared throughput and echoes it back', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: 180 });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ prefillTokensPerSec: 180 });
    expect(row()).toMatchObject({ prefill_tokens_per_sec: 180 });
  });

  it('CONTROL: a create that declares nothing leaves it NULL', async () => {
    await post('/providers', MANUAL_BODY);
    expect(row()).toMatchObject({ prefill_tokens_per_sec: null });
    expect(await data(await get('/providers/local-ds4'))).toMatchObject({ prefillTokensPerSec: null });
  });

  it('refuses zero — unlike the unattended-budget door, there is no uncapped sentinel here', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: 0 });
    expect(res.status).toBe(400);
    expect(row()).toBeUndefined();
  });

  it('refuses a value below the floor, and stores nothing', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: PREFILL_THROUGHPUT_MIN_TOK_PER_SEC - 1 });
    expect(res.status).toBe(400);
    expect(row()).toBeUndefined();
  });

  it('refuses a value above the ceiling, and stores nothing', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: PREFILL_THROUGHPUT_MAX_TOK_PER_SEC + 1 });
    expect(res.status).toBe(400);
    expect(row()).toBeUndefined();
  });

  it('refuses a fractional value', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: 180.5 });
    expect(res.status).toBe(400);
  });

  it('refuses a negative value', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: -1 });
    expect(res.status).toBe(400);
  });
});

describe('T81b — the edit door changes the throughput on a provider that already exists', () => {
  beforeEach(async () => {
    await post('/providers', MANUAL_BODY);
  });

  it('sets the throughput', async () => {
    const res = await patch('/providers/local-ds4/prefill-throughput', { prefillTokensPerSec: 180 });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ prefillTokensPerSec: 180 });
    expect(row()).toMatchObject({ prefill_tokens_per_sec: 180 });
  });

  it('clears the throughput back to undeclared with null', async () => {
    await patch('/providers/local-ds4/prefill-throughput', { prefillTokensPerSec: 180 });
    const res = await patch('/providers/local-ds4/prefill-throughput', { prefillTokensPerSec: null });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ prefill_tokens_per_sec: null });
  });

  it('touches NOTHING else on the row', async () => {
    const before = row();
    const res = await patch('/providers/local-ds4/prefill-throughput', { prefillTokensPerSec: 180 });
    expect(res.status).toBe(200); // without this the case passes when the route is absent
    const after = row();
    for (const key of Object.keys(before)) {
      if (key === 'prefill_tokens_per_sec' || key === 'updated_at') continue;
      expect({ [key]: after[key] }).toEqual({ [key]: before[key] });
    }
    expect(after).toMatchObject({
      name: 'Local DS4',
      type: 'openai-compatible',
      base_url: 'http://127.0.0.1:8123/v1',
      auth_type: 'none',
      behaves_like: 'deepseek-native',
    });
  });

  it('refuses out-of-range values and leaves the stored throughput alone', async () => {
    await patch('/providers/local-ds4/prefill-throughput', { prefillTokensPerSec: 180 });
    for (const body of [
      { prefillTokensPerSec: 0 },
      { prefillTokensPerSec: PREFILL_THROUGHPUT_MIN_TOK_PER_SEC - 1 },
      { prefillTokensPerSec: PREFILL_THROUGHPUT_MAX_TOK_PER_SEC + 1 },
      { prefillTokensPerSec: -1 },
      { prefillTokensPerSec: 15.5 },
      { prefillTokensPerSec: '180' },
    ]) {
      const res = await patch('/providers/local-ds4/prefill-throughput', body);
      expect(res.status).toBe(400);
    }
    expect(row()).toMatchObject({ prefill_tokens_per_sec: 180 });
  });

  it('404s on a provider that does not exist', async () => {
    const res = await patch('/providers/nobody/prefill-throughput', { prefillTokensPerSec: null });
    expect(res.status).toBe(404);
  });

  it('refuses a body that names nothing', async () => {
    const res = await patch('/providers/local-ds4/prefill-throughput', {});
    expect(res.status).toBe(400);
  });
});

describe('T81b — the general edit door redirects a misdirected write to the narrow one', () => {
  beforeEach(async () => {
    await post('/providers', MANUAL_BODY);
  });

  it('PATCH /providers/:id refuses `prefillTokensPerSec` by name, pointing at the right door', async () => {
    const res = await patch('/providers/local-ds4', { prefillTokensPerSec: 180 });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: expect.stringContaining('prefill-throughput'),
    });
    expect(row()).toMatchObject({ prefill_tokens_per_sec: null });
  });
});

describe('T81b — CONTROL: providers that predate this are byte-identical', () => {
  it('a seeded provider reads back null, and its row has no other change', async () => {
    mockDb.current!.prepare(`
      INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
      VALUES ('anthropic', 'Anthropic', 'anthropic', NULL, 'api_key', 1, datetime('now'), datetime('now'))
    `).run();
    expect(await data(await get('/providers/anthropic'))).toMatchObject({ prefillTokensPerSec: null });
    expect(row('anthropic')).toMatchObject({ prefill_tokens_per_sec: null });
  });

  it('a re-POST that omits the field clears it, exactly as it does for the patience pair', async () => {
    await post('/providers', { ...MANUAL_BODY, prefillTokensPerSec: 180 });
    expect(row()).toMatchObject({ prefill_tokens_per_sec: 180 });
    await post('/providers', MANUAL_BODY);
    expect(row()).toMatchObject({ prefill_tokens_per_sec: null });
  });
});
