// Re-running setup after first run must never create a second primary agent, repoint the primary,
// or delete a real agent that happens to share a placeholder id. The primary is found by the
// stored primary_agent_id, never by the name typed in the wizard.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return { createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }), setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [] };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('no db'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-setup-primary-id', 'dojo.db'),
  };
});
const past = { value: true };
vi.mock('../../../config/setup-state.js', () => ({ isPastFirstRun: () => past.value, markFirstRunComplete: vi.fn() }));

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';

const db = (): Database.Database => mockDb.current!;
const seedAgent = (id: string, name: string): void => {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))`).run(id, name);
};
const provision = (body: unknown) => setupDepsRouter.request('/provision-agent', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const names = (): string[] => (db().prepare('SELECT id FROM agents ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  past.value = true;
  d.prepare('DELETE FROM agents').run();
});

describe('provision-agent with primary:true after first run', () => {
  it('renames the stored primary and creates nothing, whatever id the caller derived', async () => {
    seedAgent('alpha', 'Alpha');
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'alpha')").run();
    const res = await provision({ id: 'beta', name: 'Beta', primary: true });
    const j = await res.json() as { ok: boolean; data: { id: string; action: string } };
    expect(j.ok).toBe(true);
    expect(j.data.id).toBe('alpha');
    expect(j.data.action).toBe('updated');
    expect(names()).toEqual(['alpha']);
    expect((db().prepare("SELECT name FROM agents WHERE id='alpha'").get() as { name: string }).name).toBe('Beta');
  });

  it('never deletes a real agent that has a placeholder id', async () => {
    seedAgent('alpha', 'Alpha');
    seedAgent('pm', 'Real PM');
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'gone')").run();
    await provision({ id: 'beta', name: 'Beta', primary: true });
    expect(names()).toContain('pm');
  });
});

describe('a stale stored primary id', () => {
  it('never adopts another agent just because the typed name derives its id', async () => {
    seedAgent('beta', 'Someone Else');
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'gone')").run();
    const res = await provision({ id: 'beta', name: 'Brand New', primary: true });
    const j = await res.json() as { ok: boolean; data: { id: string; action: string } };
    expect(j.data.action).toBe('created');
    expect(j.data.id).not.toBe('beta');
    expect((db().prepare("SELECT name FROM agents WHERE id='beta'").get() as { name: string }).name).toBe('Someone Else');
  });
});
