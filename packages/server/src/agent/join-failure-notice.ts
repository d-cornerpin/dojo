// ════════════════════════════════════════════════════════════════════════════════
// WHAT THE OWNER IS TOLD WHEN A DELEGATION DOES NOT COME BACK.
// (t90 D2 — live-test report #3)
//
// ── THE REPORT, AND THE SENTENCE IT WAS SHOWN ──
// *"The messaging tool returned success both times, and the audit trail records both sends as
// successful. Within roughly thirty to sixty seconds of each send, the platform flipped the
// associated work rows to a terminal failed state and told the user, in the platform's own voice,
// that the delegated work had never come back, that every delegated piece had come back empty,
// failed or abandoned. Nothing in that window had refused or errored: the receiving agent simply
// had not replied yet. The notice also named nothing, not what had been delegated, not to whom,
// not how long it had been waiting."*
//
// ── THE TRACE (what actually fires, on current main) ──
// Not a timer. A chain of turn boundaries, which is why it reads as 30-60 seconds:
//
//   1. A delegates to B. `recordPieceDelivery` records a REAL delivery — the audit trail the
//      report cites is correct, the send did succeed.
//   2. B is given dedicated A2A turns to reply. Each turn that ends without clearing the reply
//      counts against `MAX_A2A_TURN_RETRIES` (`agent/runtime.ts`), and those turns are queued by
//      `queueSelfWake` back to back — seconds apart, not minutes.
//   3. At the cap the runtime records a SYNTHETIC `ABANDONED` reply on B's behalf and calls
//      `failJoinPieceForAbandonedAsk`, which settles A's piece to `abandoned`.
//   4. The countdown hits zero, so `resolveCompletedJoin` reads `outcome === 'fail-closed'` and
//      tells the owner *"every delegated piece came back empty, failed or abandoned"*.
//
// ── THE DEFECT IS THE SENTENCE, NOT THE SETTLEMENT ──
// Step 3 is defensible: the enforcer has to stop somewhere, and a join with nothing to compile
// must not sit in silence (D13's own argument, and `settleAsk`'s hold arm already protects the
// parent ask from being closed while a delegation is outstanding — verified, it is not the bug).
// What is NOT defensible is the claim built from it. "Came back empty, failed or abandoned" says
// the peers ANSWERED and had nothing; when the settlement is a synthetic abandon, nothing came
// back at all and the platform stopped waiting. The owner was told his agents returned junk when
// the truth was that the engine gave up — and with no name, no subject and no elapsed time, the
// report's author could not even judge whether retrying was worth it.
//
// So this module reads the pieces' own states and says which of the three actually happened. It
// invents nothing: `failed` means a peer replied FAIL, `done` with no content means a peer
// answered emptily, and `abandoned` means nothing came back. Those are the only three, they are
// written by three different call sites, and the notice now distinguishes them.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import type { JoinPiece } from '../work/store.js';

/** A piece that never produced an answer of any kind: the platform stopped waiting. */
const NO_ANSWER_STATES = new Set(['abandoned', 'open', 'claimed', 'on_deck', 'blocked', 'paused']);

export interface PieceTally {
  /** A peer replied FAIL — something came back and it was a refusal. */
  refused: number;
  /** A peer replied, and the reply carried nothing usable. */
  empty: number;
  /** Nothing came back at all. The synthetic-abandon and TTL cases. */
  silent: number;
}

/** Which of the three things actually happened, counted off the pieces' own states. */
export function tallyPieces(pieces: readonly JoinPiece[]): PieceTally {
  const t: PieceTally = { refused: 0, empty: 0, silent: 0 };
  for (const p of pieces) {
    if (p.state === 'failed') t.refused += 1;
    else if (NO_ANSWER_STATES.has(p.state)) t.silent += 1;
    else t.empty += 1;              // `done` (or any other terminal) with nothing usable in it
  }
  return t;
}

/**
 * The reason recorded on the work row, and it must match what happened.
 *
 * The literal this replaces — *"every delegated piece came back empty, failed or abandoned"* —
 * was written at both the row and the agent-facing notice, so a row that was abandoned without a
 * word from anyone carried a sentence asserting a reply. The audit trail is the thing a later
 * session reconstructs the incident from; it does not get to be the loosest description available.
 */
