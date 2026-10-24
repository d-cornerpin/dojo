// ════════════════════════════════════════════════════════════════════════════════════
// E21 fix round 1 — THE HEALER'S BOOT NEVER ENDS AN AGENT BECAUSE OF ITS NAME.
//
// Making the Healer's boot cleanup match names without regard to case turned a name collision
// into a destructive act: an agent the OWNER made, called "healer" (or "HEALER"), was terminated on
// every boot because its name differs from the Healer's only by capital letters. Owner law: nothing
// relies on agent names. The Healer is identified by its id (config `healer_agent_id`), and the
// boot ends no other agent.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; } };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { ensureHealerAgentRunning } from '../healer-agent.js';

const status = (id: string): string => (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  const put = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  put.run('setup_completed', 'true');
  put.run('primary_agent_id', 'main-agent');
  put.run('healer_agent_id', 'healer-resident');
  put.run('healer_agent_name', 'Healer');
  clearPlatformConfigCache();
  const add = db.prepare(`INSERT INTO agents (id, name, model_id, status, config) VALUES (?, ?, 'm', 'idle', '{}')`);
  add.run('main-agent', 'Main');
  add.run('healer-resident', 'Healer');
});

describe('the Healer boot ends no agent by name', () => {
  it('an owner agent named like the Healer in another case survives the boot', () => {
    mockDb.current!.prepare(`INSERT INTO agents (id, name, model_id, status, config) VALUES ('owner-made', 'healer', 'm', 'idle', '{}')`).run();
    mockDb.current!.prepare(`INSERT INTO agents (id, name, model_id, status, config) VALUES ('owner-made-2', 'HEALER', 'm', 'idle', '{}')`).run();
    ensureHealerAgentRunning();
    expect(status('owner-made')).toBe('idle');
    expect(status('owner-made-2')).toBe('idle');
    expect(status('healer-resident')).toBe('idle');
  });

  it('an owner agent with exactly the Healer\'s name survives too (the boot identifies the Healer by id)', () => {
    mockDb.current!.prepare(`INSERT INTO agents (id, name, model_id, status, config) VALUES ('owner-made', 'Healer', 'm', 'idle', '{}')`).run();
    ensureHealerAgentRunning();
    expect(status('owner-made')).toBe('idle');
  });
});
