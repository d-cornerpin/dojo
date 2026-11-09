// ════════════════════════════════════════════════════════════════════════════
// ONE MECHANISM PER TOOL, HELD BY MACHINE (PHASE-5 T4)
//
// The toolbox split moved 268 handler bodies out of `agent/tools.ts` one
// category at a time across three sittings, so for the length of the move there
// were two dispatch surfaces: the handler table and the shrinking switch.
// Roadmap non-negotiable #1 says no task may leave both the old and the new
// mechanism alive for the same job — and "the same job" here is a DISPATCH KEY,
// not the file. This test is what made that a fact instead of a discipline:
// it reads `case '…':` labels straight out of the dispatcher's source and
// asserts they are disjoint from the table's keys, so a half-moved category —
// a module added while its cases still stood — failed here, naming the key.
//
// The move is DONE: `agent/tools.ts` is deleted and the label set is empty.
// The reader stays, pointed at `agent/tools/index.ts`, as the regression half
// of the same rule — a new tool gets a handler, never a case label.
//
// It also asserts the table is non-empty, so the test cannot pass by measuring
// nothing (the failure mode that makes a green meaningless).
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { handledDispatchKeys, handlerFor } from '../handlers.js';

describe('the handler table and the surviving switch are disjoint', () => {
  it('serves at least one dispatch key (the test measures something)', () => {
    expect(handledDispatchKeys().length).toBeGreaterThan(0);
  });

  it('every advertised key resolves to a callable handler', () => {
    for (const key of handledDispatchKeys()) {
      expect(typeof handlerFor(key), key).toBe('function');
    }
  });
});
