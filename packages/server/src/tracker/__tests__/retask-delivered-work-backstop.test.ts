// PHASE-2 T8c item 2 — THE GUARD CONVERSION `deliverable_shown` HAS BEEN WAITING FOR.
//
// PHASE-2.md PINNED §12 carries a STOP: "grep-zero on this column stays FORBIDDEN until the
// backstop's requirement is a test", and the T0 concern adjudication adds the two conditions
// this file discharges — BOTH branches of the guard, including the `allow_regenerate` escape
// hatch. Until now the guard existed only inline inside `trackerRetask`, an async handler
// that also delivers over A2A, broadcasts, writes a task-log entry and may trigger a
// stalemate; nothing could reach the condition without all of that, so nothing tested it.
//
// THE INCIDENT IT ENCODES: the PM retasks a job whose result the user was already shown. The
// assignee redoes it, produces a second, divergent version, and the person now holds two
// answers and two "done"s. That is why this is a REFUSAL and not a warning.
//
// WHAT THIS BUYS T10: the first branch reads `deliverable_shown`, the column T10 drops. When
// it goes, `deliverableShown` is simply always false and every clause below about the SECOND
// branch and the escape hatch keeps its exact meaning — so T10 removes a column, not a
// requirement. The clauses that are specifically about the legacy branch say so by name.

import { describe, it, expect } from 'vitest';
import {
  retaskWouldOverwriteDeliveredWork,
  retaskIsRefused,
  type RetaskProtectionFacts,
} from '../tools.js';

const facts = (over: Partial<RetaskProtectionFacts> = {}): RetaskProtectionFacts => ({
  deliverableShown: false,
  status: 'in_progress',
  completeValidated: false,
  closeRequestPending: false,
  ...over,
});

describe('branch 1 — the legacy stamp (DIES WITH THE COLUMN AT T10)', () => {
  it('a row stamped deliverable_shown=1 is protected whatever its status says', () => {
    expect(retaskWouldOverwriteDeliveredWork(facts({ deliverableShown: true }))).toBe(true);
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ deliverableShown: true, status: 'in_progress' }),
    )).toBe(true);
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ deliverableShown: true, status: 'on_deck' }),
    )).toBe(true);
  });

  it('POSITIVE CONTROL of the same shape: without the stamp, the same row is retaskable', () => {
    // The clause above proves nothing on its own — a predicate that returns true for
    // everything would satisfy it. This is the identical row with the one fact removed.
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ deliverableShown: false, status: 'in_progress' }),
    )).toBe(false);
  });
});

describe('branch 2 — Key 1 filed, Key 2 not (SURVIVES T10)', () => {
  it('complete + unvalidated is delivered-and-awaiting-adjudication, so it is protected', () => {
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ status: 'complete', completeValidated: false }),
    )).toBe(true);
  });

  it('complete + VALIDATED is not protected — the adjudication already happened', () => {
    // The PM has seen it and upheld it; a retask from here is a deliberate new decision,
    // not the silent overwrite the guard exists to stop.
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ status: 'complete', completeValidated: true }),
    )).toBe(false);
  });

  it('NEGATIVE CONTROLS: no other status triggers branch 2, validated or not', () => {
    for (const status of ['in_progress', 'on_deck', 'blocked', 'paused', 'fallen']) {
      expect(retaskWouldOverwriteDeliveredWork(facts({ status, completeValidated: false })),
        `${status} must not be read as delivered`).toBe(false);
      expect(retaskWouldOverwriteDeliveredWork(facts({ status, completeValidated: true })),
        `${status} must not be read as delivered`).toBe(false);
    }
  });
});

// PHASE-2 T8T — BRANCH 3, and the reason it had to exist in the same change as the trigger.
// Branch 2 reads "`complete` and unblessed". Migration `139` makes that state unreachable for
// a WORKER's own close: the row stays `in_progress` and the claim is a `validation_requested`
// event. So the exact situation branch 2 was written for stopped matching branch 2, and every
// clause in this file would still have been green. Same requirement, third store.
describe('branch 3 — Key 1 filed and the row has NOT moved (PHASE-2 T8T)', () => {
  it("a worker's close request on an in_progress row is delivered-and-awaiting-adjudication", () => {
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ status: 'in_progress', closeRequestPending: true }),
    )).toBe(true);
  });

  it('POSITIVE CONTROL of the same shape: the identical row with no request is retaskable', () => {
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ status: 'in_progress', closeRequestPending: false }),
    )).toBe(false);
  });

  it('and the hatch still opens it, exactly as for the other two branches', () => {
    const f = facts({ status: 'in_progress', closeRequestPending: true });
    expect(retaskIsRefused(f, undefined)).toBe(true);
    expect(retaskIsRefused(f, true)).toBe(false);
    expect(retaskIsRefused(f, 'yes')).toBe(true);   // strictly === true, as branch 1 and 2
  });

  it('THE REGRESSION THIS BRANCH PREVENTS, stated as a test: a delivered close request that the trigger left in_progress is not retaskable just because its status changed', () => {
    // Before T8T this row would have been `complete` + unvalidated (branch 2). After T8T it
    // is `in_progress` + pending request. Both must refuse; only the store moved.
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ status: 'complete', completeValidated: false }),
    )).toBe(true);
    expect(retaskWouldOverwriteDeliveredWork(
      facts({ status: 'in_progress', closeRequestPending: true }),
    )).toBe(true);
  });
});

describe('the escape hatch — allow_regenerate', () => {
  it('a protected row is REFUSED by default', () => {
    expect(retaskIsRefused(facts({ deliverableShown: true }), undefined)).toBe(true);
    expect(retaskIsRefused(facts({ status: 'complete' }), undefined)).toBe(true);
  });

  it('allow_regenerate === true opens BOTH branches, deliberately', () => {
    expect(retaskIsRefused(facts({ deliverableShown: true }), true)).toBe(false);
    expect(retaskIsRefused(facts({ status: 'complete' }), true)).toBe(false);
  });

  it('ONLY a real boolean true opens it — a weak model\'s truthy value does not', () => {
    // #77 absorb-don't-refuse forgives argument SHAPE everywhere else in this surface. It
    // must not forgive it here: the whole point is that overwriting delivered work is an
    // explicit choice somebody made, and "true"/1/"yes" arriving from a confused model is
    // not that choice.
    for (const v of ['true', 1, 'yes', 'TRUE', {}, [], 'allow']) {
      expect(retaskIsRefused(facts({ deliverableShown: true }), v),
        `${JSON.stringify(v)} must not open the gate`).toBe(true);
    }
  });

  it('allow_regenerate on an UNPROTECTED row changes nothing (it is not a switch of its own)', () => {
    expect(retaskIsRefused(facts(), true)).toBe(false);
    expect(retaskIsRefused(facts(), undefined)).toBe(false);
  });
});

describe('the call site still uses the predicate, and its refusal still names the hatch', () => {
  it('trackerRetask routes through retaskIsRefused and offers allow_regenerate in the text', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'tools.ts'), 'utf8',
    );
    const retask = src.slice(src.indexOf('export async function trackerRetask'));
    // The gate is the shared predicate, not a re-inlined copy that could drift from it.
    expect(retask.slice(0, 3000)).toMatch(/retaskIsRefused\(\{/);
    // And the refusal is STEERABLE — it tells the PM the exact way to proceed on purpose.
    expect(retask.slice(0, 4000)).toMatch(/allow_regenerate=true/);
  });
});
