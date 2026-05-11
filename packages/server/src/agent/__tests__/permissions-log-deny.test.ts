// error-handling-spec Phase 3 — verify GLOBAL_FILE_READ_DENY blocks raw
// Healer log access regardless of agent permission manifest.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { checkPermission } from '../permissions.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      permissions TEXT,
      spawn_depth INTEGER DEFAULT 0,
      group_id TEXT
    );
    CREATE TABLE techniques (id TEXT PRIMARY KEY, directory_path TEXT, state TEXT);
    CREATE TABLE squad_memberships (squad_id TEXT, agent_id TEXT);
    CREATE TABLE squads (id TEXT, workspace_path TEXT);
  `);
  // Give the test agent a wildcard manifest — proves the GLOBAL deny
  // overrides individual-agent permissions.
  const wildcardManifest = JSON.stringify({
    file_read: '*',
    file_write: '*',
    file_delete: 'none',
    exec_allow: [],
    exec_deny: [],
    network_allow: ['*'],
    can_spawn: false,
    can_assign_permissions: false,
    system_control: [],
  });
  db.prepare('INSERT INTO agents (id, permissions) VALUES (?, ?)').run('healer', wildcardManifest);
  mockDb.current = db;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('GLOBAL_FILE_READ_DENY — Healer log paths', () => {
  it('denies file_read on ~/.dojo/logs/healer.log even with wildcard manifest', () => {
    const result = checkPermission('healer', { type: 'file_read', path: '~/.dojo/logs/healer.log' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/healer_recent_actions|engine helper/i);
  });

  it('denies file_read on a healer-report archive', () => {
    const result = checkPermission('healer', {
      type: 'file_read',
      path: '~/.dojo/logs/healer-archives/healer-report-2026-04-13T04-40-33.log',
    });
    expect(result.allowed).toBe(false);
  });

  it('still allows file_read on the regular dojo.log', () => {
    const result = checkPermission('healer', { type: 'file_read', path: '~/.dojo/logs/dojo.log' });
    expect(result.allowed).toBe(true);
  });

  it('still allows file_read on a regular config path', () => {
    const result = checkPermission('healer', { type: 'file_read', path: '/tmp/config.yaml' });
    expect(result.allowed).toBe(true);
  });
});
