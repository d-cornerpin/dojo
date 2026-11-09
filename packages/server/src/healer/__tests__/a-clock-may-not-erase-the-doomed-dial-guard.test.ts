// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS U1 + R30) — A CLOCK MAY NOT ERASE A GUARD, NOR FAIL A RUN THAT IS RUNNING.
//
// The two fixes the first sitting could not take, because a live lane held both files. Landed on
// the merged head, per the specs written at the time.
//
// ── U1: THE 30-MINUTE SWEEP THAT ERASED THE DOOMED-DIAL GUARD ──
//
// `onAgentRecovered` is the one chokepoint for "this agent is healthy again", and the frequent
// auto-fix sweep called it on ELAPSED TIME ALONE. Every 5 minutes, any agent `paused` or `error`
// for >30 minutes was flipped to `idle` and passed through it, which reset the attempt ladder
// (row 14, whose job is to ESCALATE to a human), deleted `last_error` (the human's only account),
// and cleared `declaredPatienceHonestFails` — the T82c marker that is the only thing standing
// between an agent and a second doomed cold-redial chain.
//
// So the whole NO-DOOMED-DIALS chain could work perfectly — refuse the dial, error honestly, set
// the marker, tell the human — and thirty minutes later, with NO fact consulted about why it
// failed, the agent was idle again with its error deleted and its guard erased, free to re-enter
// the identical chain for ever while the dashboard showed a healthy agent. `auto-fix.ts`'s own
// header names the failure it was creating: "a persistent fault bounces error->idle->error with
// no fresh owner signal".
//
// ── R30: THE ONE REAPER WITHOUT A LIVENESS GUARD ──
//
// Two things had to be wrong at once. The SQL took `MIN(...)` of the agent's newest message and
// the task's `updated_at` — the OLDER of two clocks — so a row was stale if EITHER side was, and
// `work.updated_at` only moves on an explicit `work_*` tool write while the 30-second heartbeat
// touches a different table this query never reads. And nothing asked whether the run was still
// running: `scheduler/` imported `activeRuns` nowhere, making this the only reaper in the tree
// without the guard `runtime.ts`, `healer-agent.ts`, `auto-fix.ts`, `vault/maintenance.ts` and
// `pm-agent.ts` all carry. A nightly task 35 minutes in and emitting messages was force-failed
// WHILE RUNNING, and because the row was re-scheduled the next tick could dispatch a SECOND run
// of the same task against the same agent — the duplicate-work split the preempt removal existed
// to stop.
//
// Driven behaviourally where the mechanism allows it (U1's clears are observable in the DB) and
// by source shape where the alternative would be standing up the scheduler's whole dispatch loop.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { onAgentRecovered, drainRecoveryNotices } from '../injury-recovery.js';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
}));
vi.mock('../../agent/a2a-notice.js', () => ({ deliverPlatformNotice: vi.fn(async () => undefined) }));

const AGENT = 'quill';

