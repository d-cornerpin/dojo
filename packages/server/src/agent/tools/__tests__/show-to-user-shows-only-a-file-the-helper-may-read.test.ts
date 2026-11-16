// show_to_user puts a picture in the chat, so a helper limited to one folder is refused a picture
// outside it. Driven through executeTool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'show-fence-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolWasBlocked } = await import('../index.js');

const outside = path.join(home, 'Private', 'photo.png');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const limited = JSON.stringify({ file_read: ['~/Projects/**'], file_write: ['~/Projects/**'], exec_allow: [], exec_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', limited);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'not really png bytes');
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('show_to_user shows only a file the helper may read', () => {
  it('a picture outside the folder is refused', async () => {
    expect(toolWasBlocked(await executeTool(HELPER, { id: 'call-show', name: 'show_to_user', arguments: { file_paths: [outside] } }))).toBe(true);
  });
});
