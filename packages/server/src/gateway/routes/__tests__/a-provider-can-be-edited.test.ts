// ════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR / T66b — A PROVIDER CAN BE EDITED.
//
// The owner: "at the very least change the name and the patience settings". Patience already
// had its door (T64b). NOTHING ELSE did — name, base URL and dialect were create-only, and the
// only way to change one was `POST /providers` over the existing id, which is a FULL REPLACE
// of the identity fields. W45 recorded that as the door's deliberate semantics and T64b built
// a narrow PATCH rather than use it, for exactly the reason this file exists to pin:
//
//   ── THE TRAP, and it is the heart of this task ──
//   A re-POST that omits a field CLEARS it. Omit `behavesLike` and the dialect declaration is
//   gone; omit the patience pair and the owner's slow box is back on the 90-second bound that
//   broke it. So an edit door that full-replaces cannot be the edit door: a user who opens a
//   form to change a NAME must not be able to lose a base URL by not mentioning it.
//
//   `PATCH /providers/:id` therefore changes ONLY what the body names. The control that proves
//   it is `a PATCH naming only the name leaves every other column byte-identical`, asserted
//   column by column against a row seeded with every field non-default — including the two
//   patience columns and the credential, which live in two different stores.
//
// ── WHY THIS IS NOT A THIRD PATIENCE DOOR ──
// It is the fourth member of the same family (`host-ram`, `response-patience`, and now the
// identity fields). Each owns its own property and nothing else, so no door is ever in a
// position to rewrite a property it was not asked about. Patience stays where T64b put it;
// the dashboard's one Save calls both doors.
//
// ── THE CREDENTIAL ──
// Rotation rides the EXISTING credential store (`setProviderCredential` → `~/.dojo/secrets.yaml`
// under `providers.<id>`) — the same writer `POST /providers` uses. Blank or absent means KEEP:
// a form that pre-fills a password field cannot, and a form that leaves it empty must not erase
// the key. The stored key is NEVER echoed back — asserted on the response body here, and the
// call-side consequence (a rotated key must reach the next model call, not a cached client) is
// proved for real in `agent/__tests__/an-edited-provider-is-the-one-that-gets-called.test.ts`.
//
// ── VALIDATION RESET, SCOPED ──
// `is_validated` is a claim about a CONNECTION. Changing the base URL or the key invalidates
// it; renaming does not, and neither does declaring a dialect (nothing in `POST
// /providers/:id/validate` reads `behaves_like`). A reset that fired on a rename would train
// the user to ignore the badge.
//
// ── STEP-0, `__system__` ──
// The invariant at HEAD is HIDDEN, NOT GUARDED: `GET /providers` filters `id != '__system__'`
// (config.ts:460) so the sentinel never reaches the UI, but `GET /providers/:id`, `DELETE
// /providers/:id` and both PATCH doors have no guard and will act on it. This door refuses it
// outright — it is the door that rewrites identity, and the router's 'auto' pointer hangs off
// that row. The pre-existing doors are deliberately NOT changed here (that is a different task
// with its own controls); the Step-0 reading is recorded so the next reader knows the
// asymmetry is measured rather than accidental.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t66b-edit-door');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t66b-edit-door', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache, getProviderCredential, setProviderCredential } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t66b-edit-door', '.dojo');

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

const patch = (p: string, body?: unknown): Promise<Response> => send('PATCH', p, body);
const post = (p: string, body?: unknown): Promise<Response> => send('POST', p, body);
const get = (p: string): Promise<Response> => send('GET', p);

const json = async (r: Response): Promise<Record<string, unknown>> =>
  await r.json() as Record<string, unknown>;
const data = async (r: Response): Promise<Record<string, unknown>> =>
  (await json(r)).data as Record<string, unknown>;

const row = (id = 'local-ds4'): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;

/**
 * A provider with EVERY editable and non-editable column carrying a value that is not its
 * default, so "nothing else moved" is a real assertion rather than a comparison of nulls.
 * Written with direct SQL because the create door cannot set `host_ram_gb`, `is_validated`
 * or `validated_at`, and the trap this file exists for is about columns the edit body does
 * not mention.
 */
