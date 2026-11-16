// Editing a reminder with a time the engine cannot read is refused, and the reminder keeps its old time,
// instead of answering OK and never firing again. Driven through the tool executor in a scratch home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'edit-reminder-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});
afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

let n = 0;
const call = async (name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(MAIN, { id: `call-${++n}`, name, arguments: args }));
const scheduleOf = (id: string) => connection.getDb().prepare(
  'SELECT scheduled_start, next_run_at, schedule_status FROM work WHERE id = ?',
).get(id) as { scheduled_start: number | null; next_run_at: number | null; schedule_status: string };

describe('editing a reminder with an unreadable time is refused', () => {
  it('refuses "tomorrow 10am" and leaves the reminder armed at its old time', async () => {
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const made = await call('work_open', { kind: 'reminder', what: 'take the bins out', when });
    expect(made.isError, made.content).toBeFalsy();
    const id = /task_id=([\w-]+)/.exec(made.content)![1]!;
    const before = scheduleOf(id);

    const res = await call('work_update', { action: 'edit', task_id: id, scheduled_start: 'tomorrow 10am' });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not a parseable datetime/);
    expect(scheduleOf(id)).toEqual(before);
    expect(before.next_run_at).toBe(Date.parse(when));
  });
});
