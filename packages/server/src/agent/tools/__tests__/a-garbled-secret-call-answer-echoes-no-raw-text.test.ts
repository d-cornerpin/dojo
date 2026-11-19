// The answer to a garbled call repeats the model's own text, except for a tool that declares a secret.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const RAW = '{"service_name":"example_service","credentials":{"api_key":"zq9FakeRawText0000000000045';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'garbled-call-'));
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

const garbled = async (name: string) => toolResultOf(await executeTool(MAIN, { id: `call-${name}`, name, arguments: { __malformed_args: RAW } }));

describe('the answer to a garbled call', () => {
  it('echoes no raw text for a tool that declares a secret, and still says the call was malformed', async () => {
    const r = await garbled('credential_add');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('malformed JSON');
    expect(r.content).not.toContain('zq9FakeRawText');
  });
  it('repeats the model\'s own text for any other tool, so it can repair the call', async () => {
    const r = await garbled('file_read');
    expect(r.content).toContain('malformed JSON');
    expect(r.content).toContain('zq9FakeRawText');
  });
});
