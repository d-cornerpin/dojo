// ⚠ THE CLAIM. On a user's box the PM held three validations that could never be satisfied, and the
// stall capture found the identical fingerprint every minute for hours: tick, review, no verdict,
// re-drive. Three rows bought one full PM review — board assembly, an engine event, a model turn —
// every 60 seconds, for ever.
//
// So two things are asserted here and they pull against each other on purpose:
//   1. THE FIREHOSE IS BOUNDED — a wedged set costs tens of reviews a day, not 1,440.
//   2. AND IT IS NEVER DROPPED — the gap stops growing, so the row is still reviewed for ever. A
//      bound that eventually abandoned a row awaiting Key 2 would re-create the exact silence
//      SWEEP-A TB8 JOB 2 removed, which is the fix this one is bounding.
// Plus the wire, counted in BOTH directions: every release of the dedup hash must have decided what
// it does about the backoff, so a fourth release added without deciding reds a clause.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';

import {
  reReviewHeldBack, reReviewGapMs, clearReReviewBound, reReviewBoundStateForTest,
  RE_REVIEW_BACKOFF_CAP_MS,
} from '../pm-rereview-bound.js';

/** The platform's poke cadence, which is what `pm-agent.ts` passes in. Not a second clock: a clause
 *  below asserts the real call site hands over `POKE_INTERVAL_MS` and not a number of its own. */
const TICK = 60_000;
const KEY = 'task-aaa|UNVALIDATED_COMPLETE|0';

beforeEach(() => { clearReReviewBound(); });

describe('⚠ THE SCHEDULE — doubling from one tick, and it stops doubling', () => {
  it('the gap doubles per re-drive and then holds at the cap', () => {
    expect(reReviewGapMs(1, TICK)).toBe(TICK);
    expect(reReviewGapMs(2, TICK)).toBe(2 * TICK);
    expect(reReviewGapMs(3, TICK)).toBe(4 * TICK);
    expect(reReviewGapMs(4, TICK)).toBe(8 * TICK);
    // 16 ticks is 16 minutes, 32 would be 32 — the cap bites between them.
    expect(reReviewGapMs(5, TICK)).toBe(16 * TICK);
    expect(reReviewGapMs(6, TICK)).toBe(RE_REVIEW_BACKOFF_CAP_MS);
    expect(reReviewGapMs(99, TICK)).toBe(RE_REVIEW_BACKOFF_CAP_MS);
  });

  it('a gap is never zero and never NEGATIVE, however many drives are counted', () => {
    // ⚠ A REAL TRAP, AVOIDED DELIBERATELY: computing the doubling with `1 << n` wraps negative past
    // 31 bits, and a NEGATIVE gap makes every tick eligible — a bound that becomes a firehose at
    // exactly the point it was most needed.
    for (const drives of [1, 31, 32, 33, 64, 1_000, Number.MAX_SAFE_INTEGER]) {
      const gap = reReviewGapMs(drives, TICK);
      expect(gap, `drives=${drives}`).toBeGreaterThan(0);
      expect(gap, `drives=${drives}`).toBeLessThanOrEqual(RE_REVIEW_BACKOFF_CAP_MS);
    }
  });

  it('the cap is above the product\'s own owner-escalation clock, not below it', () => {
    // By the time the gap reaches its ceiling the owner has long since been told the row is
    // unvalidated (`VALIDATION_ESCALATION_MIN`, 5 minutes), so the review is no longer what stands
    // between him and the information.
    expect(RE_REVIEW_BACKOFF_CAP_MS).toBeGreaterThan(5 * 60_000);
  });
});

describe('⚠ TB8\'s OWN BEHAVIOUR IS UNTOUCHED — the bound bites on the third drive, not the second', () => {
  it('the first re-drive is granted immediately and the second after exactly one tick', () => {
    // TB8 measured TWO PM validation turns in a row returning no verdict, and the re-drive IS its
    // fix. A bound that bit on the second drive would undo the thing it is bounding.
    let t = 1_000_000;
    const first = reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    expect(first.heldBack).toBe(false);
    expect(first.drives).toBe(1);

    t += TICK;
    const second = reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    expect(second.heldBack, 'the second re-drive was held back — TB8\'s fix is undone').toBe(false);
    expect(second.drives).toBe(2);
  });

  it('the THIRD consecutive re-drive waits two ticks, and says how long it still owes', () => {
    let t = 1_000_000;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });

    t += TICK;
    const third = reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    expect(third.heldBack, 'the third re-drive was granted — nothing is bounded').toBe(true);
    expect(third.waitedMs).toBe(TICK);
    expect(third.gapMs).toBe(2 * TICK);

    t += TICK;
    const later = reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    expect(later.heldBack).toBe(false);
    expect(later.drives).toBe(3);
  });
});

