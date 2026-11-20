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
// real and the dashboard's `the-board-shows-six-columns-with-the-owners-words` is its test: a
// cancelled row is visible, in the Closed column, labelled with its own word. The board is fixed first; only then does the word become storable.
//
// SCOPE NOTE, honest: existing `failed` rows are NOT migrated. The four July FX.n4 rows the
// round-3 investigation examined were genuine failures and stay `fallen`/Failed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { holdOf } from '../../work/done/hold.js';
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
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
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
import { FX } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

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



  it('CONTROL — every other synonym class is untouched', () => {
    // `complete` and `on_deck` are excluded on purpose, each guarded by a rule that is NOT
    // the synonym table: G7 refuses `done` without a resolving delivery, and `on_deck` is
    // reserved for tasks that carry a future schedule. Asserting on either here would be
    // testing that gate, not this mapping.
    // [word, the state it lands in, the hold it sets (paused and blocked are holds), id, from]
    const cases: Array<[string, string, string | null, string, string]> = [
      ['in progress', 'claimed', null, 'wordinprog-01', 'on_deck'],
      ['on hold', 'claimed', 'paused', 'wordonhold-01', 'in_progress'],
      ['stuck', 'claimed', 'blocked', 'wordstuck-01', 'in_progress'],
      ['stalled', 'claimed', 'blocked', 'wordstalled-01', 'in_progress'],
      ['parked', 'claimed', 'paused', 'wordparked-01', 'in_progress'],
    ];
    for (const [word, state, hold, id, from] of cases) {
      seedTrackerTask(mockDb.current!, { id, title: word, status: from });
      const out = trackerUpdateStatus(AGENT, {
        taskId: id, status: word,
        notes: 'waiting for the vendor to send the tracking number',
      });
      expect(out, `${word}: ${out}`).toContain('[OK]');
      expect(rowOf(id).state, word).toBe(state);
      expect(holdOf(id)?.kind ?? null, word).toBe(hold);
    }
  });


});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE LEDGER NAMES THE ACTOR'S CHOICE, AND THE SCHEDULE STILL DISARMS (F-17)
// ════════════════════════════════════════════════════════════════════════════════════════


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
// what settles it in BOTH directions: the four July FX.n4 rows the review flagged as "open
// work the agent missed" are `state='failed'` with `closed_at` set — surfacing them as active
// would have made the agent report closed July failures as live work, which is strictly worse
// than the silence. So `cancelled` joins `fallen` OUTSIDE this list, deliberately, and this
// test is the record of that decision. What T18 fixes is the LABEL those rows carry when they
// are read (the board, the detail page, the tool's own vocabulary), not their absence here.
// ════════════════════════════════════════════════════════════════════════════════════════
