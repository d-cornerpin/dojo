// A service agent created at boot takes its setting's model, else the main agent's; one under the 32K floor
// is replaced by the cheapest model that clears it, and a big one is kept.
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
  it('inheriting a small main model becomes the cheapest model that clears the floor', () => {
    seedPrimary('m-small');
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('m-big');
  });

  it('a big main model is inherited as it is', () => {
    seedPrimary('m-big');
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('m-big');
  });

  it('a stored small setting is replaced the same way', () => {
    seedPrimary('m-big');
    db().prepare("INSERT INTO config (key, value) VALUES ('trainer_agent_model', 'm-small')").run();
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('m-big');
  });
});

describe('the replacement for a small model', () => {
  it('is the cheapest model that clears the floor', () => {
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled, input_cost_per_m)
      VALUES ('m-cheap', 'cloud', 'Cheap', 'cheap', '["chat","tools"]', 64000, 1, 0.1)`).run();
    db().prepare("UPDATE models SET input_cost_per_m = 5 WHERE id = 'm-big'").run();
    seedPrimary('m-small');
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('m-cheap');
  });

  it('an empty stored setting is ignored', () => {
    seedPrimary('m-big');
    db().prepare("INSERT INTO config (key, value) VALUES ('trainer_agent_model', '')").run();
    ensureTrainerAgentRunning();
    expect(trainerModel()).toBe('m-big');
  });
});
