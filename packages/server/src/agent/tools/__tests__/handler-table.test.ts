// ════════════════════════════════════════════════════════════════════════════
// THE HANDLER TABLE IS DISJOINT FROM THE SURVIVING SWITCH (PHASE-5 T4)
//
// The toolbox split moves handler bodies out of `agent/tools.ts` one category
// at a time, so for the length of the split there are two dispatch surfaces:
// the handler table and the shrinking switch. Roadmap non-negotiable #1 says no
// task may leave both the old and the new mechanism alive for the same job —
// and "the same job" here is a DISPATCH KEY, not the file.
//
// The discipline is that a category's move deletes its cases in the commit that
// adds its module. This file is what makes that a fact instead of a discipline:
// it reads the surviving `case '…':` labels straight out of the source text and
// asserts the two key sets do not intersect. A half-moved category — a module
// added while its cases still stand — fails here, naming the key.
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
const TOOLS_TS = path.resolve(HERE, '../../tools.ts');

/** Every `case '<key>':` label of the dispatch switch, read from the source. */
function survivingCaseLabels(): string[] {
  const src = readFileSync(TOOLS_TS, 'utf8');
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

  it('the surviving switch still has cases (the split is not silently complete)', () => {
    // A guard against this file passing trivially once the switch is empty but
    // the label reader has drifted: when the switch really is gone, `tools.ts`
    // is DELETED and this clause is deleted with it, deliberately and visibly.
    expect(survivingCaseLabels().length).toBeGreaterThan(0);
  });
});
