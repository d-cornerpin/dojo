// PHASE-2 T8T (RESUMED-2, orchestrator RULING 4) — the override queue on the spine.
//
// `task_override_requests` was the last side table with live production readers. RULING 3
// deferred the TABLE's death to T10; RULING 4 says the MECHANISM moves now, because two live
// override mechanisms coexisting for two more tasks is the two-mechanism disease by name.
//
// The requirement, in one line: an agent that the engine's hard gate refused can ASK an
// authority to force the move; that ask is queued, exactly one per (task, agent) at a time,
// visible to the PM and the dashboard, refusable, approvable, and auto-denied after 12 hours
// with the agent told. Every clause below is one of those, tested against the spine's own
// shapes rather than against a table.
//
// WHAT MAPS WHERE:
//   the ASK          -> `work_events` kind 'override_request'   (RULING 4's request/audit half)
//   the RESOLUTION   -> `work_events` kind 'override_resolved'
//   the VERDICT      -> `adjudications`, and it is already written there by `transition()`
//                       on the approve path, because approving MOVES the row with
//                       `claim: 'authoritative'`. See §"the verdict half" below.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-override-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  fileOverrideRequest,
  pendingOverrideForAgent,
  pendingOverrideForTask,
  findOverrideRequest,
  resolveOverrideRequest,
  listOverrideRequests,
  overrideRollup,
  staleOverrideRequests,
  PENDING_OVERRIDE_COUNT_SQL,
} from '../override-requests.js';

const AGENT = 'kevin';
const OTHER = 'dana';
const T = 1_700_000_000_000;

