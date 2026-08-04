// ════════════════════════════════════════════════════════════════════════════
// THE COMPENSATED-ANCHOR SCAN — PHASE-6 T0A Step 4.
//
// Two directions, and the second is the one that matters most: the scan must
// FIND a seeded compensation, and it must STAND DOWN on a body that carries
// none. A detector that fires on everything is not a detector, and one that
// cannot fire is a comment. Every clause below reports its own denominator.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  scanForCompensatedAnchors, readingsOf, describeSuspects,
  COMPENSATION_WINDOW_OPENED_AT, type ScheduledRow,
} from '../anchor-compensation.js';

const ZONE = 'America/Los_Angeles';           // UTC-7 in August
const WINDOW_OPEN = Date.parse(COMPENSATION_WINDOW_OPENED_AT);
const WINDOW_CLOSE = Date.parse('2026-08-05T00:00:00Z');
const NOW = Date.parse('2026-08-04T12:00:00Z');
const FUTURE = Date.parse('2026-08-06T13:00:00Z');

function row(over: Partial<ScheduledRow> & { id: string }): ScheduledRow {
  return {
    title: 'daily brief',
    anchor_local: '2026-08-05T13:00:00.000Z',
    scheduled_start: Date.parse('2026-08-05T13:00:00Z'),
    next_run_at: FUTURE,
    updated_at: Date.parse('2026-08-04T02:00:00Z'),   // inside the window
    state: 'open',
    is_paused: 0,
    repeat_interval: 1,
    repeat_unit: 'days',
    ...over,
  };
}

const scan = (rows: ScheduledRow[], timeZone = ZONE) => scanForCompensatedAnchors({
  rows, timeZone, now: NOW, windowOpenedAtMs: WINDOW_OPEN, windowClosedAtMs: WINDOW_CLOSE,
});

describe('the two readings of one stored anchor', () => {
  it('a UTC-labelled 06:00 reads as 13:00Z if its digits were meant as Los Angeles wall clock', () => {
    const r = readingsOf('2026-08-05T06:00:00Z', ZONE)!;
    expect(new Date(r.stored).toISOString()).toBe('2026-08-05T06:00:00.000Z');
    expect(new Date(r.intended).toISOString()).toBe('2026-08-05T13:00:00.000Z');
    expect((r.intended - r.stored) / 3_600_000).toBe(7);
  });

  it('on a UTC box the transform is the identity — nothing to undo', () => {
    const r = readingsOf('2026-08-05T06:00:00Z', 'UTC')!;
    expect(r.intended).toBe(r.stored);
  });

  it('an unreadable anchor is a null, never a guess', () => {
    expect(readingsOf('not a time', ZONE)).toBeNull();
  });
});

describe('the scan finds a seeded compensation', () => {
  it('flags an in-window live recurring row and states BOTH readings and the one-call fix', () => {
    const result = scan([row({ id: 'compensated-1', anchor_local: '2026-08-05T06:00:00.000Z' })]);
    expect(result.examined).toBe(1);
    expect(result.suspects).toHaveLength(1);
    const s = result.suspects[0];
    expect(s.storedAnchor).toBe('2026-08-05T06:00:00.000Z');
    expect(s.intendedIfCompensated).toBe('2026-08-05T13:00:00.000Z');
    expect(s.shiftMinutes).toBe(420);
    expect(s.correction).toContain('work_update(action="edit"');
    expect(s.correction).toContain('anchor_time="2026-08-05T13:00:00.000Z"');
    // The brief is for the owner, so it says the thing in plain words.
    const brief = describeSuspects(result);
    expect(brief).toContain('1 recurring item(s) of 1 scheduled item(s) examined');
    expect(brief).toContain('Do not change anything he does not confirm.');
  });

  it('uses the EFFECTIVE anchor — scheduled_start when no anchor column is set', () => {
    const result = scan([row({
      id: 'start-only', anchor_local: null, scheduled_start: Date.parse('2026-08-05T06:00:00Z'),
    })]);
    expect(result.suspects).toHaveLength(1);
    expect(result.suspects[0].storedAnchor).toBe('2026-08-05T06:00:00.000Z');
  });
});

describe('the scan stands down, and says against which clause', () => {
  it('a clean body produces ZERO suspects and a full denominator', () => {
    const rows: ScheduledRow[] = [
      row({ id: 'terminal', state: 'done' }),
      row({ id: 'paused', is_paused: 1 }),
      row({ id: 'already-fired', next_run_at: Date.parse('2026-07-01T00:00:00Z') }),
      row({ id: 'no-next-run', next_run_at: null }),
      row({ id: 'unreadable', anchor_local: 'whenever', scheduled_start: null }),
      row({ id: 'before-window', updated_at: Date.parse('2026-07-01T00:00:00Z') }),
      row({ id: 'after-window', updated_at: Date.parse('2026-08-06T00:00:00Z') }),
    ];
    const result = scan(rows);
    expect(result.examined).toBe(7);
    expect(result.suspects).toEqual([]);
    expect(result.standDown).toEqual({
      'cannot-fire': 4, 'no-readable-anchor': 1, 'written-outside-window': 2, 'box-is-utc': 0,
    });
    // The clause counts account for every row examined — that is the denominator.
    const accounted = Object.values(result.standDown).reduce((a, b) => a + b, 0) + result.suspects.length;
    expect(accounted).toBe(result.examined);
  });

  it('THE COUNTERFACTUAL: the same in-window row on a UTC box is not a suspect', () => {
    const rows = [row({ id: 'compensated-1', anchor_local: '2026-08-05T06:00:00.000Z' })];
    expect(scan(rows, ZONE).suspects).toHaveLength(1);
    const utc = scan(rows, 'UTC');
    expect(utc.suspects).toEqual([]);
    expect(utc.standDown['box-is-utc']).toBe(1);
  });

  it('the clause counts always account for every examined row (mixed body)', () => {
    const rows: ScheduledRow[] = [
      row({ id: 'compensated-1', anchor_local: '2026-08-05T06:00:00.000Z' }),
      row({ id: 'compensated-2', anchor_local: '2026-08-05T09:00:00.000Z' }),
      row({ id: 'terminal', state: 'abandoned' }),
      row({ id: 'before-window', updated_at: 0 }),
    ];
    const result = scan(rows);
    expect(result.examined).toBe(4);
    expect(result.suspects.map((s) => s.id)).toEqual(['compensated-1', 'compensated-2']);
    const accounted = Object.values(result.standDown).reduce((a, b) => a + b, 0) + result.suspects.length;
    expect(accounted).toBe(4);
  });

  it('an empty body is reported as zero of zero, never as "clean"', () => {
    const result = scan([]);
    expect(result.examined).toBe(0);
    expect(result.suspects).toEqual([]);
  });
});
