// A secrets file that cannot be parsed never turns a successful command into a failed one.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'broken-secrets-'));
vi.stubEnv('DOJO_HOME', home);
fs.mkdirSync(path.join(home, '.dojo'), { recursive: true });
fs.writeFileSync(path.join(home, '.dojo', 'secrets.yaml'), 'jwt_secret: [unclosed\n  : : bad', { mode: 0o600 });

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../index.js');

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

describe('a broken secrets file', () => {
  it('still lets a command return its output', async () => {
    const outcome = await executeTool(MAIN, { id: 'call-echo', name: 'shell', arguments: { script: 'echo still-here' } });
    expect(toolResultOf(outcome).content).toContain('still-here');
  });
});
