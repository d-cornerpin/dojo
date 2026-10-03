// ════════════════════════════════════════════════════════════════════════════════════
// t90 D1 — THE DOORS THAT MAKE THE PM'S ASK ANSWERABLE.
//
// The ladder's terminal rung stopped moving work and started asking the owner (see
// `tracker/__tests__/the-pm-waits-for-the-model-it-assigned.test.ts`). An ask nobody can answer
// is worse than the autonomous behaviour it replaced — the task would simply sit — so these are
// the two doors, and these clauses are the WIRE half for the whole deliverable:
//
//   POST /tasks/:id/assignee-decision    wait | reassign | cancel
//   POST /tasks/:id/extended-patience    granted: true | false
//
// ── THE ONE RULE THE REASSIGN BRANCH ENCODES ──
// There is NO default destination. `reassign` without `assigned_to` is a 400, because the
// report's own sentence is "The primary is not a fallback bin" — and a convenience fallback in
// the door would rebuild the defect inside the fix. §2 is that clause.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { trackerRouter } from '../tracker.js';
import { extendedPatience, PATIENCE_ENTRY } from '../../../tracker/assignee-patience.js';
import { createWorkTable, seedTrackerTask } from '../../../work/__tests__/work-fixture.js';

const SLOW = 'slow-sub-agent';
const OTHER = 'another-agent';

