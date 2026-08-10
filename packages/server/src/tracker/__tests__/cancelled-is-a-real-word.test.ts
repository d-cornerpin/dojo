// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 3 T18 — "CANCELLED" BECOMES A REAL WORD: user choices stop reading as
// failures. (round-3 findings F1 + F2, merged: they are one defect seen from two sides.)
//
// EVERY CLAUSE BELOW FAILED AT `eee3eb6`. The agent passed `status:"cancelled"` — a value the
// tool's OWN wire schema advertises (`agent/tools/definitions.ts:1097`) — and a synonym table
// four call-frames above the spine folded it into `fallen`:
//
//     fallen: 'fallen', failed: 'fallen', fail: 'fallen', cancelled: 'fallen',
//     canceled: 'fallen', abandoned: 'fallen', dropped: 'fallen', wontfix: 'fallen',
//
// The owner's recorded rationale for that table (commit `52be904`, 2026-07-04) is
// weak-model TYPO FORGIVENESS of failure words — "forgive weak-model input, never silently
// corrupt" — and it is kept here in full for `fallen`/`failed`/`fail`. What it never was is a
// judgement that a user's cancellation is a failure. `cancelled` was swept into a bucket the
// comment itself calls "the failure words".
//
// THE DESTINATION EXISTED THE WHOLE TIME, one layer below the fold: `work/tracker-view.ts:55`
// and `:69` already carry `cancelled -> abandoned` and `abandoned -> cancelled`, in both
// directions, with the file's own rule written above them — "a lossy arm here would silently
// rewrite a row's meaning". `tracker/tools.ts` performed exactly the fold that rule forbids.
//
// THE ONE REAL REASON FOR THE FOLD IS ANSWERED, NOT DELETED. `tracker/schema.ts:381-386`
// (commit `632cadd`) records it: "the board only renders the six legacy task statuses … storing
// a literal 'cancelled' on a task would make it disappear from the board." That constraint is
// real and §4 is its test: a cancelled row is VISIBLE, in the terminal column, labelled with
// its own word. The board is fixed first; only then does the word become storable.
//
// SCOPE NOTE, honest: existing `failed` rows are NOT migrated. The four July Kevin rows the
// round-3 investigation examined were genuine failures and stay `fallen`/Failed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getOwnerName: () => 'the owner',
  isPMAgent: (id: string) => id === 'pm',
}));

import { trackerUpdateStatus, trackerListActive } from '../tools.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { statusToState, stateToStatus } from '../../work/tracker-view.js';
import { isTerminalTaskStatus } from '../../agent/tool-helpers.js';
import {
  TERMINAL_COLUMN_STATUSES, columnKeyForStatus, terminalOutcomeLabel, KANBAN_COLUMN_KEYS,
} from '../../../../dashboard/src/lib/task-status';

const AGENT = 'a1';
const TASK = 'task-cancel-0001';