export function joinFailureReason(pieces: readonly JoinPiece[]): string {
  const t = tallyPieces(pieces);
  const parts: string[] = [];
  if (t.silent > 0) parts.push(`${t.silent} never answered`);
  if (t.refused > 0) parts.push(`${t.refused} replied FAIL`);
  if (t.empty > 0) parts.push(`${t.empty} replied with nothing usable`);
  return parts.length > 0
    ? `the delegated work produced no answer (${parts.join(', ')})`
    : 'the delegated work produced no answer';
}

/** Rounded, and in the unit a person thinks in. `null` when there is nothing honest to say. */
function waitedFor(openedAtMs: number | null): string | null {
  if (openedAtMs == null || !Number.isFinite(openedAtMs)) return null;
  const secs = Math.max(0, Math.round((Date.now() - openedAtMs) / 1000));
  if (secs < 90) return `${secs} seconds`;
  const mins = Math.round(secs / 60);
  return mins < 90 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(mins / 60)} hours`;
}

/** When the join's pieces were opened — the clock the owner's "how long did it wait" reads off. */
export function joinOpenedAt(parentWorkId: string): number | null {
  try {
    const row = getDb().prepare(
      'SELECT MIN(opened_at) AS at FROM work WHERE parent_id = ?',
    ).get(parentWorkId) as { at: number | null } | undefined;
    return row?.at ?? null;
  } catch {
    return null;
  }
}

export interface NoticeInput {
  parentWorkId: string;
  pieces: readonly JoinPiece[];
  /** Display names, already resolved by the caller — this module does no name lookup. */
  names: readonly string[];
  /** A short quote of the owner's own question, or ''. */
  questionSnippet: string;
}

/**
 * THE OWNER-FACING SENTENCE. Names who, what, and how long — the three things the report says it
 * was not told — and says which of the three failures happened rather than offering all three.
 *
 * It does NOT offer a retry button, because there is nothing here that could honour one: the ask
 * is already terminal by the time this is minted. Saying "ask again" would be the same class of
 * lie this module exists to remove. The report asked for a retry affordance and that is a real
 * gap, recorded in the t90 report as a follow-up rather than faked here.
 */
export function joinFailureNotice(p: NoticeInput): string {
  const t = tallyPieces(p.pieces);
  const who = p.names.length === 0 ? 'another agent'
    : p.names.length === 1 ? p.names[0]
      : `${p.names.slice(0, -1).join(', ')} and ${p.names[p.names.length - 1]}`;
  const waited = waitedFor(joinOpenedAt(p.parentWorkId));
  const plural = p.pieces.length > 1;

  // The lead sentence is the one that has to be TRUE. Silence dominates when it is present: it is
  // the case the report hit, and the one the old wording described worst.
  //
  // ⛔ THE NEGATION IS SPELLED OUT IN EVERY ARITY, AND THAT IS NOT A STYLE CHOICE. The first cut
  // of this sentence interpolated `${plural ? 'none of them' : 'they'} answered`, which put the
  // negation inside the PLURAL WORD ONLY — so ONE silent delegate, which is live-test report #3's
  // exact case, was told to the owner as *"…to <name>, and they answered."* That is the opposite
  // of the truth, in the single case this module was built to stop lying about. It shipped past
  // three clauses that matched `/answered/` and were satisfied by the lie; the fresh reviewer
  // caught it. A future edit here keeps its own "never": do not re-factor the negation into a
  // shared suffix, because a shared suffix is what made one arity able to lose it.
  const lead = t.silent > 0 && t.refused === 0 && t.empty === 0
    ? `your agent delegated ${plural ? 'parts of this' : 'this'} to ${who}`
      + `${waited ? ` and waited ${waited}` : ''}, and `
      + `${plural ? 'none of them answered' : 'they never answered'}. `
      + `The ${plural ? 'messages were' : 'message was'} delivered — nothing errored — `
      + `so the platform stopped waiting rather than leaving you in silence.`
    : t.silent > 0
      ? `your agent delegated ${plural ? 'parts of this' : 'this'} to ${who}`
        + `${waited ? ` and waited ${waited}` : ''}: `
        + `${joinFailureReason(p.pieces).replace('the delegated work produced no answer ', '')}.`
      : `your agent asked ${who} about this`
        + `${waited ? `, waited ${waited},` : ''} and got no usable answer back `
        + `(${joinFailureReason(p.pieces).replace('the delegated work produced no answer (', '').replace(/\)$/, '')}).`;

  return lead + (p.questionSnippet ? ` (Your question was: "${p.questionSnippet}")` : '');
}
