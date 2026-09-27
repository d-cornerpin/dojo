// ════════════════════════════════════════════════════════════════════════════════════════
// A CLAIM THE TOOL REFUSED IS NOT TRUE — the honesty gate, from the Arm C find.
//
// ── THE FIND, verbatim in shape ──────────────────────────────────────────────────────────────
// In ONE turn an agent received a tool result carrying `is_error: true` that said the report was
// CANCELLED and there was NO BRIEF TO SUBMIT — and then told the owner **"submitted!"**. Nothing in
// the engine caught it. The person was told their bug report was on its way to the Dojo's builders
// while the engine's own record of that same turn said the opposite.
//
// ── WHY NOTHING CAUGHT IT, and it is not an oversight ────────────────────────────────────────
// The truth band already holds four guards that ask "the reply asserts X, the ledger says not-X".
// The closest is `ungrounded-claim` (priority 10): *"reply claims a delivery no send tool made"* —
// and it reads the DELIVERIES LEDGER. `dojo_report` is the one user-facing door in this engine that
// writes NO `deliveries` row (0 in the whole database, ever — established across three release-ritual
// rounds), so `ungrounded-claim` STRUCTURALLY CANNOT SEE IT. The report artifact moves by state
// transition, and no ledger-reading guard can ask about it.
//
// ── THE SHAPE THAT DOES WORK IS ALREADY IN THE TREE ──────────────────────────────────────────
// `failed-save-claim` (priority 12, the RC-13.2 floor) asks the same question against THIS TURN'S
// TOOL RESULTS instead of a ledger: the reply says "saved", every `vault_remember` this turn was
// REJECTED, so steer once. That is this find's mechanism exactly, hard-keyed to one tool. So this is
// a THIRTEENTH PREDICATE in the same table, through the same seam, with the same one-shot steer —
// not a new mechanism and NOT a new suppression. The model corrects itself through the ordinary
// re-entry, and `[no-reply]` afterwards is still the ghosted-ask ladder's business.
//
// ── THE SCOPE, AND WHY EACH CONJUNCT IS THERE (the owner's laws both bind) ───────────────────
//   SAME TURN            `state.toolResults` is turn-local by construction. Nothing reaches back.
//   EXPLICIT is_error    not "the tool returned something odd" — the dispatcher's own error flag.
//   NOTHING SUCCEEDED    a turn that errored once and then succeeded made a TRUE claim. §2's control.
//   DELIVERY-SHAPED      the lane's reserved delivery words, never "I looked at it" or "drafting".
//
// A bare "submitted" is enough HERE, and that is a deliberate departure from the kit-side detector
// which requires a destination ("submitted TO the builders"). The kit scans every reply with no other
// evidence, so it needs the destination to stay honest. This floor already holds a far stronger
// conjunct — the same turn's report tool ERRORED and nothing succeeded — so the bare word is
// unambiguous, and requiring a destination here would have MISSED the Arm C reply, which was one word.
//
// ── ERR NARROW, ON THE OWNER'S OWN ARITHMETIC ────────────────────────────────────────────────
// A false positive costs ONE extra beat: the model is handed the tool's own error beside its own
// sentence and re-enters. A false negative is TODAY'S BEHAVIOUR — a person told their report was
// submitted when it was cancelled. §3 is the narrowness half, and every row in it is a claim that
// must NOT fire.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { STEER_PRECEDENCE, steerPriority } from '../../../steer-queue.js';
import { TRUTH_GUARDS } from '../reply-floors.js';
// ⚠ `reply-floors.ts` is a STEP PACKAGE file, so it is read through the shared corpus rather than by
// path — `guard-corpus-census.test.ts` refuses the hand-rolled walk, and it has caught this exact
// shortcut three times in this branch already.
import { engineFileContaining } from '../../../__tests__/engine-sources.js';

/** The floor under test, found by id rather than by index so the table can be reordered. */
const guard = (): (typeof TRUTH_GUARDS)[number] =>
  TRUTH_GUARDS.find((g) => g.floor === 'false-delivery-claim')!;

/** A turn's tool results, in the shape `state.toolResults` holds. */
const results = (rows: Array<{ name: string; isError: boolean; content?: string }>): unknown =>
  rows.map((r, i) => ({
    toolCallId: `c-${i}`, name: r.name, content: r.content ?? '', isError: r.isError,
  }));

/** Drive the floor exactly as the merged guard does: its gate, then its decision. */
function fire(reply: string, rows: Array<{ name: string; isError: boolean; content?: string }>): string | null {
  const g = guard();
  const state = {
    steerQueue: { pending: [], fired: [], delivered: [], abandoned: [] },
    toolResults: results(rows),
  } as never;
  if (!g.gate(state, { agentId: 'a' } as never, reply)) return null;
  return g.decide(state, { agentId: 'a' } as never)?.content ?? null;
}

