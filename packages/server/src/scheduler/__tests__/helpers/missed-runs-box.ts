// A scratch Dojo for the missed-run tests: a main agent, repeating tasks opened through the real tool, a fake
// wall clock, and readers for the runs fired, the triggers the agent got and the owner's cards.
// The importing file mocks `gateway/ws.js` and `agent/runtime.js` before importing this.
import { expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'UTC';
export const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'missed-runs-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../../agent/tools/index.js');
export const { checkScheduledTasks } = await import('../../runner.js');

export const db = () => connection.getDb();

export function openBox(): void {
  migrations.runMigrations();
  db().prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(MAIN);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
}

export function closeBox(): void {
  vi.useRealTimers();
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
}

export const at = (iso: string): void => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(iso)); };

let n = 0;
export const call = async (name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(MAIN, { id: `call-${++n}`, name, arguments: args }));

/** A task repeating every day from `firstIso` that has already run once before (so a late slot is a miss). */
export async function daily(title: string, firstIso: string): Promise<string> {
  const made = await call('work_open', {
    kind: 'task', title, goal: 'it is sent every day', scheduled_start: firstIso,
    repeat_interval: 1, repeat_unit: 'days', allow_duplicate: true,
  });
  expect(made.isError, made.content).toBeFalsy();
  const id = /task_id=([\w-]+)/.exec(made.content)![1]!;
  db().prepare('UPDATE work SET attempts = 1 WHERE id = ?').run(id);
  return id;
}

export const runsOf = (id: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work WHERE kind = 'occurrence' AND parent_id = ?",
).get(id) as { n: number }).n;
export const nextRunOf = (id: string): number | null =>
  (db().prepare('SELECT next_run_at FROM work WHERE id = ?').get(id) as { next_run_at: number | null }).next_run_at;
export const triggers = (): string[] => (db().prepare(
  "SELECT content FROM messages WHERE content LIKE '[SOURCE: SCHEDULER%' ORDER BY seq",
).all() as Array<{ content: string }>).map((r) => r.content);
export const cardsOf = (id: string): string[] => (db().prepare(
  "SELECT value FROM healer_state WHERE scope = 'owner_told' AND key = ?",
).all(`missedruns:${id}`) as Array<{ value: string }>).map((r) => r.value);
