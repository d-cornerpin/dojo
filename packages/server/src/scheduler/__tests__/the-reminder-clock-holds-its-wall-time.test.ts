// UX-REPAIR ROUND 2 / T13 — THE REMINDER CLOCK'S DST TRUTH IS PINNED, AND THE DECLARED
// TIMEZONE STOPS BEING DROPPED.
//
// ── WHY THIS FILE EXISTS (investigation-round2.md R2, measured by executing the shipped
//    engine in two process timezones) ──
// The owner asked what time a monthly 9 AM reminder fires in December, after the Nov 1 PST
// switch. The engine's answer is RIGHT — 9:00 AM local, because `calculateNextRun` walks WALL
// COMPONENTS (instant → wall → +1 month → wall → instant) and `wallToInstant` re-derives the
// UTC offset AT THE TARGET DATE. But nothing in the tree said so:
//
//   * `scheduler/engine.ts` cited a "D21 verification harness" for its DST policy;
//     `grep -rn "D21" --include=*.ts --include=*.md` returns only prose. The harness is not in
//     the tree and there is no evidence it ever was.
//   * NO test exercised `repeat_unit:'months'` or `'years'` at all.
//   * NO test crossed a DST boundary: grep for `2026-11-01`, `2026-03-08`, `2025-11-02` across
//     every `*.test.ts` returned 0 hits. The closest, `tracker/__tests__/anchor-time-seam.ts`,
//     loops two zones with `repeat_unit:'days'` and August dates — i.e. never the transition.
//
// A correctness claim whose only proof is a comment naming a file that does not exist is an
// unpinned claim. These tests are the pin: they assert TODAY'S behaviour, so a future refactor
// that reaches for `setUTCMonth` on an instant fails here instead of on the owner's calendar.
//
// The second half is the defect: the per-task zone was DECLARED and DEAD. `work.tz` existed
// since migration 135, `resolveLocalWallClock` accepted and correctly defaulted a
// caller-supplied `local_timezone`, and the resolved zone was DISCARDED at the write. Measured:
// the same monthly reminder fires 9:00 AM local on this box and 8:00 AM if the process runs
// `TZ=UTC`, for four months of every year.

import { describe, it, expect } from 'vitest';
import { calculateNextRun, type ScheduledTask } from '../engine.js';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

/** What a stored instant reads as on the wall, in a named zone. The assertion vocabulary: the
 *  whole property under test is "the WALL time is held", so the test speaks wall times. */
function wallIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't1', scheduled_start: null, repeat_interval: 1, repeat_unit: 'months',
    repeat_end_type: 'never', repeat_end_value: null, run_count: 1, is_paused: 0,
    last_run_at: null, next_run_at: null, schedule_status: 'waiting', ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE WALL CLOCK IS HELD ACROSS BOTH TRANSITIONS, ON EVERY CALENDAR UNIT.
//
// A fall-back transition moves the offset −7 → −8; a spring-forward moves it −8 → −7. Every
// case below steps a schedule ACROSS one of them and asserts the LOCAL HOUR is unchanged —
// which is what "9 AM every month" means to a person.
// ════════════════════════════════════════════════════════════════════════════════════════

