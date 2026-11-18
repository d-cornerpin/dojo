// The log line written for every tool call blanks the arguments the tool declares secret, so a key the
// owner hands the agent never lands in the Dojo log. Driven through executeTool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const FAKE_TOKEN = 'zq9FakeTokenValue00000000000042';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'secret-log-'));
vi.stubEnv('DOJO_HOME', home);

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { readLogFiles } = await import('../../../logger.js');
const { executeTool } = await import('../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, 'main', 'idle', '{}', 'sensei', NULL)").run(MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a saved secret never reaches the tool log line', () => {
  it('credential_add logs its call with the value blanked', async () => {
    await executeTool(MAIN, {
      id: 'call-cred', name: 'credential_add',
      arguments: { service_name: 'example_service', description: 'a made-up key for a test', credentials: { api_key: FAKE_TOKEN } },
    });
    const log = readLogFiles().join('');
    expect(log).toContain('Executing tool');
    expect(log).toContain('credential_add');
    expect(log).not.toContain(FAKE_TOKEN);
  });
});
