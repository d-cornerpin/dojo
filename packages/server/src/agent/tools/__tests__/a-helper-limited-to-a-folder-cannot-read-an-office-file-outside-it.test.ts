// A helper limited to one folder cannot read (or edit) a Word or Excel file outside it, named by
// `path` or by a local `file_id`; inside the folder the call is not refused. Driven through executeTool.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'office-fence-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolWasBlocked } = await import('../index.js');

const inside = path.join(home, 'Projects', 'plan.docx');
const outside = path.join(home, 'Private', 'salaries.xlsx');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const limited = JSON.stringify({ file_read: ['~/Projects/**'], file_write: ['~/Projects/**'], exec_allow: [], exec_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', limited);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  for (const f of [inside, outside]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'not really office bytes'); }
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (name: string, args: Record<string, unknown>) => executeTool(HELPER, { id: `call-${name}`, name, arguments: args });

describe('a helper limited to a folder cannot read an office file outside it', () => {
  it.each([
    ['office_read_word_document', { path: outside }],
    ['office_get_spreadsheet_range', { path: outside, range: 'A1:B2' }],
    ['office_get_word_document_outline', { file_id: outside }],
    ['office_replace_in_word_document', { path: outside, find: 'a', replace: 'b' }],
  ] as const)('%s outside the folder is refused', async (name, args) => {
    expect(toolWasBlocked(await run(name, args))).toBe(true);
  });

  it('a read inside the folder is not refused', async () => {
    expect(toolWasBlocked(await run('office_read_word_document', { path: inside }))).toBe(false);
  });
});
