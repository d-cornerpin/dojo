// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 3 / SWEEP-F T2 — THE SCHEDULER OWNS ITS CLOCK.
//
// Four properties, each one of T2's own clauses, each with a planted-fault proof recorded in
// the task report:
//
//   A1  THE INTERVAL IS THE SCHEDULER'S. Before this task the scheduler's 30-second timer was
//       installed by `tracker/pm-agent.ts:startPokeLoop` — so the platform's clock for
//       "when does a schedule fire" was a side effect of the PROJECT MANAGER starting up, and
//       a box with `isPMEnabled() === false` fired no schedules at all. The timer is the
//       scheduler's now, and `stopScheduler()` is its own.
//
//   A2  A TICK MAY NOT RE-ENTER ITSELF. `checkScheduledTasks` is async and awaits the DB, the
//       occurrence claim and (through `onTaskRunComplete`) the agent runtime; a tick that
//       outruns the 30-second period used to have a second tick walking the same due set.
//
//   A3  ONE WRITER FOR `work.next_run_at`. The census is PERMANENT, not a one-off count: the
//       column may only be SET by `work/next-run.ts`, and `patchWork`'s attribute union no
//       longer names it, so a second writer does not compile.
//
//   A4  ONE COMPUTER FOR THE NEXT RUN. The TB10K-era claim, re-asserted at this HEAD rather
//       than inherited (#14): `calculateNextRun` is the only recurrence walker in the tree,
//       and every value written to `next_run_at` that does NOT come from it is named here
//       with its reason.
//
//   A5  THE NON-SCHEDULING SWEEPS ARE THE REAPER'S. Phase 2's choke point owns every periodic
//       obligation sweep; the scheduler tick keeps only the work of deciding which occurrence
//       fires now and advancing the cadence.
//
//   A6  THE SKIPPED-REMINDER HEADS-UP IS OFF THE DEAD CHANNEL. `role='system'` rows are
//       stripped by the model-context builder (the RC-19 doctrine at the top of
//       `scheduler/runner.ts`), so the owner's "I skipped your reminder" note was written
//       where no model could ever read it and no agent could ever relay it.
//
// The walk reads source with `fs.readFileSync`, not grep — the idiom and the reason are
// `work/__tests__/single-writer-conformance.test.ts`'s (NUL bytes; ugrep).
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const productionFiles = (): string[] => walk(SRC).map(rel).sort();
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping line count, so prose describing a write is never counted as one. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

// ════════════════════════════════════════════════════════════════════════════════
// A1 — THE INTERVAL IS THE SCHEDULER'S
// ════════════════════════════════════════════════════════════════════════════════

