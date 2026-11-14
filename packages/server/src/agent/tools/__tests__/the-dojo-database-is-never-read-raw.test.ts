// The file-read tool refuses the raw Dojo database, its -wal and -shm side files and its backup
// copies for every agent, the main agent and the Healer included; an ordinary file in the data
// folder stays readable. Driven through the tool executor with the real grants.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HEALER = 'agent-healer';
const WORKER = 'agent-worker';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'raw-db-read-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf, toolWasBlocked } = await import('../index.js');

const data = path.join(home, '.dojo', 'data');
const RAW = [
  path.join(data, 'dojo.db'),
  path.join(data, 'dojo.db-wal'),
  path.join(data, 'dojo.db-shm'),
  path.join(data, 'backups', 'dojo-pre-1-to-2.db'),
  path.join(home, '.dojo', 'backups', 'dojo-copy.db'),
];
const ORDINARY = path.join(data, 'toolbox-groups.json');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const wide = JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: '*', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HEALER, 'healer', 'sensei', wide);
  add.run(WORKER, 'worker', 'apprentice', wide);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(MAIN, HEALER);
  platform.clearPlatformConfigCache();
  for (const file of [...RAW, ORDINARY]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, file === ORDINARY ? '{"groups":[]}' : 'raw bytes');
  }
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const read = (agentId: string, file: string) => executeTool(agentId, { id: `call-${agentId}`, name: 'file_read', arguments: { path: file } });

describe('the Dojo database is never read raw', () => {
  for (const who of [MAIN, HEALER, WORKER]) {
    it.each(RAW)(`${who} is refused: %s`, async (file) => {
      const outcome = await read(who, file);
      expect(toolResultOf(outcome).content).not.toContain('raw bytes');
      expect(toolResultOf(outcome).content).toContain('is prohibited');
      expect(toolWasBlocked(outcome)).toBe(true);
    });
    it(`${who} still reads an ordinary file in the data folder`, async () => {
      expect(toolResultOf(await read(who, ORDINARY)).content).toContain('{"groups":[]}');
    });
  }
});
