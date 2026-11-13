// A model under the 32K main-model floor that sits on a router tier serves no agent turn and does not
// set the router window; a helper job (no tools asked) may still use it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { selectModel, routedSkipReasons } from '../selector.js';
import { routerWindowFloor } from '../router-window.js';

const db = (): Database.Database => mockDb.current!;
const onTiers = (modelId: string, tiers: string[]): void => {
  for (const t of tiers) db().prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, ?)').run(t, modelId, modelId === 'm-small' ? 0 : 1);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1)`).run();
  const model = db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
    VALUES (?, 'prov', ?, ?, '["text","tools"]', ?, 4096, 1)`);
  model.run('m-small', 'Small', 'small', 8_192);
  model.run('m-big', 'Big', 'big', 200_000);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config) VALUES ('a-auto', 'Desk', 'auto', 'idle', '{}')`).run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a tier model under 32K runs no agent turn', () => {
  it('beside a big model: the agent turn gets the big one, the window is the big one\'s, a helper may get the small one', () => {
    onTiers('m-small', ['light']);
    onTiers('m-big', ['light', 'standard', 'heavy']);
    expect(selectModel('light', 'a-auto', [], ['tools'])?.modelId).toBe('m-big');
    expect(routerWindowFloor()?.modelId).toBe('m-big');
    expect(selectModel('light', 'a-auto')?.modelId).toBe('m-small');
  });

  it('alone on every tier: no agent-turn pick, and the router names it too small', () => {
    onTiers('m-small', ['light', 'standard', 'heavy']);
    expect(selectModel('light', 'a-auto', [], ['tools'])).toBeNull();
    expect(routedSkipReasons('light', 'a-auto', [], ['tools'])).toEqual([{ modelId: 'm-small', skip: 'too_small' }]);
    expect(routerWindowFloor()).toBeNull();
  });
});
