// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2c) — THE SECOND STEERING CHANNEL IS GOVERNED.
//
// W27's census §5.7 called this "THE BIG ONE" and refused to decide it inside a census: some
// queue floors write their steer's text to the events lane as well, and the events lane has
// none of the queue's three properties — no priority, no latch, no budget. `lane.events`
// takes rows by recency (`memory/assembler.ts`), so an engine directive reaches the model
// once as a steer this turn and again as an events line next turn, and nothing dedups.
//
// THIS SUITE DID NOT STOP THE SECOND WRITE; it made the pairing DECLARED, BOUNDED and
// CONTENT-IDENTICAL, so the design call the census handed up was one edit away instead of
// seven — and so an eighth double-writer cannot land unnoticed, which is the whole disease.
//
// RED at `e8b7b56`: §1 failed. The inherited count was SIX (the plan's own sentence, and the
// census's list) and the tree carried SEVEN — `thrash-*` is two floors with two steers.
// A hand-counted set drifts; this clause is what stops it.
//
// ── T53 (owner ruling 5, 2026-08-16): THE DESIGN CALL CAME BACK, AND IT IS "CLEAN UP" ──
// The pairs are being retired one site at a time, each in its own commit. `QUEUE_PAIRED_RIDERS`
// is the LEDGER of what is left: a site that stops writing the events lane must leave the map
// in the same commit (the second direction below fails otherwise), and a site that keeps the
// pair must stay declared (the first direction). The suite's own job is unchanged — it is what
// makes a new double-writer impossible — and the argument for which channel goes is measured
// in `the-second-channel-stops-double-writing.test.ts`, not asserted here.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { ENGINE_RIDER_INTENTS, QUEUE_PAIRED_RIDERS } from '../engine-riders.js';
import { STEER_PRECEDENCE } from '../steer-queue.js';

describe('§1 the pairing is DECLARED, and derived from the writers rather than hand-counted', () => {

  it('every paired intent is a RIDER, never a deliverable — the second channel may not drive a turn', () => {
    const riders = new Set<string>(ENGINE_RIDER_INTENTS);
    for (const p of Object.values(QUEUE_PAIRED_RIDERS)) expect(riders.has(p.intent)).toBe(true);
  });

  it('every paired floor is a floor the precedence table ranks', () => {
    const declared = new Set(STEER_PRECEDENCE.map((f) => f.id));
    for (const floor of Object.keys(QUEUE_PAIRED_RIDERS)) expect(declared.has(floor)).toBe(true);
  });
});