function post(path: string, body: unknown): Promise<Response> {
  return trackerRouter.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function auditPayloads(taskId: string, entryKind: string): string[] {
  return (mockDb.current!.prepare(
    `SELECT payload FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?
      ORDER BY id`,
  ).all(taskId, entryKind) as Array<{ payload: string }>).map((r) => r.payload);
}
/**
 * EVERY COLUMN THAT CARRIES AN ASSIGNMENT, not just the one the PM reads.
 *
 * A mutant that made `wait` call `updateTask({ assignedTo: null })` survived a clause that read
 * `agent_id` alone — because the spine splits the fact in two (`tracker/schema.ts`: "`agent_id`
 * is the OWNER of the row; `assignee_agent` is the nullable column that carries whether anyone
 * is assigned at all"), and a null write lands on the second one only. "Wait changes nothing"
 * has to mean nothing on either axis, so this is the snapshot and §1 compares the whole thing.
 */
function row(taskId: string): Record<string, unknown> {
  return mockDb.current!.prepare(
    'SELECT state, agent_id, assignee_agent, assigned_to_group FROM work WHERE id = ?',
  ).get(taskId) as Record<string, unknown>;
}
function verdictEvents(taskId: string, kind: string): number {
  return (mockDb.current!.prepare(
    'SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = ?',
  ).get(taskId, kind) as { c: number }).c;
}

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT, updated_at TEXT)`);
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(SLOW, SLOW);
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(OTHER, OTHER);
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('gone', 'gone', 'terminated')").run();
  mockDb.current = db;
  seedTrackerTask(db, { id: 'task-ask', agentId: SLOW, status: 'in_progress', title: 'the long project' });
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — WAIT: the option whose whole job is to change nothing
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 wait', () => {
  it('leaves the task exactly where it is, and still leaves a record', async () => {
    const before = row('task-ask');

    const res = await post('/tasks/task-ask/assignee-decision', { decision: 'wait', reason: 'it is slow on purpose' });

    expect(res.status).toBe(200);
    expect(row('task-ask'), 'wait must change NOTHING about the assignment, on any column')
      .toEqual(before);
    expect(row('task-ask').agent_id, 'and the assignee the PM reads is untouched').toBe(SLOW);

    // ⚠ The record is the point. Without it, "the owner was asked and chose to wait" is
    // indistinguishable from "nobody ever answered" the next time the ladder climbs.
    const answered = auditPayloads('task-ask', PATIENCE_ENTRY.decisionAnswered);
    expect(answered.length).toBe(1);
    expect(answered[0]).toContain('wait');
    expect(answered[0], 'the answer names who held it when the question was asked').toContain(SLOW);
    expect(verdictEvents('task-ask', 'user_verdict_cleared'),
      'and the ladder is released, or the task is frozen by its own protection').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — REASSIGN: only where the owner names
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 reassign', () => {
  it('⚠ refuses with no destination — there is no fallback bin', async () => {
    const res = await post('/tasks/task-ask/assignee-decision', { decision: 'reassign' });

    expect(res.status, 'a reassign with nowhere to go must not pick somewhere').toBe(400);
    expect((await res.json() as { error: string }).error).toContain('no default destination');
    expect(row('task-ask').agent_id, 'and nothing moved').toBe(SLOW);
    expect(row('task-ask').assignee_agent, 'on either column').toBe(SLOW);
    expect(auditPayloads('task-ask', PATIENCE_ENTRY.reassigned).length).toBe(0);
  });

  it('refuses a terminated or unknown destination', async () => {
    expect((await post('/tasks/task-ask/assignee-decision', { decision: 'reassign', assigned_to: 'gone' })).status).toBe(400);
    expect((await post('/tasks/task-ask/assignee-decision', { decision: 'reassign', assigned_to: 'nobody' })).status).toBe(400);
    expect(row('task-ask').agent_id).toBe(SLOW);
  });

  it('moves the task where the owner said, and records the prior assignee', async () => {
    const res = await post('/tasks/task-ask/assignee-decision', {
      decision: 'reassign', assigned_to: OTHER, reason: 'it really is stuck',
    });

    expect(res.status).toBe(200);
    expect(row('task-ask').agent_id).toBe(OTHER);
    const moved = auditPayloads('task-ask', PATIENCE_ENTRY.reassigned);
    expect(moved.length).toBe(1);
    expect(moved[0], 'where it came from').toContain(SLOW);
    expect(moved[0], 'where it went').toContain(OTHER);
    expect(moved[0], 'and the prior assignee\'s last known state').toContain('prior assignee last state');
    expect(verdictEvents('task-ask', 'poke_remediation'),
      'a reassignment re-arms the ladder against the NEW owner').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — CANCEL
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 cancel', () => {
  it('closes the task through the work gate, with the owner as the authority', async () => {
    const res = await post('/tasks/task-ask/assignee-decision', { decision: 'cancel', reason: 'no longer needed' });

    expect(res.status).toBe(200);
    expect(row('task-ask').state, 'cancelled is "abandoned" on the spine').toBe('abandoned');
    expect(auditPayloads('task-ask', PATIENCE_ENTRY.decisionAnswered)[0]).toContain('cancel');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 — THE DOOR REFUSES WHAT IT CANNOT HONOUR
// ════════════════════════════════════════════════════════════════════════════════

describe('§4 the door is narrow', () => {
  it('refuses any decision that is not one of the three', async () => {
    for (const decision of ['stop', 'retry', '', 'WAIT ', undefined]) {
      const res = await post('/tasks/task-ask/assignee-decision', { decision });
      expect(res.status, `"${String(decision)}" must not be honoured`).toBe(400);
    }
    expect(row('task-ask').agent_id, 'and no refused call touched the task').toBe(SLOW);
  });

  it('404s an id that resolves to nothing', async () => {
    expect((await post('/tasks/no-such-task/assignee-decision', { decision: 'wait' })).status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §5 — THE EXTENDED-PATIENCE DOOR, AND THE PM READING IT
// ════════════════════════════════════════════════════════════════════════════════

describe('§5 extended patience', () => {
  it('grants, revokes, and reports the flag the PM will read', async () => {
    const granted = await post('/tasks/task-ask/extended-patience', {
      granted: true, reason: 'assigned to the slow local model on purpose',
    });
    expect(granted.status).toBe(200);
    expect((await granted.json() as { data: { extendedPatience: boolean } }).data.extendedPatience).toBe(true);

    // ⚠ THE WIRE: the predicate the poke ladder consults, not a flag the route invented.
    expect(extendedPatience('task-ask'), 'the door and the ladder must read the same fact').toBe(true);

    const revoked = await post('/tasks/task-ask/extended-patience', { granted: false });
    expect(revoked.status).toBe(200);
    expect(extendedPatience('task-ask')).toBe(false);

    // Both decisions survive — the flag is history, not a column.
    expect(auditPayloads('task-ask', PATIENCE_ENTRY.extended).length).toBe(1);
    expect(auditPayloads('task-ask', PATIENCE_ENTRY.revoked).length).toBe(1);
  });

  it('refuses a body that does not say which way', async () => {
    expect((await post('/tasks/task-ask/extended-patience', {})).status).toBe(400);
    expect((await post('/tasks/task-ask/extended-patience', { granted: 'yes' })).status).toBe(400);
    expect(extendedPatience('task-ask')).toBe(false);
  });
});
