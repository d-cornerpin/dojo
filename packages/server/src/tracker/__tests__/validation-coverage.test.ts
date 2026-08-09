// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP-A TB8 JOB 2 — THE PM SHOWS UP, AND THE SYSTEM CAN SEE WHETHER IT RULED.
//
// ── WHAT WAS MEASURED, AND WHAT THE INHERITED PREMISE GOT WRONG ─────────────────────────
// HU-2 (SWEEP-F T1, from TB5) and BATTERY4 §4.2 both read "the PM made ZERO audits across
// both delegation windows" off `work_events.kind='audit' AND actor='pm'`. Re-derived from
// the same durable sinks over battery `bmsgs7qejup`'s own window (00:32:44 → 01:55:13):
//
//   PM poke loop ticks                                     89
//   validation reviews that reached the report stage       43
//   PM (`kelly`) model calls                               85
//   PM verdicts actually written (claim_upheld/rejected)   4 + 1
//
// The PM shows up. `audit` was simply the wrong instrument: `tracker/task-log.ts:119`
// returns null for `entryKind: 'transition'`, and EVERY successful validation uses exactly
// that entry kind — so a validation that WORKS writes no `audit` row at all. The census
// was reading a number that could never have been non-zero for the thing it was counting.
//
// ── WHAT ACTUALLY FAILS, WITH ITS NUMBERS ───────────────────────────────────────────────
// Latency, and the two clocks are in the wrong order. In that window:
//
//   01:14:17 / :23 / :33   three tasks request Key 2 (`validation_requested`)
//   01:15:00 – 01:16:10    PM validation turn #1 — no verdict
//   01:17:00 – 01:18:04    PM validation turn #2 — no verdict
//   01:20:00               the SCHEDULER escalates all three TO THE OWNER as unvalidated
//   01:23:11               PM turn #3 finally upholds all of them (8m38s–8m54s after Key 1)
//
// The system told the owner its own validator had not ruled, three minutes before that
// validator ruled — and NOTHING anywhere recorded that turns #1 and #2 had been handed
// those rows and returned without a verdict. That is the owner's two-key law failing in
// its bookkeeping half: *a validator that cannot rule must say so loudly instead of
// silently skipping.*
//
// ── THE BOUND, WHICH IS NOT INVENTED ────────────────────────────────────────────────────
// No new cadence is chosen here. The bound is the product's OWN existing owner-escalation
// clock — `VALIDATION_ESCALATION_MIN = 5` minutes, `scheduler/runner.ts` — now exported and
// single-sourced instead of copied. The requirement is only that the two clocks be ordered:
// a row must not reach the owner as "unvalidated" while the platform holds no record that
// its validator was ever asked.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VALIDATION_COVERAGE_BOUND_MS,
  validationCoverageAfterReview,
} from '../pm-agent.js';
import { VALIDATION_ESCALATION_MIN } from '../../scheduler/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pmSource = (): string =>
  readFileSync(path.resolve(__dirname, '../pm-agent.ts'), 'utf8');

const NOW = 1_785_980_000_000;

describe('TB8 JOB 2 — the bound is the product’s own escalation clock, single-sourced', () => {
  it('is the scheduler’s VALIDATION_ESCALATION_MIN, not a second number', () => {
    expect(VALIDATION_COVERAGE_BOUND_MS).toBe(VALIDATION_ESCALATION_MIN * 60_000);
    // …and the scheduler still owns it: pm-agent must IMPORT it rather than re-declare.
    expect(pmSource()).toMatch(/import\s*\{[^}]*VALIDATION_ESCALATION_MIN[^}]*\}\s*from\s*'\.\.\/scheduler\/runner\.js'/);
    expect(pmSource()).not.toMatch(/const\s+VALIDATION_ESCALATION_MIN\s*=/);
  });
});

