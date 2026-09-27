// ════════════════════════════════════════════════════════════════════════════════════════
// THE THIRD CARVE-OUT — AN ANSWER THAT RODE WITH A TOOL CALL IS STILL AN ANSWER.
//
// ── THE DEFECT, STATED AS THE ASSUMPTION IT IS ──
// `terminal-text.ts`'s text-with-tools arm demotes assistant text to a dimmed
// `[working-note]` on CO-OCCURRENCE with a tool call, and `shared/visibility.ts` states the
// premise as a definition: *"Assistant text that rides in the same model response as tool
// calls is process narration, never a message to the user."* That sentence is an
// ASSUMPTION, not a definition, and it is false whenever the model answers the person AND
// touches a tool in one response. When it is false the person's only answer is filed as
// process narration and greyed out.
//
// ── MEASURED, AND THE NUMBER IS THE HONEST ONE ──
// On the owner's box: 424 turns carried a working note; 146 of those had no visible agent
// text at all; after excluding service agents and engine scheduler notices the genuine class
// is **7 of 204 human-triggered turns (3.4%)** — and it is concentrated on the agents the
// owner actually watches. It is a FLOOR, not a ceiling: the internal-note arm
// (`[working-note:internal] `, a routed-channel turn) is hidden entirely rather than dimmed,
// and a turn whose ANSWER was demoted while a throwaway ack stayed visible does not register
// in that count at all.
//
// ── WHY THIS IS A CARVE-OUT AND NOT A NEW MECHANISM ──
// The platform has already carved this exact class out TWICE, and both are the template:
// `deliveredAsCompiledAnswer` (T52) and `deliveredAsStartLine` (the start-ack steer). Both
// promote text that rode with a tool call, IN PLACE, and both skip the demotion so no second
// copy is written. The anti-repetition property is preserved by promotion-in-place, never by
// hiding — and promotion is the SAFER direction for repetition, because a demoted note is
// `role='system'` and never enters model context, so the model cannot see what it already
// said and is free to say it again (T52's own log line names precisely that).
//
// ── ONE PREDICATE, A ROW, NOT PROSE ──
// The receipt-keyed doctrine (`report/withdrawn-claim.ts`, `answered-edge.ts`: *"honesty
// floors are receipt-keyed, never prose-keyed"*) is not bent here. Not one character the
// model wrote is read.
//
// **`isHumanContinuation` — THE NEVER-SILENT BACKSTOP, AND THE ONE TURN CLASS WITH NO OTHER
// WAY OUT.** A long human task that hit MAX_TOOL_LOOPS / the time budget / emergency
// compaction is auto-continued with an empty trigger, and its ask was stamped served at the
// ORIGINAL pickup (`preflight/turn-trigger.ts`'s C3 stash). Three consequences compose into a
// turn that CANNOT speak:
//   · `hasUnansweredUser` is FALSE — the ask is no longer `state='open'`, so G-SUP-2's capture
//     at the seam never arms and `finalize/deferred-recovery.ts` has nothing to recover;
//   · no ack is owed and no start-ack steer will fire — the person was acked at the original
//     pickup, so the owed window is shut;
//   · no compile is owed.
// Every promotion arm is therefore false, the text is demoted, and the turn ends with the
// person shown nothing but grey. That is the measured shape, exactly: two consecutive turns on
// ONE ask, each ending silent, on a long human task. The invariant this file enforces is that
// such a turn may not END with its only utterance demoted.
//
// ── PREDICATE A (`hasUnansweredUser`) WAS DESIGNED, DRIVEN, AND **REFUSED** — ON EVIDENCE ──
// The investigation's Option A was "an OPEN human ask on the ledger ⇒ promote". It was
// implemented here first and it is not in this file, because driving it turned FIVE reviewed
// CONTROL clauses in three sibling suites red — every one of them a deliberate statement that
// a waiting human with no owed ack and no owed compile keeps the capture-and-demote untouched:
//   · `the-owed-window-delivers-the-model-s-own-line.test.ts` — three clauses, including
//     *"outside the owed window the 2026-07-23 ruling stands, byte for byte"*;
//   · `the-composed-answer-delivers-the-first-time.test.ts` — *"CONTROL — a waiting human with
//     no owed compile keeps G-SUP-2's capture, untouched"*;
//   · `a-reminder-turn-has-a-waiting-human.test.ts` — the same control for the D1 arm.
// Those clauses are THREE OWNER RULINGS in test form (demote-don't-discard 2026-07-10; the
// 2026-07-23 refusal of a branch that delivered *"whatever mid-work narration was captured …
// AS the ack … so the model was never actually asked to address the user"*; and its 2026-08-12
// narrowing). `hasUnansweredUser` is true on EVERY ordinary human turn, so keying on it
// promotes ordinary mid-work preamble — which is the branch 2026-07-23 deleted. Re-blessing
// five reviewed controls to let that back in is not a fix, it is a re-rule, and it is not this
// file's to make.
//
// WHAT A IS MISSING IS THE HALF THE INVESTIGATION NAMED AND THIS SEAM CANNOT SUPPLY: *"if the
// turn holds an open human ask **and this text is the turn's terminal text**"*. Terminality is
// only knowable at turn end — `teardown/draft-reclassify.ts` says so in its own bold text
// (*"THE ANSWER'S IDENTITY IS ONLY KNOWN AT TURN END"*) — and A's correct home is therefore the
// turn boundary, where the note would have to be promoted after the fact. That needs a runtime
// writer for the display-suppression axis (`messages.retired_at`, whose only writers today are
// two migrations) or a new WS frame to un-dim a rendered note. Both are owner-visible design
// decisions, recorded in the lane report rather than taken in passing.
//
// ── WHAT KEEPS GENUINE MID-WORK NARRATION A NOTE ──
// `nothingSaidYet`. The arm fires only while the turn has surfaced NOTHING
// (`state.surfacedReplyThisTurn` false) and has not already spoken on the ledger
// (`startAckRepliedNow()` false) — so at this instant this text IS the turn's only utterance,
// and the choice is between a person reading it and a person reading nothing. A narration
// line on a turn that has already spoken is untouched and is demoted exactly as it was
// (owner request 2026-07-10).
//
// ── AND WHY EAGER PROMOTION CANNOT DOUBLE-SPEAK ──
// This is the part that makes the design safe rather than optimistic, and it rests on a fact
// about an existing setter: the truthful-answer key is **LAST-WRITE-WINS**
// (`preflight/turn-closures.ts` holds the engine's ONE setter, an unconditional assignment to
// the scratch field — deliberately not quoted here: `answered-edge.ts`'s conformance census
// counts matching LINES, so pasting that statement into a comment reads as a second writer and
// fails the census. It was written that way once and the census caught it). So
// if the model goes on to produce a real terminal reply later in the same turn, that reply
// overwrites the key, `turns.answer_message_id` names the LATER row, and
// `teardown/draft-reclassify.ts` re-classifies THIS bubble into the working-note lane at the
// boundary — row and broadcast together, live view and reload agreeing. The anti-repetition
// law is therefore enforced by the mechanism that already owns it, at the moment
// `draft-reclassify.ts` says in its own bold text is the only moment it is decidable
// (*"THE ANSWER'S IDENTITY IS ONLY KNOWN AT TURN END"*) — instead of by keeping the person in
// the dark mid-turn in case a better answer shows up.
//
// ── WHY IT IS ITS OWN MODULE ──
// `terminal-text.ts` is pinned at 407 lines in `ratchets.json` with the standing note *"From
// here this file may only shrink"*. The carve-out's argument is longer than its code, which
// is the normal ratio in this tree, so the whole decision lives here and the seam spends the
// minimum. The three flags stay siblings at the seam, which is what the demote condition
// reads.
//
// ── WHAT THIS IS NOT ──
// It is NOT the ack lane. `engine-ack` is excluded from every settlement by name (*"a
// start-ack is not an answer"*, `work/ask-settlement.ts`), so delivering through it would
// leave the ask open and the ladder running. This delivers an ordinary `agent-text` row with
// NO origin stamp, through the same door the model's own reply uses, and the ask settles by
// the ordinary road. It also does NOT touch `compileGateSatisfied` — that is T47's duty flag
// and only an owed compile discharges it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { stripMoodMarker } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import type { DisplayKind } from '@dojo/shared';

