// A scheduled run counts as delivered only by a message the engine recorded in a turn of one of this task's
// runs: a message sent for another task's run, or outside any run, does not settle it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { freshDoneDb, doneDb, seedTask } from './helpers/done-db.js';
import { proofDelivery } from '../proof.js';
import { turnRow } from '../../../agent/v2/__tests__/helpers/live-turn.js';

const WORKER = randomUUID();
const TASK = 'task-digest';
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** A run of `taskId`, opened a minute ago, as the scheduler's claim writes it. */
function runOf(taskId: string): string {
  const id = randomUUID();
  const at = Date.now() - 60_000;
  doneDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, root_kind, root_id,
      state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
    VALUES (?, 'occurrence', ?, ?, ?, 'schedule', ?, 'schedule', ?, 'open', 'occurrence', 0, 0, 'occurrence #1', 1, ?, ?)`)
    .run(id, taskId, WORKER, WORKER, taskId, taskId, at, at);
  return id;
}

/** The worker's message to the owner, sent in a turn whose root is `root` (null: no root). */
let turns = 0;
function sent(root: { kind: string; id: string } | null): string {
  const turn = turnRow(WORKER, ++turns, root);
  const id = randomUUID();
  const msg = randomUUID();
  doneDb().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at)
    VALUES (?, ?, 'owner', 'assistant', 'Your digest: three new orders and one refund today.', 1, ?, ?)`).run(msg, WORKER, Date.now(), Date.now());
  doneDb().prepare(`INSERT INTO deliveries (id, agent_id, tool, channel, message_id, outcome, created_at, updated_at, turn_number, root_kind, root_id)
    VALUES (?, ?, 'auto-route', 'dashboard', ?, 'delivered', ?, ?, ?, ?, ?)`)
    .run(id, WORKER, msg, sqlTime(Date.now()), sqlTime(Date.now()), turn, root?.kind ?? null, root?.id ?? null);
  return id;
}

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  doneDb().prepare("INSERT INTO agents (id, name) VALUES (?, 'Worker')").run(WORKER);
  seedTask(TASK, WORKER);
  seedTask('task-other', WORKER);
  doneDb().prepare("UPDATE work SET opened_at = ? WHERE kind = 'task'").run(Date.now() - 120_000);
});

describe('a run is settled only on its own delivery', () => {
  it("a message sent in another task's run does not settle this one", () => {
    runOf(TASK);
    sent({ kind: 'occurrence', id: runOf('task-other') });
    expect(proofDelivery(TASK, true)).toBeNull();
  });

  it('a message sent outside any run does not settle it', () => {
    runOf(TASK);
    sent(null);
    expect(proofDelivery(TASK, true)).toBeNull();
  });

  it('a message sent in its own run settles it', () => {
    const d = sent({ kind: 'occurrence', id: runOf(TASK) });
    expect(proofDelivery(TASK, true)).toBe(d);
  });
});
