// PHASE-0 T9: the out-of-box-experience doors must LOCK once first run is over.
//
// Before this task, `/api/setup/` was an unconditional public prefix: on a
// fully-configured, internet-reachable box, anyone could still call
// `/api/setup/deps/install/:dep` (installs software), `/api/setup/ollama/pull`,
// `/api/setup/permissions/request/:perm`, and — via the second, PUBLIC mount of
// the migration router at `/api/setup/migration` — restore an attacker-supplied
// database over the owner's. Nothing about the box being set up ever changed
// that. These tests pin the gate: OOBE routes are open ONLY while the box has
// genuinely never completed first run.
//
// Case (d) is the important one. `setup_completed` absent must NOT be read as
// "first run" when a dashboard password already exists — absence of a row is
// not evidence of absence of a setup (roadmap non-negotiable #15). The
// backfill migration (125) makes the DB itself honest; the gate refuses to
// depend on it having run.
//
// The gate is `isPastFirstRun()` in config/setup-state.ts — deliberately NOT
// `isSetupCompleted()` in config/platform.ts, which answers the spawn-gate
// version of the same question and fails the opposite way (see both files).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { Hono } from 'hono';

const TEST_SECRET = 'test-jwt-secret-for-setup-auth-tests';

// The two facts the gate reads: the config row (DB) and the dashboard password
// hash (secrets.yaml, via the config loader — a SQL migration cannot see it).
const state = {
  db: null as Database.Database | null,
  passwordHash: null as string | null,
};

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!state.db) throw new Error('test DB not initialized');
    return state.db;
  },
}));

