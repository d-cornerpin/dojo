// A safe-sender list (the people the agent may auto-reply to) is saved whole. A save built on a
// list the client did not read most recently - blank after a failed load, or older than what is
// stored - must be refused with a plain message and change nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-clock-time-doors', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import * as coldImport1 from '../../../config/platform.js';

const db = (): Database.Database => mockDb.current!;

const seedModel = (id: string, window: number | null): void => {
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, '["text"]', ?, 1024, 1, datetime('now'), datetime('now'))
  `).run(id, `Model ${id}`, id, window);
};
const seedAgent = (id: string, modelId: string, parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, parent_agent, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'idle', '{}', 0, ?, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, modelId, parent);
};
const setConfig = (k: string, v: string): void => {
  db().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
};
const getConfig = (k: string): string | undefined =>
  (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const key = 'gmail_approved_senders_acct1';
const put = (k: string, body: unknown) => configRouter.request(`/settings/${k}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const stored = (k: string): string | null =>
  (mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
const list = (...a: string[]) => JSON.stringify(a.map((address) => ({ address, name: address, is_primary: false, sharing_level: 'dont_overshare' })));

beforeEach(() => {
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a safe-sender list save', () => {
  it('refuses a blank-based save over a saved list and leaves it unchanged', async () => {
    const real = list('a@x.test', 'b@x.test');
    expect((await put(key, { value: real, base: null })).status).toBe(200);
    const res = await put(key, { value: list('c@x.test'), base: null });
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/changed/i);
    expect(stored(key)).toBe(real);
  });

  it('refuses a save built on an older version', async () => {
    const v1 = list('a@x.test');
    const v2 = list('a@x.test', 'b@x.test');
    await put(key, { value: v1, base: null });
    await put(key, { value: v2, base: v1 });
    expect((await put(key, { value: list('a@x.test', 'c@x.test'), base: v1 })).status).toBe(409);
    expect(stored(key)).toBe(v2);
  });

  it('accepts a save built on the stored version', async () => {
    const v1 = list('a@x.test');
    await put(key, { value: v1, base: null });
    expect((await put(key, { value: list(), base: v1 })).status).toBe(200);
    expect(stored(key)).toBe(list());
  });

  it('refuses a save that says nothing about what it was built on', async () => {
    expect((await put(key, { value: list('a@x.test') })).status).toBe(400);
    expect(stored(key)).toBeNull();
  });

  it('leaves other keys alone', async () => {
    expect((await put('some_other_key', { value: 'x' })).status).toBe(200);
  });
});

// Owner ruling: the owner flag never moves, and is never removed, as a side effect of another edit.
const withOwner = (owner: string | null, ...others: string[]) =>
  JSON.stringify([...(owner ? [{ address: owner, name: owner, is_primary: true, sharing_level: 'open_book' }] : []),
    ...others.map((address) => ({ address, name: address, is_primary: false, sharing_level: 'dont_overshare' }))]);

describe('a safe-sender save that changes who the owner is', () => {
  const k = 'imessage_approved_senders';
  it('is refused unless it says it is an owner change, and writes nothing', async () => {
    const v1 = withOwner('me@x.test', 'b@x.test');
    await put(k, { value: v1, base: null, ownerChange: true });
    const res = await put(k, { value: withOwner(null, 'b@x.test'), base: v1 });   // the starred row deleted
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/owner/i);
    expect(stored(k)).toBe(v1);
  });
  it('is refused when the star would move to another entry', async () => {
    const v1 = withOwner('me@x.test', 'b@x.test');
    await put(k, { value: v1, base: null, ownerChange: true });
    expect((await put(k, { value: withOwner('b@x.test', 'me@x.test'), base: v1 })).status).toBe(409);
  });
  it('is accepted when it says so (removing the starred owner leaves no owner)', async () => {
    const v1 = withOwner('me@x.test', 'b@x.test');
    await put(k, { value: v1, base: null, ownerChange: true });
    expect((await put(k, { value: withOwner(null, 'b@x.test'), base: v1, ownerChange: true })).status).toBe(200);
  });
  it('an edit that leaves the owner alone needs no flag', async () => {
    const v1 = withOwner('me@x.test', 'b@x.test');
    await put(k, { value: v1, base: null, ownerChange: true });
    expect((await put(k, { value: withOwner('me@x.test'), base: v1 })).status).toBe(200);
  });
});

// Review fix 1: "who is the owner" is judged by the ONE reader (parseSafeSenders), on both sides. A box whose
// stored list is a bare-address list, or has no star but the legacy default-sender key names an entry, saves
// normally when the dashboard writes that same owner back with its star.
describe('the owner check uses the same reader as everything else', () => {
  const k = 'imessage_approved_senders';
  const setRaw = (key: string, v: string) => mockDb.current!.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, v);

  it('a bare-address list saves when the dashboard writes its first entry back starred', async () => {
    const bare = JSON.stringify(['+15550001', '+15550002']);
    setRaw(k, bare);
    const res = await put(k, { value: withOwner('+15550001', '+15550002'), base: bare, ownerChange: false });
    expect(res.status).toBe(200);
  });
  it('an unstarred list whose legacy key names the second entry saves with that entry starred', async () => {
    const raw = withOwner(null, '+15550001', '+15550002');
    setRaw(k, raw);
    setRaw('imessage_default_sender', '+15550002');
    const body = JSON.stringify([
      { address: '+15550001', name: '+15550001', is_primary: false, sharing_level: 'dont_overshare' },
      { address: '+15550002', name: '+15550002', is_primary: true, sharing_level: 'open_book' },
    ]);
    expect((await put(k, { value: body, base: raw, ownerChange: false })).status).toBe(200);
  });
  it('moving the star off the bare list\'s first entry still needs the flag', async () => {
    const bare = JSON.stringify(['+15550001', '+15550002']);
    setRaw(k, bare);
    expect((await put(k, { value: withOwner('+15550002', '+15550001'), base: bare })).status).toBe(409);
  });
});
