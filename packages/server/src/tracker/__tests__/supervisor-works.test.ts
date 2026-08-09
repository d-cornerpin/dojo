// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 ITEM 1 — THE SUPERVISOR WORKS: the PM side of the owner's design.
//
// This file drives the three halves that live in `tracker/pm-agent.ts`:
//   (1) THE DOORBELL'S RIDER — the wake carries the row, and its latency is a stated bound
//       measured against the product's own owner-escalation clock.
//   (2) THE HOURLY LLM CAP IS RETIRED OUTRIGHT — no replacement throttle, no budget, no
//       reserved cadence. *"cost and token use is not really a factor… let her do it."*
//   (3) SPIN-RECOVERY, NEVER CAPS — the PM is inside the SAME detect-and-steer recovery
//       every other agent got, and nothing anywhere caps a per-item attempt or renders an
//       item terminally un-approvable.
//
// The queue-order and attempt-ledger halves are driven against a real database in
// `work/__tests__/validation-drive.test.ts`; the escalation ordering in
// `work/__tests__/owner-escalation-ordering.test.ts`. This file does not repeat them.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const broadcastSpy = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
// No database is touched by anything this file drives, and a debounced review that fires
// under fake timers must not reach for one. `runPMReview` catches its own rejection.
vi.mock('../../db/connection.js', () => ({
  getDb: () => { throw new Error('no database in this suite'); },
  closeDb: vi.fn(),
  getDbPath: () => '/dev/null/dojo.db',
}));

import {
  PM_DOORBELL_LATENCY_MS,
  drainValidationDoorbell,
  noteValidationDoorbell,
  pendingValidationDoorbellCount,
} from '../pm-agent.js';
import { VALIDATION_ESCALATION_MIN } from '../../scheduler/runner.js';
import {
  VALIDATION_ATTEMPT_MISS,
  VALIDATION_ATTEMPT_UNAVAILABLE,
} from '../../work/validation-drive.js';
import {
  IDENTICAL_CALL_REFUSE_AT, IDENTICAL_CALL_TERMINAL_AT, IDENTICAL_CALL_WARN_AT,
  checkIdenticalCallRefusal, identicalCallSignature, isSignatureTerminal,
  recordIdenticalCallResult, type RepeatCallState,
} from '../../agent/v2/identical-call-brake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string =>
  readFileSync(path.resolve(__dirname, rel), 'utf8');
const pmSource = (): string => readSrc('../pm-agent.ts');
const runnerSource = (): string => readSrc('../../scheduler/runner.ts');
const storeSource = (): string => readSrc('../../work/store.ts');

