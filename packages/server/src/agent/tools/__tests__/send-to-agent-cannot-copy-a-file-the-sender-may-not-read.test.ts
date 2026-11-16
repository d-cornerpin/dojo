// send_to_agent copies its attachments into the recipient's folder, so a helper cannot hand over a file
// its own read limit does not cover: the call is refused and nothing is copied. Driven through executeTool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'a2a-copy-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolWasBlocked } = await import('../index.js');

const privateFile = path.join(home, 'Private', 'diary.txt');
const recipientDir = path.join(home, '.dojo', 'uploads', MAIN);

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const limited = JSON.stringify({ file_read: ['~/Projects/**'], file_write: ['~/Projects/**'], exec_allow: [], exec_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', limited);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  fs.writeFileSync(privateFile, 'private words');
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('send_to_agent cannot copy a file the sender may not read', () => {
  it('the call is refused and the recipient folder holds no copy', async () => {
    const outcome = await executeTool(HELPER, {
      id: 'call-a2a', name: 'send_to_agent',
      arguments: { agent: MAIN, payload: 'Here is the file.', intent: 'FYI', attach_paths: [privateFile] },
    });
    expect(toolWasBlocked(outcome)).toBe(true);
    const copies = fs.existsSync(recipientDir) ? fs.readdirSync(recipientDir).filter((f) => f.includes('diary')) : [];
    expect(copies).toEqual([]);
  });
});
