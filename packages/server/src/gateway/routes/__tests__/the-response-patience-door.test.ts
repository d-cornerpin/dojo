// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T64b — THE RESPONSE-PATIENCE DOOR.
//
// The owner's DeepSeek box is ALREADY a configured provider. He is not going to delete it and
// re-add it to change one number, so the patience pair has to be settable on a provider that
// exists — which is why there are two doors here and not one:
//
//   POST  /providers                        — the manual form's create, carrying the pair
//   PATCH /providers/:id/response-patience  — the edit, on any provider, changing ONLY the pair
//
// The PATCH exists in the shape `PATCH /providers/:id/host-ram` already established: a narrow
// door for one property. It matters that it is narrow. `POST /providers` over an existing id
// is a FULL REPLACE of the identity fields (name, type, base_url, auth_type, behaves_like) —
// T63 recorded that as the door's deliberate semantics — so re-POSTing to change a timeout
// would mean re-sending the whole identity, and getting one field wrong would silently
// rewrite the provider. The PATCH cannot.
//
// ── THE BOUNDS ──
// 10 s to 30 min, and they are `STREAM_PATIENCE_MIN_MS` / `STREAM_PATIENCE_MAX_MS` — the
// SAME two constants the resolver trusts. A floor below the standing idle bound would let a
// typo make every call fail instantly; a ceiling exists because "patience" that outlives the
// turn is a hang with a nicer name.
//
// ── CONTROL ──
// Every provider that exists stores NULL for both, reads back null on the wire, and a create
// that mentions neither field leaves them NULL.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t64b-patience-door');
  return { ...real, homedir, default: { ...real, homedir } };
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t64b-patience-door', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';
import { STREAM_PATIENCE_MIN_MS, STREAM_PATIENCE_MAX_MS } from '../../../agent/stream-patience.js';

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t64b-patience-door', '.dojo');

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

/** The manual form's body — the same one T63's door test uses, plus the new pair. */
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

describe('T64b — the manual form creates a provider carrying its own patience', () => {
  it('stores both declared bounds and echoes them back', async () => {
    const res = await post('/providers', {
      ...MANUAL_BODY,
      firstChunkTimeoutMs: 600_000,
      streamIdleTimeoutMs: 300_000,
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      firstChunkTimeoutMs: 600_000,
      streamIdleTimeoutMs: 300_000,
    });
    expect(row()).toMatchObject({ first_chunk_timeout_ms: 600_000, stream_idle_timeout_ms: 300_000 });
  });

  it('CONTROL: a create that declares neither leaves both NULL', async () => {
    await post('/providers', MANUAL_BODY);
    expect(row()).toMatchObject({ first_chunk_timeout_ms: null, stream_idle_timeout_ms: null });
    expect(await data(await get('/providers/local-ds4')))
      .toMatchObject({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: null });
  });

  it('refuses a bound below the floor, and stores nothing', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, firstChunkTimeoutMs: STREAM_PATIENCE_MIN_MS - 1 });
    expect(res.status).toBe(400);
    expect(row()).toBeUndefined();
  });

  it('refuses a bound above the ceiling, and stores nothing', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, streamIdleTimeoutMs: STREAM_PATIENCE_MAX_MS + 1 });
    expect(res.status).toBe(400);
    expect(row()).toBeUndefined();
  });

  it('refuses a fractional bound', async () => {
    const res = await post('/providers', { ...MANUAL_BODY, firstChunkTimeoutMs: 90_000.5 });
    expect(res.status).toBe(400);
  });
});

