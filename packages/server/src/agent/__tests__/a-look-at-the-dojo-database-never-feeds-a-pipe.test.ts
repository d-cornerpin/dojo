// A metadata look at the Dojo database or its data folder (ls, stat, ...) is a look only while
// its output goes nowhere else: piped onward it could name the file to a reader, so it is refused.
// Driven through the exec seam the broker uses, for the two roles that get metadata looks.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HEALER = 'agent-healer';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'door-pipe-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const brokers = await import('../brokers/index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', 'sensei', ?)");
  add.run(MAIN, 'main', null);
  add.run(HEALER, 'healer', JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: '*', file_delete: 'none', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }));
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(MAIN, HEALER);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const allowed = (who: string, line: string): boolean => brokers.authorizeExecShapedCall(brokers.grantFor(who), 'shell', line).allowed;

const PIPED = [
  'ls -d ~/.dojo/data/dojo.db | xargs cat',
  'stat -f %N ~/.dojo/data/dojo.db | xargs strings',
  'ls ~/.dojo/data | xargs -I{} cat ~/.dojo/data/{}',
  'ls ~/.dojo/data | wc -l',
  'find ~/.dojo -name "*.db" | xargs strings',
];
const STANDALONE = [
  'ls -la ~/.dojo/data/dojo.db',
  'find ~/.dojo/data -name "*.db"',
  'ls -la ~/.dojo/data && stat ~/.dojo/data/dojo.db-wal',
  'sqlite3 -readonly ~/.dojo/data/dojo.db "select id from agents" | head -5',
];

describe('a look at the Dojo database never feeds a pipe', () => {
  for (const who of [MAIN, HEALER]) {
    it.each(PIPED)(`${who} is refused: %s`, (line) => expect(allowed(who, line)).toBe(false));
    it.each(STANDALONE)(`${who} still runs: %s`, (line) => expect(allowed(who, line)).toBe(true));
  }
});
