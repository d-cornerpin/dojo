// A scheduled step whose earlier step was cancelled, or is gone, is handed in as "can't be done" with that
// reason, once, instead of being re-checked every 30 seconds for ever. Driven through the tool executor and
// the scheduler tick in a scratch home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => 'ran', whenQueuedRunEnds: async () => 'ran' }),
}));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dead-dependency-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');
const { checkScheduledTasks } = await import('../runner.js');

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
async function open(args: Record<string, unknown>): Promise<string> {
  const res = toolResultOf(await executeTool(MAIN, { id: `call-${++n}`, name: 'work_open', arguments: { kind: 'task', allow_duplicate: true, ...args } }));
  expect(res.isError, res.content).toBeFalsy();
  return /task_id=([\w-]+)/.exec(res.content)![1]!;
}
const handIns = (id: string) => connection.getDb().prepare(
  "SELECT json_extract(payload, '$.outcome') AS outcome, json_extract(payload, '$.note') AS note FROM work_events WHERE work_id = ? AND kind = 'handed_in'",
).all(id) as Array<{ outcome: string; note: string | null }>;
const stateOf = (id: string) => (connection.getDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

describe('a step after a cancelled step is handed in as cannot be done, once', () => {
  it('a cancelled earlier step', async () => {
    const step2 = await open({ title: 'Book the venue', goal: 'the venue is booked' });
    const step3 = await open({
      title: 'Send the invitations', goal: 'the invitations are sent', depends_on: [step2],
      scheduled_start: new Date(Date.now() - 60_000).toISOString(),
    });
    connection.getDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = ?").run(Date.now(), step2);

    await checkScheduledTasks();
    await checkScheduledTasks();

    expect(stateOf(step3)).toBe('handed_in');
    expect(handIns(step3)).toHaveLength(1);
    expect(handIns(step3)[0]!.outcome).toBe('cant_be_done');
  });

  it('an earlier step that no longer exists', async () => {
    const step3 = await open({
      title: 'Print the programmes', goal: 'the programmes are printed', depends_on: ['no-such-step'],
      scheduled_start: new Date(Date.now() - 60_000).toISOString(),
    });

    await checkScheduledTasks();
    await checkScheduledTasks();

    expect(handIns(step3)).toHaveLength(1);
    expect(handIns(step3)[0]!.outcome).toBe('cant_be_done');
  });
});