const logger = createLogger('v2-loop');

/** What the seam knows that this decision needs. All of it is already on the turn's context.
 *  `hasUnansweredUser` is DELIBERATELY ABSENT — see the header's refusal of predicate A. */
export interface LiveAskPromotionInputs {
  /** A2A / background turns keep the hard suppression: their narration never streamed. */
  readonly interAgentTurn: boolean;
  /** The never-silent backstop's one predicate: a human task the engine auto-continued. */
  readonly isHumanContinuation: boolean;
  /** Has anything user-visible shipped this turn? */
  readonly surfacedReplyThisTurn: boolean;
  /** The ledger-backed "have they heard the model this turn" question the ack family owns. */
  readonly startAckRepliedNow: () => boolean;
}

/**
 * MAY this text be delivered as the answer instead of demoted to a note?
 *
 * Exported separately from the delivery so the predicate can be driven on its own — the
 * service-agent exclusion and the narration-stays-a-note rule are properties of THIS
 * function, and a clause that had to perform a delivery to read them would be testing two
 * things at once.
 */
export function answersALiveAsk(p: LiveAskPromotionInputs): boolean {
  if (p.interAgentTurn) return false;
  // The turn has already spoken: whatever this line is, it is not the person's only utterance.
  if (p.surfacedReplyThisTurn || p.startAckRepliedNow()) return false;
  return p.isHumanContinuation;
}