describe('T64b — the edit door changes the pair on a provider that already exists', () => {
  beforeEach(async () => {
    await post('/providers', MANUAL_BODY);
  });

  it('sets both bounds', async () => {
    const res = await patch('/providers/local-ds4/response-patience', {
      firstChunkTimeoutMs: 480_000,
      streamIdleTimeoutMs: 120_000,
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ firstChunkTimeoutMs: 480_000, streamIdleTimeoutMs: 120_000 });
    expect(row()).toMatchObject({ first_chunk_timeout_ms: 480_000, stream_idle_timeout_ms: 120_000 });
  });

  it('clears a bound back to the standing default with null', async () => {
    await patch('/providers/local-ds4/response-patience', { firstChunkTimeoutMs: 480_000, streamIdleTimeoutMs: 120_000 });
    const res = await patch('/providers/local-ds4/response-patience', {
      firstChunkTimeoutMs: null,
      streamIdleTimeoutMs: null,
    });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ first_chunk_timeout_ms: null, stream_idle_timeout_ms: null });
  });

  it('the two bounds are independent: one may be set while the other stays null', async () => {
    await patch('/providers/local-ds4/response-patience', { firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null });
    expect(row()).toMatchObject({ first_chunk_timeout_ms: 600_000, stream_idle_timeout_ms: null });
  });

  it('touches NOTHING else on the row', async () => {
    const before = row();
    const res = await patch('/providers/local-ds4/response-patience', { firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null });
    expect(res.status).toBe(200); // without this the case passes when the route is absent
    const after = row();
    for (const key of Object.keys(before)) {
      if (key === 'first_chunk_timeout_ms' || key === 'updated_at') continue;
      expect({ [key]: after[key] }).toEqual({ [key]: before[key] });
    }
    // Named explicitly, because this is the whole reason the door is narrow rather than a
    // re-POST: the identity fields a full replace would rewrite.
    expect(after).toMatchObject({
      name: 'Local DS4',
      type: 'openai-compatible',
      base_url: 'http://127.0.0.1:8123/v1',
      auth_type: 'none',
      behaves_like: 'deepseek-native',
    });
  });

  it('refuses out-of-range values and leaves the stored pair alone', async () => {
    await patch('/providers/local-ds4/response-patience', { firstChunkTimeoutMs: 600_000, streamIdleTimeoutMs: null });
    for (const body of [
      { firstChunkTimeoutMs: STREAM_PATIENCE_MIN_MS - 1, streamIdleTimeoutMs: null },
      { firstChunkTimeoutMs: STREAM_PATIENCE_MAX_MS + 1, streamIdleTimeoutMs: null },
      { firstChunkTimeoutMs: 0, streamIdleTimeoutMs: null },
      { firstChunkTimeoutMs: -1, streamIdleTimeoutMs: null },
      { firstChunkTimeoutMs: 60_000.5, streamIdleTimeoutMs: null },
      { firstChunkTimeoutMs: '600000', streamIdleTimeoutMs: null },
    ]) {
      const res = await patch('/providers/local-ds4/response-patience', body);
      expect(res.status).toBe(400);
    }
    expect(row()).toMatchObject({ first_chunk_timeout_ms: 600_000 });
  });

  it('404s on a provider that does not exist', async () => {
    const res = await patch('/providers/nobody/response-patience', { firstChunkTimeoutMs: null, streamIdleTimeoutMs: null });
    expect(res.status).toBe(404);
  });

  it('refuses a body that names neither field', async () => {
    const res = await patch('/providers/local-ds4/response-patience', {});
    expect(res.status).toBe(400);
  });
});

describe('T64b — CONTROL: providers that predate this are byte-identical', () => {
  it('a seeded provider reads back null for both, and its row has no other change', async () => {
    mockDb.current!.prepare(`
      INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
      VALUES ('anthropic', 'Anthropic', 'anthropic', NULL, 'api_key', 1, datetime('now'), datetime('now'))
    `).run();
    expect(await data(await get('/providers/anthropic')))
      .toMatchObject({ firstChunkTimeoutMs: null, streamIdleTimeoutMs: null });
    expect(row('anthropic')).toMatchObject({ first_chunk_timeout_ms: null, stream_idle_timeout_ms: null });
  });

  it('a re-POST that omits the pair clears it, exactly as it does for behavesLike', async () => {
    // The full-replace semantics T63 documented, stated here so nobody rediscovers it as a
    // bug. It is why the dashboard edits patience through the PATCH and never a re-POST.
    await post('/providers', { ...MANUAL_BODY, firstChunkTimeoutMs: 600_000 });
    expect(row()).toMatchObject({ first_chunk_timeout_ms: 600_000 });
    await post('/providers', MANUAL_BODY);
    expect(row()).toMatchObject({ first_chunk_timeout_ms: null });
  });
});
