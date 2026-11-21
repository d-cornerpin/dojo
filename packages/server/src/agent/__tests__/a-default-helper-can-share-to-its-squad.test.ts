// A helper spawned into a squad with no stated grants can write to the squad's memory, and the main agent,
// which sits in the System group, can read that squad by naming it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../services/resource-monitor.js', () => ({ canSpawnAgent: () => ({ allowed: true }) }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: vi.fn(async () => new Float32Array(8).fill(0.5)), queueEmbedding: vi.fn() }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main', getPrimaryAgentId: () => 'main',
}));

import { runMigrations } from '../../db/migrations.js';
import { spawnAgent } from '../spawner.js';
import { executeTool, toolResultOf } from '../tools/index.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'cloud', 'M', 'm', '["chat","tools"]', 128000, 1)`).run();
  mockDb.current.prepare("INSERT OR IGNORE INTO agent_groups (id, name, created_by) VALUES ('system-group', 'Masters', 'system'), ('crew', 'Crew', 'main'), ('other', 'Other', 'someone-else')").run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config, group_id) VALUES ('main', 'Main', 'm', 'idle', '{}', 'system-group')").run();
});

const call = async (agentId: string, name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(agentId, { id: `tc-${Math.random()}`, name, arguments: args }));

describe('a default helper can share to its squad', () => {
  it('the helper shares and the main agent recalls it by the squad id', async () => {
    const { agentId } = await spawnAgent({ parentId: 'main', name: 'Scout', systemPrompt: 'Scout.', groupId: 'crew' });
    const shared = await call(agentId, 'squad_share', { content: 'The supplier closes at 5pm on Fridays.' });
    expect(shared.isError, shared.content).toBeFalsy();
    const recalled = await call('main', 'squad_recall', { query: 'supplier', group_id: 'crew' });
    expect(recalled.content).toContain('closes at 5pm');
  });

  it('a helper cannot read a squad it neither belongs to nor created', async () => {
    const { agentId } = await spawnAgent({ parentId: 'main', name: 'Scout', systemPrompt: 'Scout.', groupId: 'crew' });
    const r = await call(agentId, 'squad_recall', { query: '', group_id: 'other' });
    expect(r.isError).toBe(true);
  });
});
