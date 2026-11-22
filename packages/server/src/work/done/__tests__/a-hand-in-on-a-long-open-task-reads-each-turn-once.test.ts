// A task open for days, its worker busy with other things all that time: 120 turns, three lines to the owner in
// each. Handing it in through the real tool reads each of those turns once, about this task alone, never each line.
// What one turn served costs the same for a worker with months of finished work as for one with none.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { freshBoard, call, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { servedBy } from '../../task-turns.js';

const TURNS = 120;
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Turn `n` of the worker at `at`, rooted on `root`, with `lines` lines to the owner; returns the last line's id. */
function turnWithLines(n: number, at: number, lines: number, root: { kind: string; id: string } | null): string {
  doneDb().prepare(`INSERT INTO turns (agent_id, turn_number, root_kind, root_id, started_at, ended_at, exit_reason, answered)
    VALUES (?, ?, ?, ?, ?, ?, 'answered', 1)`).run(WORKER, n, root?.kind ?? null, root?.id ?? null, sqlTime(at), sqlTime(at + 30_000));
  let id = '';
  for (let i = 0; i < lines; i++) {
    id = `d-${n}-${i}`;
    doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, created_at) VALUES (?, ?, 'owner', 'assistant', ?, 1, ?)")
      .run(`m-${id}`, WORKER, `Line ${i} about something else entirely, turn ${n}.`, at);
    doneDb().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at, updated_at)
      VALUES (?, ?, ?, 'auto-route', 'dashboard', ?, 'delivered', ?, ?)`).run(id, WORKER, n, `m-${id}`, sqlTime(at + i * 1000), sqlTime(at + i * 1000));
  }
  return id;
}

describe('a hand-in on a long-open task reads each turn once', () => {
  it(`${TURNS} turns about other work since the task opened: the hand-in runs a bounded number of statements`, async () => {
    freshBoard();
    const start = Date.now() - 10 * 86_400_000;
    doneDb().prepare('UPDATE work SET opened_at = ? WHERE id = ?').run(start, TASK);
    for (let n = 1; n <= TURNS; n++) turnWithLines(n, start + n * 3_600_000, 3, null);
    doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, task_id, origin_intent, authorized, created_at) VALUES ('hint', ?, 'events', 'user', '[Engine hint: the report]', ?, 'engine_hint', 0, ?)")
      .run(WORKER, TASK, Date.now() - 120_000);
    const answer = turnWithLines(TURNS + 1, Date.now() - 60_000, 1, { kind: 'engine', id: 'hint' });

    const proto = Object.getPrototypeOf(doneDb().prepare('SELECT 1')) as Record<string, (...a: unknown[]) => unknown>;
    const spies = ['all', 'get', 'run', 'iterate'].map((m) => vi.spyOn(proto, m));
    const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: answer }], note: 'The report is with the owner' });
    const statements = spies.reduce((sum, s) => sum + s.mock.calls.length, 0);
    spies.forEach((s) => s.mockRestore());

    expect(r.isError, r.content).toBe(false);
    expect(statements, 'one read per turn and a fixed number besides, never one per line').toBeLessThan(TURNS + 150);
  });

  it('what a turn served reads the same rows whatever the worker finished before it', () => {
    freshBoard();
    // Every payload the reader looks into, counted: one per row of the worker's it probes.
    let reads = 0;
    doneDb().function('json_extract', { deterministic: true }, (json: unknown, path: unknown) => {
      reads++;
      const v = json === null ? null : (JSON.parse(String(json)) as Record<string, unknown>)[String(path).slice(2)];
      return v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v as string | number;
    });
    const old = Date.now() - 90 * 86_400_000;
    let done = 0;
    const finished = (count: number): void => {
      for (let end = done + count; done < end; done++) {
        doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, closed_at, updated_at)
          VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'abandoned', 'task', 0, 0, 'old', ?, ?, ?)`).run(`old-${done}`, WORKER, `old-${done}`, old, old + 1000, old + 1000);
        doneDb().prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'claim_turn', ?, 'engine', ?)")
          .run(`old-${done}`, JSON.stringify({ turn_number: 1, agent_id: WORKER, how: 'job' }), Date.now() - 1000);
      }
    };
    turnWithLines(1, Date.now() - 60_000, 1, null);
    const cost = (): number => { reads = 0; servedBy(WORKER, 1); return reads; };
    finished(10);
    const few = cost();
    finished(2000);
    expect(cost(), 'two thousand finished tasks more read nothing more').toBe(few);
  });
});
