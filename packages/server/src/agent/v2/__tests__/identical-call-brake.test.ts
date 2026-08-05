// ════════════════════════════════════════
// Identical-call brake (2026-07-17)
//
// Pins the defense added after the PM repeated one failing tracker_get_status
// call 189 times in a turn: warn at 3 identical failures, refuse execution at
// 6, reset on success, never touch distinct calls.
// ════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  identicalCallSignature,
  checkIdenticalCallRefusal,
  recordIdenticalCallResult,
  IDENTICAL_CALL_WARN_AT,
  IDENTICAL_CALL_REFUSE_AT,
  IDENTICAL_CALL_TERMINAL_AT,
  isSignatureTerminal,
  type RepeatCallState,
} from '../identical-call-brake.js';

const SIG = identicalCallSignature('tracker_get_status', { task_id: 'Process Archives' });

function failN(state: RepeatCallState, n: number): string | null {
  let notice: string | null = null;
  for (let i = 0; i < n; i++) {
    notice = recordIdenticalCallResult(state, SIG, true, "Error: Task not found: 'Process Archives'.");
  }
  return notice;
}

/** `failN` for an arbitrary signature. */
function failN2(state: RepeatCallState, sig: string, n: number): void {
  for (let i = 0; i < n; i++) recordIdenticalCallResult(state, sig, true, 'Error: refused.');
}

describe('identical-call brake', () => {
  it('says nothing on the first two identical failures', () => {
    const state: RepeatCallState = new Map();
    expect(failN(state, 2)).toBeNull();
    expect(checkIdenticalCallRefusal(state, SIG)).toBeNull();
  });

  it('appends the corrective notice at exactly WARN_AT, once', () => {
    const state: RepeatCallState = new Map();
    const atWarn = failN(state, IDENTICAL_CALL_WARN_AT);
    expect(atWarn).toContain('failed');
    expect(atWarn).toContain('not an id');
    // The next failure does not re-append (no spam).
    expect(recordIdenticalCallResult(state, SIG, true, 'same')).toBeNull();
  });

  it('refuses execution at REFUSE_AT with the last error quoted', () => {
    const state: RepeatCallState = new Map();
    failN(state, IDENTICAL_CALL_REFUSE_AT);
    const refusal = checkIdenticalCallRefusal(state, SIG);
    expect(refusal).toContain('NOT re-executed');
    expect(refusal).toContain('Process Archives');
  });

  it('a success resets the signature entirely', () => {
    const state: RepeatCallState = new Map();
    failN(state, IDENTICAL_CALL_REFUSE_AT);
    recordIdenticalCallResult(state, SIG, false, '');
    expect(checkIdenticalCallRefusal(state, SIG)).toBeNull();
    expect(failN(state, 2)).toBeNull();
  });

  it('distinct arguments are independent signatures', () => {
    const state: RepeatCallState = new Map();
    failN(state, IDENTICAL_CALL_REFUSE_AT);
    const other = identicalCallSignature('tracker_get_status', { task_id: '3bcd0151' });
    expect(checkIdenticalCallRefusal(state, other)).toBeNull();
  });

  it('signature is stable across key ordering', () => {
    expect(identicalCallSignature('t', { a: 1, b: 2 })).toBe(identicalCallSignature('t', { b: 2, a: 1 }));
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // THE TERMINAL RUNG — PHASE-6 T13, and these are its FIRST clauses.
  //
  // The rung is the owner's 2026-07-19 ruling: after the SAME refused signature is
  // resubmitted TERMINAL_AT times, the whole tool phase ends for the turn. `git grep`
  // for `isSignatureTerminal` across both repos found it in the executor and nowhere
  // else — the ladder's last rung had no test at all, which is how CUT 5 came to
  // report it as unreachable after ONE end-to-end fixture failed to reach it.
  //
  // THE REACHABILITY CORRECTION, measured rather than inferred (#15: an absence is a
  // question). CUT 5 drove an identical FAILING call end to end and the thrash gate
  // fired first at `DUPLICATE_SIG_LIMIT` = 4, so the rung at 6 failures + 3 refusals
  // was never reached. That is true of THAT fixture and not of the engine: the thrash
  // detector returns `{ thrashing: false }` outright the moment the window holds ONE
  // successful effectful call (`loop.ts` — `if (madeProgress) return`), and the two
  // gates key on DIFFERENT signature functions (`canonicalToolSignature` vs
  // `identicalCallSignature`, the documented landmine that keeps them distinct). So on
  // the turn this rung was actually written for — an agent doing real work that also
  // spins one exact failing call — the thrash gate declines to judge and the rung is
  // the defense that fires. Both layers stay; neither number moved.
  //
  // The clauses below drive the rung's own state machine, which is where it can be
  // driven honestly. The DRIVER's half — that the resulting grace ends the turn — is
  // in `integration.test.ts` under the T13 spin-brake block.
  // ══════════════════════════════════════════════════════════════════════════════
  it('the rung is NOT armed by failures alone, however many', () => {
    const state: RepeatCallState = new Map();
    failN(state, IDENTICAL_CALL_REFUSE_AT * 3);
    // Nothing has been REFUSED yet — the engine has been executing these.
    expect(isSignatureTerminal(state, SIG)).toBe(false);
  });

  it('the rung fires at exactly TERMINAL_AT refusals, and not one earlier', () => {
    const state: RepeatCallState = new Map();
    failN(state, IDENTICAL_CALL_REFUSE_AT);
    for (let i = 1; i < IDENTICAL_CALL_TERMINAL_AT; i++) {
      expect(checkIdenticalCallRefusal(state, SIG)).toContain('NOT re-executed');
      expect(isSignatureTerminal(state, SIG), `after ${i} refusal(s)`).toBe(false);
    }
    expect(checkIdenticalCallRefusal(state, SIG)).toContain('NOT re-executed');
    expect(isSignatureTerminal(state, SIG)).toBe(true);
  });

  it('a success DISARMS the rung — legitimate poll-retry work never reaches it', () => {
    const state: RepeatCallState = new Map();
    failN(state, IDENTICAL_CALL_REFUSE_AT);
    for (let i = 0; i < IDENTICAL_CALL_TERMINAL_AT; i++) checkIdenticalCallRefusal(state, SIG);
    expect(isSignatureTerminal(state, SIG)).toBe(true);
    recordIdenticalCallResult(state, SIG, false, '');
    expect(isSignatureTerminal(state, SIG)).toBe(false);
  });

  it('refusals of DIFFERENT signatures never add up to one rung — a fan-out is safe', () => {
    const state: RepeatCallState = new Map();
    for (let i = 0; i < IDENTICAL_CALL_TERMINAL_AT; i++) {
      const sig = identicalCallSignature('imessage_send', { to: `person-${i}`, text: 'hi' });
      failN2(state, sig, IDENTICAL_CALL_REFUSE_AT);
      checkIdenticalCallRefusal(state, sig);
      expect(isSignatureTerminal(state, sig)).toBe(false);
    }
  });
});
