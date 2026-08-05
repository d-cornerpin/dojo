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
import fs from 'node:fs';
import path from 'node:path';
import { engineSources, engineFileContaining, SERVER_SRC } from './engine-sources.js';
import { STEER_PRECEDENCE } from '../steer-queue.js';

// ── the corpora ─────────────────────────────────────────────────────────────────────────

/** Comments first: a matcher that reads a tombstone's own epitaph reports code that is gone. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

interface Source { rel: string; code: string; raw: string }

/** The engine — driver plus step packages — with comments stripped. */
function engineCode(): Source[] {
  return engineSources().map((s) => ({ rel: s.rel, raw: s.text, code: stripComments(s.text) }));
}

/** One named engine file. Throws when the name is stale, so a moved site fails loudly. */
function engineFile(rel: string): Source {
  const hit = engineCode().find((s) => s.rel === rel);
  if (!hit) {
    throw new Error(
      `tombstones: no engine source at ${rel}. The site MOVED or was renamed — re-point this ` +
      'clause at wherever it went. Passing on a missing file is how a guard goes quiet.',
    );
  }
  return hit;
}

/** Every production `.ts` under `packages/server/src` — tests, fixtures and typings out. */
function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    for (const e of fs.readdirSync(path.join(SERVER_SRC, relDir), { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') walk(rel);
        continue;
      }
      if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')
        && !e.name.endsWith('.test.ts') && !e.name.endsWith('.spec.ts')) out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/** Production files whose CODE (not comments) contains `needle`. */
function productionHits(needle: string): string[] {
  return productionFiles()
    .filter((rel) => stripComments(fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8')).includes(needle));
}

/** Engine files whose CODE matches `re`, as `rel` strings. */
function engineMatches(re: RegExp): string[] {
  return engineCode().filter((s) => re.test(s.code)).map((s) => s.rel);
}

const steerFloorIds = (): string[] => STEER_PRECEDENCE.map((f) => f.id);

// ── non-vacuity of the corpora themselves ───────────────────────────────────────────────
// Every clause below is an ABSENCE over one of these two walks, so a walk that returns
// nothing would make the whole file pass while checking nothing. `engine-sources` already
// throws on a missing driver; these are the size and content floors on top of it.

describe('the tombstone corpora are real before anything is asserted absent from them', () => {
  it('the engine walk finds the driver and the step packages', () => {
    const engine = engineCode();
    expect(engine.length, 'the engine walk collapsed').toBeGreaterThan(40);
    expect(engine.map((s) => s.rel)).toContain('agent/v2/loop.ts');
    expect(
      engine.filter((s) => s.rel.startsWith('agent/v2/steps/')).length,
      'the step packages are missing — every mechanism clause would pass vacuously',
    ).toBeGreaterThan(35);
  });

  it('the production walk finds the whole server, and the comment stripper leaves code alone', () => {
    expect(productionFiles().length, 'the production walk collapsed').toBeGreaterThan(300);
    // Positive controls: things that DO exist must be found, or an absence proves nothing.
    expect(productionHits('export function finalizeTurn')).toContain('agent/v2/turn-record.ts');
    expect(productionHits('export function setAnswerMessageId')).toContain('memory/message-store.ts');
    // ...and the stripper must not eat code that merely mentions a comment marker.
    expect(stripComments('const a = "http://x"; // gone\nconst b = 1;')).toContain('const b = 1;');
    expect(stripComments('const a = "http://x"; // gone')).toContain('http://x');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 1 — THE DELIVERABLE-CLAIM FLOOR (research 16 REVERSAL 12)
//
// Removed 2026-07-19, the same day it landed, at `2726fab`. It read the terminal reply's
// PROSE for a completion claim, checked it against a hard-coded artifact-receipt tool list,
// and STEERED when the two disagreed. The first full battery with it live steered a
// TRUTHFUL completion — a checklist task whose work WAS its `technique_read` calls, and
// reads appear in no artifact-receipt list — and the floor model answered the steer by
// spiralling re-reads until turns blew their windows (run `bmrrg3lk3db`).
//
// The design law it violated, in the removing commit's own words: *prose classification is
// safe as an observer and wrong as an actor.*
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 1 — the deliverable-claim floor (prose never gains authority)', () => {
  it('ABSENT: the classifier, its identifiers and its steer floor are all gone', () => {
    expect(
      fs.existsSync(path.join(SERVER_SRC, 'agent/v2/classifiers/deliverable-claim.ts')),
      'the deliverable-claim classifier module is back',
    ).toBe(false);
    // The floor's own identifiers, transcribed from `2726fab`. Walked across ALL production
    // source, not just the engine: a re-derivation that puts the classifier back under
    // `classifiers/` and imports it is exactly the shape this has to catch.
    for (const ident of [
      'detectDeliverableClaim',
      'hadReceiptToolThisTurn',
      'DELIVERABLE_RECEIPT_TOOLS',
      'nudgedForDeliverableClaimThisTurn',
    ]) {
      expect(
        productionHits(ident),
        `${ident} is the deliverable-claim floor's own name and it is back in production source. `
        + 'It steered a truthful completion into a re-read spiral and was removed the day it landed.',
      ).toEqual([]);
    }
    // A floor that cannot be steered cannot act. The precedence table is the one register.
    expect(
      steerFloorIds().filter((id) => /deliverable/i.test(id)),
      'a deliverable-claim steer floor is declared again',
    ).toEqual([]);
  });

  it('REPLACEMENT: claims honesty is enforced where it is DETERMINISTIC — the ledger, not the prose', () => {
    // The rekey. `claimed-delivery.ts` asks the delivery LEDGER whether the claimed send
    // happened, and the floor STANDS DOWN when the ledger answers — that stand-down is the
    // whole difference between reading rows and reading wording.
    const claimed = fs.readFileSync(path.join(SERVER_SRC, 'agent/v2/claimed-delivery.ts'), 'utf8');
    expect(stripComments(claimed), 'the claimed-delivery floor must read the deliveries ledger')
      .toMatch(/FROM deliveries/);
    const floors = engineFile('agent/v2/steps/post-call-classify/reply-floors.ts');
    expect(floors.code, 'the reply floors must consult the ledger-backed decision')
      .toMatch(/decideClaimedDelivery\(/);
    // Named to the CLAIMED-DELIVERY floor, not to any floor that happens to use the same
    // sentence: a sibling floor's stand-down would otherwise satisfy this clause and it
    // would stop saying anything about the mechanism that replaced the tombstone. (The
    // planted fault found exactly that — two floors share the wording.)
    expect(floors.code, 'the ledger must be able to STAND THIS FLOOR DOWN, not merely feed it')
      .toMatch(/claimed-delivery floor stood down; the ledger answered/);
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
  it('ABSENT: the swallow\'s carriers are gone and the owed round reads no wording', () => {
    for (const ident of ['owedInterruptPriorReply', 'nudgedForOwedInterruptThisTurn']) {
      expect(
        productionHits(ident),
        `${ident} carried the already-delivered reply so the granted round could be compared `
        + 'against it. It is back.',
      ).toEqual([]);
    }
    // The two sites the swallow lived at, named. Neither may read similarity at all.
    for (const rel of [
      'agent/v2/steps/post-call-classify/owed-interrupt.ts',
      'agent/v2/steps/post-call-classify/closeout-floors.ts',
    ]) {
      expect(
        engineFile(rel).code,
        `${rel} reads text similarity again — this is the site the swallow was deleted from`,
      ).not.toMatch(/isNearDuplicateText|similarity|nearDuplicate/i);
    }
    // A CENSUS, not a sample: similarity survives in the engine at exactly two sites, and
    // both are named. A third one anywhere is a re-derivation and fails here.
    expect(
      engineMatches(/isNearDuplicateText\s*\(/).sort(),
      'a new near-duplicate call site appeared in the engine. The two survivors are the '
      + 'within-turn dedup and the cross-turn respond-once read, both of which SKIP any turn a '
      + 'human is waiting on. A third site is the swallow coming back under another name.',
    ).toEqual([
      'agent/v2/steps/post-call-classify/reply-floors.ts',
      'agent/v2/steps/post-call-classify/turn-classification.ts',
    ]);
  });

  it('REPLACEMENT: the round is audited by IDENTITY — served_by_turn + answer_message_id', () => {
    const store = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'memory/message-store.ts'), 'utf8'));
    // The stamp exists, keys on the SERVE edge, and never overwrites an answer already recorded.
    expect(store).toMatch(/export function setAnswerMessageId/);
    expect(store, 'the answer stamp must key on served_by_turn, the serve edge')
      .toMatch(/served_by_turn\s*=\s*@servedByTurn/);
    expect(store, 'the answer stamp must never overwrite an answer already recorded')
      .toMatch(/answer_message_id IS NULL/);
    // ...and the engine actually stamps it, at the turn's own teardown.
    const record = engineFile('agent/v2/steps/teardown/finalize-record.ts');
    expect(record.code, 'the teardown must stamp the answering reply onto the rows the turn served')
      .toMatch(/setAnswerMessageId\(\{[^}]*servedByTurn/);
    // The re-prompt itself is unchanged: the owed round is still granted, exactly once.
    expect(steerFloorIds()).toContain('owed-interrupt');
    expect(engineFile('agent/v2/steps/post-call-classify/owed-interrupt.ts').code)
      .toMatch(/steerFired\(state\.steerQueue, 'owed-interrupt'\)/);
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
// OR2: *the engine never speaks to the user as the agent.* The replacement keeps the SAME
// check and hands back the mic — the `silent-closeout` steer, after which the MODEL says
// the completion in its own words.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 3 — the engine-composed "Done:" line (OR2: the engine never speaks as the agent)', () => {
  it('ABSENT: nothing in the engine composes a completion sentence, and the driver writes no reply at all', () => {
    // The composer's own two literals, transcribed from `932bf60`:
    //   `Done: ${resultBit}` / `Done, "${first.title.slice(0, 60)}" is complete.`
    expect(
      engineMatches(/Done:\s*\$\{|Done,\s*\\?["']?\$\{/),
      'an engine-composed completion line is back',
    ).toEqual([]);
    // The driver held the composer. It now composes and persists NO user-facing text at all —
    // the strongest form of the ruling, and a structural fact rather than a wording check.
    expect(
      engineFile('agent/v2/loop.ts').code,
      'the driver is persisting assistant text again — the engine wearing the agent\'s face',
    ).not.toMatch(/role:\s*'assistant'/);
    // The gate that used to compose now resolves to a STEER and writes nothing.
    const gate = engineFile('agent/v2/steps/post-call-classify/silent-closeout.ts');
    expect(gate.code, 'the silent-closeout gate must hand the mic back, never take it')
      .not.toMatch(/role:\s*'assistant'|insertMessageIfAbsent\s*\(/);
  });

  it('REPLACEMENT: the same check survives as a declared steer floor and the model says it', () => {
    const gate = engineFile('agent/v2/steps/post-call-classify/silent-closeout.ts');
    // The check is intact — an ending turn that closed work while nothing user-facing surfaced.
    expect(gate.code).toMatch(/steerFired\(state\.steerQueue, 'silent-closeout'\)/);
    expect(gate.code, 'the gate must still test that nothing user-facing surfaced')
      .toMatch(/surfacedReplyThisTurn/);
    expect(gate.code, 'the gate must still key on work that closed without a delivery')
      .toMatch(/closedWithoutDelivery\(/);
    // ...and its outcome is a queued steer with a declared precedence, not a message.
    expect(gate.code).toMatch(/enqueueSteer\(/);
    const spec = STEER_PRECEDENCE.find((f) => f.id === 'silent-closeout');
    expect(spec, 'the silent-closeout floor must be declared in the precedence table').toBeTruthy();
    expect(spec!.priority, 'it is a SILENCE floor: a human is waiting and will hear nothing')
      .toBeGreaterThanOrEqual(20);
    expect(spec!.priority).toBeLessThan(40);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 4 — THE SETTLED-CONTEXT TRIPWIRE, **RELOCATED** (the trap in this task)
//
// Moved at `5604f6d` from the in-loop calibration site to the end-of-turn ROUTE site,
// because its 2026-07-18 upgrade (the phantom-outreach fix) HOLDS the auto-route channel
// push — and a hold can only be applied where the destination is resolved. Keeping the
// in-loop copy would have left two implementations free to drift.
//
// ⚠ THIS IS THE ONE THAT ABSENCE ALONE GETS WRONG. A clause asserting only "it is not at
// the in-loop site" passes on a tree where the tripwire was DELETED OUTRIGHT — the opposite
// of what happened, and a silent loss of the phantom-outreach fix. So: ABSENT-HERE, and
// PRESENT-THERE, and EXACTLY ONE of it.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 4 — the settled-context tripwire was RELOCATED, not deleted', () => {
  it('PRESENT-THERE: exactly one implementation, and it lives at the route decision', () => {
    // `engineFileContaining` throws when two files hold it — which is the drift the move
    // existed to prevent, reported rather than silently resolved to the first hit.
    const home = engineFileContaining('const settledContextHold');
    expect(home, 'the settled-context hold is in NO engine file — the tripwire was deleted, not moved. '
      + 'That is the failure this clause exists for: the phantom-outreach fix would be gone.').toBeTruthy();
    expect(home!.rel, 'the hold must live at the route decision, where the destination is resolved')
      .toBe('agent/v2/steps/finalize/route-reply.ts');
    const route = engineFile('agent/v2/steps/finalize/route-reply.ts');
    // It is APPLIED, not merely computed — and it withholds the PUSH only, never the reply.
    expect(route.code, 'the hold must be applied to the channel push')
      .toMatch(/settledContextHold\s*&&\s*destination\s*!==\s*'dashboard'/);
    // The affirmative-root read is the single decision the hold is derived from (PHASE-4 T4).
    expect(
      engineMatches(/outboundRoot\s*\(\s*\{/),
      'the affirmative-root decision must be reached from exactly one engine site',
    ).toEqual(['agent/v2/steps/finalize/route-reply.ts']);
  });

  it('ABSENT-HERE: the in-loop calibration site holds no implementation, and its note points at the move', () => {
    const inLoop = engineFile('agent/v2/steps/post-call-classify/missed-reply.ts');
    expect(inLoop.code, 'a second settled-context implementation is back inside the model loop — '
      + 'two copies free to drift is exactly what the move removed')
      .not.toMatch(/settledContextHold|outboundRoot\s*\(/);
    // The note is the record. It must still name where the mechanism WENT, or the next
    // reader finds an absence with no forwarding address and re-derives it.
    expect(inLoop.raw, 'the relocation note must survive and must name the route site')
      .toMatch(/Settled-context tripwire: MOVED to the end-of-turn route site/);
    expect(inLoop.raw).toMatch(/Settled-context hold/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 5 — THE START-ACK AS A LOOP-BOUNDARY CHECK (a REFUSAL, not a deletion)
//
// This tombstone records a mechanism that was refused rather than one that was removed. A
// start-ack floor evaluated at the loop boundary can only fire BETWEEN model rounds, and a
// single slow first round pushed the ack to seconds before the reply (observed live), while
// wakeup/drain turns with a user counterparty but no waiting human got a stray "On it."
// attached to nothing.
//
// The floor is a WALL-CLOCK TIMER armed at turn start (`524618b`), gated twice: armed only
// when a human is waiting NOW (`triggerRow`), and it only speaks when the turn has actually
// started using tools by the time it fires (the owner's slow-local-model report).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 5 — the start-ack floor is a timer, never a loop-boundary check', () => {
  it('ABSENT: no loop boundary fires the ack — the call sites are the timer and the first-tool hook, and nothing else', () => {
    expect(
      engineMatches(/fireStartAckIfOwed\s*\(/).sort(),
      'the start-ack is fired from somewhere new. A boundary check can only fire between '
      + 'model rounds, which is what put the ack seconds before the reply and stuck a stray '
      + '"On it." on drain turns.',
    ).toEqual([
      'agent/v2/steps/execute/run-one.ts',      // the first-tool hook: work that starts late
      'agent/v2/steps/preflight/start-ack.ts',  // the definition and its timer
    ]);
    // Named negatively as well, because the pre-call gates ARE the loop boundary: that
    // package is where a re-derived boundary check would land, and it holds the tombstone.
    for (const s of engineCode().filter((f) => f.rel.startsWith('agent/v2/steps/pre-call-gates/'))) {
      expect(s.code, `${s.rel} fires the start-ack at the loop boundary — the refused design`)
        .not.toMatch(/fireStartAckIfOwed\s*\(/);
    }
  });

  it('REPLACEMENT: a wall-clock timer armed at turn start, work-gated, and cancelled at teardown', () => {
    const ack = engineFile('agent/v2/steps/preflight/start-ack.ts');
    // Armed at turn start, by the clock.
    expect(ack.code, 'the floor must be a timer armed at turn start')
      .toMatch(/if\s*\(startAckArmed\)\s*\{[\s\S]{0,80}setTimeout\(/);
    // Gate 1 — a human is waiting NOW. `triggerRow` is the same signal the close-out gate trusts.
    expect(ack.code, 'the timer must arm only when this turn serves a waiting human')
      .toMatch(/startAckArmed\s*=\s*counterparty\.kind === 'user' && !!triggerRow/);
    // Gate 2 — the ack exists for WORK, not conversation (owner report 2026-07-10).
    expect(ack.code, 'the timer must stay quiet on a chat-shaped turn')
      .toMatch(/if\s*\(!turnCtx\.anyToolStartedThisTurn\)/);
    // The handle outlives no turn: armed here, cancelled in the teardown that always runs.
    expect(ack.code).toMatch(/turnCtx\.startAckTimer\s*=\s*setTimeout\(/);
    expect(
      engineFile('agent/v2/steps/teardown/index.ts').code,
      'the timer must be cancelled on every exit path or an ack outlives its turn',
    ).toMatch(/clearTimeout\(turnCtx\.startAckTimer\)/);
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
  it('ABSENT: no writer, and the engine reads the flag nowhere in code', () => {
    expect(
      productionHits('markDeliverableShown'),
      'the hidden-second-status writer is back. It marked every in_progress task delivered '
      + 'from the mere fact that a reply existed, and stood the ladder down invisibly.',
    ).toEqual([]);
    expect(
      engineMatches(/deliverable_shown|deliverableShown/),
      'the engine reads or writes the stand-down flag again (comments are stripped, so this '
      + 'is code, not the tombstone naming itself)',
    ).toEqual([]);
    // The going-idle site itself: the only write left in the post-nudge block is the
    // recurring carve-out, and it is scoped to schedules by its own WHERE clause.
    const idle = engineFile('agent/v2/steps/post-call-classify/going-idle.ts');
    expect(idle.code, 'the recurring carve-out must stay scoped to recurring rows')
      .toMatch(/repeat_interval IS NOT NULL/);
    expect(idle.code, 'going-idle must not transition one-shot work off the back of a reply')
      .not.toMatch(/state\s*=\s*'done'|status\s*=\s*'complete'/);
  });

  it('REPLACEMENT: statuses are promises — the ladder drives, and the pause reads the RECORD not the prose', () => {
    // The drive: the going-idle nudge is a declared floor and the model is asked to close
    // with evidence, pause, or continue. The ladder is never stood down by a flag.
    expect(steerFloorIds()).toContain('going-idle-in-progress');
    expect(engineFile('agent/v2/steps/post-call-classify/going-idle.ts').code)
      .toMatch(/floor: 'going-idle-in-progress'/);
    // The one disposition that MAY move drive-state work keys on the engine's own turn
    // record — `exit_reason`, `answered`, `effectful_calls` — and reads no text at all.
    const edge = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'agent/v2/answered-edge.ts'), 'utf8'));
    expect(edge, 'the pause must key on the turn record').toMatch(/exit_reason/);
    expect(edge, 'the pause must require a turn that did no effectful work').toMatch(/effectful_calls/);
    expect(
      edge,
      'a prose read appeared in the disposition that pauses drive-state work — this is the '
      + 'stamp\'s defect returning at the site that replaced it',
    ).not.toMatch(/RegExp|\.match\(|isNearDuplicateText|persistedContent/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 7 — THE F3 RUNWAY TRIPWIRE (a log-only guard on a guard)
//
// Deleted at `292e005` alongside the near-duplicate swallow. It recorded the loop count at
// which the owed-interrupt re-prompt fired and warned once if the granted round kept
// iterating more than three loops past it. It never blocked anything: it was an instrument
// watching another instrument, and its whole question — how did this round actually end —
// is a column now.
//
// The replacement: the turns record audits the round.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('TOMBSTONE 7 — the F3 runway tripwire (the turn record audits the round)', () => {
  it('ABSENT: the tripwire\'s counters and its warning are gone', () => {
    for (const ident of ['owedInterruptRePromptLoopCount', 'owedInterruptRunwayWarned']) {
      expect(productionHits(ident), `${ident} is back — the guard on the guard`).toEqual([]);
    }
    expect(
      engineMatches(/runway/i),
      'a runway tripwire is back in the engine. It answered "how did the granted round end", '
      + 'which the turn record answers durably.',
    ).toEqual([]);
  });

  it('REPLACEMENT: every turn ends by recording HOW it ended, from exactly one place', () => {
    const record = fs.readFileSync(path.join(SERVER_SRC, 'agent/v2/turn-record.ts'), 'utf8');
    const finalize = stripComments(record.slice(record.indexOf('export function finalizeTurn')));
    // The audit the tripwire was standing in for, as columns.
    expect(finalize).toMatch(/UPDATE turns/);
    expect(finalize).toMatch(/exit_reason\s*=\s*\?/);
    expect(finalize).toMatch(/answered\s*=\s*\?/);
    expect(finalize, 'the effectful-call count may only ever rise — two observation points, one safe direction')
      .toMatch(/effectful_calls = MAX\(effectful_calls, \?\)/);
    // ONE auditor: the turn's own teardown, on every exit path.
    expect(
      engineMatches(/finalizeTurn\s*\(/),
      'the turn record must be finalized from exactly one engine site',
    ).toEqual(['agent/v2/steps/teardown/finalize-record.ts']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE RECORD ITSELF — research 16's law, applied to the notes rather than the code.
//
// A tombstone whose note is quietly deleted leaves an absence with no explanation, and the
// next reader re-derives the mechanism in good faith. That is the exact failure mode the
// reversals list exists to prevent, so the notes are load-bearing and this clause says so.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('the seven tombstone NOTES survive, each in the engine, each naming its removal', () => {
  // Phrases are matched against the notes UNWRAPPED — leading `//` markers dropped and
  // whitespace collapsed — so a re-flow of a comment block cannot fail this clause. What it
  // polices is the SENTENCE, which is the record; where the line breaks fall is not.
  const NOTES: ReadonlyArray<{ n: number; what: string; phrase: string }> = [
    { n: 1, what: 'deliverable-claim floor', phrase: 'Deliverable-claim floor: REMOVED same day it landed' },
    { n: 2, what: 'owed-interrupt near-duplicate swallow', phrase: 'the owed-interrupt near-duplicate swallow that lived here was DELETED' },
    { n: 3, what: 'engine-composed "Done:" line', phrase: 'The engine-composed silent-close "Done:" line that briefly lived here is GONE' },
    { n: 4, what: 'settled-context tripwire relocation', phrase: 'Settled-context tripwire: MOVED to the end-of-turn route site' },
    { n: 5, what: 'start-ack as a loop-boundary check', phrase: 'the start-ack floor is the wall-clock timer armed at turn start' },
    { n: 6, what: 'going-idle deliverable_shown stamp', phrase: 'going-idle deliverable_shown stamp that lived here was DELETED' },
    { n: 7, what: 'F3 runway tripwire', phrase: 'the F3 runway tripwire (a log-only guard on the guard) was DELETED' },
  ];

  /** Comment markers dropped, whitespace collapsed — the sentence, free of its wrapping. */
  const unwrap = (s: string): string => s
    .replace(/^\s*(\/\/|\*)\s?/gm, ' ')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ');

  it('all seven are present', () => {
    const raw = unwrap(engineSources().map((s) => s.text).join('\n'));
    const missing = NOTES.filter((t) => !raw.includes(t.phrase)).map((t) => `${t.n} — ${t.what}`);
    expect(
      missing,
      'a tombstone note was deleted. The note is the forwarding address: without it the next '
      + 'reader finds an absence, cannot see what it replaced, and re-derives the mechanism.',
    ).toEqual([]);
  });

  it('the list is SEVEN — the survey\'s number, not the plan\'s five', () => {
    expect(NOTES.length).toBe(7);
    expect(new Set(NOTES.map((t) => t.n)).size).toBe(7);
  });
});