const seedFullyLoaded = (): void => {
  mockDb.current!.prepare(`
    INSERT INTO providers (
      id, name, type, base_url, auth_type, behaves_like,
      first_chunk_timeout_ms, stream_idle_timeout_ms, host_ram_gb,
      is_validated, validated_at, created_at, updated_at
    ) VALUES (
      'local-ds4', 'Local DS4', 'openai-compatible', 'http://127.0.0.1:8123/v1', 'api_key', 'deepseek-native',
      600000, 300000, 64,
      1, '2026-08-30T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    )
  `).run();
  setProviderCredential('local-ds4', 'sk-original-key', 'api_key');
};

describe('T66b — the edit door exists and changes only what it is asked to change', () => {
  beforeEach(() => seedFullyLoaded());

  it('changes the name', async () => {
    const res = await patch('/providers/local-ds4', { name: 'The Basement Box' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'local-ds4', name: 'The Basement Box' });
    expect(row()).toMatchObject({ name: 'The Basement Box' });
  });

  it('THE TRAP, PINNED: a PATCH naming only the name leaves every other column untouched', async () => {
    const before = row();
    const res = await patch('/providers/local-ds4', { name: 'The Basement Box' });
    expect(res.status).toBe(200); // without this the case passes when the route is absent

    const after = row();
    for (const key of Object.keys(before)) {
      if (key === 'name' || key === 'updated_at') continue;
      expect({ [key]: after[key] }).toEqual({ [key]: before[key] });
    }
    // Named one by one as well, because a loop over keys reads as bookkeeping and these are
    // the five a full-replace re-POST would have silently cleared.
    expect(after).toMatchObject({
      type: 'openai-compatible',
      base_url: 'http://127.0.0.1:8123/v1',
      auth_type: 'api_key',
      behaves_like: 'deepseek-native',
      first_chunk_timeout_ms: 600000,
      stream_idle_timeout_ms: 300000,
      host_ram_gb: 64,
    });
    // The credential lives in the other store, and a rename must not reach it either.
    expect(getProviderCredential('local-ds4')).toBe('sk-original-key');
  });

  it('changes the base URL alone', async () => {
    await patch('/providers/local-ds4', { baseUrl: 'http://192.168.1.40:8000/v1' });
    expect(row()).toMatchObject({
      base_url: 'http://192.168.1.40:8000/v1',
      name: 'Local DS4',
      behaves_like: 'deepseek-native',
      first_chunk_timeout_ms: 600000,
    });
  });

  it('changes the declared dialect alone, and can clear it back to sniffing', async () => {
    await patch('/providers/local-ds4', { behavesLike: 'generic-openai-compatible' });
    expect(row()).toMatchObject({ behaves_like: 'generic-openai-compatible', base_url: 'http://127.0.0.1:8123/v1' });

    await patch('/providers/local-ds4', { behavesLike: null });
    expect(row()).toMatchObject({ behaves_like: null, base_url: 'http://127.0.0.1:8123/v1' });
  });

  it('changes several fields in one call', async () => {
    const res = await patch('/providers/local-ds4', {
      name: 'Basement', baseUrl: 'http://10.0.0.9:8000/v1', behavesLike: 'generic-openai-compatible',
    });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({
      name: 'Basement', base_url: 'http://10.0.0.9:8000/v1', behaves_like: 'generic-openai-compatible',
      first_chunk_timeout_ms: 600000, stream_idle_timeout_ms: 300000,
    });
  });

  it('404s on a provider that does not exist, and creates nothing', async () => {
    const res = await patch('/providers/nobody', { name: 'Ghost' });
    expect(res.status).toBe(404);
    expect(row('nobody')).toBeUndefined();
  });

  it('refuses a body that names nothing', async () => {
    const res = await patch('/providers/local-ds4', {});
    expect(res.status).toBe(400);
    expect(row()).toMatchObject({ name: 'Local DS4' });
  });

  it('refuses a field it does not own, rather than ignoring it', async () => {
    // `.strict()`. A caller who thinks this door takes `hostRamGb` must be told it does not,
    // not silently have the value dropped.
    const res = await patch('/providers/local-ds4', { name: 'X', hostRamGb: 32 });
    expect(res.status).toBe(400);
    expect(row()).toMatchObject({ name: 'Local DS4', host_ram_gb: 64 });
  });

  it('sends the patience pair to its own door by name, rather than "unrecognized key"', async () => {
    const res = await patch('/providers/local-ds4', { name: 'X', firstChunkTimeoutMs: 120000 });
    expect(res.status).toBe(400);
    expect(String((await json(res)).error)).toContain('response-patience');
    expect(row()).toMatchObject({ name: 'Local DS4', first_chunk_timeout_ms: 600000 });
  });

  it('refuses a name that is empty or too long, and a base URL that is not a URL', async () => {
    for (const body of [{ name: '' }, { name: 'x'.repeat(129) }, { baseUrl: 'not a url' }, { behavesLike: 'nonsense' }]) {
      const res = await patch('/providers/local-ds4', body);
      expect(res.status).toBe(400);
    }
    expect(row()).toMatchObject({ name: 'Local DS4', base_url: 'http://127.0.0.1:8123/v1', behaves_like: 'deepseek-native' });
  });
});

