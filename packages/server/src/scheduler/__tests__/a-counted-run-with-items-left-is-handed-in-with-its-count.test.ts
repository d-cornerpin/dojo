// A job that empties a folder a batch at a time, every five minutes, counted by its measure. A run that moves half
// the files and tells the owner so is handed in as can't be done with the count left as its reason, never as "no
// proof on record".
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, call, turn, line, openRun, checkScheduledTasks, closeRunsThatDelivered } = box;

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

describe('a counted run with items left is handed in with its count', () => {
  it('half the inbox moved: can\'t be done, naming the 10 files left', async () => {
    const inbox = path.join(process.env.DOJO_HOME!, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(inbox, `f${i}.txt`), 'x');
    at('2026-03-02T07:40:00Z');
    const made = await call('work_open', { kind: 'task', title: 'Inbox sweep', goal: 'move five files every five minutes until the inbox is empty, and say what is left',
      scheduled_start: '2026-03-02T07:45:00Z', repeat_interval: 5, repeat_unit: 'minutes', measure: { tool: 'file_list', args: { path: inbox }, unit: 'files' } });
    expect(made.isError, made.content).toBeFalsy();
    const task = /task_id=([\w-]+)/.exec(made.content)![1]!;
    db().prepare("UPDATE work SET task_kind = 'notify' WHERE id = ?").run(task);
    at('2026-03-02T07:45:25Z');
    await checkScheduledTasks();
    await turn({ kind: 'occurrence', id: openRun(task) }, () => {
      for (let i = 0; i < 10; i++) fs.rmSync(path.join(inbox, `f${i}.txt`));
      line('Inbox down to 10 of 20.', 'dashboard');
    });
    await closeRunsThatDelivered();
    await vi.dynamicImportSettled();
    const h = db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'handed_in' ORDER BY id DESC LIMIT 1").get(task) as { payload: string };
    const record = JSON.parse(h.payload) as { outcome: string; scope: string; items: Array<{ kind: string; facts: { reason?: string } }> };
    const reason = record.items.find((i) => i.kind === 'remainder')?.facts.reason ?? '';
    expect([record.outcome, record.scope]).toEqual(['cant_be_done', 'run']);
    expect(reason).toContain('10 files left');
    expect(reason).not.toContain('no proof on record');
  });
});
