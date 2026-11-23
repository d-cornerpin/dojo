// SWEEP CORE-2 item 2 (SWEEP-F T1) — THE SERVICE SIDE JOINS THE ENGINE'S SINGLE OWNER.
//
// ── WHAT T0 MEASURED, AND WHAT IT REFUSED TO "FIX" ──
//
// SWEEP-F T1 carries a correction dated 2026-07-27: `injury-recovery.ts` ALREADY DB-backs
// the Healer's provider damping via `healer_state`, and the task is scoped to the state that
// GENUINELY resets on restart. Re-derived at `adfee42` by reading (#14), the whole of this
// module's module-scope state is:
//
//     healerSuppressedUntil   -> healer_state('agent_suppression')   DURABLE   (migration 068)
//     providerPatternAlerted  -> healer_state('provider_alert')      DURABLE   (migration 068)
//     getAttempts/setAttempts -> agents.recovery_attempts            DURABLE   (migration 035)
//     pendingTimers           -> Map<agentId, Timeout>               DIES with the process
//     autoWakeTimers          -> Map<agentId, Timeout>               DIES with the process
//
// The first three are the ones the correction protects and the first clause below PINS them
// durable, so the correction stops being a sentence in a plan and becomes a thing that fails.
//
// ── THE STATE THAT GENUINELY RESETS, AND WHY IT IS NOT THE MAPS ──
//
// A `setTimeout` handle CANNOT be persisted; what has to survive a restart is the SCHEDULE it
// encodes, and that schedule is already in the database — `agents.status IN ('error','paused')`
// is the durable record that somebody is owed a Healer dispatch, and `rehydrateInjuredAgents()`
// (index.ts) exists to re-arm from it. So the honest defect is not "a Map holds a bound"; it is
// that THE REHYDRATE QUERY CANNOT SEE PART OF ITS OWN SUBJECT:
//
//     WHERE status IN ('error','paused') AND status != 'terminated' AND last_error IS NOT NULL
//
// and one line later the loop reads `agent.last_error ?? 'Unknown error (pre-restart)'`. That
// fallback is UNREACHABLE — a dead branch is the code's own statement that the filter is wrong.
//
// A row lands in that blind spot whenever the status write and the `last_error` write come
// apart, and at `adfee42` they were TWO statements at every injury site: `agent/v2/recovery.ts`
// wrote the status through the owner and the diagnostic through a second raw UPDATE inside
// `try { } catch { /* best effort */ }`. A throw on the second one — or a process death between
// them — leaves `error` with a NULL `last_error`, and that agent is then invisible to the very
// sweep that exists to rescue it across a restart. This is T10's own class in a second place:
// THE RECOVERY THAT EXISTS TO SURVIVE A CRASH IS SKIPPED BY EXACTLY THE CRASH IT IS FOR.
//
// Both halves are closed here: the two statements become ONE through the status owner (so the
// hole is shut by construction), and the filter goes (so rows already in that state on a real
// box are picked up on the next boot). The restart clause is DRIVEN — the module is re-imported
// with a fresh registry against the same durable body, which is what a restart is.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-recovery-owner-test', 'dojo.db'),
  };
});

// The Healer's grace-period timer eventually reaches the runtime through a dynamic import.
// Stubbed so the clause under test is the SCHEDULE, not the engine it would wake.
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
// ── WHY THESE THREE ARE STATIC AND `injury-recovery.js` IS NOT ──────────────────────────
//
// t119 root-caused this file's long-running timeout family here. `beforeEach` resets the
// module registry, and a COLD dynamic `await import()` of a multi-module graph taken inside
// a test's measured window can, under a concurrent suite, never settle: vite-node's module
// runner (vitest 3.2.4 / vite 6.4.1) leaves the import pending, so the clause fails at
// whatever its per-test budget happens to be while the product call it was measuring takes
// single-digit milliseconds. MEASURED: 12 duplicate copies of this file run together wedged
// 14 clauses across 5 runs with these imports dynamic, and 0 across 7 runs (884 clauses)
// with them static — the modules below are the ones a clause merely NEEDS, so loading them
// once at file load removes the exposure without touching a subject.
//
// `injury-recovery.js` stays DYNAMIC on purpose: for the restart clauses the fresh registry
// IS the subject — re-importing it against the same durable body is what a restart is — so
// those three sites must keep paying for a real re-instantiation.
import { compileDiagnosticReport } from '../diagnostic.js';
import { runAutoFixes } from '../auto-fix.js';
import { selectHealerApprovalRouting, evaluateScratchZoneAutoApprove } from '../approval-routing.js';
// t265: ONE instance of the recovery module, loaded here at file load, for the single clause
// whose subject is NOT the restart (the negative control below). See that clause for why.
import { rehydrateInjuredAgents as rehydrateHoisted } from '../injury-recovery.js';