export interface LiveAskPromotionResult {
  /** The state the caller must adopt: the routing text and the respond-once floor moved. */
  readonly state: AgentTurnState;
  /** The row the answer landed on, so the caller can see the promotion happened. */
  readonly answerId: string;
}

/**
 * Deliver the text as the turn's answer, in place, and move the three facts the rest of the
 * turn reads.
 *
 * The row id is minted HERE and handed to the delivery rather than left to the closure, for
 * the start-ack arm's own recorded reason: the caller's `messageId` is about to hold this
 * iteration's `tool_use` row, and reusing it makes that INSERT a no-op and loses the tool
 * calls. `noteTerminalAnswer` is NOT optional — the superseded-bubble narrowing refuses an
 * `agent-text` bubble on an ENDED turn unless the turn's own answer key names it.
 */
export async function deliverAsAnswerToLiveAsk(
  state: AgentTurnState,
  p: LiveAskPromotionInputs & {
    readonly agentId: string;
    readonly turnNumber: number;
    readonly answer: string;
    readonly deliverEngineUserAck: (
      text: string, originIntent: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
    ) => Promise<void>;
    readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  },
): Promise<LiveAskPromotionResult> {
  const answerId = uuidv4();
  // `null` origin intent, deliberately: an origin stamp would classify the row `engine-ack`,
  // which every settlement excludes by name, and the ask would stay open.
  await p.deliverEngineUserAck(p.answer, null, answerId, 'agent-text');
  p.noteTerminalAnswer(answerId, 'the answer to a live ask, delivered from the round it was composed in');
  const next = advance(state, {
    lastAssistantTextForIM: stripMoodMarker(p.answer),
    surfacedReplyThisTurn: true,
  });
  logger.info('v2 never-silent invariant: a continued human task would have ended with its only utterance demoted; delivered as the answer now instead of as a note nobody reads', {
    agentId: p.agentId, turnNumber: p.turnNumber, basis: 'human-continuation',
    answerId, chars: p.answer.length, preview: p.answer.slice(0, 60),
  }, p.agentId);
  return { state: next, answerId };
}