describe('⚠ THE HEADLINE: a wedged set costs tens of reviews a day, and is never dropped', () => {
  it('a validation nobody can satisfy is reviewed under 60 times in 24h instead of 1,440', () => {
    // The tick loop, played out: every 60 s the poke fires, the hash has been released by the review
    // that ruled on nothing, and this gate decides.
    const DAY_MS = 24 * 60 * 60_000;
    let t = 1_000_000;
    let granted = 0;
    for (let elapsed = 0; elapsed < DAY_MS; elapsed += TICK) {
      const d = reReviewHeldBack({ key: KEY, nowMs: t + elapsed, baseGapMs: TICK });
      if (!d.heldBack) granted += 1;
    }
    const ticks = DAY_MS / TICK;
    // eslint-disable-next-line no-console
    console.log(`PM RE-REVIEW BOUND  a wedged issue-set over 24h: ${granted} review(s) granted of ${ticks} ticks `
      + `(${(100 * granted / ticks).toFixed(1)}% — pre-fix it was 100%)`);
    expect(ticks).toBe(1440);
    expect(granted, 'the firehose is not bounded').toBeLessThan(60);
    // ⚠ AND NOT DROPPED. The other direction of the same claim: a bound that silenced the row would
    // be the silence TB8 removed, arriving by a new route.
    expect(granted, 'a wedged row stopped being reviewed at all').toBeGreaterThan(10);
  });

  it('and it keeps being reviewed on the SECOND day, and the hundredth', () => {
    let t = 1_000_000;
    // Burn the schedule out to its cap.
    for (let i = 0; i < 40; i += 1) {
      t += RE_REVIEW_BACKOFF_CAP_MS;
      reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    }
    t += RE_REVIEW_BACKOFF_CAP_MS;
    expect(reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK }).heldBack,
      'the row was abandoned once the gap reached the cap').toBe(false);
  });
});

describe('⚠ WHAT RESETS THE SCHEDULE — three things, each for a reason that already exists', () => {
  it('a DOORBELL resets it, because a doorbell IS a change', () => {
    let t = 1_000_000;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    expect(reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK }).heldBack).toBe(true);

    // The dedup hash already exempts a doorbell (SWEEP CORE-2 item 1: a row rung in by its own
    // completion event can carry the same stable id it had a minute ago). The backoff must too, or
    // the exemption is defeated one layer down.
    const rung = reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK, doorbell: true });
    expect(rung.heldBack, 'a doorbell was held back by the backoff').toBe(false);
    expect(rung.drives).toBe(1);
  });

  it('a CHANGED issue-set resets it — the backoff is about one set, not about the PM', () => {
    let t = 1_000_000;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    expect(reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK }).heldBack).toBe(true);
    const other = reReviewHeldBack({ key: 'task-bbb|UNVALIDATED_COMPLETE|0', nowMs: t, baseGapMs: TICK });
    expect(other.heldBack, 'a different issue-set inherited another set\'s backoff').toBe(false);
    expect(other.drives).toBe(1);
  });

  it('a RESOLVED set that recurs arrives on a fresh schedule — AUDIT-FIX\'s finding, second route', () => {
    // {A} -> {} -> {A}. AUDIT-FIX clears the dedup hash on the empty set because the recurrence
    // otherwise compared equal to a stale hash and was skipped until a restart. A backoff record left
    // behind does the identical harm: the same set would come back carrying the gap it earned while
    // it was wedged.
    let t = 1_000_000;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    t += TICK;
    expect(reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK }).heldBack).toBe(true);

    clearReReviewBound();                       // the issue-set emptied
    expect(reReviewBoundStateForTest()).toBeNull();
    const again = reReviewHeldBack({ key: KEY, nowMs: t, baseGapMs: TICK });
    expect(again.heldBack, 'a resolved-then-recurring set inherited its old backoff').toBe(false);
    expect(again.drives).toBe(1);
  });
});

