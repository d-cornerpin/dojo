// An agent made before a setting left the manifest keeps working: its stored row still carries the old
// `max_processes`, and its scope loads as stored, with no error and nothing re-scoped.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()), isPrimaryAgent: (id: string) => id === 'main',
}));

import { runMigrations } from '../../db/migrations.js';
import { checkPermission, getAgentPermissions } from '../permissions.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const old = { file_read: ['~/Projects/**'], file_write: ['~/Projects/**'], exec_allow: ['git'], exec_deny: [], network_domains: '*', max_processes: 3, can_spawn_agents: true, can_assign_permissions: false, system_control: [] };
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config, permissions, spawn_depth, created_by) VALUES ('old-helper', 'Old', 'idle', '{}', ?, 1, 'main')").run(JSON.stringify(old));
});

describe('a stored manifest with a removed setting still loads', () => {
  it('keeps the scope it was given', () => {
    const scope = getAgentPermissions('old-helper');
    expect(scope.can_spawn_agents).toBe(true);
    expect(checkPermission('old-helper', { type: 'file_read', path: '~/Projects/site/index.html' }).allowed).toBe(true);
    expect(checkPermission('old-helper', { type: 'exec', command: 'git status' }).allowed).toBe(true);
    expect(checkPermission('old-helper', { type: 'spawn' }).allowed).toBe(true);
  });
});
