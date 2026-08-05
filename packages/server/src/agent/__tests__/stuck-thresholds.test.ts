// PHASE-6 T10 Step 1c — ONE STUCK-THRESHOLD TABLE, AND THE TWO NUMBERS THAT ARE NOT IN IT.
//
// ── THE GROUND, RE-DERIVED AT THIS TASK'S HEAD (#14) ──
//
// Research 09 recorded "×3 with three thresholds/timers". T0-SURVEY corrected it at the phase
// base to FOUR time thresholds, one check interval and one count bound. Command, unit
// CONSTANTS:
//
//   git grep -nE "STUCK|_THRESHOLD" HEAD -- packages/server/src | grep -v __tests__
//
// This task reproduced the four and found a FIFTH occurrence the survey's grep could not see,
// because it is not a constant at all: `healer/diagnostic.ts` carried a bare `'-10 minutes'`
// SQL literal in its stuck-agent query. That is the Healer's duplicate stuck detector — the
// one Step 1c says must read the same table — and it was duplicating a number that had no
// name to duplicate. A grep for `_THRESHOLD` will never find that class; only reading does.
//
// ── WHAT THE TABLE IS FOR, AND THE THING IT MUST NOT DO ──
//
// It does NOT make the four agree, and a clause below asserts they still disagree. The engine
// reaps a `working` row at 75 minutes (what a DEAD PROCESS looks like); the Healer calls one
// frozen at 10 (what a WEDGED TURN looks like to a person watching). Unifying them would be
// inventing a number. What the table buys is that the disagreement is DECLARED — four rows,
// four owners, four reasons — so a fifth answer has to be written down beside the four it
// disagrees with.
//
// ── THE NAMED ERROR, NOW WITH BOTH A SITE AND A VALUE ──
//
// PHASE-6.md: "The 5-min `STUCK_AGENT_CHECK_MS` is a CHECK INTERVAL and `MAX_DRAIN_STUCK = 4`
// is a COUNT — neither enters a time table; unifying an interval with a threshold is the
// named error." Both are asserted ABSENT below, by value and by name, so the error cannot be
// made silently.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  STUCK_THRESHOLDS, STUCK_THRESHOLD_IDS,
  STUCK_AGENT_THRESHOLD_MINUTES, HEALER_WORKING_STUCK_MINUTES,
  DORMANT_THRESHOLD_DAYS, HARD_STUCK_THRESHOLD_MINUTES,
} from '../stuck-thresholds.js';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Every site that ENFORCES one of the four, with the constant it must read. */
const ENFORCERS: Array<{ file: string; reads: string }> = [
  { file: 'agent/runtime.ts', reads: 'STUCK_AGENT_THRESHOLD_MINUTES' },
  { file: 'healer/healer-agent.ts', reads: 'HEALER_WORKING_STUCK_MINUTES' },
  { file: 'healer/diagnostic.ts', reads: 'HEALER_WORKING_STUCK_MINUTES' },
  { file: 'healer/diagnostic.ts', reads: 'DORMANT_THRESHOLD_DAYS' },
  { file: 'scheduler/runner.ts', reads: 'HARD_STUCK_THRESHOLD_MINUTES' },
];

describe('T10 Step 1c — four cliffs, four owners, one table', () => {
  it('four ids, no more and no fewer', () => {
    expect(STUCK_THRESHOLD_IDS).toHaveLength(4);
    expect(Object.keys(STUCK_THRESHOLDS).sort()).toEqual([...STUCK_THRESHOLD_IDS].sort());
  });

  it('every row names an OWNER, states WHY, and says where its value came from', () => {
    for (const id of STUCK_THRESHOLD_IDS) {
      const t = STUCK_THRESHOLDS[id];
      expect(t.id, `${id}: id must match its key`).toBe(id);
      expect(t.ms, `${id}: a threshold is a positive duration`).toBeGreaterThan(0);
      // An owner is a subsystem a person can go and read, never "the system".
      expect(t.owner, `${id}: no owner`).toMatch(/\w/);
      expect(t.owner.toLowerCase(), `${id}: "the system" is not an owner`).not.toBe('the system');
      // A reason is prose a person can judge, not a restatement of the name.
      expect(t.reason.length, `${id}: no reason written`).toBeGreaterThan(40);
      // #14: "a count with no command beside it is a rumour" — same for a threshold with no
      // site beside it.
      expect(t.carriedFrom, `${id}: no provenance`).toMatch(/\.ts\b/);
    }
  });

  it('the four values are the four the tree already had — nothing was tuned by this move', () => {
    expect(STUCK_AGENT_THRESHOLD_MINUTES).toBe(75);
    expect(HEALER_WORKING_STUCK_MINUTES).toBe(10);
    expect(DORMANT_THRESHOLD_DAYS).toBe(7);
    expect(HARD_STUCK_THRESHOLD_MINUTES).toBe(120);
    expect(STUCK_THRESHOLDS.agent_working_dead_process.ms).toBe(75 * 60_000);
    expect(STUCK_THRESHOLDS.agent_working_wedged_turn.ms).toBe(10 * 60_000);
    expect(STUCK_THRESHOLDS.agent_dormant.ms).toBe(7 * 86_400_000);
    expect(STUCK_THRESHOLDS.recurring_run_hard_stuck.ms).toBe(120 * 60_000);
  });

  it('THE DISAGREEMENT IS PRESERVED, not resolved — the two `working` cliffs still differ', () => {
    // If a later change ever "tidies" these into one number, this is what fails. The Healer
    // noticing early and the reaper repairing a dead row are two requirements, not one.
    expect(STUCK_THRESHOLDS.agent_working_wedged_turn.ms)
      .toBeLessThan(STUCK_THRESHOLDS.agent_working_dead_process.ms);
    expect(STUCK_THRESHOLDS.agent_working_dead_process.ms)
      .toBeLessThan(STUCK_THRESHOLDS.recurring_run_hard_stuck.ms);
  });
});

