// RULE TWO: the one file check refuses the main agent only the hidden files. An ordinary file anywhere on
// the Mac is attached, read, copied and appended to through the same tools without a refusal.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'main-ordinary-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolWasBlocked } = await import('../index.js');
const { UPLOADS } = await import('./scratch-dojo.js');

const ordinary = path.join(home, 'Documents', 'Taxes', 'report.txt');
const projectEnv = path.join(home, 'code', 'site', '.env');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', null);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  for (const f of [ordinary, projectEnv]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'PORT=3000\n'); }
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const run = (name: string, args: Record<string, unknown>) => executeTool(MAIN, { id: `call-${name}`, name, arguments: args });

describe('the main agent is not refused an ordinary file by any tool', () => {
  it.each([
    ['gmail_send', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [ordinary] }],
    ['outlook_send', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [ordinary] }],
    ['office_read_word_document', { path: ordinary }],
    ['file_append', { path: projectEnv, content: 'DEBUG=1\n' }],
    ['file_append', { path: ordinary, content: 'more\n' }],
    ['file_write', { path: path.join(home, 'Library', 'notes', 'new.txt'), content: 'hello' }],
    ['file_read', { path: projectEnv }],
    ...UPLOADS(ordinary),
  ] as const)('%s is not refused', async (name, args) => {
    expect(toolWasBlocked(await run(name, args))).toBe(false);
  });

  it('send_to_agent copies an ordinary file to the recipient', async () => {
    const outcome = await run('send_to_agent', { agent: HELPER, payload: 'The report.', intent: 'FYI', attach_paths: [ordinary] });
    expect(toolWasBlocked(outcome)).toBe(false);
    expect(fs.readdirSync(path.join(home, '.dojo', 'uploads', HELPER)).some((f) => f.endsWith('report.txt'))).toBe(true);
  });
});
