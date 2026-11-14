// The main agent searches its whole home through the shell tool; a value from the secrets file and a
// private key block are blanked in what it gets back, and every other line comes back as printed.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const FAKE_KEY = 'zq7FakeProviderValue0042';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'blank-secret-'));
vi.stubEnv('DOJO_HOME', home);
fs.mkdirSync(path.join(home, '.dojo'), { recursive: true });
fs.writeFileSync(path.join(home, '.dojo', 'secrets.yaml'), `jwt_secret: fakejwtsecret000111\nproviders:\n  example:\n    api_key: ${FAKE_KEY}\n`, { mode: 0o600 });
fs.mkdirSync(path.join(home, 'notes'));
fs.writeFileSync(path.join(home, 'notes', 'todo.txt'),
  `zq7 invoice 42 is paid\ncopied ${FAKE_KEY} into the zq7 form\n-----BEGIN OPENSSH PRIVATE KEY-----\nzq7fakekeybody\n-----END OPENSSH PRIVATE KEY-----\n`);

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

describe('a secret in command output is blanked, the rest stays', () => {
  it('a recursive search of the home folder', async () => {
    const outcome = await executeTool(MAIN, { id: 'call-grep', name: 'shell', arguments: { script: `grep -r -B1 -A1 zq7 "${home}"` } });
    const text = toolResultOf(outcome).content;
    expect(text).toContain('zq7 invoice 42 is paid');
    expect(text).toContain('copied <redacted-credential> into the zq7 form');
    expect(text).toContain('secrets.yaml');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('zq7fakekeybody');
  });
});
