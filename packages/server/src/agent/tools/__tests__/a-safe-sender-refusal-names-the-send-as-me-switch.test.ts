// Adding a mail safe sender on an account that may not send is refused, and the refusal names the one
// send switch by its words on the dashboard: "The agent may send as me".

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'safe-sender-switch-'));
vi.stubEnv('DOJO_HOME', home);

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

describe('a safe sender on an account that may not send', () => {
  it('is refused, naming the switch "The agent may send as me"', async () => {
    const r = toolResultOf(await executeTool(MAIN, { id: 'call-safe', name: 'add_safe_sender', arguments: {
      channel: 'gmail', slot: 'user', address: 'friend@example.com', name: 'A Friend',
      user_request_quote: 'add my friend to the list',
    } }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('"The agent may send as me"');
    expect(r.content).not.toContain('Allow sending email');
  });
});
