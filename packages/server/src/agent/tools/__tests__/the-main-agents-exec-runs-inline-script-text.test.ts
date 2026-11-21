// The main agent's exec runs inline shell script text (`sh -c`); another agent's same call is sent to the shell door.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inline-exec-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, ?, 'idle', '{}', ?)");
  add.run(MAIN, 'main', 'sensei');
  add.run(HELPER, 'helper', 'apprentice');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

const inline = async (agentId: string) => toolResultOf(await executeTool(agentId, {
  id: `tc-${agentId}`, name: 'exec', arguments: { argv: ['sh', '-c', 'printf abc | wc -c'] },
}));

describe("the main agent's exec runs inline script text", () => {
  it('the main agent runs sh -c and gets its output', async () => {
    const r = await inline(MAIN);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(String(r.content)).toMatch(/\b3\b/);
  });

  it("another agent's sh -c is refused and pointed at the shell door", async () => {
    const r = await inline(HELPER);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('Use shell({script:');
  });
});
