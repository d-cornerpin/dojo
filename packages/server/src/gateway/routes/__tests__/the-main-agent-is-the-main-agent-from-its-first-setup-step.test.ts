// First-run setup creates the main agent in one request and saves the rest later: from that first request
// on, the new agent already has the main agent's full reach, and the later save of the same pointer is harmless.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../../config/setup-state.js', () => ({ isPastFirstRun: () => false, markFirstRunComplete: vi.fn() }));

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';
import { clearPlatformConfigCache, setPlatformConfig } from '../../../config/platform.js';
import { getAgentPermissions, PRIMARY_AGENT_PERMISSIONS } from '../../../agent/permissions.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("DELETE FROM config WHERE key = 'primary_agent_id'").run();
  clearPlatformConfigCache();
});

describe('the main agent is the main agent from its first setup step', () => {
  it('has the full reach after the provisioning request alone, and keeps it after the later save', async () => {
    const res = await setupDepsRouter.request('/provision-agent', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'atlas', name: 'Atlas', classification: 'sensei', primary: true }),
    });
    expect(res.status).toBe(200);
    expect(getAgentPermissions('atlas')).toEqual(PRIMARY_AGENT_PERMISSIONS);
    setPlatformConfig('primary_agent_id', 'atlas');
    expect(getAgentPermissions('atlas')).toEqual(PRIMARY_AGENT_PERMISSIONS);
  });

  it('an agent provisioned without the main-agent flag is not made the main agent', async () => {
    await setupDepsRouter.request('/provision-agent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'scout', name: 'Scout' }),
    });
    expect(getAgentPermissions('scout')).not.toEqual(PRIMARY_AGENT_PERMISSIONS);
  });
});
