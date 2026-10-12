// ════════════════════════════════════════════════════════════════════════════════════════
// t142 — `<state>_validated` IS DECIDED BY THE SEQUENCE, NOT THE CLOCK.
//
// `validatedExpr` scopes a verdict to "at or after the row last entered that state". At
// 00a2b34d it compared `adjudications.created_at >= MAX(work_events.created_at)` — a CLOCK —
// while `work_events` carries a SEQUENCE, against the codebase's own written law
// (`work/override-requests.ts`: "Ordering is by `work_events.id`, never by `created_at` …
// a sequence exists here, so a clock is the wrong instrument").
//
// The defect is a millisecond tie. A block the PM upheld, resolved forward, and then blocked
// AGAIN on a fresh obstacle inside the same millisecond reads as UPHELD: the old verdict
// leaks into the new episode. Three real readers, three wrong answers, driven here:
//
//   · the owner-escalation sentence tells the owner "Your PM checked it and confirmed the
//     block is real" about a block nobody has checked;
//   · the blocked-work disposal door refuses the assignee's own ordinary close-out as if an
//     authority had ruled on it;
//   · the tracker row the board and the PM read reports `blocked_validated = 1`.
//
// The clock is frozen for the whole file (`vi.setSystemTime`), so every write lands in ONE
// millisecond — the tie is the fixture, stated, not raced.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t142-seq-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not under test */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }),
}));

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import { upholdClaim, setTrackerStatus } from '../tracker-store.js';
import { validatedExpr, taskScope } from '../tracker-view.js';
import { selectRowsForOwnerEscalation, ownerEscalationAlertLine } from '../validation-drive.js';

const ASSIGNEE = 'quillon';
const PM = 'pm-agent';
const T = 1_700_000_000_000;
const NOW = T + 60 * 60_000;
const CUTOFF = NOW - 5 * 60_000;

function seedWork(id: string): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state,
                       intent, wakes, closes_thread, title, priority, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'owner', 'tracker', ?, 'claimed', 'do-it', 1, 0,
             'reconcile the seed-tray inventory', 'normal', ?, ?)`,
  ).run(id, ASSIGNEE, id, T, T);
}

function move(id: string, to: 'blocked' | 'claimed' | 'paused', extra: Record<string, unknown> = {}): void {
  const r = transition(id, {
    to, by: 'agent', actorId: ASSIGNEE, reason: `-> ${to}`,
    note: to === 'blocked' ? 'the inventory spreadsheet is locked by another editor' : undefined,
    ...extra,
  });
  expect(r.kind, `${id} -> ${to}`).toBe('applied');
}

/** The board's / PM's reading of the row, through the one builder every reader calls. */
const validated = (id: string, state: 'blocked' | 'paused' | 'done'): number =>
  (mockDb.current!.prepare(
    `SELECT ${validatedExpr('w', state)} AS v FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
  ).get(id) as { v: number }).v;

/** blocked -> PM upholds -> resolved forward -> blocked AGAIN, all in one millisecond. */
function upheldThenReblocked(id: string): void {
  seedWork(id);
  move(id, 'blocked');
  upholdClaim(id, 'blocked', 'pm', PM, 'PM confirmed the block is real');
  move(id, 'claimed');
  move(id, 'blocked');
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Quillon', 'idle')`).run(ASSIGNEE);
  vi.setSystemTime(new Date(NOW));
});

describe('§1 THE WITNESS: a same-millisecond tie is read by the clock, wrongly', () => {
  it.fails('RED at 00a2b34d: the board reads a fresh, unchecked block as PM-upheld', () => {
    upheldThenReblocked('t-tie');
    expect(validated('t-tie', 'blocked'), 'the verdict belonged to the PREVIOUS block').toBe(0);
  });

  it.fails('RED at 00a2b34d: the owner is told "Your PM checked it" about a block nobody checked', () => {
    upheldThenReblocked('t-tie-owner');
    const row = selectRowsForOwnerEscalation(CUTOFF, []).find((r) => r.id === 't-tie-owner');
    expect(row, 'the re-blocked row is a candidate').toBeDefined();
    const line = ownerEscalationAlertLine({
      title: row!.title, status: row!.status, since: row!.updated, agentName: 'Quillon',
      steers: 2, failures: row!.failures, blockedValidated: row!.blocked_validated === 1,
      obstacle: row!.obstacle,
    });
    expect(line).not.toContain('confirmed the block is real');
    expect(line).toContain('has not been able to confirm');
  });

  it.fails('RED at 00a2b34d: the disposal door refuses the assignee\'s own close-out as "ruled"', () => {
    upheldThenReblocked('t-tie-door');
    // The assignee's own disposal of its own UNRULED block is the normal close-out path the
    // gate promises to leave alone (`blockedDisposalRefusal`: "the normal close-out path").
    const r = setTrackerStatus('t-tie-door', 'cancelled', {
      by: 'agent', actorId: ASSIGNEE, reason: 'the owner withdrew the request; standing it down',
    });
    expect(r.kind, 'the assignee owns an unruled block').toBe('applied');
  });

  it.fails('RED at 00a2b34d: the same tie on a PAUSE leaks the old blessing too', () => {
    seedWork('t-tie-pause');
    move('t-tie-pause', 'paused');
    upholdClaim('t-tie-pause', 'paused', 'pm', PM, 'the pause is legitimate');
    move('t-tie-pause', 'claimed');
    move('t-tie-pause', 'paused');
    expect(validated('t-tie-pause', 'paused'), 'a fresh pause is unvalidated').toBe(0);
  });
});

describe('§2 THE POSITIVE CONTROLS — the tie must not cost a verdict that IS current', () => {
  it('an uphold in the same millisecond AFTER the entry is current', () => {
    seedWork('t-after');
    move('t-after', 'blocked');
    upholdClaim('t-after', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    expect(validated('t-after', 'blocked')).toBe(1);
  });

  it('an AUTHORITATIVE entry carries its own verdict, in its own unit', () => {
    seedWork('t-auth');
    move('t-auth', 'blocked');
    move('t-auth', 'claimed');
    const r = transition('t-auth', {
      to: 'blocked', by: 'pm', actorId: PM, reason: 'PM forces the block', claim: 'authoritative',
    });
    expect(r.kind).toBe('applied');
    expect(validated('t-auth', 'blocked')).toBe(1);
  });

  it('a re-block AFTER the uphold, then a fresh uphold, is current again', () => {
    upheldThenReblocked('t-again');
    upholdClaim('t-again', 'blocked', 'pm', PM, 'PM checked the new obstacle too');
    expect(validated('t-again', 'blocked')).toBe(1);
  });
});
