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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

beforeEach(() => {
  vi.resetModules();
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
  const { drainRecoveryNotices } = await import('../injury-recovery.js');
  await drainRecoveryNotices();
  mockDb.current?.close();
  mockDb.current = null;
});

const agentRow = (): { status: string; last_error: string | null; recovery_attempts: number } =>
  mockDb.current!.prepare('SELECT status, last_error, recovery_attempts FROM agents WHERE id = ?')
    .get(AGENT) as { status: string; last_error: string | null; recovery_attempts: number };

describe('§1 U1 — a COOLDOWN recovery may not clear what only evidence earns', () => {
  it('THE RED: the doomed-dial marker and the error text survive a cooldown recovery', async () => {
    const { onAgentRecovered } = await import('../injury-recovery.js');

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

  it('THE OTHER DIRECTION: an EVIDENCE recovery still clears everything, as it always did', async () => {
    const { onAgentRecovered } = await import('../injury-recovery.js');

    // A completed turn is proof the agent is working. This path must not be made more timid —
    // that would leave a genuinely recovered agent carrying a stale diagnostic for ever.
    onAgentRecovered(AGENT, 'evidence');

    const row = agentRow();
    expect(doomMarkers(), 'a completed turn IS proof, so the marker is cleared').toBe(0);
    expect(row.last_error, 'a real recovery clears the diagnostic').toBeNull();
    expect(row.recovery_attempts, 'and resets the ladder').toBe(0);
  });

  it('CONTROL: `evidence` is the DEFAULT, so every existing caller keeps today\'s behaviour', async () => {
    const { onAgentRecovered } = await import('../injury-recovery.js');

    // The turn path and the Healer self-watchdog call this with one argument. If the default had
    // been `cooldown`, this fix would have quietly stopped real recoveries from clearing.
    onAgentRecovered(AGENT);

    expect(agentRow().last_error, 'a one-argument call is still a full recovery').toBeNull();
  });
});

describe('§2 U1 — the sweep reads the CAUSE before it writes a status', () => {
  it('THE RED: a declared-patience failure is left alone, with its diagnostic intact', () => {
    const src = stripped('healer/auto-fix.ts');

    expect(/function cooldownSweepMayRecover\(/.test(src), 'the sweep asks whether it may act').toBe(true);
    expect(/DECLARED_PATIENCE_EXCEEDED_CODE/.test(src), 'and it keys on the code, not on prose').toBe(true);
    // BOTH arms — the paused one and the errored one. Fixing one of a matched pair is how this
    // family survives review.
    const guards = src.match(/cooldownSweepMayRecover\(item\.agentId\)/g) ?? [];
    expect(guards.length, 'both sweep arms consult it').toBe(2);
  });

  it('the cause is read BEFORE the status write, in BOTH functions that were changed', () => {
    const src = stripped('healer/auto-fix.ts');

    // Scoped PER FUNCTION on purpose. `auto-fix.ts` carries other fixers that write the same
    // status for unrelated reasons (`fixStuckAgent`), and one of them sits above these two — so a
    // whole-file `indexOf` comparison measures function ORDER, not check order, and an earlier
    // cut of this clause failed for exactly that reason.
    for (const fn of ['function fixPausedAgent(', 'function fixErrorAgent(']) {
      const start = src.indexOf(fn);
      expect(start, `${fn} exists`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
      const guardAt = body.indexOf('cooldownSweepMayRecover(item.agentId)');
      const writeAt = body.indexOf("writeAgentStatus(item.agentId, 'idle')");
      expect(guardAt, `${fn} consults the cause`).toBeGreaterThan(-1);
      expect(writeAt, `${fn} writes a status`).toBeGreaterThan(-1);
      expect(guardAt, `${fn}: a check after the write would be decoration`).toBeLessThan(writeAt);
    }
  });

  it('the sweep passes `cooldown`, which is what makes §1 bite in production', () => {
    const src = stripped('healer/auto-fix.ts');
    expect(/m\.onAgentRecovered\(agentId, 'cooldown'\)/.test(src)).toBe(true);
  });

  it('CONTROL: an unreadable row does not become permission — the sweep makes no claim', () => {
    const src = stripped('healer/auto-fix.ts');
    // The sweep is an optimisation, never an obligation, so the safe direction on a failed read
    // is to leave the agent as the human last saw it.
    expect(/return \{ ok: false, why: 'its last error could not be read/.test(src)).toBe(true);
  });
});

describe('§3 R30 — the scheduler stops failing runs that are running', () => {
  it('THE RED: `activeRuns` is consulted, in the file that imported it nowhere', () => {
    const src = stripped('scheduler/runner.ts');

    expect(/import \{ activeRuns \} from '\.\.\/agent\/shared-state\.js'/.test(src),
      'the liveness fact every other reaper guards on').toBe(true);
    // BOTH clauses: the 30-minute arm and the 120-minute one, which is the same defect with a
    // longer fuse.
    const guards = src.match(/activeRuns\.has\(/g) ?? [];
    expect(guards.length, 'both stale arms ask whether the run is live').toBe(2);
  });

  it('THE SQL reads the NEWEST evidence of life, not the oldest', () => {
    const src = stripped('scheduler/runner.ts');

    // `MIN` made a row stale if EITHER clock was stale, and one of the two only moves on an
    // explicit tracker-tool write. This is the half that made a talking agent look dead.
    expect(/AND MIN\(\s*COALESCE\(/.test(src), 'the older-of-two reading is the defect').toBe(false);
    expect(/AND MAX\(\s*COALESCE\(/.test(src), 'the newest evidence is what answers the question').toBe(true);
  });

  it('the guard runs BETWEEN the scan and the verdict, so nothing is written first', () => {
    const src = stripped('scheduler/runner.ts');
    const scanAt = src.indexOf('const staleTasksRaw = db.prepare');
    const filterAt = src.indexOf('const staleTasks = staleTasksRaw.filter');
    expect(scanAt).toBeGreaterThan(-1);
    expect(filterAt, 'the filter stands between the query and every use of its rows')
      .toBeGreaterThan(scanAt);
  });

  it('the exit reason states what was MEASURED, not a status it never read', () => {
    const raw = fs.readFileSync(path.join(SRC, 'scheduler/runner.ts'), 'utf8');

    // "assigned agent idle for 30+ minutes" asserted a state the query could not see — the
    // heartbeat lives in another table. What it actually measured is an absence of output plus a
    // live-run check, so that is what it now says.
    expect(raw).toMatch(/produced nothing for \$\{AGENT_IDLE_THRESHOLD_MINUTES\}\+ minutes and is not running now/);
    expect(raw, 'the old claim is gone').not.toMatch(/reason: `assigned agent idle for/);
  });

  it('CONTROL: the reaper still reaps — a dead run is untouched by the guard', () => {
    const src = stripped('scheduler/runner.ts');
    // The guard RETURNS TRUE (keep it in the stale list) when the agent is not running, so a
    // genuinely dead run still reaches `onTaskRunComplete`. A guard that filtered everything
    // would be a deleted reaper.
    expect(/if \(!activeRuns\.has\(t\.assigned_to\)\) return true;/.test(src)).toBe(true);
  });
});