function applySchema(db: Database.Database): void {
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, agent_type TEXT, model_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO agents (id, name, status) VALUES ('a1', 'Agent One', 'idle');
    CREATE TABLE IF NOT EXISTS task_log (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_entity TEXT NOT NULL,
      entry_kind TEXT NOT NULL, from_status TEXT, to_status TEXT, reason TEXT,
      action_taken TEXT, note TEXT, evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, outcome TEXT, tool TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
      origin_intent TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
      display_kind TEXT NOT NULL DEFAULT 'unclassified',
      display_tier TEXT NOT NULL DEFAULT 'agent-only',
      turn_number INTEGER, task_id TEXT, run_id TEXT, conv_key TEXT DEFAULT NULL,
      provenance TEXT NOT NULL DEFAULT 'live',
      swept_at TEXT, served_by_turn INTEGER, answer_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

const rowOf = (id = TASK) =>
  mockDb.current!.prepare('SELECT state, closed_at, schedule_status, is_paused, next_run_at FROM work WHERE id = ?')
    .get(id) as { state: string; closed_at: number | null; schedule_status: string; is_paused: number; next_run_at: number | null };

/** Every audit/transition line the spine recorded for this task, oldest first. The trail is
 *  `work_events` since PHASE-2 T8c absorbed `task_log`; this reads the raw payloads so the
 *  assertion is on what was WRITTEN, not on a projection that could translate it. */
const logOf = (id = TASK): string =>
  (mockDb.current!.prepare('SELECT kind, payload FROM work_events WHERE work_id = ? ORDER BY id').all(id) as
    Array<{ kind: string; payload: string | null }>)
    .map((r) => `${r.kind} :: ${r.payload ?? ''}`).join('\n');

beforeEach(() => {
  const db = new Database(':memory:');
  applySchema(db);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE WORD SURVIVES THE TOOL BOUNDARY
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 status:"cancelled" lands on the spine as `abandoned`', () => {
  it('the round-3 S2 shape: a user cancellation is stored as abandoned, read back as cancelled', () => {
    seedTrackerTask(mockDb.current!, { id: TASK, title: 'Take the trash out', status: 'on_deck' });
    const out = trackerUpdateStatus(AGENT, {
      taskId: TASK, status: 'cancelled',
      notes: 'Cancelled per David: he\'ll take the trash out tonight instead.',
    });
    expect(out).toContain('[OK]');
    expect(rowOf().state).toBe('abandoned');
    expect(rowOf().closed_at).not.toBeNull();
    expect(out).toContain('status=cancelled');
  });

  it('every user-choice synonym reaches the same terminal, and none of them reach `failed`', () => {
    const words = ['cancelled', 'canceled', 'dropped', 'wontfix', 'abandoned', 'Cancelled', 'CANCELLED'];
    for (const [n, word] of words.entries()) {
      const id = `synonym-${n}-000${n}`;
      seedTrackerTask(mockDb.current!, { id, title: word, status: 'on_deck' });
      const out = trackerUpdateStatus(AGENT, { taskId: id, status: word });
      expect(out, `${word}: ${out}`).toContain('[OK]');
      expect(rowOf(id).state, word).toBe('abandoned');
    }
  });

  it('CONTROL — the failure words are byte-identical: still `failed`', () => {
    // Ids are deliberately non-prefixing: `resolveTaskId` accepts an 8+ char PREFIX, so
    // `task-fail` + the word would make three ambiguous ids and the tool would refuse all
    // three — a green that proved nothing.
    const cases: Array<[string, string]> = [
      ['fallen', 'wordfallen-01'], ['failed', 'wordfailed-01'], ['fail', 'wordfailbare-01'],
    ];
    for (const [word, id] of cases) {
      seedTrackerTask(mockDb.current!, { id, title: word, status: 'on_deck' });
      const out = trackerUpdateStatus(AGENT, { taskId: id, status: word });
      expect(out, `${word}: ${out}`).toContain('[OK]');
      expect(rowOf(id).state, word).toBe('failed');
    }
  });

  it('CONTROL — every other synonym class is untouched', () => {
    // `complete` and `on_deck` are excluded on purpose, each guarded by a rule that is NOT
    // the synonym table: G7 refuses `done` without a resolving delivery, and `on_deck` is
    // reserved for tasks that carry a future schedule. Asserting on either here would be
    // testing that gate, not this mapping.
    const cases: Array<[string, string, string, string]> = [
      ['in progress', 'claimed', 'wordinprog-01', 'on_deck'],
      ['on hold', 'paused', 'wordonhold-01', 'in_progress'],
      ['stuck', 'blocked', 'wordstuck-01', 'in_progress'],
      ['stalled', 'blocked', 'wordstalled-01', 'in_progress'],
      ['parked', 'paused', 'wordparked-01', 'in_progress'],
    ];
    for (const [word, state, id, from] of cases) {
      seedTrackerTask(mockDb.current!, { id, title: word, status: from });
      const out = trackerUpdateStatus(AGENT, {
        taskId: id, status: word,
        notes: 'waiting for the vendor to send the tracking number',
      });
      expect(out, `${word}: ${out}`).toContain('[OK]');
      expect(rowOf(id).state, word).toBe(state);
    }
  });

  it('an unrecognized value is still REFUSED, and the guidance now names cancelled', () => {
    seedTrackerTask(mockDb.current!, { id: 'task-bogus-1', title: 'x', status: 'on_deck' });
    const out = trackerUpdateStatus(AGENT, { taskId: 'task-bogus-1', status: 'flumped' });
    expect(out).toMatch(/^Error: "flumped" is not a recognized task status/);
    expect(out).toContain('cancelled');
    expect(rowOf('task-bogus-1').state).toBe('on_deck');
  });

  it('the advertised vocabulary and the error text agree — the contradiction is gone', () => {
    seedTrackerTask(mockDb.current!, { id: 'task-vocab-1', title: 'x', status: 'on_deck' });
    const err = trackerUpdateStatus(AGENT, { taskId: 'task-vocab-1', status: 'zzz' });
    // Every value the wire enum advertises for action="status" must appear in the legal set
    // the error prints. `definitions.ts:1097` is the enum; this is the promise it makes.
    for (const v of ['on_deck', 'in_progress', 'complete', 'blocked', 'fallen', 'paused', 'cancelled']) {
      expect(err, `error text omits the advertised value "${v}"`).toContain(v);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE LEDGER NAMES THE ACTOR'S CHOICE, AND THE SCHEDULE STILL DISARMS (F-17)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the reason string and the schedule', () => {
  it('a cancellation never says "given up on"', () => {
    seedTrackerTask(mockDb.current!, {
      id: TASK, title: 'Reminder: trash', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: Date.now() + 3_600_000,
      repeat_interval: 1, repeat_unit: 'days', task_kind: 'reminder',
    });
    trackerUpdateStatus(AGENT, { taskId: TASK, status: 'cancelled' });
    const log = logOf();
    expect(log).not.toContain('given up on');
    expect(log).not.toContain('marked fallen');
    // The trail line the OWNER reads carries the same word, not the failure one.
    expect(log).not.toContain('terminated on fallen');
    expect(log).toContain('schedule terminated on cancel');
    expect(log).toMatch(/cancell?ed/i);
  });

  it('F-17 STAYS CLOSED: a cancelled reminder\'s live schedule is terminated', () => {
    seedTrackerTask(mockDb.current!, {
      id: TASK, title: 'Reminder: trash', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: Date.now() + 3_600_000,
      repeat_interval: 1, repeat_unit: 'days', task_kind: 'reminder',
    });
    const out = trackerUpdateStatus(AGENT, { taskId: TASK, status: 'cancelled' });
    const r = rowOf();
    expect(r.schedule_status, 'a cancelled reminder left ARMED is F-17 exactly').toBe('completed');
    expect(r.is_paused).toBe(1);
    expect(r.next_run_at).toBeNull();
    expect(out).toContain('Schedule stopped');
  });

  it('CONTROL — a fallen task still disarms, and still says "given up on"', () => {
    seedTrackerTask(mockDb.current!, {
      id: 'task-fallen-1', title: 'Reminder: x', status: 'on_deck',
      schedule_status: 'waiting', is_paused: 0, next_run_at: Date.now() + 3_600_000,
      repeat_interval: 1, repeat_unit: 'days', task_kind: 'reminder',
    });
    trackerUpdateStatus(AGENT, { taskId: 'task-fallen-1', status: 'fallen' });
    expect(rowOf('task-fallen-1').schedule_status).toBe('completed');
    expect(logOf('task-fallen-1')).toContain('given up on');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE PREDICATES THAT WOULD HAVE FALLEN THROUGH SILENTLY
// The investigation enumerated these; each one is a place where a new terminal value would
// have been treated as still-open work.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 terminality is not a list of two words any more', () => {
  it('isTerminalTaskStatus accepts cancelled', () => {
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('complete')).toBe(true);
    expect(isTerminalTaskStatus('fallen')).toBe(true);
    expect(isTerminalTaskStatus('in_progress')).toBe(false);
    expect(isTerminalTaskStatus('paused')).toBe(false);
  });

  it('the tracker view round-trips cancelled in both directions, totally', () => {
    expect(statusToState('cancelled')).toBe('abandoned');
    expect(stateToStatus('abandoned')).toBe('cancelled');
    expect(stateToStatus(statusToState('cancelled'))).toBe('cancelled');
  });

  // (The end-of-turn floor's half of this — that no terminal word can be read as an
  //  ADVANCING status arg — is pinned in the step package that owns that set:
  //  `agent/v2/steps/execute/__tests__/advancing-status-args.test.ts`. It lives there because
  //  a guard reaching into `agent/v2/steps` by path from outside is what the guard-corpus
  //  census refuses.)
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3b — THE FOUR-STATE "ACTIVE" WHITELIST, REVIEWED AND ITS REASON WRITTEN DOWN.
//
// `trackerListActive` (`tracker/tools.ts`) lists exactly four states — in_progress, on_deck,
// blocked, paused — and the round-3 investigation found NO recorded intent for the exclusion
// anywhere: the set is inherited from the initial commit `69277f3` with no comment, and the
// one commit that touched it (`8529a8b`) was about the `filter` param being ignored.
//
// It is REVIEWED here rather than widened, and the reason is this clause. A terminal row does
// not belong in a listing whose trailer says "No active tasks", and the round-3 evidence is
// what settles it in BOTH directions: the four July Kevin rows the review flagged as "open
// work the agent missed" are `state='failed'` with `closed_at` set — surfacing them as active
// would have made the agent report closed July failures as live work, which is strictly worse
// than the silence. So `cancelled` joins `fallen` OUTSIDE this list, deliberately, and this
// test is the record of that decision. What T18 fixes is the LABEL those rows carry when they
// are read (the board, the detail page, the tool's own vocabulary), not their absence here.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3b terminal rows stay out of the "active" listing, on purpose', () => {
  it('neither terminal outcome appears in work_update(action="list")', () => {
    seedTrackerTask(mockDb.current!, { id: 'listcancel-01', title: 'Cancelled work', status: 'in_progress' });
    seedTrackerTask(mockDb.current!, { id: 'listfallen-01', title: 'Failed work', status: 'in_progress' });
    seedTrackerTask(mockDb.current!, { id: 'listopen-001', title: 'Live work', status: 'in_progress' });
    trackerUpdateStatus(AGENT, { taskId: 'listcancel-01', status: 'cancelled' });
    trackerUpdateStatus(AGENT, { taskId: 'listfallen-01', status: 'fallen' });
    expect(rowOf('listcancel-01').state).toBe('abandoned');
    expect(rowOf('listfallen-01').state).toBe('failed');

    const listed = trackerListActive(AGENT, {});
    expect(listed, 'a still-open task must be listed — otherwise this clause is vacuous')
      .toContain('Live work');
    expect(listed, 'a cancelled task is closed; "active" must not claim it').not.toContain('Cancelled work');
    expect(listed, 'a failed task is closed; "active" must not claim it').not.toContain('Failed work');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE BOARD. This is the constraint `632cadd` recorded, and it is the reason the fold
// existed: a literal "cancelled" USED to vanish from the kanban. It does not any more.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 a cancelled row is visible on the board, with its own word', () => {
  it('THE NO-VANISHING TEST: cancelled resolves to a real column', () => {
    const col = columnKeyForStatus('cancelled');
    expect(col, 'a cancelled task in NO column is the exact bug 632cadd avoided').not.toBeNull();
    expect(KANBAN_COLUMN_KEYS).toContain(col!);
  });

  it('cancelled and fallen share ONE column and are labelled differently', () => {
    expect(columnKeyForStatus('cancelled')).toBe(columnKeyForStatus('fallen'));
    expect(TERMINAL_COLUMN_STATUSES).toEqual(['fallen', 'cancelled']);
    expect(terminalOutcomeLabel('fallen')).toBe('Failed');
    expect(terminalOutcomeLabel('cancelled')).toBe('Cancelled');
    expect(terminalOutcomeLabel('complete')).toBeNull();
  });

  it('every other status still resolves to its own column, unchanged', () => {
    for (const s of ['on_deck', 'in_progress', 'paused', 'complete', 'blocked', 'fallen'] as const) {
      expect(columnKeyForStatus(s), s).toBe(s === 'cancelled' ? 'fallen' : s);
    }
  });
});
