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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handledDispatchKeys, handlerFor } from '../handlers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// PHASE-5 T4 (the split's last move): `agent/tools.ts` is DELETED; the
// dispatcher is `agent/tools/index.ts`. The reader follows the code — and it
// failed loudly on the stale path first, which is what a source walk is for.
const DISPATCHER_TS = path.resolve(HERE, '../index.ts');

/** Every `case '<key>':` label of the dispatch switch, read from the source. */
function survivingCaseLabels(): string[] {
  const src = readFileSync(DISPATCHER_TS, 'utf8');
  // The dispatch switch's cases are the only ones at this exact indent (six
  // spaces): `canvasMime`'s switch and the two nested switches sit deeper or
  // shallower. §T0-PINS / research 05 uses the same discriminator.
  return [...src.matchAll(/^ {6}case '([^']+)':/gm)].map((m) => m[1]);
}

describe('the handler table and the surviving switch are disjoint', () => {
  it('serves at least one dispatch key (the test measures something)', () => {
    expect(handledDispatchKeys().length).toBeGreaterThan(0);
  });

  it('no dispatch key is served by BOTH the handler table and a switch case', () => {
    const cases = new Set(survivingCaseLabels());
    const both = handledDispatchKeys().filter((k) => cases.has(k));
    expect(both, `these dispatch keys are handled twice — the category's move did not delete its cases: ${both.join(', ')}`).toEqual([]);
  });

  it('every advertised key resolves to a callable handler', () => {
    for (const key of handledDispatchKeys()) {
      expect(typeof handlerFor(key), key).toBe('function');
    }
  });

  it('the switch is GONE — no dispatch case label survives anywhere in the dispatcher', () => {
    // FLIPPED 2026-08-02 (PHASE-5 T4, the split's last move), deliberately and
    // visibly, which is what the clause it replaces asked for. It used to read
    // `toBeGreaterThan(0)` — a guard against this file passing trivially while
    // the label reader silently drifted off a still-populated switch. That
    // guard fired on its own terms in this commit: `load_tool_docs` was the
    // last key, the count went to zero, and the clause failed rather than the
    // completion happening quietly.
    //
    // It is not deleted, because the reader is still worth keeping pointed at
    // the dispatcher: from here it is a REGRESSION guard. One mechanism per
    // tool means a new tool gets a handler in `cat/*` or `provider/*`, never a
    // case label bolted back onto the executor — and the empty-set assertion
    // names the offender if anyone tries.
    expect(survivingCaseLabels()).toEqual([]);
  });
});
