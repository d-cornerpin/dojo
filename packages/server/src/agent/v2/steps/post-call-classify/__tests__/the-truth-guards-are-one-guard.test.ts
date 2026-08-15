// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2e), MERGER 2 — THE FOUR TRUTH GUARDS ARE ONE GUARD WITH FOUR PREDICATES.
//
// W27's census, §5.2: `reply-floors.ts` carries four blocks that ask the same question with
// four different nouns — "the reply asserts X, the ledger says not-X" — behind a
// BYTE-REPEATED prologue (a terminal reply, no tool calls, not inter-agent), each ending in
// its own `continueLoop`. Two of the four already delegate their decision to a named module
// (`claimed-delivery.ts`, `recorded-commitment.ts`); the other two inline theirs.
//
// THE MERGER IS A DELETION AND A DECLARATION. One prologue, one loop, four records that
// each declare their floor, their own extra gate and their decision. The order is not
// re-typed here either: it is SORTED by `STEER_PRECEDENCE`, the same authority 2a made the
// turn-ending family derive from — so the truth band's 10 → 11 → 12 → 13 cannot drift from
// the table that argues it.
//
// WHAT THIS SUITE DOES NOT DO IS RE-PROVE THE FOUR DECISIONS. They are already covered, and
// those suites are the preservation evidence for this merger: `contract.test.ts` (the
// RC-13.2 save-claim floor's four clauses, and the uncommitted-promise floor's two, one of
// which pins its SEQUENCE against `promise-floor`), `claimed-delivery-obligation.test.ts`,
// `recorded-commitment.test.ts`, `grounding.test.ts`. What this suite proves is that there
// is now ONE guard, and that its order is the table's.
//
// RED at `ff1be2f`: the prologue is written four times and there is no declared set.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEER_PRECEDENCE, steerPriority } from '../../../steer-queue.js';
import { TRUTH_GUARDS } from '../reply-floors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../reply-floors.ts'), 'utf8');

/** Code only. This file's own prose names every shape it forbids. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const occurrences = (re: RegExp): number => (CODE.match(re) ?? []).length;

describe('§1 one prologue, not four', () => {
  it('the shared gate is written ONCE', () => {
    // Four copies of one sentence is how the fifth copy gets written slightly differently.
    expect(occurrences(/result\.toolCalls\.length === 0/g)).toBe(1);
    expect(occurrences(/!interAgentTurn/g)).toBe(1);
  });

  it('there is ONE `continueLoop` for the whole family, not one per guard', () => {
    // The four `return continueLoop(state)` exits were the four blocks' only shared shape
    // and the loop now owns it. The count is 1: the family's own exit.
    expect(occurrences(/return continueLoop\(/g)).toBe(1);
  });

  it('there is ONE `persistEngineSteer` call for the whole family', () => {
    expect(occurrences(/persistEngineSteer\(/g)).toBe(1);
  });
});

describe('§2 four declared predicates, ordered by the declared table', () => {
  it('the set is exactly the four truth guards, in the truth band', () => {
    expect(TRUTH_GUARDS.map((g) => g.floor)).toEqual([
      'ungrounded-claim',    // 10 — a delivery no send tool made
      'delivery-denial',     // 11 — a denial the receipt ledger contradicts
      'failed-save-claim',   // 12 — a save every vault call rejected
      'uncommitted-promise', // 13 — a recorded commitment the work ledger does not hold
    ]);
  });

  it('THE PROPERTY: the running order is `STEER_PRECEDENCE`\'s, and re-ranking moves it', () => {
    const running = TRUTH_GUARDS.map((g) => g.floor);
    const byTable = [...running].sort((a, b) => steerPriority(a) - steerPriority(b));
    expect(running).toEqual(byTable);
    const priorities = running.map(steerPriority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeGreaterThan(priorities[i - 1]);
    }
  });

  it('every guard names a floor the table ranks, and all four sit in the TRUTH band', () => {
    const declared = new Set(STEER_PRECEDENCE.map((f) => f.id));
    for (const g of TRUTH_GUARDS) {
      expect(declared.has(g.floor)).toBe(true);
      // The band is the argument: nothing outranks stopping a false claim from standing.
      expect(steerPriority(g.floor)).toBeLessThan(20);
    }
  });

  it('the whole truth band is here — no fifth guard is hiding outside the set', () => {
    const truthBand = STEER_PRECEDENCE.filter((f) => f.priority < 20).map((f) => f.id);
    expect(TRUTH_GUARDS.map((g) => g.floor)).toEqual(truthBand);
  });
});

describe('§3 the tombstone the census asked to keep is still here', () => {
  it('the removed deliverable-claim floor still says why it was removed', () => {
    // "a removal that cannot say why comes back" — the file's own words, and the reason
    // this merger had to carry the tombstone across rather than tidy it away.
    expect(SRC).toContain('Deliverable-claim floor: REMOVED same day it landed');
    expect(SRC).toContain('prose classification must never gain authority');
  });
});