// t277: injury-recovery loads ONCE, at file collection. The clauses used to `vi.resetModules()` in
// beforeEach and then `await import('../injury-recovery.js')` inside the clause AND again in
// afterEach, so every clause (and its teardown) paid the cold graph (imessage bridge, diagnostic,
// tracker view, owner cards...) inside its own 30 s budget - 13 s for the first clause on a loaded
// box, a timeout when several suites ran at once. Nothing needs a fresh graph: the database is
// reached only through the mocked getDb -> mockDb.current, replaced in each beforeEach, and the
// module's own timers are drained by afterEach.
beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, last_error TEXT,
      -- last_error_at is NOT decoration: clearAgentLastError writes it, and the product wraps
      -- that call in a swallowing try/catch. A fixture missing the column made the clear throw
      -- silently, so the clause scored the fixture's own gap as a product failure.
      last_error_at TEXT,
      recovery_attempts INTEGER DEFAULT 0, updated_at TEXT, model_id TEXT, classification TEXT
    );
  `);
  // The DOOMED-DIAL MARKER's real home. The first cut of this file asserted only its two
  // NEIGHBOURS (the error text and the attempt ladder) and the mutation run caught that
  // immediately: planting back `clearDeclaredPatienceHonestFails` on the cooldown path left all
  // twelve clauses GREEN, because nothing was watching the marker itself — the sharpest of the
  // three clears and the whole reason U1 is ranked where it is. Same lesson as U5's oracle.
  db.exec(`
    CREATE TABLE healer_state (
      scope TEXT NOT NULL, key TEXT NOT NULL, at_ms INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (scope, key)
    );
  `);
  db.prepare(
    `INSERT INTO agents (id, name, status, last_error, recovery_attempts, updated_at)
     VALUES (?, 'Quill', 'error', 'declared_patience_exceeded: the prompt cannot finish in time', 3, '1970-01-01')`,
  ).run(AGENT);
  seedDoomMarker();
});

/** The T82c marker, written where the product writes it: `healer_state`, keyed `<agentId>:<turn>`. */
function seedDoomMarker(): void {
  mockDb.current!.prepare(
    `INSERT INTO healer_state (scope, key, at_ms) VALUES ('declared_patience_honest_fail', ?, 1)`,
  ).run(`${AGENT}:7`);
}

/** How many doom markers this agent still carries. */
const doomMarkers = (): number =>
  (mockDb.current!.prepare(
    `SELECT count(*) AS n FROM healer_state WHERE scope = 'declared_patience_honest_fail' AND key LIKE ?`,
  ).get(`${AGENT}:%`) as { n: number }).n;

afterEach(async () => {
  await drainRecoveryNotices();
  mockDb.current?.close();
  mockDb.current = null;
});

const agentRow = (): { status: string; last_error: string | null; recovery_attempts: number } =>
  mockDb.current!.prepare('SELECT status, last_error, recovery_attempts FROM agents WHERE id = ?')
    .get(AGENT) as { status: string; last_error: string | null; recovery_attempts: number };

describe('§1 U1 — a COOLDOWN recovery may not clear what only evidence earns', () => {
  it('THE RED: the doomed-dial marker and the error text survive a cooldown recovery', () => {
    onAgentRecovered(AGENT, 'cooldown');

    const row = agentRow();
    // THE MARKER FIRST. It is the only thing standing between this agent and a second doomed
    // cold-redial chain, so it is the assertion this clause exists for.
    expect(doomMarkers(), 'a clock must NEVER be able to clear the doomed-dial marker').toBe(1);
    expect(row.last_error, 'the human\'s only account of the failure is not deleted by a clock')
      .toMatch(/declared_patience_exceeded/);
    expect(row.recovery_attempts, 'and row 14\'s ladder is not reset to zero, so it can still escalate')
      .toBe(3);
  });

  it('THE OTHER DIRECTION: an EVIDENCE recovery still clears everything, as it always did', () => {
    // A completed turn is proof the agent is working. This path must not be made more timid —
    // that would leave a genuinely recovered agent carrying a stale diagnostic for ever.
    onAgentRecovered(AGENT, 'evidence');

    const row = agentRow();
    expect(doomMarkers(), 'a completed turn IS proof, so the marker is cleared').toBe(0);
    expect(row.last_error, 'a real recovery clears the diagnostic').toBeNull();
    expect(row.recovery_attempts, 'and resets the ladder').toBe(0);
  });

  it('CONTROL: `evidence` is the DEFAULT, so every existing caller keeps today\'s behaviour', () => {
    // The turn path and the Healer self-watchdog call this with one argument. If the default had
    // been `cooldown`, this fix would have quietly stopped real recoveries from clearing.
    onAgentRecovered(AGENT);

    expect(agentRow().last_error, 'a one-argument call is still a full recovery').toBeNull();
  });
});
