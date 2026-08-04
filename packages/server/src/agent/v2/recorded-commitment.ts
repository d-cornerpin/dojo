// ════════════════════════════════════════════════════════════════════════════════════════
// THE UNCOMMITTED-PROMISE FLOOR'S TRIGGER — PHASE-6 T-PROMISE.
//
// THE GROUNDING GUARD, APPLIED TO A SECOND NOUN. `claimed-delivery.ts` asks the ledger
// whether a claimed SEND happened. This asks the work spine whether a claimed PROMISE was
// recorded. Both hand-ups asked for exactly this in writing — the kit scenario's own
// `knownFailing` (*"steer on a promise claimed with no commitment row, the grounding guard
// applied to a second noun"*) and `task-T0C-report.md` §7 hand-up 4 — and neither had a live
// owner until the `postCallClassify` tranche gave the machinery a home.
//
// ── WHAT IT IS FOR, MEASURED RATHER THAN ASSERTED (T-PROMISE Step 0, dojo `b17b39b`) ─────
// The kit scenario `promise-survives-the-turn` drives an agent to make a promise it cannot
// keep this turn and asks it to record the promise. Driven 12 times on the floor model:
//
//   · a `work(kind='commitment')` row was opened on   3 of 12 attempts  (UPTAKE 25%)
//   · 9 misses, and 9 OF THE 9 CALLED NO TOOL AT ALL
//   · 9 OF THE 9 told the user, in the past tense, that the commitment was recorded
//   · 0 of 12 attempts produced any engine steer — nothing in the tree detected it
//
// THE PROSE OF A HIT AND THE PROSE OF A MISS ARE THE SAME SENTENCE. Measured, both:
//   HIT  "Noted — the roof quote for Bob is recorded as a commitment; it will go out once…"
//   MISS "Noted — the roof quote to Bob is recorded as a commitment; I'll email it once…"
// Which is the whole argument for this module's shape: the TEXT cannot tell them apart and
// the LEDGER can, so the text may only ever narrow and the row must fire. Research 21's
// binding caution, and the owner's own "told Michael" incident, say the same thing from the
// other direction — honesty floors are receipt-keyed, never prose-keyed.
//
// ── THE TRIGGER ─────────────────────────────────────────────────────────────────────────
// One ROW-shaped question, asked only after the narrowing has said there is a claim to check:
//   *did ANY work row land on this agent's board during this turn?*
// If the answer is none, the reply's claim has nothing behind it: nothing ages, nothing
// enters the OPEN WORK block, nothing ever surfaces as still owed.
//
// ── THE THREE STAND-DOWNS, AND THEY ARE DELIBERATELY GENEROUS ───────────────────────────
// A false accusation is this floor's failure mode, so every arm errs toward silence:
//   'no-claim-in-text'   the reply never claimed a recording (a promise the model made
//                        SILENTLY is out of scope on purpose — see THE BOUND below)
//   'work-open-ran'      a `work_open` call succeeded this turn. WHICH KIND IS NOT THIS
//                        FLOOR'S BUSINESS: `work_open`'s own description offers
//                        kind="task" as the right home when the promise is board work, so
//                        a floor that insisted on kind="commitment" would be steering
//                        against the tool's own advice (P5-R5's family).
//   'ledger-holds-work'  the spine has a row opened this turn. The authority, and the arm
//                        that closes the loop after a steer: the moment the model records
//                        the promise, the floor cannot fire again.
//
// ── THE BOUND, STATED SO IT IS A DECISION AND NOT A GAP ─────────────────────────────────
// This floor catches the CLAIM, never the promise. A model that promises and says nothing
// about recording it is not steered here, because the only way to detect that is to read
// the USER's prose for "they wanted an obligation tracked" — prose gaining authority over
// the ledger, which is the exact class removed twice already (the deliverable-claim floor,
// the pre-rekey claimed-delivery floor). If the silent case ever needs an owner it needs a
// structural signal, not a bigger regex.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('recorded-commitment');

/**
 * The work kinds that count as "the promise landed on the board".
 *
 * `ask` is EXCLUDED and the exclusion is load-bearing: `openAsk` writes one for the user's
 * own inbound at ingest, on this same turn, every time. Counting it would make this floor
 * structurally unable to fire — a stand-down that always stands down, which is worse than
 * no floor because it reads like a guard.
 *
 * `occurrence` is excluded for the same class of reason: the scheduler writes those, not the
 * model, so one firing during a turn says nothing about what the model did.
 */
export const BOARD_KINDS: readonly string[] = ['commitment', 'task', 'project'];

/** A recording claim in the past tense. Both halves must be present, in ONE sentence. */
const RECORDED_VERB =
  /\b(recorded|logged|tracked|noted|saved|filed|captured|added|booked|put)\b/i;
const COMMITMENT_NOUN =
  /\b(commitment|commitments|promise|promised|obligation|follow[-\s]?up|to[-\s]?do)\b/i;
/** "on the books" / "on my list" carry the claim without either word above. */
const RECORDED_IDIOM = /\b(on the books|on my list|in the tracker|on the board)\b/i;

/**
 * The claim is CANCELLED by a negation or a future marker in the same sentence. Both
 * directions matter and the negation one is not optional: this floor's own steer tells the
 * model to say plainly that the promise is NOT tracked, so a floor that then fires on
 * "I have not recorded it" would punish the model for obeying it.
 */