const INJURED = 'injured-agent';
const CONTROL = 'control-agent';
const HEALER = 'healer';

function seed(db: Database.Database): void {
  db.prepare(
    "INSERT INTO agents (id, name, status) VALUES (?, 'Injured', 'idle'), (?, 'Control', 'idle'), (?, 'Healer', 'idle')",
  ).run(INJURED, CONTROL, HEALER);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  seed(db);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

/** Put a row in the state a crashed injury leaves behind. `lastError: null` is the blind spot. */
function injure(agentId: string, lastError: string | null): void {
  mockDb.current!.prepare(
    "UPDATE agents SET status = 'error', last_error = ?, last_error_at = datetime('now') WHERE id = ?",
  ).run(lastError, agentId);
}

const attemptsOf = (agentId: string): number =>
  (mockDb.current!.prepare('SELECT recovery_attempts FROM agents WHERE id = ?')
    .get(agentId) as { recovery_attempts: number | null }).recovery_attempts ?? 0;

// ════════════════════════════════════════════════════════════════════════════
describe('SWEEP CORE-2 item 2 — the damping the 2026-07-27 correction protects is DURABLE', () => {
  it('a driven restart keeps the Healer suppression and the provider-pattern dedup', async () => {
    const before = await import('../injury-recovery.js');
    // Drive the suppression through the real path: MAX_RECOVERY_ATTEMPTS is 3, so an injury
    // at attempts=3 writes the backoff window rather than dispatching.
    mockDb.current!.prepare('UPDATE agents SET recovery_attempts = 3 WHERE id = ?').run(INJURED);
    injure(INJURED, 'boom');
    vi.useFakeTimers();
    before.onAgentInjured(INJURED, 'boom');
    vi.useRealTimers();

    const suppression = mockDb.current!.prepare(
      "SELECT at_ms FROM healer_state WHERE scope = 'agent_suppression' AND key = ?",
    ).get(INJURED) as { at_ms: number } | undefined;
    expect(suppression?.at_ms, 'the suppression must be in the DB, not in a Map').toBeGreaterThan(0);

    // THE RESTART: a brand-new module registry against the same durable body. A Map could
    // not survive this; `healer_state` does.
    vi.resetModules();
    const after = await import('../injury-recovery.js');
    expect(after, 'the module really is a new one').not.toBe(before);
    const stillThere = mockDb.current!.prepare(
      "SELECT at_ms FROM healer_state WHERE scope = 'agent_suppression' AND key = ?",
    ).get(INJURED) as { at_ms: number } | undefined;
    expect(stillThere?.at_ms).toBe(suppression?.at_ms);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('SWEEP CORE-2 item 2 — the pending dispatch survives a restart THROUGH THE DB', () => {
  /** Rehydrate in a fresh module registry, then let the grace period elapse. The observable
   *  is `agents.recovery_attempts`, which the dispatch timer bumps before it notifies. */
  async function restartAndDrain(): Promise<void> {
    vi.resetModules();
    const fresh = await import('../injury-recovery.js');
    vi.useFakeTimers();
    fresh.rehydrateInjuredAgents();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  }

  it('POSITIVE CONTROL: an injured agent WITH a last_error is re-armed (the harness works)', async () => {
    injure(INJURED, 'provider exploded');
    await restartAndDrain();
    expect(attemptsOf(INJURED)).toBe(1);
  });

  it('THE DEFECT: an injured agent with a NULL last_error is re-armed too', async () => {
    // The row a crash between the status write and the diagnostic write leaves behind, and
    // the row the unreachable `?? 'Unknown error (pre-restart)'` fallback was written for.
    injure(INJURED, null);
    await restartAndDrain();
    expect(
      attemptsOf(INJURED),
      'an agent stuck in error with no diagnostic is exactly the one that cannot rescue itself',
    ).toBe(1);
  });

  // t265 — WHY THIS CLAUSE NO LONGER RE-IMPORTS THE MODULE.
  //
  // This clause timed out at 30s in full-suite runs under heavy load (twice running) and passed
  // 13/13 alone. Nothing in it waits on the clock: the timers are fake, the 60s is virtual, the
  // body is two UPDATE/SELECTs. The only real-time cost it carried was `restartAndDrain`'s COLD
  // `await import('../injury-recovery.js')` after `vi.resetModules()` — the exact exposure t119
  // root-caused (a cold dynamic import of a multi-module graph inside the measured window can be
  // left pending by vite-node's module runner under a concurrent suite). t119 kept that import
  // dynamic because for the RESTART clauses a fresh registry is the subject. Here it is not: the
  // question this clause asks is "does the sweep's SELECTION leave a healthy agent alone", which
  // is a property of the rehydrate query against the DB, not of module-registry mechanics. So it
  // uses the instance loaded at file load. That instance is untouched by any other clause (every
  // other clause imports its own fresh one), so its timer registries start empty.
  //
  // It is also made a real control. It used to assert only `CONTROL === 0` after injuring the
  // other agent — which a rehydrate that did NOTHING satisfies equally well. It now asserts the
  // injured agent WAS re-armed in the same run, so `CONTROL === 0` can only mean "the sweep ran,
  // armed the injured one, and left the healthy one alone".
  it('NEGATIVE CONTROL: a healthy agent is not dragged into recovery', async () => {
    injure(INJURED, null);
    vi.useFakeTimers();
    try {
      rehydrateHoisted();
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(attemptsOf(INJURED), 'the sweep ran and armed the injured agent (control is live)').toBe(1);
    expect(attemptsOf(CONTROL), 'the healthy agent was not dragged in').toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('SWEEP CORE-2 item 2 — the shadow budget ledger is gone', () => {

  // Back on the 30s default. The elevated budget this clause carried was reading a wedged
  // dynamic import as slowness: the window measured a cold module-graph instantiation, not
  // the collector. With the import hoisted (see the note at the top of this file) the body
  // is one INSERT and one synchronous call — 2ms of work — so a 30s failure here is now a
  // real hang rather than a load artifact.
  it('the health report reads the REAL budget owner — the capability is preserved, not deleted', () => {
    // #15: this collector has live readers (the Healer's own cycle prompt, the stale-proposal
    // sweep's code set, `GET /healer/diagnostics`, the Settings counts). What dies is the
    // duplicate ACCOUNTING, not the answer; the answer now comes from the one owner.
    mockDb.current!.prepare(
      "INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', 500.0, 'daily')",
    ).run();
    const report = compileDiagnosticReport();
    const budgetItem = report.items.find((i) => i.code === 'BUDGET_OK' || i.code === 'BUDGET_HIGH');
    expect(budgetItem, 'the budget line still reaches the health report').toBeTruthy();
    expect(budgetItem!.title).toContain('500');
    expect(budgetItem!.title).not.toContain('$25');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE TEMPLATE IS PRESERVED. SWEEP-F T1: "Healer's deterministic fixes + approval-routing
// PRESERVED verbatim (the template)". Asserted by DRIVING them, because a diff can be read
// clean while the behaviour has moved — the three agent-status fixes are the ones this task
// re-points, so they are driven end to end, cooldown included.
describe('SWEEP CORE-2 item 2 — the Healer\'s deterministic tier is unchanged behaviour', () => {
  const item = (code: string, agentId: string) => ({
    severity: 'critical' as const, code, title: 't', detail: 'd', agentId, agentName: 'Injured',
  });
  const statusOf = (id: string): string =>
    (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
  const agedTo = (id: string, status: string, minutes: number): void => {
    mockDb.current!.prepare(
      `UPDATE agents SET status = ?, updated_at = datetime('now', '-${minutes} minutes') WHERE id = ?`,
    ).run(status, id);
  };

  it('STUCK_AGENT unfreezes immediately — no cooldown, that is the point of it', () => {
    agedTo(INJURED, 'working', 20);
    const res = runAutoFixes('diag-stuck', [item('STUCK_AGENT', INJURED)]);
    expect(res.fixCount).toBe(1);
    expect(statusOf(INJURED)).toBe('idle');
  });

  it('AGENT_ERROR keeps its 30-minute cooldown, both directions; AGENT_PAUSED is never restarted', () => {
    agedTo(INJURED, 'error', 5);
    expect(runAutoFixes('err-early', [item('AGENT_ERROR', INJURED)]).fixCount).toBe(0);
    expect(statusOf(INJURED)).toBe('error');
    agedTo(INJURED, 'error', 45);
    expect(runAutoFixes('err-late', [item('AGENT_ERROR', INJURED)]).fixCount).toBe(1);
    expect(statusOf(INJURED)).toBe('idle');

    agedTo(INJURED, 'paused', 45);
    expect(runAutoFixes('paused-late', [item('AGENT_PAUSED', INJURED)]).fixCount).toBe(0);
    expect(statusOf(INJURED)).toBe('paused');
  });

  it('every applied fix still leaves its healer_actions row — the Vitals panel reads it', () => {
    agedTo(INJURED, 'working', 20);
    runAutoFixes('diag-audit', [item('STUCK_AGENT', INJURED)]);
    const row = mockDb.current!.prepare(
      "SELECT category, result, agent_id FROM healer_actions WHERE diagnostic_id = 'diag-audit'",
    ).get() as { category: string; result: string; agent_id: string } | undefined;
    expect(row).toEqual({ category: 'STUCK_AGENT', result: 'success', agent_id: INJURED });
  });

  it('approval routing still fails closed on all three arms', () => {
    // The ONE loud lane, and only when all three facts hold.
    expect(selectHealerApprovalRouting({ engineSeverity: 'critical', presence: 'away', imessageEnabled: true }))
      .toEqual({ urgency: 'urgent', surface: 'imessage' });
    expect(selectHealerApprovalRouting({ engineSeverity: 'critical', presence: 'in_dojo', imessageEnabled: true }))
      .toEqual({ urgency: 'routine', surface: 'vitals' });
    expect(selectHealerApprovalRouting({ engineSeverity: 'warning', presence: 'away', imessageEnabled: true }))
      .toEqual({ urgency: 'routine', surface: 'vitals' });
    // The scratch zone stays narrow: a metacharacter, a non-rm head and an out-of-zone
    // target each take the hold path.
    expect(evaluateScratchZoneAutoApprove('exec', { command: 'rm -rf /tmp/x && cat /etc/passwd' })).toBeNull();
    expect(evaluateScratchZoneAutoApprove('exec', { command: 'mv /tmp/a /tmp/b' })).toBeNull();
    // The out-of-zone target must be out-of-zone BY CONSTRUCTION, never derived
    // from process.cwd(): the zone includes /tmp (resolved /private/tmp), so a
    // checkout living under the scratchpad put cwd IN-zone and the product's
    // correct auto-approve read as this clause's failure (ritual v3.2.0 round-1
    // triage, 2026-09-26).
    expect(evaluateScratchZoneAutoApprove('exec', { command: 'rm -rf /opt/dojo-definitely-not-scratch/nope' })).toBeNull();
    expect(evaluateScratchZoneAutoApprove('file_write', { command: 'rm -rf /tmp/x' })).toBeNull();
  });
});
