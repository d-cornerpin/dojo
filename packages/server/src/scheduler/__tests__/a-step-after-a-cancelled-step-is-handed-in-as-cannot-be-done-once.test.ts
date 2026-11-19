// A step whose earlier step was cancelled, or is gone, is handed in as "can't be done" with that reason, once,
// within one reaper sweep, whenever its own start time is. Driven through the tool executor and the reaper kind.

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
const { REAPER_KINDS } = await import('../../work/work-reaper.js');
const sweep = () => REAPER_KINDS.find((k) => k.id === 'steps-after-a-dead-step')!.run();

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
  "SELECT json_extract(payload, '$.outcome') AS outcome FROM work_events WHERE work_id = ? AND kind = 'handed_in'",
).all(id) as Array<{ outcome: string }>;
const cancel = (id: string) => connection.getDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = ?").run(Date.now(), id);
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe('a step after a cancelled step is handed in as cannot be done, once', () => {
  it('a cancelled earlier step, the step due an hour from now: handed in on this sweep, once', async () => {
    const earlier = await open({ title: 'Book the venue', goal: 'the venue is booked' });
    const step = await open({ title: 'Send the invitations', goal: 'the invitations are sent', depends_on: [earlier], scheduled_start: inAnHour() });
    cancel(earlier);
    await sweep();
    await sweep();
    expect(handIns(step)).toEqual([{ outcome: 'cant_be_done' }]);
  });

  it('an earlier step that no longer exists: handed in once', async () => {
    const step = await open({ title: 'Print the programmes', goal: 'the programmes are printed', depends_on: ['no-such-step'], scheduled_start: inAnHour() });
    await sweep();
    await sweep();
    expect(handIns(step)).toEqual([{ outcome: 'cant_be_done' }]);
  });

  it('an earlier step that is still open: nothing is handed in', async () => {
    const earlier = await open({ title: 'Order the flowers', goal: 'the flowers are ordered' });
    const step = await open({ title: 'Collect the flowers', goal: 'the flowers are collected', depends_on: [earlier], scheduled_start: inAnHour() });
    await sweep();
    expect(handIns(step)).toEqual([]);
  });
});