describe('T66b — NOT-DOING: a type change is a different provider', () => {
  beforeEach(() => seedFullyLoaded());

  for (const [field, value] of [['type', 'anthropic'], ['id', 'something-else'], ['authType', 'oauth']] as const) {
    it(`refuses \`${field}\` with a plain message and stores nothing`, async () => {
      const res = await patch('/providers/local-ds4', { name: 'Fine', [field]: value });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(String(body.error)).toMatch(/delete/i);
      expect(row()).toMatchObject({ name: 'Local DS4', type: 'openai-compatible', auth_type: 'api_key' });
    });
  }
});

describe('T66b — the credential rotates through the existing store, and is never echoed', () => {
  beforeEach(() => seedFullyLoaded());

  it('a typed credential replaces the stored one', async () => {
    const res = await patch('/providers/local-ds4', { credential: 'sk-rotated-key' });
    expect(res.status).toBe(200);
    expect(getProviderCredential('local-ds4')).toBe('sk-rotated-key');
  });

  it('an omitted credential keeps the stored one', async () => {
    const res = await patch('/providers/local-ds4', { name: 'Renamed' });
    expect(res.status).toBe(200); // without this the case passes when the route is absent
    expect(getProviderCredential('local-ds4')).toBe('sk-original-key');
  });

  it('a BLANK credential keeps the stored one — an untouched password field is not an erasure', async () => {
    const res = await patch('/providers/local-ds4', { name: 'Renamed', credential: '   ' });
    expect(res.status).toBe(200);
    expect(getProviderCredential('local-ds4')).toBe('sk-original-key');
    expect(row()).toMatchObject({ name: 'Renamed' });
  });

  it('an oauth provider rotates into its own slot, not the api-key one', async () => {
    mockDb.current!.prepare(`
      INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
      VALUES ('claude', 'Claude', 'anthropic', NULL, 'oauth', 1, datetime('now'), datetime('now'))
    `).run();
    setProviderCredential('claude', 'sk-ant-oat-old', 'oauth');
    await patch('/providers/claude', { credential: 'sk-ant-oat-new' });
    // Read the raw file, not just the resolved value, so WHICH SLOT is what is asserted:
    // `getProviderCredential` returns `api_key ?? oauth_token` and would answer the same
    // either way.
    const stored = fs.readFileSync(path.join(FAKE_DOJO, 'secrets.yaml'), 'utf-8');
    expect(stored).toContain('oauth_token: sk-ant-oat-new');
    expect(stored).not.toContain('api_key: sk-ant-oat-new');
    expect(getProviderCredential('claude')).toBe('sk-ant-oat-new');
  });

  it('the response never carries the stored key', async () => {
    const res = await patch('/providers/local-ds4', { credential: 'sk-rotated-key' });
    const body = JSON.stringify(await json(res));
    expect(body).not.toContain('sk-rotated-key');
    expect(body).not.toContain('sk-original-key');
    expect(body).not.toContain('credential');
  });

  it('refuses an empty-after-trim credential paired with nothing else, rather than reading as a no-op edit', async () => {
    const res = await patch('/providers/local-ds4', { credential: '' });
    expect(res.status).toBe(400);
    expect(getProviderCredential('local-ds4')).toBe('sk-original-key');
  });
});