// ── WHY THE DATES ARE 2035 AND NOT 2026 ──
// The walk advances until it lands strictly after `max(now, last_run_at)` (`engine.ts:322-328`),
// so a fixture anchored in the PAST walks all the way to the present and the assertion becomes
// a statement about the day the suite happens to run. Every base below is therefore a stable
// future instant, and each pair straddles a real US transition: 2035 fall-back is Nov 4, 2035
// spring-forward is Mar 11, 2036 fall-back is Nov 2. The owner's own 2026 question is answered
// in the investigation by executing this same engine; what is pinned here is the MECHANISM that
// produced that answer.
describe('T13: a calendar-unit schedule keeps its wall-clock time across a DST transition', () => {
  it('MONTHLY across fall-back: Nov 1 9:00 AM PDT → Dec 1 9:00 AM PST — the owner\'s shape', () => {
    const next = calculateNextRun(task({
      scheduled_start: '2035-11-01T16:00:00.000Z',   // 9:00 AM PDT
      anchor_time: '2035-11-01T16:00:00.000Z',
      last_run_at: '2035-11-01T16:00:00.000Z',
    }), LA);
    expect(next).not.toBeNull();
    expect(wallIn(next!, LA)).toBe('2035-12-01, 09:00');
    // …and the stored instant really did move an hour, which is the whole point.
    expect(new Date(next!).toISOString()).toBe('2035-12-01T17:00:00.000Z');
  });

  it('MONTHLY three months running, straight through the transition, 9:00 AM every time', () => {
    let iso = '2035-09-01T16:00:00.000Z';
    for (let run = 1; run <= 3; run++) {
      const next = calculateNextRun(task({
        scheduled_start: iso, anchor_time: iso, last_run_at: iso, run_count: run,
      }), LA);
      expect(next).not.toBeNull();
      expect(wallIn(next!, LA).endsWith('09:00')).toBe(true);
      iso = new Date(next!).toISOString();
    }
    expect(wallIn(iso, LA)).toBe('2035-12-01, 09:00');
  });

  it('MONTHLY across spring-forward: Feb 11 → Mar 11, 9:00 AM both times', () => {
    const next = calculateNextRun(task({
      scheduled_start: '2035-02-11T17:00:00.000Z',   // 9:00 AM PST
      anchor_time: '2035-02-11T17:00:00.000Z',
      last_run_at: '2035-02-11T17:00:00.000Z',
    }), LA);
    expect(wallIn(next!, LA)).toBe('2035-03-11, 09:00');
    expect(new Date(next!).toISOString()).toBe('2035-03-11T16:00:00.000Z');
  });

  it('WEEKLY across fall-back: Nov 1 → Nov 8, 9:00 AM both times', () => {
    const next = calculateNextRun(task({
      repeat_unit: 'weeks',
      scheduled_start: '2035-11-01T16:00:00.000Z',
      anchor_time: '2035-11-01T16:00:00.000Z',
      last_run_at: '2035-11-01T16:00:00.000Z',
    }), LA);
    expect(wallIn(next!, LA)).toBe('2035-11-08, 09:00');
    expect(new Date(next!).toISOString()).toBe('2035-11-08T17:00:00.000Z');
  });

  it('WEEKLY across spring-forward: Mar 4 → Mar 11, 9:00 AM both times', () => {
    const next = calculateNextRun(task({
      repeat_unit: 'weeks',
      scheduled_start: '2035-03-04T17:00:00.000Z',
      anchor_time: '2035-03-04T17:00:00.000Z',
      last_run_at: '2035-03-04T17:00:00.000Z',
    }), LA);
    expect(wallIn(next!, LA)).toBe('2035-03-11, 09:00');
  });

  it('YEARLY across a whole DST cycle: Nov 1 2035 → Nov 1 2036, 9:00 AM both times', () => {
    const next = calculateNextRun(task({
      repeat_unit: 'years',
      scheduled_start: '2035-11-01T16:00:00.000Z',
      anchor_time: '2035-11-01T16:00:00.000Z',
      last_run_at: '2035-11-01T16:00:00.000Z',
    }), LA);
    expect(wallIn(next!, LA)).toBe('2036-11-01, 09:00');
  });

  it('DAILY across fall-back keeps the wall time (that day is 25 real hours long)', () => {
    const next = calculateNextRun(task({
      repeat_unit: 'days',
      scheduled_start: '2035-11-03T16:00:00.000Z',
      anchor_time: '2035-11-03T16:00:00.000Z',
      last_run_at: '2035-11-03T16:00:00.000Z',
    }), LA);
    expect(wallIn(next!, LA)).toBe('2035-11-04, 09:00');
    expect(new Date(next!).toISOString()).toBe('2035-11-04T17:00:00.000Z');
  });

  it('CONTROL — a TIME-based unit deliberately does NOT hold wall time: "every 24 hours" is 24 REAL hours', () => {
    // `engine.ts`'s own recorded policy: minutes/hours step the absolute instant, so across
    // fall-back the local hour moves by one. Pinned so the two policies cannot be conflated.
    const next = calculateNextRun(task({
      repeat_unit: 'hours', repeat_interval: 24,
      scheduled_start: '2035-11-03T16:00:00.000Z',
      anchor_time: '2035-11-03T16:00:00.000Z',
      last_run_at: '2035-11-03T16:00:00.000Z',
    }), LA);
    expect(wallIn(next!, LA)).toBe('2035-11-04, 08:00');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE DECLARED ZONE IS HONOURED. `work.tz` was a column nothing could write and nothing
//     read; `resolveLocalWallClock` resolved the caller's zone and threw it away.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T13: the schedule row\'s own timezone decides its advance', () => {
  const monthly = {
    scheduled_start: '2035-11-01T16:00:00.000Z',
    anchor_time: '2035-11-01T16:00:00.000Z',
    last_run_at: '2035-11-01T16:00:00.000Z',
  };

  it('a row carrying tz advances in THAT zone, whatever the process timezone is', () => {
    const inLA = calculateNextRun(task({ ...monthly, tz: LA }));
    expect(new Date(inLA!).toISOString()).toBe('2035-12-01T17:00:00.000Z');   // 9 AM PST
    const inTokyo = calculateNextRun(task({ ...monthly, tz: TOKYO }));
    // 16:00Z is 01:00 next-day in Tokyo, which has no DST: +1 month, same instant of day.
    expect(wallIn(inTokyo!, TOKYO)).toBe('2035-12-02, 01:00');
  });

  it('CONTROL: a row with NO tz behaves exactly as today — the box timezone', () => {
    const withoutTz = calculateNextRun(task(monthly));
    const asBox = calculateNextRun(task(monthly), Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(withoutTz).toBe(asBox);
  });

  it('CONTROL: an EXPLICIT argument still wins over the row\'s own zone', () => {
    // The one caller that wants "when would this fire in Tokyo?" keeps that answer.
    const explicit = calculateNextRun(task({ ...monthly, tz: LA }), TOKYO);
    expect(wallIn(explicit!, TOKYO)).toBe('2035-12-02, 01:00');
  });

  it('CONTROL: a null tz is not an empty string — it falls back, it does not throw', () => {
    expect(() => calculateNextRun(task({ ...monthly, tz: null }))).not.toThrow();
    expect(calculateNextRun(task({ ...monthly, tz: null }))).toBe(calculateNextRun(task(monthly)));
  });
});
