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
});
