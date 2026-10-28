// ════════════════════════════════════════
// Identical-call brake — nested-args signature
//
// Pins that the canonical signature keeps every nested property: a call that
// fixes one value inside a nested object or array must read as a DIFFERENT
// signature, so the brake stops blocking a call that is actually different.
// Key order still never matters; element order in an array still does.
// ════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  identicalCallSignature,
  checkIdenticalCallRefusal,
  recordIdenticalCallResult,
  IDENTICAL_CALL_REFUSE_AT,
  type RepeatCallState,
} from '../identical-call-brake.js';

describe('identical-call brake — nested args', () => {
  it('a changed nested object property is a different signature', () => {
    expect(identicalCallSignature('t', { a: { x: 1 } })).not.toBe(
      identicalCallSignature('t', { a: { x: 2 } }),
    );
  });

  it('a changed nested array element is a different signature', () => {
    expect(identicalCallSignature('t', { events: [{ id: 1 }] })).not.toBe(
      identicalCallSignature('t', { events: [{ id: 2 }] }),
    );
  });

  it('a refusal is not inherited by a different nested signature', () => {
    const state: RepeatCallState = new Map();
    const sig1 = identicalCallSignature('t', { a: { x: 1 } });
    for (let i = 0; i < IDENTICAL_CALL_REFUSE_AT; i++) {
      recordIdenticalCallResult(state, sig1, true, 'Error: x');
    }
    // The signature of {a:{x:2}} has never failed — it is not refused.
    expect(checkIdenticalCallRefusal(state, identicalCallSignature('t', { a: { x: 2 } }))).toBeNull();
    // The failing signature of {a:{x:1}} IS refused.
    expect(checkIdenticalCallRefusal(state, identicalCallSignature('t', { a: { x: 1 } }))).toContain('NOT re-executed');
  });

  it('key order does not matter at any depth', () => {
    expect(identicalCallSignature('t', { a: 1, b: { y: 1, z: 2 } })).toBe(
      identicalCallSignature('t', { b: { z: 2, y: 1 }, a: 1 }),
    );
  });

  it('array element order matters', () => {
    expect(identicalCallSignature('t', { ids: [1, 2] })).not.toBe(
      identicalCallSignature('t', { ids: [2, 1] }),
    );
  });

  it('null/undefined args and {} collapse to the same {args} signature', () => {
    const u = identicalCallSignature('t', undefined);
    const e = identicalCallSignature('t', {});
    expect(u).toBe(e);
    expect(u.startsWith('t:')).toBe(true);
  });
});