describe('⚠ THE WIRE, COUNTED IN BOTH DIRECTIONS', () => {
  const pmSrc = (): string => {
    const raw = fs.readFileSync(new URL('../pm-agent.ts', import.meta.url), 'utf-8');
    // ⚠ COMMENTS STRIPPED FIRST, and the lesson is this package's own: a bound clause in the search
    // half asserted a function name over the RAW source and the mutant that DELETED THE CALL still
    // passed, because the paragraph above it named the function. A clause that matches its own
    // comment tests the comment.
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  };

  it('the gate is CALLED and its verdict is APPLIED — not merely computed', () => {
    const code = pmSrc();
    expect(code, 'the re-review bound is not called').toMatch(/const\s+backoff\s*=\s*reReviewHeldBack\(\{/);
    // The call shape AND the application: a decision nobody reads is a decision that changed nothing.
    expect(code, 'the verdict is computed and ignored').toMatch(/if\s*\(backoff\.heldBack\)\s*\{/);
    expect(code, 'a held-back tick must RETURN, not fall through').toMatch(
      /if\s*\(backoff\.heldBack\)\s*\{[\s\S]{0,600}?return;\s*\}/);
  });

  it('it declares NO second clock — the cadence comes from the poke loop\'s own constant', () => {
    // The tree's standing rule: a second spelling of one number is how two clocks drift. The bound
    // module takes `baseGapMs` as an argument for exactly this reason.
    const code = pmSrc();
    expect(code).toMatch(/baseGapMs:\s*POKE_INTERVAL_MS/);
    const bound = fs.readFileSync(new URL('../pm-rereview-bound.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The module must REQUIRE the cadence rather than knowing one. A default would be the second
    // spelling — silently correct today and silently wrong the day the poke interval moves.
    expect(bound, 'the bound module gave baseGapMs a default, which is a second clock')
      .not.toMatch(/baseGapMs\s*(=|\?\?)/);
    expect(bound, 'baseGapMs must be a required number on both doors')
      .toMatch(/baseGapMs:\s*number/);
    expect(bound, 'the gap helper must take the cadence, not assume it')
      .toMatch(/reReviewGapMs\(drives: number, baseGapMs: number\)/);
  });

  it('the gate sits AFTER the issue-set-hash comparison, which is the placement decision', () => {
    // Before the comparison it would see every unchanged tick — including the already-cheap case the
    // hash gate exists to skip — and would report a backoff as the reason for a skip whose real
    // reason was "nothing changed". After it, the gate is reached only when something RELEASED the
    // hash, which is the re-drive path this bound is for.
    const code = pmSrc();
    const hashGate = code.indexOf('if (reportHash === lastSituationReportHash && !carriedDoorbell)');
    const boundGate = code.indexOf('reReviewHeldBack({');
    const assignment = code.indexOf('lastSituationReportHash = reportHash;');
    expect(hashGate).toBeGreaterThan(0);
    expect(boundGate, 'the bound runs before the dedup comparison').toBeGreaterThan(hashGate);
    expect(assignment, 'the bound runs after the hash is already consumed').toBeGreaterThan(boundGate);
  });

  it('EVERY release of the dedup hash has decided what it does about the backoff', () => {
    // ⚠ THE OTHER DIRECTION, and the reason this clause is worth more than a presence check. There
    // are THREE places that release `lastSituationReportHash`, each correct in itself: the issue-set
    // emptied (resolved — clears the backoff too), a review that ruled on nothing (TB8's re-drive —
    // the thing being bounded, so it does NOT clear), and a thrown review (retry — also bounded, for
    // the same reason). A FOURTH release added without that decision reds this, and whoever adds it
    // has to come here and say which kind it is.
    const code = pmSrc();
    // ⚠ THE DECLARATION IS NOT A RELEASE. `let lastSituationReportHash = '';` matches the same shape,
    // and counting it made this clause read 4 where the answer is 3 — a lookbehind, not a looser
    // number, because a looser number is how a clause stops counting.
    const releases = (code.match(/(?<!let )lastSituationReportHash\s*=\s*''/g) ?? []).length;
    expect(releases, 'a release of the dedup hash was added or removed without deciding what it does '
      + 'about the re-review backoff — go to pm-rereview-bound.ts and say which kind it is').toBe(3);
    // And exactly ONE of them is the resolved case, so exactly one clears the backoff.
    const clears = (code.match(/clearReReviewBound\(\)/g) ?? []).length;
    expect(clears, 'the resolved-set release must clear the backoff, and nothing else should').toBe(1);
    // The clear belongs to the EMPTY-SET release, not to either of the other two.
    const emptySet = code.indexOf('if (issues.length === 0)');
    const clearAt = code.indexOf('clearReReviewBound()');
    const emptySetReturn = code.indexOf('return;', emptySet);
    expect(emptySet).toBeGreaterThan(0);
    expect(clearAt, 'the backoff clear is not inside the empty-issue-set branch')
      .toBeGreaterThan(emptySet);
    expect(clearAt).toBeLessThan(emptySetReturn);
  });

  it('the skip is READABLE in production and says the row is still queued', () => {
    // The capture's own lesson, and the owner's ruling behind TB8 JOB 2: `logger.debug` is pinned out
    // of existence in production, so a skip at debug level is the silent skip he ruled against. And
    // the line must not read as a drop — the row IS still coming back.
    const code = pmSrc();
    const line = code.slice(code.indexOf('if (backoff.heldBack)'), code.indexOf('lastSituationReportHash = reportHash;'));
    expect(line).toContain('logger.info');
    expect(line, 'a backoff skip that reads as a drop is worse than no line').toContain('not dropped');
    expect(line, 'the skip must carry the numbers a reader needs').toMatch(/reDrives:\s*backoff\.drives/);
    expect(line).toMatch(/waitedMs:\s*backoff\.waitedMs/);
  });
});