vi.mock('../../config/loader.js', () => ({
  getJwtSecret: () => TEST_SECRET,
  getDashboardPasswordHash: () => state.passwordHash,
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Fresh in-memory config table; `completed` seeds the setup_completed row. */
function freshDb(opts: { setupRow?: 'true' | 'false' | null } = {}): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (opts.setupRow != null) {
    db.prepare("INSERT INTO config (key, value) VALUES ('setup_completed', ?)").run(opts.setupRow);
  }
  state.db = db;
}

/**
 * Build an app wired exactly like `gateway/server.ts:135` — the auth middleware
 * across the whole /api/* mount — with a catch-all behind it. A 200 means the
 * middleware let the request through; 401/403 means it refused. The route
 * handlers themselves are not under test here; the door is.
 *
 * Each call re-imports the middleware through a reset module registry so the
 * `isPastFirstRun()` cache starts cold, the way it does on a fresh boot.
 */
async function buildApp(): Promise<Hono> {
  vi.resetModules();
  const { authMiddleware } = await import('../middleware/auth.js');
  const app = new Hono();
  app.use('/api/*', authMiddleware);
  app.all('/api/*', (c) => c.json({ ok: true, reached: true }));
  return app;
}

const ownerToken = (): string => jwt.sign({ userId: 'admin' }, TEST_SECRET, { expiresIn: '1h' });

beforeEach(() => {
  state.db = null;
  state.passwordHash = null;
});

describe('(a) before first run completes, the OOBE doors are open', () => {
  beforeEach(() => {
    freshDb({ setupRow: null });
    state.passwordHash = null; // nothing set yet — a genuinely fresh box
  });

  it('GET /api/setup/deps/check needs no token', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/deps/check');
    expect(res.status).toBe(200);
  });

  it('POST /api/setup/provision-agent needs no token', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/provision-agent', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('(b) after first run, the OOBE doors are shut to anonymous callers', () => {
  beforeEach(() => {
    freshDb({ setupRow: 'true' });
    state.passwordHash = '$2b$12$fakehashfakehashfakehashfake';
  });

  it('GET /api/setup/deps/check without a token is refused', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/deps/check');
    expect(res.status).toBe(401);
  });

  it('POST /api/setup/migration/import without a token is refused', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/migration/import', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /api/migration/import — the one real mount — was never public', async () => {
    const app = await buildApp();
    const res = await app.request('/api/migration/import', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('the always-public doors stay open: health, login, setup status', async () => {
    const app = await buildApp();
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/auth/login', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/setup/status')).status).toBe(200);
  });
});

describe('(c) after first run, the owner still gets in', () => {
  beforeEach(() => {
    freshDb({ setupRow: 'true' });
    state.passwordHash = '$2b$12$fakehashfakehashfakehashfake';
  });

  it('GET /api/setup/deps/check with the owner JWT succeeds', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/deps/check', {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/migration/import with the owner JWT succeeds', async () => {
    const app = await buildApp();
    const res = await app.request('/api/migration/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('(d) an ABSENT setup_completed row is not evidence of first run', () => {
  // The bug class this pins: `row?.value === 'true'` coerces a missing row to
  // false, i.e. "first run", i.e. doors open — on a box that plainly has an
  // owner, because it has a password. Every pre-flag install is that box.
  beforeEach(() => {
    freshDb({ setupRow: null });
    state.passwordHash = '$2b$12$fakehashfakehashfakehashfake';
  });

  it('GET /api/setup/deps/check is refused when a password hash exists', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/deps/check');
    expect(res.status).toBe(401);
  });

  it('POST /api/setup/migration/import is refused when a password hash exists', async () => {
    const app = await buildApp();
    const res = await app.request('/api/setup/migration/import', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('the Upgrade: websocket bypass stays closed (T9 Step 0 regression)', () => {
  beforeEach(() => {
    freshDb({ setupRow: 'true' });
    state.passwordHash = '$2b$12$fakehashfakehashfakehashfake';
  });

  it('a protected route carrying Upgrade: websocket is still refused', async () => {
    const app = await buildApp();
    const res = await app.request('/api/agents', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(401);
  });

  it('the three real WS endpoints still pass through to their own handlers', async () => {
    const app = await buildApp();
    for (const p of ['/api/ws', '/api/ws/voice', '/api/screen/vnc']) {
      const res = await app.request(p, { headers: { Upgrade: 'websocket' } });
      expect(res.status, p).toBe(200);
    }
  });
});

// ── The durable half: migration 125 ──
//
// The gate above keeps a legacy box closed at runtime. 125 makes the database
// itself say so, so the fact survives into the Stable Bridge instead of being
// re-derived on every request.
describe('migration 125 backfills setup_completed on a lived-in box', () => {
  const SQL = fs.readFileSync(
    path.join(HERE, '..', '..', 'db', 'migrations', '125_setup_completed_backfill.sql'),
    'utf-8',
  );

  function boxDb(seed: { providers?: string[]; enabledModels?: string[]; setupRow?: string | null }): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE providers (id TEXT PRIMARY KEY);
      CREATE TABLE models (id TEXT PRIMARY KEY, is_enabled INTEGER NOT NULL DEFAULT 0);
    `);
    db.prepare("INSERT INTO providers (id) VALUES ('__system__')").run();
    db.prepare("INSERT INTO models (id, is_enabled) VALUES ('auto', 1)").run();
    for (const p of seed.providers ?? []) db.prepare('INSERT INTO providers (id) VALUES (?)').run(p);
    for (const m of seed.enabledModels ?? []) db.prepare('INSERT INTO models (id, is_enabled) VALUES (?, 1)').run(m);
    if (seed.setupRow != null) {
      db.prepare("INSERT INTO config (key, value) VALUES ('setup_completed', ?)").run(seed.setupRow);
    }
    return db;
  }

  const flag = (db: Database.Database): string | null =>
    ((db.prepare("SELECT value FROM config WHERE key = 'setup_completed'").get() as { value: string } | undefined)
      ?.value) ?? null;

  it('stamps a configured box that predates the flag', () => {
    const db = boxDb({ providers: ['anthropic'], enabledModels: ['claude'] });
    db.exec(SQL);
    expect(flag(db)).toBe('true');
  });

  it('leaves a genuinely fresh box alone (only the seeded sentinels present)', () => {
    const db = boxDb({});
    db.exec(SQL);
    expect(flag(db)).toBeNull();
  });

  it('is idempotent — a second run changes nothing', () => {
    const db = boxDb({ providers: ['anthropic'] });
    db.exec(SQL);
    const first = db.prepare("SELECT value, updated_at FROM config WHERE key = 'setup_completed'").get();
    db.exec(SQL);
    expect(db.prepare("SELECT value, updated_at FROM config WHERE key = 'setup_completed'").get()).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS c FROM config WHERE key = 'setup_completed'").get()).toEqual({ c: 1 });
  });

  it('never overwrites an existing row, including an explicit false', () => {
    const db = boxDb({ providers: ['anthropic'], setupRow: 'false' });
    db.exec(SQL);
    expect(flag(db)).toBe('false');
  });

  it('touches nothing but its own config row', () => {
    const db = boxDb({ providers: ['anthropic'], enabledModels: ['claude'] });
    db.prepare("INSERT INTO config (key, value) VALUES ('primary_agent_id', 'sensei')").run();
    db.exec(SQL);
    expect(db.prepare('SELECT COUNT(*) AS c FROM providers').get()).toEqual({ c: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM models').get()).toEqual({ c: 2 });
    expect(db.prepare("SELECT value FROM config WHERE key = 'primary_agent_id'").get()).toEqual({ value: 'sensei' });
  });
});