describe('T66b — the validation badge resets only when the CONNECTION changed', () => {
  beforeEach(() => seedFullyLoaded());

  it('a rename leaves the provider validated', async () => {
    const res = await patch('/providers/local-ds4', { name: 'The Basement Box' });
    expect(await json(res)).toMatchObject({ revalidationRequired: false });
    expect(row()).toMatchObject({ is_validated: 1, validated_at: '2026-08-30T00:00:00Z' });
  });

  it('a dialect declaration leaves the provider validated — validate never reads it', async () => {
    const res = await patch('/providers/local-ds4', { behavesLike: 'generic-openai-compatible' });
    expect(res.status).toBe(200); // without this the case passes when the route is absent
    expect(row()).toMatchObject({ is_validated: 1 });
  });

  it('a base-URL change resets the badge and asks for revalidation', async () => {
    const res = await patch('/providers/local-ds4', { baseUrl: 'http://10.0.0.9:8000/v1' });
    expect(await json(res)).toMatchObject({ revalidationRequired: true });
    expect(row()).toMatchObject({ is_validated: 0, validated_at: null });
  });

  it('a credential rotation resets the badge', async () => {
    const res = await patch('/providers/local-ds4', { credential: 'sk-rotated-key' });
    expect(await json(res)).toMatchObject({ revalidationRequired: true });
    expect(row()).toMatchObject({ is_validated: 0, validated_at: null });
  });

  it('re-sending the SAME base URL is not a change and does not reset anything', async () => {
    const res = await patch('/providers/local-ds4', { baseUrl: 'http://127.0.0.1:8123/v1', name: 'Renamed' });
    expect(await json(res)).toMatchObject({ revalidationRequired: false });
    expect(row()).toMatchObject({ is_validated: 1, name: 'Renamed' });
  });
});

describe('T66b — the engine sentinel is not an editable provider', () => {
  it('refuses `__system__` with a plain message and leaves the row alone', async () => {
    const before = row('__system__');
    expect(before).toBeDefined(); // the seed the migration chain writes
    const res = await patch('/providers/__system__', { name: 'Mine now' });
    expect(res.status).toBe(400);
    expect(row('__system__')).toEqual(before);
  });
});

describe('T66b — a rename is display-only: the id is the key everywhere', () => {
  beforeEach(() => seedFullyLoaded());

  it('models, credentials and agent assignments all survive a rename untouched', async () => {
    const db = mockDb.current!;
    db.prepare(`
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
      VALUES ('m-local', 'local-ds4', 'Local DS4', 'deepseek-v4', '["text"]', 32768, 4096, 1, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
      VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{}', datetime('now'), datetime('now'))
    `).run();

    await patch('/providers/local-ds4', { name: 'Completely Different Name' });

    expect(db.prepare('SELECT provider_id FROM models WHERE id = ?').get('m-local'))
      .toEqual({ provider_id: 'local-ds4' });
    expect(db.prepare('SELECT model_id FROM agents WHERE id = ?').get('kevin'))
      .toEqual({ model_id: 'm-local' });
    expect(getProviderCredential('local-ds4')).toBe('sk-original-key');
    expect(await data(await get('/providers/local-ds4')))
      .toMatchObject({ id: 'local-ds4', name: 'Completely Different Name', baseUrl: 'http://127.0.0.1:8123/v1' });
  });
});

describe('T66b — CONTROL: the full-replace door it exists to avoid is unchanged', () => {
  it('a re-POST still clears an omitted field, exactly as W45 documented', async () => {
    // Not a regression and not a thing to fix here: `POST /providers` over an existing id has
    // always been a full replace, four other callers depend on that, and the answer to the trap
    // is the PATCH above rather than a change of meaning under the existing callers' feet.
    const body = {
      id: 'local-ds4', name: 'Local DS4', type: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8123/v1', authType: 'none', behavesLike: 'deepseek-native',
    };
    await post('/providers', { ...body, firstChunkTimeoutMs: 600_000 });
    expect(row()).toMatchObject({ first_chunk_timeout_ms: 600_000, behaves_like: 'deepseek-native' });

    await post('/providers', { ...body, behavesLike: undefined });
    expect(row()).toMatchObject({ first_chunk_timeout_ms: null, behaves_like: null });
  });
});