/**
 * Source with comments removed. A grep-zero on a retired symbol must read the CODE, because
 * the retirement's own tombstone names the symbol it buried — and a tombstone that trips the
 * gate it exists to explain would teach the next worker to delete the explanation.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .map((l) => l.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

// The whole file runs on fake timers: `noteValidationDoorbell` arms a real debounce, and a
// suite that leaves one armed is a process that keeps working after the test ended.
beforeEach(() => { vi.useFakeTimers(); drainValidationDoorbell(); });
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  drainValidationDoorbell();
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (1) THE DOORBELL'S RIDER
// ════════════════════════════════════════════════════════════════════════════════════════

describe('THE DOORBELL — the wake carries the row, not a patrol sweep', () => {
  it('a ring puts THAT row on the rider, and the review drains it', () => {
    noteValidationDoorbell({ workId: 'task-a', shape: 'close-request' });
    expect(pendingValidationDoorbellCount()).toBe(1);
    expect(drainValidationDoorbell()).toEqual(['task-a']);
    // Drained once: the rider is what THIS review carries, and the row then lives in the
    // ordinary queue with its own attempt count. A rider that never drains would bypass the
    // dedup for ever.
    expect(drainValidationDoorbell()).toEqual([]);
  });

  it('a burst coalesces into ONE review carrying EVERY row — none is dropped', () => {
    for (let i = 0; i < 20; i++) noteValidationDoorbell({ workId: `t${i}`, shape: 'close-request' });
    const carried = drainValidationDoorbell();
    expect(carried).toHaveLength(20);
    expect(new Set(carried).size).toBe(20);
  });

  it('the same row rung twice is carried once', () => {
    noteValidationDoorbell({ workId: 'task-a', shape: 'close-request' });
    noteValidationDoorbell({ workId: 'task-a', shape: 'engine-receipt' });
    expect(drainValidationDoorbell()).toEqual(['task-a']);
  });

  it('THE LATENCY BOUND IS STATED, AND IT IS THE PLATFORM’S OWN NUMBER', () => {
    // 10 s: `TRANSITION_DEBOUNCE_MS`, the burst-coalescer this file has used for event wakes
    // since Phase B.1 — carried, not chosen. It is measured against the only clock in the
    // product that says how long a row may await Key 2 before the OWNER is told
    // (`VALIDATION_ESCALATION_MIN`), and it must sit far inside it: the whole defect is the
    // two clocks running in the wrong order.
    expect(PM_DOORBELL_LATENCY_MS).toBe(10_000);
    expect(PM_DOORBELL_LATENCY_MS * 30).toBeLessThanOrEqual(VALIDATION_ESCALATION_MIN * 60_000);
  });

  it('a ring ARMS a review inside that bound — no waiting on the 60 s patrol tick', () => {
    expect(vi.getTimerCount()).toBe(0);
    noteValidationDoorbell({ workId: 'task-a', shape: 'close-request' });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // Before this task the same completion armed NOTHING: `tracker/tools.ts` returns on the
    // Key-1 refusal before it ever reaches a PM wake, so the row waited for a patrol sweep
    // that de-duplicated it away. Measured cost: 0 verdicts in 84 minutes (BATTERY9).
    vi.advanceTimersByTime(PM_DOORBELL_LATENCY_MS + 1);
    // The debounce FIRED inside the bound, proven by the only thing that can arm a fresh
    // one: the latch it holds while a review is pending is released.
    const settled = vi.getTimerCount();
    noteValidationDoorbell({ workId: 'task-b', shape: 'engine-receipt' });
    expect(vi.getTimerCount()).toBe(settled + 1);
  });

  it('the review carries the rider INTO the queue it hands the validator', () => {
    const src = pmSource();
    // The rider is spliced into the unvalidated-complete rows the review reports on, and it
    // bypasses the settle window — a doorbell row IS the completion event, so waiting 15 s
    // for it to "settle" is the patrol sweep by another name.
    expect(src).toMatch(/drainValidationDoorbell\(\)/);
    expect(src).toMatch(/doorbell/i);
  });

  it("the doorbell is wired at the SPINE, so no close path can forget it", () => {
    // Both shapes ring from inside `transition()` — the one writer — rather than from the
    // two tool call sites that happen to produce them today.
    expect(storeSource()).toMatch(/ringValidationDoorbell/);
    expect(pmSource()).toMatch(/setValidationDoorbellHandler/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (2) THE HOURLY LLM CAP IS RETIRED OUTRIGHT
// ════════════════════════════════════════════════════════════════════════════════════════

describe('THE CAP IS GONE — with no replacement throttle and no budget', () => {
  it('every piece of the cap is deleted from the source', () => {
    const src = codeOnly(pmSource());
    for (const gone of [
      'PM_LLM_CALLS_PER_HOUR_CAP',
      'pmLlmCallTimestamps',
      'recordPmLlmCall',
      'pmLlmCallsInLastHour',
      'pmCapReached',
      'lastValidationReviewAt',
    ]) {
      expect(src, `${gone} must be gone, not merely unused`).not.toContain(gone);
    }
  });

  it('the two cap SKIPS are gone with it — a skip cannot be loud if it cannot happen', () => {
    const src = codeOnly(pmSource());
    expect(src).not.toContain('PM review skipped, hourly LLM cap reached');
    expect(src).not.toContain('PM validation review deferred: event-wake cap full');
    expect(src).not.toContain('PM event wake dropped: hourly LLM cap reached');
  });

  it('NOTHING replaced it: no new per-hour, per-minute or per-review budget appears', () => {
    const src = codeOnly(pmSource());
    expect(src).not.toMatch(/CALLS_PER_HOUR|PER_HOUR_CAP|VALIDATION_BUDGET|MAX_VALIDATIONS/);
  });

  it('the retirement carries a TOMBSTONE naming what it was and why it went', () => {
    const src = pmSource();
    expect(src).toMatch(/RETIRED[\s\S]{0,400}cap/i);
    expect(src).toMatch(/SWEEP CORE-2/);
  });

  it('the polled 10-minute heartbeat SURVIVES — it is a cadence, never a validation throttle', () => {
    // Negative control. `LLM_REVIEW_INTERVAL_MS` gates the idle no-validation-pending
    // review only, and validation has always bypassed it. Deleting it would be a different
    // change wearing this one's name.
    const src = pmSource();
    expect(src).toContain('LLM_REVIEW_INTERVAL_MS');
    expect(src).toMatch(/if \(!validationPending && now - lastLLMReviewAt < LLM_REVIEW_INTERVAL_MS\) return;/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (3) SPIN-RECOVERY, NEVER CAPS
// ════════════════════════════════════════════════════════════════════════════════════════

describe('SPIN-RECOVERY — the PM gets the same back-on-track treatment, never a cage', () => {
  it('NOTHING caps a per-item attempt or a per-item time budget', () => {
    const src = codeOnly(pmSource());
    // The owner's named nightmare: one blocked approval halting a whole project. There is
    // no attempt ceiling, no per-row deadline, and no state that means "un-approvable".
    expect(src).not.toMatch(/MAX_VALIDATION_ATTEMPTS|VALIDATION_ATTEMPT_LIMIT|unapprovable|abandonValidation/i);
    expect(codeOnly(runnerSource())).not.toMatch(/MAX_VALIDATION_ATTEMPTS|VALIDATION_ATTEMPT_LIMIT/);
    // …and the attempt count is used ONLY to ORDER the queue. If it ever appears in a
    // comparison against a ceiling, this file is the place that says so.
    expect(src).not.toMatch(/attempts_recorded\s*[><]=?\s*\d/);
  });

  it('the queue orders by attempts so a stubborn row serves the ones behind it', () => {
    const src = codeOnly(pmSource());
    // The order is IMPORTED from its one owner, never restated here — so the DB-driven proof
    // in `work/__tests__/validation-drive.test.ts` reads the same string the queue is built
    // with and cannot pass against a copy.
    expect(src).toMatch(/ORDER BY \$\{validationQueueOrderExpr\('w'\)\}/);
    expect(src).toMatch(/validationQueueOrderExpr/);
  });

  it('a miss and an unavailable validator are recorded through the SAME existing audit door', () => {
    const src = pmSource();
    expect(src).toContain('VALIDATION_ATTEMPT_MISS');
    expect(src).toContain('VALIDATION_ATTEMPT_UNAVAILABLE');
    expect(src).toMatch(/writeTaskLog\(\{[\s\S]{0,400}VALIDATION_ATTEMPT_MISS/);
    // The markers are single-sourced in `work/validation-drive.ts` so the writer and the
    // scheduler's reader cannot drift — the TB5 lesson, not re-learned here.
    expect(src).toMatch(/from '\.\.\/work\/validation-drive\.js'/);
    expect(runnerSource()).toMatch(/validation-drive\.js/);
    expect(VALIDATION_ATTEMPT_MISS).toBe('validation_review_miss');
    expect(VALIDATION_ATTEMPT_UNAVAILABLE).toBe('validation_validator_unavailable');
  });

  it('a validator that cannot be asked at all SAYS SO on the row', () => {
    const src = codeOnly(pmSource());
    // The terminated / model-less PM. Before this the review simply RETURNED, so a box whose
    // validator was gone produced neither verdicts nor any record of the absence — and once
    // the owner escalation waits for a recorded attempt, that silence would become permanent.
    // The record must hang off THAT early return, not merely exist somewhere in the file.
    expect(src).toMatch(
      /pmAgent\.status === 'terminated'\)[\s\S]{0,600}recordValidatorUnavailable\(/,
    );
    // …and the recorder writes the marker the scheduler's gate reads.
    expect(src).toMatch(
      /function recordValidatorUnavailable[\s\S]{0,2000}actionTaken: VALIDATION_ATTEMPT_UNAVAILABLE/,
    );
    // …only on rows that carry no attempt yet, so a down validator cannot firehose the trail.
    expect(src).toMatch(
      /function recordValidatorUnavailable[\s\S]{0,1200}validationAttemptCountExpr\('w'\)\} = 0/,
    );
  });

  it('TB8’s coverage recorder is REUSED, not re-implemented', () => {
    const src = pmSource();
    expect(src).toMatch(/validationCoverageAfterReview\(/);
    expect(src).toMatch(/idsStillAwaitingKeyTwo\(/);
  });
});

describe('SPIN-RECOVERY — the PM inherits the platform’s own recovery', () => {
  it('the repeated-identical-work brake is the platform’s, unchanged, and still armed', () => {
    // Its own header records that the PM is the agent it was BUILT for: 189 identical
    // `work_update(action="get")` calls in one turn. Nothing here narrows it, and nothing
    // here is a new mechanism — the owner's constraint (b) is the SAME treatment, not a
    // second one.
    const brake = readSrc('../../agent/v2/identical-call-brake.ts');
    expect(brake).toMatch(/IDENTICAL_CALL_WARN_AT = 3/);
    expect(brake).toMatch(/IDENTICAL_CALL_REFUSE_AT = 6/);
    expect(brake).not.toMatch(/isPMAgent|pm_agent_id/);
    expect(IDENTICAL_CALL_WARN_AT).toBe(3);
    expect(IDENTICAL_CALL_REFUSE_AT).toBe(6);
  });

  it('a PM signature that keeps failing is REFUSED, then ends its tool phase — never the queue', () => {
    // Driven, on the PM's own recorded spin shape. The brake stops the SPIN; it does not
    // touch the tracker row, so nothing here can make an item un-approvable.
    const state: RepeatCallState = new Map();
    const sig = identicalCallSignature('work_update', { action: 'get', task_id: 'Nudge Kevin' });
    for (let i = 0; i < IDENTICAL_CALL_REFUSE_AT; i++) {
      recordIdenticalCallResult(state, sig, true, 'not found');
    }
    expect(checkIdenticalCallRefusal(state, sig)).toMatch(/NOT re-executed/);
    for (let i = 1; i < IDENTICAL_CALL_TERMINAL_AT; i++) checkIdenticalCallRefusal(state, sig);
    expect(isSignatureTerminal(state, sig)).toBe(true);
    // NEGATIVE CONTROL: a different row is untouched — the queue behind the spin still flows.
    const other = identicalCallSignature('work_validate', { task_id: 'behind-1', valid: true });
    expect(checkIdenticalCallRefusal(state, other)).toBeNull();
    expect(isSignatureTerminal(state, other)).toBe(false);
  });
});
