// ════════════════════════════════════════════════════════════════════════════════════
// T72b claim 1 — THE MODEL LIMITS DOOR.
//
// The second half of the 1024 defect, and the durable half. `max_output_tokens` and
// `context_window` decide what `max_tokens` goes on every wire (`resolveOutputBudget`), and
// for a manual provider both are GUESSES:
//
//   * browse-add stores NULL for both (`POST /providers/:id/add-model`), because
//     `top_provider` is an OpenRouter-only field and no local server reports it. NULL then
//     resolves at call time to a phantom 200,000-token window and a 16,384 cap;
//   * provider-validate stores `context_length ?? 128000` and a cap derived from it. Same
//     provider, two different answers depending on which button was pressed last;
//   * vLLM's `max_model_len` and LM Studio's `max_context_length` are not read at all.
//
// And there was NO WAY TO CORRECT EITHER. Every `UPDATE models SET ... max_output_tokens` in
// the codebase is a discovery sync; the dashboard's model row exposes capabilities, pricing,
// thinking, num_ctx and enable/disable, and neither of these. The only remedies were editing
// SQLite by hand or deleting the model and re-adding it, which writes NULL again.
//
// So: a narrow PATCH, in the shape `PATCH /models/:id/num-ctx` already established, and the
// two numbers rendered on the row. The person who owns the box is the one who knows what it
// can do; this is how they say so.
//
// ── WHY NULL MUST STAY EXPRESSIBLE ──
// NULL is not "unset by accident", it is "let discovery decide" — so the door accepts null
// on both fields and that is how a user undoes an override without deleting the model.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t72b-model-limits');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t72b-model-limits', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t72b-model-limits', '.dojo');

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type, is_validated)
     VALUES ('local-ds4', 'Local DS4', 'openai-compatible', 'http://127.0.0.1:8123/v1', 'none', 1)`,
  ).run();
  // The browse-added shape, verbatim: both limits NULL.
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, is_enabled)
     VALUES ('m-local', 'local-ds4', 'ds4', 'DS4 Local', NULL, NULL, 1)`,
  ).run();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const patch = (p: string, body?: unknown): Promise<Response> =>
  configRouter.request(p, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const data = async (r: Response): Promise<Record<string, unknown>> =>
  ((await r.json()) as Record<string, unknown>).data as Record<string, unknown>;

const row = (): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM models WHERE id = ?').get('m-local') as Record<string, unknown>;

describe('T72b/1 — a model row states its own limits', () => {
  it('THE DEFECT: the two numbers are settable at all', async () => {
    const res = await patch('/models/m-local/limits', {
      maxOutputTokens: 32_768,
      contextWindow: 131_072,
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ maxOutputTokens: 32_768, contextWindow: 131_072 });
    expect(row()).toMatchObject({ max_output_tokens: 32_768, context_window: 131_072 });
  });

  it('each field moves alone — an omitted field is untouched (the clears-on-omit trap)', async () => {
    await patch('/models/m-local/limits', { maxOutputTokens: 8_192, contextWindow: 65_536 });
    await patch('/models/m-local/limits', { maxOutputTokens: 16_384 });
    expect(row()).toMatchObject({ max_output_tokens: 16_384, context_window: 65_536 });
    await patch('/models/m-local/limits', { contextWindow: 32_768 });
    expect(row()).toMatchObject({ max_output_tokens: 16_384, context_window: 32_768 });
  });

  it('NULL is expressible — it hands the field back to discovery', async () => {
    await patch('/models/m-local/limits', { maxOutputTokens: 8_192, contextWindow: 65_536 });
    const res = await patch('/models/m-local/limits', { maxOutputTokens: null, contextWindow: null });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ max_output_tokens: null, context_window: null });
  });

  it('refuses incoherent values, and stores nothing', async () => {
    for (const body of [
      { maxOutputTokens: 0 },
      { maxOutputTokens: -1 },
      { maxOutputTokens: 1.5 },
      { maxOutputTokens: '8192' },
      { contextWindow: 0 },
      { contextWindow: -4096 },
      { contextWindow: 3.3 },
      { contextWindow: 4_000_000 },
      { maxOutputTokens: 40_000_000 },
    ]) {
      const res = await patch('/models/m-local/limits', body);
      expect(res.status).toBe(400);
    }
    expect(row()).toMatchObject({ max_output_tokens: null, context_window: null });
  });

  it('refuses a body that names neither field', async () => {
    expect((await patch('/models/m-local/limits', {})).status).toBe(400);
    expect((await patch('/models/m-local/limits', { nonsense: 1 })).status).toBe(400);
  });

  it('404s an unknown model rather than inventing a row', async () => {
    expect((await patch('/models/nope/limits', { maxOutputTokens: 8_192 })).status).toBe(404);
  });

  it('CONTROL — no other column moves', async () => {
    const before = row();
    await patch('/models/m-local/limits', { maxOutputTokens: 8_192, contextWindow: 65_536 });
    const after = row();
    for (const k of Object.keys(before)) {
      if (k === 'max_output_tokens' || k === 'context_window' || k === 'updated_at') continue;
      expect(after[k]).toEqual(before[k]);
    }
  });
});
