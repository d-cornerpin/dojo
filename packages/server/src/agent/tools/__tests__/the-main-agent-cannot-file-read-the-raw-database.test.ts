// The owner's ruling stands: the raw database file is not read through the file tools, by the main
// agent either, nor its backup copies.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'raw-db-'));
vi.stubEnv('DOJO_HOME', home);
const project = path.join(home, 'code', 'site');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, '.env.example'), 'PORT=3000\n');
fs.writeFileSync(path.join(project, '.env'), 'PORT=3000\n');
fs.writeFileSync(path.join(project, '.npmrc'), 'registry=https://registry.example.com/\n');

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolWasBlocked } = await import('../index.js');

const WIDE = JSON.stringify({ file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], shell_allow: ['*'], shell_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', WIDE);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (agentId: string, name: string, args: Record<string, unknown>) => executeTool(agentId, { id: `call-${name}`, name, arguments: args });
const dotenv = path.join(project, '.env');

describe('the main agent cannot file_read the raw database', () => {
  it.each(['data/dojo.db', 'data/dojo.db-wal', 'backups/dojo-old.db'])('%s', async (rel) => {
    const file = path.join(home, '.dojo', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'not a real database');
    expect(toolWasBlocked(await run(MAIN, 'file_read', { path: file }))).toBe(true);
  });
});
