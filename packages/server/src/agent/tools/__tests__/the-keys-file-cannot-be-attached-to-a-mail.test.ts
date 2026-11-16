// "Email me a backup of the settings" cannot carry the Dojo's keys file: every mail tool's attachment
// list meets the one file check, the main agent's included. Driven through executeTool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'keys-mail-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf, toolWasBlocked } = await import('../index.js');

const keys = path.join(home, '.dojo', 'secrets.yaml');

beforeAll(() => {
  migrations.runMigrations();
  connection.getDb().prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(MAIN);
  connection.getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  fs.mkdirSync(path.dirname(keys), { recursive: true });
  fs.writeFileSync(keys, 'anthropic_api_key: FAKE-KEY-VALUE');
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the keys file cannot be attached to a mail', () => {
  it.each(['gmail_send', 'outlook_send', 'gmail_draft', 'outlook_draft'])('%s with the keys file attached is refused', async (name) => {
    const outcome = await executeTool(MAIN, {
      id: `call-${name}`, name,
      arguments: { to: 'someone@example.com', subject: 'Settings backup', body: 'Attached.', attachments: [keys] },
    });
    expect(toolWasBlocked(outcome)).toBe(true);
    expect(toolResultOf(outcome).content).not.toContain('FAKE-KEY-VALUE');
  });
});