describe('TB8 JOB 2 — a review that returns without a verdict is a RECORDED miss', () => {
  it('a row handed to the validator and still awaiting Key 2 is a miss, with its wait', () => {
    const out = validationCoverageAfterReview({
      asked: [{ id: 'task-a', awaitingSinceMs: NOW - 90_000 }],
      stillAwaiting: new Set(['task-a']),
      nowMs: NOW,
    });
    expect(out.missed).toHaveLength(1);
    expect(out.missed[0].id).toBe('task-a');
    expect(out.missed[0].waitedMs).toBe(90_000);
    // The drive: the next tick must re-ask. Silence is what the dedup produced before.
    expect(out.reReview).toBe(true);
  });

  it('a row the validator DID rule on is not a miss, and nothing is re-driven', () => {
    const out = validationCoverageAfterReview({
      asked: [{ id: 'task-a', awaitingSinceMs: NOW - 90_000 }],
      stillAwaiting: new Set(),
      nowMs: NOW,
    });
    expect(out.missed).toHaveLength(0);
    expect(out.reReview).toBe(false);
  });

  it('a review that never reached the model at all is a miss on EVERY row it held', () => {
    // The busy path: `runtime.handleMessage` returns without running a turn when the PM
    // is already mid-run (`agent/runtime.ts:532`). It does not throw, so the existing
    // catch-block hash reset never fires and the dedup swallowed the whole set.
    const out = validationCoverageAfterReview({
      asked: [
        { id: 'task-a', awaitingSinceMs: NOW - 30_000 },
        { id: 'task-b', awaitingSinceMs: NOW - 30_000 },
      ],
      stillAwaiting: new Set(['task-a', 'task-b']),
      nowMs: NOW,
    });
    expect(out.missed.map((m) => m.id).sort()).toEqual(['task-a', 'task-b']);
    expect(out.reReview).toBe(true);
  });

  it('THE ORDERING LAW: a row past the owner-escalation bound is flagged, loudly', () => {
    // The 01:20 vs 01:23 shape, in one clause. 8m38s > 5m00s.
    const out = validationCoverageAfterReview({
      asked: [
        { id: 'past', awaitingSinceMs: NOW - 8 * 60_000 - 38_000 },
        { id: 'inside', awaitingSinceMs: NOW - 60_000 },
      ],
      stillAwaiting: new Set(['past', 'inside']),
      nowMs: NOW,
    });
    const past = out.missed.find((m) => m.id === 'past')!;
    const inside = out.missed.find((m) => m.id === 'inside')!;
    expect(past.pastOwnerBound).toBe(true);
    expect(inside.pastOwnerBound).toBe(false);
    expect(out.anyPastOwnerBound).toBe(true);
  });

  it('an empty ask is not a miss and never re-drives (no churn on an empty board)', () => {
    const out = validationCoverageAfterReview({ asked: [], stillAwaiting: new Set(), nowMs: NOW });
    expect(out.missed).toHaveLength(0);
    expect(out.reReview).toBe(false);
    expect(out.anyPastOwnerBound).toBe(false);
  });

  it('a row that was never asked about cannot become a miss', () => {
    const out = validationCoverageAfterReview({
      asked: [{ id: 'asked', awaitingSinceMs: NOW - 10_000 }],
      stillAwaiting: new Set(['asked', 'never-asked']),
      nowMs: NOW,
    });
    expect(out.missed.map((m) => m.id)).toEqual(['asked']);
  });
});

describe('TB8 JOB 2 — the review WIRES the law: recorded, said out loud, re-driven', () => {
  it('the miss is written through the EXISTING audit door, never a new table', () => {
    const src = pmSource();
    // `writeTaskLog` is the one seam every tracker audit entry goes through
    // (`tracker/task-log.ts:118`). The miss rides it.
    //
    // ⚠ CENSUS UPDATED, SWEEP CORE-2 item 1: the marker string moved to
    // `work/validation-drive.ts` and arrives here as `VALIDATION_ATTEMPT_MISS`, because the
    // scheduler now READS it to decide whether the owner may be told. The literal is
    // asserted at its new owner; what this clause pins is unchanged — the miss goes through
    // the existing audit door and is keyed on the coverage result.
    expect(src).toMatch(/VALIDATION_ATTEMPT_MISS/);
    expect(src).toMatch(/coverage\.missed/);
  });

  it('the dedup hash is RESET on a miss, so the next tick re-asks the same rows', () => {
    // Without this the `stableIssuesKey` gate (`if (reportHash === lastSituationReportHash)
    // return;`) means an unchanged awaiting-Key-2 row is reviewed once and then skipped
    // forever. The catch block already does exactly this for a THROWN failure and says why
    // in its own comment; a review that ran and ruled on nothing is the same failure.
    const src = pmSource();
    const at = src.indexOf('const coverage = validationCoverageAfterReview');
    expect(at).toBeGreaterThan(-1);
    // Window widened from 2400 to 3200 chars, SWEEP CORE-2 item 1: the recorder's block grew
    // a comment naming the two new readers of the miss record (the owner-escalation gate and
    // the queue order). The property is unchanged — the reset still lives inside this block.
    expect(src.slice(at, at + 3200)).toMatch(/lastSituationReportHash\s*=\s*''/);
  });

  it('THE LOUD HALF: the validation skips are no longer structurally invisible', () => {
    // `logger.ts:21` pins the level at 'info' and `setLogLevel` is never called in
    // production, so every `logger.debug` in this file could never be read. Measured: a
    // six-hour production log containing 388 PM ticks holds ZERO occurrences of any of
    // these lines. A skip nobody can see is the silent skip the owner ruled against.
    // ⚠ CENSUS UPDATED, SWEEP CORE-2 item 1, in the commit that earned it. Two of the four
    // phrases TB8 promoted — `PM review skipped, hourly LLM cap reached` and
    // `PM validation review deferred: event-wake cap full` — are GONE, because the skips
    // they described are gone: the owner retired the per-hour cap outright. A skip cannot be
    // loud if it cannot happen, and asserting the loudness of a deleted branch is exactly the
    // dead-guard class this suite exists to prevent. Their absence is asserted, by name, in
    // `supervisor-works.test.ts`. The two that remain are still live skips and still loud.
    const src = pmSource();
    for (const phrase of [
      'PM review: no issues detected',
      'PM review: actionable issue-set unchanged since last review',
    ]) {
      const at = src.indexOf(phrase);
      expect(at, `${phrase} must still exist`).toBeGreaterThan(-1);
      const lineStart = src.lastIndexOf('logger.', at);
      expect(
        src.slice(lineStart, at),
        `"${phrase}" must be visible at the production log level`,
      ).not.toMatch(/logger\.debug/);
    }
  });

  it('NEGATIVE CONTROL: the poke path’s mid-turn skips are untouched', () => {
    // T14's recorded assignee-working skip is a DIFFERENT mechanism and this task does not
    // widen, narrow or move it. If it disappears, that is a regression, not a side effect.
    const src = pmSource();
    expect(src).toMatch(/assigneeStatus === 'working'\) continue;/);
    expect(src).toMatch(/PM poke deferred: assignee is mid-run/);
  });
});