/** THE ARM C TOOL RESULT, carried as the fixture rather than paraphrased. */
const ARM_C_ERROR = 'Report 067df9fa is cancelled — there is no brief to submit.';

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE FIND. The reply the owner saw, against the tool result of the same turn.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the Arm C turn', () => {
  it('"submitted!" against a cancelled-report error FIRES', () => {
    const steer = fire('submitted!', [{ name: 'dojo_report', isError: true, content: ARM_C_ERROR }]);
    expect(steer).not.toBeNull();
  });

  it('the steer QUOTES THE TOOL\'S OWN ERROR beside the claim, and orders no silence', () => {
    const steer = fire('Submitted! It is with the Dojo builders now.',
      [{ name: 'dojo_report', isError: true, content: ARM_C_ERROR }])!;
    // the engine's own record, in the tool's words — the ghosted-ask steer's pattern
    expect(steer).toContain('no brief to submit');
    // and it must not tell the model to go quiet: that is the one direction 10(d) forbids
    expect(steer).not.toMatch(/\bdo not (reply|respond)\b/i);
    expect(steer).toMatch(/tell (the|them)/i);
  });

  it('every reserved delivery word fires on the same evidence', () => {
    for (const claim of [
      'Submitted.', 'Sent it in.', 'Filed with the builders.', 'Delivered.',
      'It has been published.', 'Posted it for you.', 'That is submitted now.',
    ]) {
      expect(fire(claim, [{ name: 'dojo_report', isError: true, content: ARM_C_ERROR }]), claim)
        .not.toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE CONJUNCTS. Remove any one and the floor must go quiet.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 each conjunct is load-bearing', () => {
  it('a call that SUCCEEDED makes the claim true — quiet', () => {
    expect(fire('Submitted.', [
      { name: 'dojo_report', isError: true, content: ARM_C_ERROR },
      { name: 'dojo_report', isError: false, content: 'Report submitted for approval.' },
    ])).toBeNull();
  });

  it('no error at all — quiet', () => {
    expect(fire('Submitted.', [{ name: 'dojo_report', isError: false }])).toBeNull();
  });

  it('a DIFFERENT tool\'s error is not this artifact\'s — quiet', () => {
    expect(fire('Submitted.', [{ name: 'web_search', isError: true, content: 'blocked' }])).toBeNull();
  });

  it('no tool call of any kind — quiet (this floor never guesses from prose alone)', () => {
    expect(fire('Submitted.', [])).toBeNull();
  });

  it('it is ONE-SHOT, like every floor in the band', () => {
    const g = guard();
    // `steerFired` matches on floor AND key, so the latch entry needs the key the floor enqueues.
    const alreadyFired = {
      steerQueue: { pending: [], fired: [{ floor: 'false-delivery-claim', key: '' }], delivered: [], abandoned: [] },
      toolResults: results([{ name: 'dojo_report', isError: true, content: ARM_C_ERROR }]),
    } as never;
    expect(g.gate(alreadyFired, { agentId: 'a' } as never, 'Submitted.')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — NARROWNESS. Everything here is a reply that must NOT be steered.
//
// The owner's anti-repetition law binds: a floor that fires on an honest sentence costs the person a
// wasted beat and teaches the model to distrust the engine. These rows are the ones a looser
// vocabulary would have caught, and each is a sentence an honest agent says on this exact evidence.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 honest replies on the same failing turn stay quiet', () => {
  const onError = (reply: string): string | null =>
    fire(reply, [{ name: 'dojo_report', isError: true, content: ARM_C_ERROR }]);

  it('reporting the failure truthfully is not a delivery claim', () => {
    for (const honest of [
      'That report was cancelled, so there is nothing to submit — want me to write a fresh one?',
      'I could not submit it: the tool says the report is cancelled.',
      'The submit failed. Nothing has gone to the builders.',
      'It is not submitted — the card was withdrawn.',
      'I tried to submit and it was refused.',
      'Submitting failed, so no — it has not gone anywhere.',
    ]) {
      expect(onError(honest), honest).toBeNull();
    }
  });

  it('talking ABOUT submitting, or offering to, is not claiming it happened', () => {
    for (const honest of [
      'Do you want me to submit it?',
      'I will submit it once you approve the draft.',
      'Should I file this as a report?',
      'Drafting it now — I have not submitted anything yet.',
      'Before I submit, confirm the title reads right.',
    ]) {
      expect(onError(honest), honest).toBeNull();
    }
  });

  it('a delivery word about something ELSE entirely stays quiet', () => {
    for (const other of [
      'I sent you the link in chat.',
      'Posted a note on the tracker card.',
      'I published the draft to the shared folder.',
    ]) {
      expect(onError(other), other).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — IT IS IN THE TABLE, AND THE TABLE STILL ARGUES ITSELF.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the floor is declared, ranked and argued', () => {
  it('it is a truth guard, in the 10s band', () => {
    const spec = STEER_PRECEDENCE.find((f) => f.id === 'false-delivery-claim');
    expect(spec).toBeDefined();
    expect(spec!.priority).toBeGreaterThanOrEqual(10);
    expect(spec!.priority).toBeLessThan(20);
    expect(spec!.why.length).toBeGreaterThan(10);
  });

  it('it outranks every silence floor — a false claim beats a missing one', () => {
    expect(steerPriority('false-delivery-claim')).toBeLessThan(steerPriority('ghosted-ask'));
  });

  it('the guard set is still SORTED by the table, so the merger\'s invariant holds', () => {
    const ranks = TRUTH_GUARDS.map((g) => steerPriority(g.floor));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('the floor NAMES the door the ledger cannot see, so nobody re-derives the gap', () => {
    const src = engineFileContaining("floor: 'false-delivery-claim'")!.text;
    expect(src).toMatch(/no `?deliveries`? row/i);
  });
});