describe('A1 the scheduler owns its own interval', () => {
  it('the PM no longer declares, starts or stops the scheduler clock', () => {
    const pm = stripComments(read('tracker/pm-agent.ts'));
    expect(pm).not.toMatch(/SCHEDULER_INTERVAL_MS/);
    expect(pm).not.toMatch(/schedulerTimer/);
    // The PM may still *react* to schedules; what it may not do is start their clock.
    expect(pm).not.toMatch(/checkScheduledTasks/);
  });

  it('`scheduler/clock.ts` declares the period, and it is the 30s value CARRIED from the PM', async () => {
    const clock = await import('../clock.js');
    expect(clock.SCHEDULER_INTERVAL_MS).toBe(30_000);
    const src = read('scheduler/clock.ts');
    // The period is carried, never re-chosen: the file must say where it came from.
    expect(src).toMatch(/pm-agent\.ts/);
  });

  it('the boot path starts the scheduler independently of whether the PM agent is enabled', () => {
    const boot = stripComments(read('index.ts'));
    expect(boot).toMatch(/startScheduler\(\)/);
    // The old coupling: the ONLY start was inside the `isPMEnabled()` block.
    const pmBlock = boot.slice(boot.indexOf('isPMEnabled()'), boot.indexOf('isPMEnabled()') + 600);
    expect(pmBlock).not.toMatch(/startScheduler/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A2 — RE-ENTRANCY
// ════════════════════════════════════════════════════════════════════════════════

describe('A2 a scheduler tick cannot re-enter itself', () => {
  it('an overlapping tick is SKIPPED, and the body runs exactly once', async () => {
    const { runSchedulerTick, schedulerClockState } = await import('../clock.js');
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowBody = async (): Promise<void> => { entered += 1; await gate; };

    const first = runSchedulerTick(slowBody);
    // The second call happens while the first is still awaiting.
    const second = await runSchedulerTick(slowBody);
    expect(second).toBe('skipped');
    expect(entered).toBe(1);
    expect(schedulerClockState().overlapsSkipped).toBeGreaterThan(0);

    release();
    expect(await first).toBe('ran');
    // The guard RELEASES: the next tick runs.
    expect(await runSchedulerTick(async () => { entered += 1; })).toBe('ran');
    expect(entered).toBe(2);
  });

  it('the guard releases even when the tick throws — a failed tick may not wedge the clock', async () => {
    const { runSchedulerTick } = await import('../clock.js');
    await expect(runSchedulerTick(async () => { throw new Error('boom'); })).resolves.toBe('ran');
    let ran = false;
    expect(await runSchedulerTick(async () => { ran = true; })).toBe('ran');
    expect(ran).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A3 — ONE WRITER FOR `work.next_run_at` (PERMANENT CENSUS)
// ════════════════════════════════════════════════════════════════════════════════

/** The module that owns the schedule's fire time. */
const NEXT_RUN_WRITER = 'work/next-run.ts';

/**
 * The ONE declared exception, and why it is not a second writer: `claimOccurrence`'s INSERT
 * stamps the OCCURRENCE row (`kind='occurrence'`) with the instant that run was FOR. It is a
 * different fact on a different row-kind, written once at row creation and never updated —
 * `work/__tests__/occurrence-runs.test.ts` reads it back as `scheduledFor`. Allowlisted BY
 * NAME so that a genuinely new writer still fails this census.
 */
const OCCURRENCE_STAMP_INSERT = 'work/occurrences.ts';

describe('A3 `work.next_run_at` has one writer', () => {
  it('no production module outside the writer SETs next_run_at', () => {
    const offenders: string[] = [];
    for (const f of productionFiles()) {
      if (f === NEXT_RUN_WRITER) continue;
      const body = stripComments(read(f));
      // Any SQL assignment of the column: `next_run_at = ?`, `next_run_at = NULL`, ...
      if (/next_run_at\s*=/.test(body)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the only production INSERT naming the column is the occurrence stamp, and it is declared', () => {
    const inserting: string[] = [];
    for (const f of productionFiles()) {
      if (f === NEXT_RUN_WRITER) continue;
      const body = stripComments(read(f));
      if (/INTO\s+work\b[\s\S]{0,900}?next_run_at/i.test(body)) inserting.push(f);
    }
    expect(inserting).toEqual([OCCURRENCE_STAMP_INSERT]);
  });

  it('the generic attribute patcher can no longer name the column — a second writer does not compile', () => {
    const store = read('work/tracker-store.ts');
    const union = store.slice(store.indexOf('export type TrackerAttr'), store.indexOf('export type WorkPatch'));
    expect(union).not.toMatch(/'next_run_at'/);
  });

  it('every fire-time write carries a REASON — the column cannot move anonymously', async () => {
    const writer = read(NEXT_RUN_WRITER);
    // The exported door takes a reason and the module says so.
    expect(writer).toMatch(/reason/);
    const mod = await import('../../work/next-run.js');
    expect(typeof mod.setNextRun).toBe('function');
    expect(typeof mod.clearLiveSchedule).toBe('function');
    expect(typeof mod.advanceScheduleOnClaim).toBe('function');
    expect(typeof mod.restoreScheduleOnRelease).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A4 — ONE COMPUTER FOR THE NEXT RUN (the TB10K-era claim, re-asserted)
// ════════════════════════════════════════════════════════════════════════════════

describe('A4 there is exactly one next-run computer', () => {
  it('`calculateNextRun` is declared once, in the engine, and nothing else walks a recurrence', () => {
    const declarations = productionFiles().filter((f) =>
      /export\s+function\s+calculateNextRun\b/.test(stripComments(read(f))));
    expect(declarations).toEqual(['scheduler/engine.ts']);
  });

  it('the callers are enumerated — a new one is a change this census makes visible', () => {
    const callers = productionFiles().filter((f) =>
      f !== 'scheduler/engine.ts' && /\bcalculateNextRun\s*\(/.test(stripComments(read(f))));
    expect(callers.sort()).toEqual([
      'gateway/routes/tracker.ts',
      'scheduler/runner.ts',
      'tracker/tools.ts',
    ]);
  });

  it('the two values NOT derived from the computer are named, with their reasons', () => {
    const writer = read(NEXT_RUN_WRITER);
    // Both are documented in the writer module, so the exception list lives beside the column.
    expect(writer).toMatch(/dependency defer/i);
    expect(writer).toMatch(/run_now|catch-up/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A5 — THE NON-SCHEDULING SWEEPS BELONG TO THE REAPER
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Re-derived at HEAD (#14). The plan wrote "the five non-scheduling sweeps"; at this commit
 * it is SIX, because SWEEP CORE-1 CT2 added the delivered-run close after the plan was
 * written and it rides the tick for exactly the reason the other five did — "that is where
 * run lifecycle already lives". The two 12-hour sweeps the plan also counted left at
 * PHASE-2 T9 and are already the reaper's.
 *
 * UX-REPAIR ROUND 4 T19 (D6) renamed that sixth sweep `closeRunsThatDelivered`: it no longer
 * requires a steer marker, because the deliverable authority's own evidence predicate is
 * stronger than the agent's assertion it replaced. Same sweep, same owner, same cadence —
 * only the name and the row set moved, and this list follows its subject.
 *
 * What STAYS on the scheduler tick, and why: the due scan itself, and
 * `autoResolveStaleMissedRunPauses` — that one advances the cadence past missed slots, which
 * IS scheduling; it is not an obligation cliff wearing a schedule's clothes.
 */
const MOVED_TO_THE_REAPER = [
  'cleanupOrphanedRuns',
  'cleanupStaleRuns',
  'pruneTerminalTasks',
  'resumeExpiredPauses',
  'sweepUnvalidatedTasksForUserEscalation',
  'closeRunsThatDelivered',
];

describe('A5 the scheduler tick keeps only scheduling', () => {
  it('`checkScheduledTasks` no longer calls any of the six', () => {
    const runner = stripComments(read('scheduler/runner.ts'));
    const start = runner.indexOf('export async function checkScheduledTasks');
    expect(start).toBeGreaterThan(-1);
    const body = runner.slice(start, runner.indexOf('\n}\n', start));
    for (const fn of MOVED_TO_THE_REAPER) {
      expect(body, `checkScheduledTasks still calls ${fn}`).not.toMatch(new RegExp(`\\b${fn}\\s*\\(`));
    }
  });

  it('the reaper declares them, each with the clock its cadence was carried from', async () => {
    const { REAPER_KINDS, REAPER_BASE_TICK_MS } = await import('../../work/work-reaper.js');
    const ids = REAPER_KINDS.map((k) => k.id);
    for (const id of ['orphaned-and-stale-runs', 'expired-pauses', 'validation-escalation',
      'steered-run-delivery-close', 'terminal-task-prune']) {
      expect(ids, `reaper is missing kind ${id}`).toContain(id);
    }
    // Every kind's period is an exact multiple of the base tick — the reaper's own law.
    for (const k of REAPER_KINDS) {
      expect(k.everyMs % REAPER_BASE_TICK_MS, `${k.id} period is not a multiple of the base tick`).toBe(0);
      expect(k.cadenceFrom.length, `${k.id} has no cadence provenance`).toBeGreaterThan(20);
    }
  });

  it('the hourly prune keeps its OWN period — the cadence is carried, not re-chosen', async () => {
    const { REAPER_KINDS } = await import('../../work/work-reaper.js');
    const prune = REAPER_KINDS.find((k) => k.id === 'terminal-task-prune');
    expect(prune?.everyMs).toBe(3_600_000);
  });

  it('the validation escalation is declared as a kind that WAKES — the storm law can see it', async () => {
    const { REAPER_KINDS } = await import('../../work/work-reaper.js');
    expect(REAPER_KINDS.find((k) => k.id === 'validation-escalation')?.wakes).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// A6 — THE SKIPPED-REMINDER HEADS-UP IS OFF THE DEAD CHANNEL
// ════════════════════════════════════════════════════════════════════════════════

describe('A6 postSkippedReminderHeadsUp rides the model-visible lane', () => {
  it('it no longer writes a bare role=system chat row', () => {
    const runner = stripComments(read('scheduler/runner.ts'));
    const start = runner.indexOf('export function postSkippedReminderHeadsUp');
    expect(start).toBeGreaterThan(-1);
    const body = runner.slice(start, runner.indexOf('\n}\n', start));
    expect(body).not.toMatch(/insertMessage\s*\(/);
    expect(body).not.toMatch(/role:\s*'system'/);
    expect(body).toMatch(/postAgentNotice\s*\(/);
  });

  it('the note still speaks to the owner in the platform\'s own heads-up shape', () => {
    const runner = read('scheduler/runner.ts');
    const start = runner.indexOf('export function postSkippedReminderHeadsUp');
    const body = runner.slice(start, runner.indexOf('\n}\n', start));
    expect(body).toMatch(/OWNER_ALERT_HEADS_UP_PREFIX/);
    // ...and it is delivered as a SUBSYSTEM, not as an agent that does not exist.
    expect(body).toMatch(/selfIntro:\s*false/);
  });
});