function seedTask(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: '', state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', goal: 'the goal', priority: 'normal',
    notes: null, remaining_children: null, compile_pending: 0, ttl_at: null,
    reply_conversation_id: null, attempts: 0, next_attempt_at: null, schedule_json: null,
    tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

const file = (taskId = 'w1', by = AGENT, over: Record<string, unknown> = {}) =>
  fileOverrideRequest(taskId, {
    requestedBy: by,
    requestedStatus: 'complete',
    justification: 'the artifact exists and the audit log rotated before the gate could see it',
    ...over,
  });

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  seedTask('w1');
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 — FILABLE, and exactly one per (task, agent)
// ════════════════════════════════════════════════════════════════════════════════

describe('the ask is filable, and it lands on the spine', () => {
  it('files ONE override_request event carrying every fact the old row carried', () => {
    const id = file('w1', AGENT, { lastEngineError: 'evidence unresolved', attemptsAttached: 3 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = mockDb.current!.prepare(
      "SELECT kind, actor, payload FROM work_events WHERE work_id = 'w1' ORDER BY id",
    ).all() as Array<{ kind: string; actor: string; payload: string }>;
    expect(rows.map((r) => r.kind)).toEqual(['override_request']);
    expect(rows[0].actor).toBe(AGENT);
    const p = JSON.parse(rows[0].payload) as Record<string, unknown>;
    expect(p).toMatchObject({
      request_id: id,
      requested_status: 'complete',
      last_engine_error: 'evidence unresolved',
      attempts_attached: 3,
    });
    expect(String(p.justification)).toContain('audit log rotated');
  });

  it('writes NOTHING to task_override_requests — the table is dead to production', () => {
    file();
    const n = (mockDb.current!.prepare(
      'SELECT count(*) AS c FROM task_override_requests',
    ).get() as { c: number }).c;
    expect(n).toBe(0);
  });

  it('the rate limit is per (task, agent): the same agent is blocked, a DIFFERENT agent is not', () => {
    file('w1', AGENT);
    expect(pendingOverrideForAgent('w1', AGENT)).not.toBeNull();
    // POSITIVE CONTROL of the same shape — the clause above proves nothing if the lookup
    // matches everything.
    expect(pendingOverrideForAgent('w1', OTHER)).toBeNull();
    seedTask('w2');
    expect(pendingOverrideForAgent('w2', AGENT)).toBeNull();
  });

  it('a RESOLVED request no longer blocks the same agent from asking again', () => {
    const first = file('w1', AGENT);
    resolveOverrideRequest(first, { outcome: 'denied', resolvedBy: 'pm-1', reason: 'the gate was right' });
    expect(pendingOverrideForAgent('w1', AGENT)).toBeNull();
    const second = file('w1', AGENT);
    expect(second).not.toBe(first);
    expect(pendingOverrideForAgent('w1', AGENT)?.id).toBe(second);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — SERVABLE: found by prefix, listed, counted, rolled up
// ════════════════════════════════════════════════════════════════════════════════

describe('the ask is servable', () => {
  it('is found by its FULL id and by the 8-char prefix the PM is shown', () => {
    const id = file();
    expect(findOverrideRequest(id)?.id).toBe(id);
    expect(findOverrideRequest(id.slice(0, 8))?.id).toBe(id);
    expect(findOverrideRequest('nope-nope')).toBeNull();
  });

  it('carries the task title and goal, which is what the PM rung renders', () => {
    const id = file();
    const req = findOverrideRequest(id)!;
    expect(req.taskTitle).toBe('a thing');
    expect(req.taskGoal).toBe('the goal');
    expect(req.taskId).toBe('w1');
  });

  it('lists pending-first-by-age and filters by status', () => {
    const a = file('w1', AGENT);
    seedTask('w2');
    const b = file('w2', OTHER);
    resolveOverrideRequest(b, { outcome: 'approved', resolvedBy: 'user', reason: 'fine' });
    expect(listOverrideRequests({ status: 'pending' }).map((r) => r.id)).toEqual([a]);
    expect(listOverrideRequests({ status: 'approved' }).map((r) => r.id)).toEqual([b]);
    expect(listOverrideRequests({}).map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it('the pending COUNT fragment answers the same question as the lookup', () => {
    const count = () => (mockDb.current!.prepare(
      `SELECT ${PENDING_OVERRIDE_COUNT_SQL} AS c`,
    ).get() as { c: number }).c;
    expect(count()).toBe(0);
    const id = file();
    expect(count()).toBe(1);
    resolveOverrideRequest(id, { outcome: 'denied', resolvedBy: 'pm-1', reason: 'no' });
    expect(count()).toBe(0);
  });

  it('the 7-day rollup groups by outcome, the shape the dashboard renders', () => {
    const a = file('w1', AGENT);
    seedTask('w2');
    const b = file('w2', OTHER);
    resolveOverrideRequest(a, { outcome: 'approved', resolvedBy: 'user', reason: 'yes' });
    resolveOverrideRequest(b, { outcome: 'auto_denied', resolvedBy: 'engine', reason: 'timed out' });
    const roll = Object.fromEntries(overrideRollup(7).map((r) => [r.status, r.count]));
    expect(roll).toEqual({ approved: 1, auto_denied: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 — REFUSABLE, and resolvable exactly once
// ════════════════════════════════════════════════════════════════════════════════

describe('the ask is refusable', () => {
  it('a resolution records who, why and the outcome, and flips the status', () => {
    const id = file();
    expect(findOverrideRequest(id)!.status).toBe('pending');
    resolveOverrideRequest(id, { outcome: 'denied', resolvedBy: 'pm-1', reason: 'the engine was right' });
    const after = findOverrideRequest(id)!;
    expect(after.status).toBe('denied');
    expect(after.resolvedBy).toBe('pm-1');
    expect(after.resolvedReason).toBe('the engine was right');
    expect(after.resolvedAt).not.toBeNull();
  });

  it.each(['approved', 'denied', 'auto_denied'] as const)(
    'outcome %s round-trips', (outcome) => {
      const id = file();
      resolveOverrideRequest(id, { outcome, resolvedBy: 'x', reason: 'r' });
      expect(findOverrideRequest(id)!.status).toBe(outcome);
    },
  );

  it('a second resolution is REFUSED — "cannot resolve again" is the old contract', () => {
    const id = file();
    expect(resolveOverrideRequest(id, { outcome: 'approved', resolvedBy: 'pm-1', reason: 'y' })).toBe(true);
    expect(resolveOverrideRequest(id, { outcome: 'denied', resolvedBy: 'pm-1', reason: 'n' })).toBe(false);
    expect(findOverrideRequest(id)!.status).toBe('approved');
  });

  it('resolving an id nobody filed is refused rather than silently written', () => {
    expect(resolveOverrideRequest('not-a-request', { outcome: 'denied', resolvedBy: 'pm-1', reason: 'x' })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 — THE 12-HOUR AUTO-DENIAL (5a, carried verbatim: the threshold is not invented here)
// ════════════════════════════════════════════════════════════════════════════════

describe('the 12-hour sweep sees exactly what the old query saw', () => {
  const ageRequest = (id: string, hoursAgo: number) => {
    mockDb.current!.prepare(
      `UPDATE work_events SET created_at = ?
        WHERE kind = 'override_request' AND json_extract(payload, '$.request_id') = ?`,
    ).run(Date.now() - hoursAgo * 3600_000, id);
  };

  it('finds a request older than the bound and NOT one inside it', () => {
    const old = file('w1', AGENT);
    seedTask('w2');
    const fresh = file('w2', OTHER);
    ageRequest(old, 13);
    ageRequest(fresh, 11);
    expect(staleOverrideRequests(12, 50).map((r) => r.id)).toEqual([old]);
  });

  it('never returns one that is already resolved', () => {
    const id = file();
    ageRequest(id, 99);
    expect(staleOverrideRequests(12, 50).map((r) => r.id)).toEqual([id]);
    resolveOverrideRequest(id, { outcome: 'denied', resolvedBy: 'pm-1', reason: 'ruled' });
    expect(staleOverrideRequests(12, 50)).toEqual([]);
  });

  it('carries the fields the auto-denial notice quotes back to the agent', () => {
    const id = file('w1', AGENT, { justification: 'x'.repeat(40) });
    ageRequest(id, 20);
    const [r] = staleOverrideRequests(12, 50);
    expect(r.requestedBy).toBe(AGENT);
    expect(r.requestedStatus).toBe('complete');
    expect(r.justification).toHaveLength(40);
    expect(r.taskId).toBe('w1');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 — THE VERDICT HALF, and the one place old semantics could have drifted
// ════════════════════════════════════════════════════════════════════════════════

describe('the verdict half lives in `adjudications`, and revert_count is unchanged', () => {
  it('APPROVE writes the upheld adjudication through transition(), not through this module', async () => {
    // The approve path forces the move with `claim: 'authoritative'`, and that is what files
    // the verdict — one writer, the one this phase already built.
    const { transition } = await import('../store.js');
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
       VALUES ('d-1', ?, 'send_message', 'imessage', 'delivered')`,
    ).run(AGENT);
    const id = file();
    transition('w1', {
      to: 'done', by: 'pm', actorId: 'pm-1', claim: 'authoritative',
      reason: `PM approved override request ${id}`, resultDeliveryId: 'd-1',
    });
    resolveOverrideRequest(id, { outcome: 'approved', resolvedBy: 'pm-1', reason: 'ok' });
    const adj = mockDb.current!.prepare(
      "SELECT claim_state, verdict, by_agent FROM adjudications WHERE work_id = 'w1'",
    ).all();
    expect(adj).toEqual([{ claim_state: 'done', verdict: 'upheld', by_agent: 'pm-1' }]);
  });

  it('DENY writes NO adjudication — revert_count must read exactly what it read before', async () => {
    const { revertCount } = await import('../store.js');
    const id = file();
    expect(revertCount('w1')).toBe(0);
    resolveOverrideRequest(id, { outcome: 'denied', resolvedBy: 'pm-1', reason: 'the gate was right' });
    // An override request ASKS to move; it is not a claim the work carries, so refusing it is
    // not a thrown-back claim. Counting it would move the stalemate threshold (high=2 /
    // normal=3 / low=5) without anyone deciding to — a live behaviour change smuggled in as a
    // storage change. Old semantics preserved, deliberately and on the record.
    expect(revertCount('w1')).toBe(0);
    // POSITIVE CONTROL of the same shape: a real thrown-back claim still counts.
    const { rejectClaim } = await import('../store.js');
    rejectClaim('w1', { claimState: 'done', by: 'pm', note: 'evidence does not show the goal' });
    expect(revertCount('w1')).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6 — THE TABLE IS DEAD TO PRODUCTION (RULING 4's exit condition)
// ════════════════════════════════════════════════════════════════════════════════

describe('zero production readers and writers of task_override_requests', () => {
  it('no production file names the table (tests, migrations and this walk excluded)', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = fileURLToPath(new URL('../../', import.meta.url));
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          if (e === '__tests__' || e === 'migrations' || e === 'node_modules') continue;
          walk(p, out);
        } else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    const offenders = walk(ROOT)
      .filter((f) => readFileSync(f, 'utf8')
        // comments are blanked first: a tombstone naming the table is not a reader
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
        .includes('task_override_requests'))
      .map((f) => f.slice(ROOT.length));
    expect(offenders).toEqual([]);
  });
});
