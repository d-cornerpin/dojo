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
// WHAT THIS BOUGHT T10, NOW SPENT (PHASE-2 T10F): the first branch read `deliverable_shown`,
// and migration `145` dropped that column. The clauses that were specifically about the legacy
// branch are RETIRED HERE — deliberately, in the same change as the drop, exactly as they said
// they would be — and every clause about the surviving branches and the escape hatch keeps its
// exact meaning, untouched. That is the whole point of having converted the guard first: T10F
// removed a column, not a requirement.
//
// THE RETIREMENT IS NOT A DELETION OF COVERAGE. What branch 1's clauses proved was "a row
// already shown to the user cannot be silently retasked". That is now proved by branches 2 and
// 3, whose inputs are REACHABLE, plus one new clause asserting the column is GONE FROM THE
// SCHEMA — strictly stronger than the old assertion that nobody wrote a column that existed,
// because a reader arriving later cannot reintroduce a column that is not there. A clause whose
// input can no longer occur is not coverage; it is a test of an unreachable state, and keeping
// it would be the same kind of comfort as a guard nobody can trip.

import { describe, it, expect } from 'vitest';
import {
  retaskWouldOverwriteDeliveredWork,
  retaskIsRefused,
  type RetaskProtectionFacts,
} from '../tools.js';

const facts = (over: Partial<RetaskProtectionFacts> = {}): RetaskProtectionFacts => ({
  status: 'in_progress',
  completeValidated: false,
  closeRequestPending: false,
  ...over,
});

describe('branch 1 — the legacy stamp — RETIRED AT PHASE-2 T10F WITH ITS COLUMN', () => {
  it('the column is GONE FROM THE SCHEMA, which is why the branch could go', () => {
    // The replacement for three clauses about a flag that can no longer be set. This asserts
    // against the MIGRATION CHAIN rather than against a database, so it holds on a fresh box
    // and a lived-in one alike: `145` drops the column, and nothing after it re-adds one.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const dir = path.resolve(__dirname, '..', '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const dropIdx = files.findIndex((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return /ALTER\s+TABLE\s+work\s+DROP\s+COLUMN\s+deliverable_shown/i.test(sql);
    });
    expect(dropIdx, 'some migration must drop work.deliverable_shown').toBeGreaterThan(-1);
    // POSITIVE CONTROL that the scan is looking at real files and can see a real ADD: the
    // column was added before it was dropped, so a scan that finds neither is broken, not clean.
    const addIdx = files.findIndex((f) =>
      /deliverable_shown/i.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(addIdx, 'the scan must be able to see the column being introduced').toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(dropIdx);
    // ...and NOTHING AFTER THE DROP re-adds it. This is the clause a future reader trips.
    //
    // ⚠ THE REMAINDER OF THE DROP FILE COUNTS, and my first version of this scan started at
    // `dropIdx + 1` — so a re-add on the line AFTER the drop, in the drop's own file, passed.
    // A planted fault caught it, which is why the tail of the drop file is scanned here.
    const dropSql = fs.readFileSync(path.join(dir, files[dropIdx]), 'utf8');
    const afterDropInSameFile = dropSql.slice(
      dropSql.search(/ALTER\s+TABLE\s+work\s+DROP\s+COLUMN\s+deliverable_shown/i));
    for (const [label, sql] of [
      [files[dropIdx], afterDropInSameFile],
      ...files.slice(dropIdx + 1).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')] as const),
    ] as Array<readonly [string, string]>) {
      expect(/ADD\s+COLUMN\s+deliverable_shown/i.test(sql),
        `${label} re-adds deliverable_shown after it was dropped`).toBe(false);
    }
  });

  it('and the predicate no longer takes the argument at all', () => {
    // A boolean parameter with one reachable value is residue, not a stub. If somebody
    // reintroduces it, this fails — which is the point.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'tools.ts'), 'utf8');
    const iface = src.slice(src.indexOf('export interface RetaskProtectionFacts'));
    expect(iface.slice(0, 1200)).not.toMatch(/^\s*deliverableShown\??:/m);
  });
});

describe('branch 2 — Key 1 filed, Key 2 not (SURVIVED T10F, UNTOUCHED)', () => {
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
    // PHASE-2 T10F: the first example was `deliverableShown: true`; with that branch retired
    // the two REACHABLE protected shapes stand in its place, so the clause still exercises
    // more than one route into the refusal.
    expect(retaskIsRefused(facts({ status: 'complete' }), undefined)).toBe(true);
    expect(retaskIsRefused(facts({ closeRequestPending: true }), undefined)).toBe(true);
  });

  it('allow_regenerate === true opens BOTH branches, deliberately', () => {
    expect(retaskIsRefused(facts({ status: 'complete' }), true)).toBe(false);
    expect(retaskIsRefused(facts({ closeRequestPending: true }), true)).toBe(false);
  });

  it('ONLY a real boolean true opens it — a weak model\'s truthy value does not', () => {
    // #77 absorb-don't-refuse forgives argument SHAPE everywhere else in this surface. It
    // must not forgive it here: the whole point is that overwriting delivered work is an
    // explicit choice somebody made, and "true"/1/"yes" arriving from a confused model is
    // not that choice.
    for (const v of ['true', 1, 'yes', 'TRUE', {}, [], 'allow']) {
      expect(retaskIsRefused(facts({ status: 'complete' }), v),
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
