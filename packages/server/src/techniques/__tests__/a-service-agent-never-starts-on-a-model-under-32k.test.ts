// A service agent created at boot takes its setting's model, else the main agent's; one under the 32K floor
// becomes the auto-router (which offers only models that clear it), and a big one is kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../agent/primary-ready.js', () => ({ primaryReady: () => true }));

import { runMigrations } from '../../db/migrations.js';
import { ensureTrainerAgentRunning } from '../trainer-agent.js';
import { getTrainerAgentId, getPrimaryAgentId } from '../../config/platform.js';

const db = (): Database.Database => mockDb.current!;
const trainerModel = (): string | null => (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(getTrainerAgentId()) as { model_id: string | null }).model_id;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(db());
  db().prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  for (const [id, window] of [['m-small', 8192], ['m-big', 128_000]] as const) {
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
      VALUES (?, 'cloud', ?, ?, '["chat","tools"]', ?, 1)`).run(id, id, id, window);
  }
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const seedPrimary = (modelId: string): void => {
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Main', ?, 'idle', '{}')").run(getPrimaryAgentId(), modelId);
};

describe('a service agent never starts on a model under 32K', () => {
  it('inheriting a small main model becomes auto', () => {
    seedPrimary('m-small');
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('auto');
  });

  it('a big main model is inherited as it is', () => {
    seedPrimary('m-big');
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('m-big');
  });

  it('a stored small setting becomes auto as well', () => {
    seedPrimary('m-big');
    db().prepare("INSERT INTO config (key, value) VALUES ('trainer_agent_model', 'm-small')").run();
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('auto');
  });
});
