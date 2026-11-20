// The main agent spawns a helper and names no limits: the helper works in its own folders (/tmp and its
// uploads folder), never in the owner's projects or anywhere else on the Mac.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { runMigrations } from '../../db/migrations.js';
import { spawnAgent } from '../spawner.js';
import { checkPermission } from '../permissions.js';
import { artifactDirFor } from '../manifest.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'cloud', 'M', 'm', '["chat","tools"]', 128000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('main', 'Main', 'm', 'idle', '{}')").run();
});

describe('a helper spawned without limits cannot read the owner\'s projects', () => {
  it('reads and writes only its own folders', async () => {
    const { agentId } = await spawnAgent({ parentId: 'main', name: 'Helper', systemPrompt: 'Sort files.' });
    const read = (path: string) => checkPermission(agentId, { type: 'file_read', path }).allowed;
    const write = (path: string) => checkPermission(agentId, { type: 'file_write', path }).allowed;
    expect(read('~/Projects/site/index.html')).toBe(false);
    expect(write('~/Projects/site/index.html')).toBe(false);
    expect(read('~/Documents/taxes.pdf')).toBe(false);
    expect(read('/tmp/work/notes.txt')).toBe(true);
    expect(write('/tmp/work/notes.txt')).toBe(true);
    expect(write(`${artifactDirFor(agentId)}/chart.png`)).toBe(true);
  });
});
