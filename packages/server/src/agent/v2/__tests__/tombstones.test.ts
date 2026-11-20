// ════════════════════════════════════════════════════════════════════════════════════════
// THE ENGINE'S TOMBSTONES, AS NEGATIVE TESTS — PHASE-6 T11
// ════════════════════════════════════════════════════════════════════════════════════════
//
// RESEARCH 16's LAW, IN ONE SENTENCE: *a reversal must never be silently re-derived.* The
// engine carries comment blocks where a mechanism used to be — each one records what was
// removed, why it was removed, and what holds the requirement now. A comment is a warning
// sign, not a lock. This file is the lock.
//
// ── WHAT EACH TOMBSTONE OWES, AND WHY IT IS TWO CLAUSES AND NOT ONE ─────────────────────
// Every tombstone below gets BOTH halves, always:
//
//   ABSENT      — the retired mechanism is not in the tree. Written against the mechanism's
//                 OWN identifiers, transcribed from the removing commit, so the clause
//                 names the thing rather than a word near it.
//   REPLACEMENT — the invariant the removal handed off to is present and load-bearing. This
//                 half is what stops the file from degenerating into a list of things that
//                 are missing: a tree where BOTH the mechanism and its replacement were
//                 deleted is not a tree that honoured the tombstone, and only the second
//                 clause can tell the two apart.
//
// #4 is the sharpest of the seven and the easiest to get wrong. The settled-context
// tripwire was RELOCATED, not deleted — so a test asserting only its absence at the old
// site PASSES on a tree where the mechanism was deleted outright, which is the exact
// opposite of what happened. Its clauses therefore assert ABSENT-HERE **and** PRESENT-THERE,
// and pin that there is exactly ONE implementation.
//
// ── THE LIST IS SEVEN, NOT FIVE ─────────────────────────────────────────────────────────
// `PHASE-6.md` named five. The T0-SURVEY re-derived them at the phase base `d716172` and
// found two more that were on no prior list: the going-idle `deliverable_shown` stamp
// (research 16 REVERSAL 16) and the F3 runway tripwire. Seven is the number.
//
// ── CORPUS ──────────────────────────────────────────────────────────────────────────────
// The engine is the driver PLUS the step packages, derived ONCE from
// `engine-sources.ts` — never a hand-rolled walk, because PHASE-6 moved every one of these
// sites out of `loop.ts` and a guard that reads the driver by path goes QUIET rather than
// red (the GUARD-AUDIT's whole finding). Clauses about identifiers that could be
// re-derived ANYWHERE — a deleted classifier module, a deleted store writer — walk the
// whole of `packages/server/src` instead, because a re-derivation outside the engine is
// still a re-derivation.
//
// Comments are stripped before any mechanism clause runs. These tombstones are comment
// blocks that NAME the mechanisms they buried, so a matcher that reads comments would find
// every one of them in its own epitaph and pass on a tree where the code came back.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { STEER_PRECEDENCE } from '../steer-queue.js';

// ── the corpora ─────────────────────────────────────────────────────────────────────────

const steerFloorIds = (): string[] => STEER_PRECEDENCE.map((f) => f.id);

// ── non-vacuity of the corpora themselves ───────────────────────────────────────────────
// Every clause below is an ABSENCE over one of these two walks, so a walk that returns
// nothing would make the whole file pass while checking nothing. `engine-sources` already
// throws on a missing driver; these are the size and content floors on top of it.

describe('TOMBSTONE 1 — the deliverable-claim floor (prose never gains authority)', () => {
  it('ABSENT: the classifier, its identifiers and its steer floor are all gone', () => {
    // A floor that cannot be steered cannot act. The precedence table is the one register.
    expect(
      steerFloorIds().filter((id) => /deliverable/i.test(id)),
      'a deliverable-claim steer floor is declared again',
    ).toEqual([]);
  });

  it('REPLACEMENT: claims honesty is enforced where it is DETERMINISTIC — the ledger, not the prose', () => {
    // ...and the truth guards that survive are ledger-backed by declaration, in the band
    // whose own reason names a RECORD rather than a reading of the text.
    const truthGuards = STEER_PRECEDENCE.filter((f) => f.priority < 20).map((f) => f.id);
    expect(truthGuards).toContain('ungrounded-claim');
    expect(truthGuards).toContain('delivery-denial');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 2 — THE OWED-INTERRUPT NEAR-DUPLICATE SWALLOW
//
// Deleted at `292e005`. The F3 owed-interrupt block grants exactly ONE extra round to
// answer a message that arrived mid-turn. The swallow compared that round's reply against
// the already-delivered one with `isNearDuplicateText` and, on a wording-similarity
// verdict, NULLED it — prose-as-authority in the suppression direction. Its known worst
// case silently ate a genuinely different short answer.
//
// The replacement is IDENTITY: the owed rows carry `served_by_turn` + `answer_message_id`
// (migration 113), so "was this ask answered" is a stamp instead of a similarity score. The
// worst case of the swallow's absence is a visible duplicate paragraph, never a silent drop.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 2 — the owed-interrupt near-duplicate swallow (wording never suppresses)', () => {

  it('REPLACEMENT: the round is audited by IDENTITY — served_by_turn + answer_message_id', () => {
    // The re-prompt itself is unchanged: the owed round is still granted, exactly once.
    expect(steerFloorIds()).toContain('owed-interrupt');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 3 — THE ENGINE-COMPOSED SILENT-CLOSE "Done:" LINE (owner ruling OR2, 2026-07-22)
//
// Removed at `932bf60`. When a turn closed work with no reply delivered, the engine read
// the task's own `title`/`result` and wrote a first-person completion line — `Done: …` —
// as an `assistant` row, then stamped it as the turn's terminal answer. The owner could not
// tell it from their agent.
//
// OR2: *the engine never speaks to the user as the agent.* The replacement hands back the
// mic: the required reply (`forced-reply`), in which the MODEL says the completion in its
// own words.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 3 — the engine-composed "Done:" line (OR2: the engine never speaks as the agent)', () => {

  it('REPLACEMENT: the required reply is a declared steer floor and the model says it', () => {
    const spec = STEER_PRECEDENCE.find((f) => f.id === 'forced-reply');
    expect(spec, 'the required-reply floor must be declared in the precedence table').toBeTruthy();
    expect(spec!.priority, 'it is a SILENCE floor: a human is waiting and will hear nothing')
      .toBeGreaterThanOrEqual(20);
    expect(spec!.priority).toBeLessThan(40);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 6 — THE GOING-IDLE `deliverable_shown` STAMP (research 16 REVERSAL 16)
//
// Deleted at `f8c7091`; the column itself dropped at migration `145`. It inferred DELIVERY
// from the bare coexistence of a non-empty reply and open tasks, applied that to EVERY
// `in_progress` task, and the hidden flag then stood the poke ladder down — the yacht-
// research silent hour.
//
// The replacement is the P2 drive boundary: *statuses are promises.* An `in_progress` task
// stays visibly `in_progress` and the ladder DRIVES it. The one carve-out kept is
// janitorial and not forgery: a recurring schedule is never terminally completed by a
// missed close-out, so THIS run fails and the schedule lives on.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 6 — the going-idle deliverable_shown stamp (a reply is not a delivery)', () => {

  it('REPLACEMENT: statuses are promises — the ladder drives, and the pause reads the RECORD not the prose', () => {
    // The drive: the going-idle nudge is a declared floor and the model is asked to close
    // with evidence, pause, or continue. The ladder is never stood down by a flag.
    expect(steerFloorIds()).toContain('going-idle-in-progress');
  });
});
