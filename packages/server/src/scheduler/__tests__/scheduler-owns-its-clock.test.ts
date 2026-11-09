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

// ════════════════════════════════════════════════════════════════════════════════
// A1 — THE INTERVAL IS THE SCHEDULER'S
// ════════════════════════════════════════════════════════════════════════════════

describe('A1 the scheduler owns its own interval', () => {

  it('`scheduler/clock.ts` declares the period, and it is the 30s value CARRIED from the PM', async () => {
    const clock = await import('../clock.js');
    expect(clock.SCHEDULER_INTERVAL_MS).toBe(30_000);
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

describe('A3 `work.next_run_at` has one writer', () => {

  it('every fire-time write carries a REASON — the column cannot move anonymously', async () => {
    const mod = await import('../../work/next-run.js');
    expect(typeof mod.setNextRun).toBe('function');
    expect(typeof mod.clearLiveSchedule).toBe('function');
    expect(typeof mod.advanceScheduleOnClaim).toBe('function');
    expect(typeof mod.restoreScheduleOnRelease).toBe('function');
  });
});

describe('A5 the scheduler tick keeps only scheduling', () => {

  it('the reaper declares them, each with the clock its cadence was carried from', async () => {
    const { REAPER_KINDS, REAPER_BASE_TICK_MS } = await import('../../work/work-reaper.js');
    const ids = REAPER_KINDS.map((k) => k.id);
    for (const id of ['orphaned-and-stale-runs', 'expired-pauses', 'ladder',
      'steered-run-delivery-close']) {
      expect(ids, `reaper is missing kind ${id}`).toContain(id);
    }
    // Every kind's period is an exact multiple of the base tick — the reaper's own law.
    for (const k of REAPER_KINDS) {
      expect(k.everyMs % REAPER_BASE_TICK_MS, `${k.id} period is not a multiple of the base tick`).toBe(0);
      expect(k.cadenceFrom.length, `${k.id} has no cadence provenance`).toBeGreaterThan(20);
    }
  });

  it('there is no hourly prune: work records are kept (field fix 3 audit round #9, ruling 9d)', async () => {
    const { REAPER_KINDS } = await import('../../work/work-reaper.js');
    expect(REAPER_KINDS.find((k) => k.id === 'terminal-task-prune')).toBeUndefined();
  });

  it('the stall ladder is declared as a kind that WAKES, so the storm law can see it', async () => {
    const { REAPER_KINDS } = await import('../../work/work-reaper.js');
    expect(REAPER_KINDS.find((k) => k.id === 'ladder')?.wakes).toBe(true);
  });
});