describe('T10 Step 1c — every enforcing site reads the table, including the Healer\'s duplicate', () => {
  for (const { file, reads } of ENFORCERS) {
    it(`${file} enforces via ${reads}`, () => {
      const src = read(file);
      expect(src).toMatch(new RegExp(`from '[^']*stuck-thresholds\\.js'`));
      expect(src).toMatch(new RegExp(`\\b${reads}\\b`));
    });
  }

  it('THE FIFTH OCCURRENCE: the Healer\'s stuck query has no bare minute literal left', () => {
    // The exact shape that hid from the survey's `_THRESHOLD` grep: a number with no name.
    const diag = read('healer/diagnostic.ts');
    expect(diag).not.toMatch(/datetime\('now', '-10 minutes'\)/);
    expect(diag).toMatch(/datetime\('now', '-\$\{HEALER_WORKING_STUCK_MINUTES\} minutes'\)/);
  });

  it('the value the Healer enforces is UNCHANGED at ten minutes', () => {
    // The re-point must not have moved what the query does. Same cliff, now named.
    expect(HEALER_WORKING_STUCK_MINUTES).toBe(10);
  });

  it('no enforcing site keeps a private copy of its own cliff', () => {
    for (const { file } of ENFORCERS) {
      const src = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      expect(src, `${file} re-declares a stuck threshold`)
        .not.toMatch(/const\s+(STUCK_AGENT_THRESHOLD_MINUTES|HEALER_WORKING_STUCK_MINUTES|HARD_STUCK_THRESHOLD_MINUTES)\s*=\s*\d/);
      expect(src, `${file} re-declares the dormant cliff`)
        .not.toMatch(/const\s+DORMANT_THRESHOLD_MS\s*=\s*\d/);
    }
  });
});

describe('T10 Step 1c — the two numbers that are NOT thresholds, and stay out', () => {
  it('the 5-minute CHECK INTERVAL is not in the table, by value or by name', () => {
    // "Unifying an interval with a threshold is the named error" (PHASE-6.md Step 1c). It is
    // a cadence: how often the reaper LOOKS, not how old a row must be.
    const table = JSON.stringify(STUCK_THRESHOLDS);
    expect(table).not.toMatch(/STUCK_AGENT_CHECK_MS['"\s]*:/);
    expect(STUCK_THRESHOLD_IDS.map((id) => STUCK_THRESHOLDS[id].ms)).not.toContain(5 * 60_000);
    // …and it is still where it belongs, unchanged, next to the timer it drives.
    expect(read('agent/runtime.ts')).toMatch(/const STUCK_AGENT_CHECK_MS = 5 \* 60 \* 1000;/);
    expect(read('agent/runtime.ts')).toMatch(/setInterval\(recoverStuckAgents, STUCK_AGENT_CHECK_MS\)/);
  });

  it('MAX_DRAIN_STUCK is a COUNT and is not in the table', () => {
    const ids = STUCK_THRESHOLD_IDS.map(String).join(' ');
    expect(ids).not.toMatch(/drain/i);
    // A count cannot be compared with a duration; asserting its absence by VALUE would be
    // meaningless (4 ms is not a cliff anyone wrote), so this asserts it stayed at its own
    // site, in its own unit.
    expect(read('agent/turn-state.ts')).toMatch(/export const MAX_DRAIN_STUCK = 4;/);
  });
});
