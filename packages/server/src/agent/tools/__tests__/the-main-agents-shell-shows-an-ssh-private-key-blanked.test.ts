// The main agent's shell is not refused for reading an SSH private key: the command runs, by cat or by a
// python one-liner, and the key block comes back blanked. Made-up key in a scratch folder mapped as the home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'ssh-blank-'));
vi.stubEnv('DOJO_HOME', home);
const key = path.join(home, '.ssh', 'id_ed25519');
fs.mkdirSync(path.dirname(key), { recursive: true });
fs.writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAfakekeybodyzq7\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 });

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf, toolWasBlocked } = await import('../index.js');

beforeAll(() => {
  migrations.runMigrations();
  connection.getDb().prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, 'main', 'idle', '{}', 'sensei', NULL)").run(MAIN);
  connection.getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the main agent's shell shows an SSH private key blanked", () => {
  it.each([
    `cat "${key}"`,
    `python3 -c "print(open('${key}').read())"`,
  ])('%s runs and returns no key material', async (script) => {
    const outcome = await executeTool(MAIN, { id: 'call-key', name: 'shell', arguments: { script } });
    expect(toolWasBlocked(outcome)).toBe(false);
    expect(toolResultOf(outcome).content).not.toContain('fakekeybodyzq7');
  });
});