// `\w+n['’]t` rather than `\bn['’]t`: there is no word boundary inside "haven't", so the
// bare form silently matched nothing and the floor would have fired on the model doing
// exactly what its own steer asked. Caught by this module's own RED-first clause.
const CANCELS_THE_CLAIM =
  /(?:\w+n['’]t|\bnot|\bnever|\bno)\s+(?:yet\s+)?(?:been\s+)?(?:\w+\s+){0,3}?(recorded|logged|tracked|noted|saved|filed|captured|added|booked)\b|\b(i['’]ll|i will|will be|going to|gonna|about to|let me|need to|should|can|could|shall)\s+(?:\w+\s+){0,2}?(record|log|track|note|save|file|capture|add|book|put)\b/i;

export type UncommittedPromiseStandDown =
  | 'no-claim-in-text'    // the narrowing found no past-tense recorded-commitment claim
  | 'work-open-ran'       // a `work_open` succeeded this turn; the kind is not our business
  | 'ledger-holds-work';  // ← THE AUTHORITY: the spine has a row from this turn

export interface UncommittedPromiseFires {
  fires: true;
  /** The sentence that carries the claim — quoted back so the steer points at it. */
  claim: string;
  /** True when the promise went to the VAULT instead, so the steer can say where it went. */
  wentToMemory: boolean;
}

export interface UncommittedPromiseStandsDown {
  fires: false;
  reason: UncommittedPromiseStandDown;
}

export type UncommittedPromiseDecision = UncommittedPromiseFires | UncommittedPromiseStandsDown;

export interface RecordedCommitmentClaim {
  claimed: boolean;
  /** The matching sentence, trimmed. Empty when nothing matched. */
  sentence: string;
}

/**
 * THE NARROWING. Answers one question — *does this reply tell the person a commitment has
 * been recorded?* — and nothing else. It cannot fire anything: the caller must ask the
 * ledger, and the ledger is what decides.
 */
export function detectRecordedCommitmentClaim(input: { responseText: string | null }): RecordedCommitmentClaim {
  const text = input.responseText?.replace(/\s+/g, ' ').trim();
  if (!text || text.length < 4) return { claimed: false, sentence: '' };
  // Sentence-scoped on purpose: "I'll email it once he sends his address. The commitment is
  // recorded." must match on the second sentence, and "I'll record the commitment later.
  // Meanwhile I saved your address." must match on neither.
  const sentences = text.split(/(?<=[.!;:])\s+|\s+[—–]\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (CANCELS_THE_CLAIM.test(s)) continue;
    const hasIdiom = RECORDED_IDIOM.test(s);
    const hasPair = RECORDED_VERB.test(s) && COMMITMENT_NOUN.test(s);
    if (hasIdiom || hasPair) return { claimed: true, sentence: s.slice(0, 200) };
  }
  return { claimed: false, sentence: '' };
}

export interface UncommittedPromiseInput {
  agentId: string;
  /** The terminal user-facing text about to stand. */
  responseText: string | null;
  /** Cumulative tool activity this turn — C5's rule, never just the terminal iteration.
   *  A `work_open` made three iterations ago is still this turn's bookkeeping. */
  toolResultsThisTurn: ReadonlyArray<{ name?: string | null; isError?: boolean }>;
  /** The spine read, injected so the decision is testable without a database — the same
   *  discipline `claimed-delivery.ts` uses for its receipt suppressor. Returns the ids of
   *  the board rows this agent opened during this turn. */
  openedWorkThisTurn: () => readonly string[];
}

/** The floor's whole decision. A stand-down carries its REASON so a red says which arm answered. */
export function decideUncommittedPromise(input: UncommittedPromiseInput): UncommittedPromiseDecision {
  const claim = detectRecordedCommitmentClaim({ responseText: input.responseText });
  if (!claim.claimed) return { fires: false, reason: 'no-claim-in-text' };

  const succeeded = (name: string): boolean =>
    input.toolResultsThisTurn.some((r) => r.name === name && r.isError !== true);

  // The generous arm, taken before the ledger is even asked: the model DID open work this
  // turn. Which kind is the model's call, not this floor's.
  if (succeeded('work_open')) return { fires: false, reason: 'work-open-ran' };

  const rows = input.openedWorkThisTurn();
  if (rows.length > 0) return { fires: false, reason: 'ledger-holds-work' };

  return { fires: true, claim: claim.sentence, wentToMemory: succeeded('vault_remember') };
}

/**
 * The board rows this agent opened during this turn. `ask` and `occurrence` are excluded at
 * the query — see `BOARD_KINDS`.
 */
export function openedBoardWorkSince(agentId: string, sinceMs: number): readonly string[] {
  try {
    const rows = getDb().prepare(
      `SELECT id FROM work
        WHERE agent_id = ? AND opened_at >= ?
          AND kind IN ('commitment','task','project')`,
    ).all(agentId, sinceMs) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (err) {
    // A ledger read that fails must SILENCE the floor, never accuse on a missing answer.
    logger.warn('uncommitted-promise: the spine read failed; standing down rather than accusing', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return ['read-failed'];
  }
}

/**
 * The steer. It states the LEDGER fact and names the call that fixes it, and it offers the
 * honest way out as a first-class option — a floor that only knows how to say "do it" is the
 * floor the owner caught ordering a delivery nobody asked for.
 */
export function uncommittedPromiseSteer(d: UncommittedPromiseFires): string {
  const where = d.wentToMemory
    ? 'You saved it to MEMORY instead, and memory carries no obligation: it does not age, it never enters your OPEN WORK block, and nothing will ever surface it as still owed. '
    : '';
  return (
    `[System: your reply tells the user the commitment is recorded ("${d.claim}"), and the work ledger ` +
    `has nothing from this turn. ${where}` +
    `Call work_open(kind="commitment") now with what you promised, in your own words, in \`description\` — ` +
    `that is the only call that puts it on the ledger. If you would rather not track it, tell the user ` +
    `plainly that it is NOT recorded. Do not leave a claim standing that the ledger does not back.]`
  );
}
