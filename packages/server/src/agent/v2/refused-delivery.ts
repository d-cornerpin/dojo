// ════════════════════════════════════════════════════════════════════════════════════════
// A DELIVERY CLAIM THE SAME TURN'S TOOL REFUSED — the fifth truth guard's decision.
//
// ── THE FIND (Arm C) ─────────────────────────────────────────────────────────────────────────
// In ONE turn an agent was handed a tool result carrying `is_error: true` saying the report was
// CANCELLED and there was NO BRIEF TO SUBMIT — and then told the owner **"submitted!"**. Nothing in
// the engine caught it. The person was told their bug report was on its way to the Dojo's builders
// while the engine's own record of that same turn said the opposite.
//
// ── WHY NOTHING COULD CATCH IT, and it is not an oversight ───────────────────────────────────
// The truth band holds four guards that ask "the reply asserts X, the ledger says not-X". The
// closest, `ungrounded-claim` (priority 10), is *"reply claims a delivery no send tool made"* — and
// it reads the DELIVERIES LEDGER. `dojo_report` is the one user-facing door in this engine that
// writes NO `deliveries` row (0 in the whole database, ever; established across three release-ritual
// rounds). The artifact moves by STATE TRANSITION, so no ledger-reading guard can ask about it.
//
// ── THE SHAPE WAS ALREADY IN THE TREE, and this is that shape with the noun changed ──────────
// `failed-save-claim` (priority 12, the RC-13.2 floor) asks the same question against THIS TURN'S
// TOOL RESULTS instead of a ledger: the reply says "saved", every `vault_remember` this turn was
// REJECTED, so steer once. This module is that decision for a DELIVERY rather than a save, and it
// lives beside `claimed-delivery.ts` and `recorded-commitment.ts` because the merged guard's own
// header says a truth guard's decision belongs in a named module rather than inlined in the table.
//
// NO NEW SUPPRESSION. The steer hands the model the tool's own words beside its own sentence and the
// turn re-enters through the ordinary seam — the ghosted-ask steer's pattern, and the one the owner's
// 2026-07-22 ruling requires (the engine never speaks as the agent; it quotes). A silence afterwards
// is still the ghosted-ask ladder's business, and ruling 10(d) means the steer must never ask for one.
//
// ── ERR NARROW, ON THE OWNER'S OWN ARITHMETIC ────────────────────────────────────────────────
// A false positive costs ONE extra beat: the model re-enters holding the contradiction. A false
// negative is TODAY'S BEHAVIOUR — a person told their report was submitted when it was cancelled. So
// every conjunct below narrows, and the clause file's §3 is nothing but replies that must NOT fire.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The one door whose artifact moves by state transition instead of a `deliveries` row. */
export const REPORT_ARTIFACT_TOOL = 'dojo_report';

/**
 * The lane's RESERVED DELIVERY WORDS in a DONE claim — never "I will submit", never "drafting".
 * `agent/tools/cat/report-prose.ts` owns the same vocabulary on the writing side.
 *
 * ⚠ ONLY `submitted` AND `delivered` STAND ALONE. `sent`, `posted`, `filed` and `published` need
 * their object, and that is measured against the clause file's §3 rather than guessed: "I sent you
 * the link in chat", "Posted a note on the tracker card" and "I published the draft to the shared
 * folder" are all honest sentences an agent says on a failing report turn, and every one of them
 * fires on a bare-word list. With the object required they are silent, while "Posted it for you" and
 * "Sent it in" — where the object IS the turn's subject — still fire.
 *
 * ⚠ AND A BARE "submitted" IS ENOUGH HERE, which is a deliberate departure from the kit-side
 * detector that requires a destination ("submitted TO the builders"). The kit scans every reply with
 * no other evidence and needs the destination to stay honest; this guard already holds the far
 * stronger conjunct below, so requiring one would have MISSED the Arm C reply — which was one word.
 */
const DELIVERY_CLAIM_RE =
  /\b(?:(?:it|that|this)\s+(?:has\s+been|is|was)\s+(?:submitted|sent|filed|delivered|published|posted)|(?:i\s+)?(?:submitted|sent|filed|delivered|published|posted)\s+it|submitted|delivered|sent\s+it\s+in|filed\s+(?:it\s+)?with)\b/i;

/**
 * The same words inside a DENIAL or a failure report — the honest reply on this exact evidence.
 *
 * Checked after the claim, so it can only ever QUIETEN. "I could not submit it", "the submit
 * failed", "it is not submitted" and "submitting failed, so no" are what a truthful agent says when
 * the tool refuses, and a guard that steers those teaches the model to distrust the engine.
 */
const DISCLAIMED_DELIVERY_RE =
  /\b(?:not|never|no|cannot|can't|could\s?n[o']t|failed|fails|refused|rejected|nothing)\b[^.!?]{0,60}\b(?:submit|submitted|sent|send|filed|file|delivered|deliver|published|posted)\b|\b(?:submit|submitted|sending|submitting|filing)\b[^.!?]{0,40}\b(?:failed|refused|rejected|cancelled|canceled)\b/i;

/** Does this reply CLAIM the artifact went out? The gate half, prose only. */
export function claimsDelivery(reply: string): boolean {
  return DELIVERY_CLAIM_RE.test(reply) && !DISCLAIMED_DELIVERY_RE.test(reply);
}

/** One recorded tool call of this turn, in the shape `state.toolResults` holds. */
export interface TurnToolResult { readonly name?: string; readonly content?: string; readonly isError?: boolean }

export interface RefusedDelivery { readonly refused: number; readonly quoted: string }

/**
 * Did the artifact's tool REFUSE, with nothing of it succeeding, in THIS turn?
 *
 * Three conjuncts and the clause file removes each in turn: an EXPLICIT `is_error` (the dispatcher's
 * own flag, not "the result looked odd"), at least one refusal, and NOTHING of that tool succeeded —
 * a turn that failed once and then succeeded made a TRUE claim, and steering it would be the false
 * positive this guard cannot afford. Same-turn is by construction: `state.toolResults` is turn-local,
 * so nothing here can reach back into another turn.
 */
export function decideRefusedDelivery(results: readonly TurnToolResult[]): RefusedDelivery | null {
  const calls = results.filter((r) => r.name === REPORT_ARTIFACT_TOOL);
  const refused = calls.filter((r) => r.isError === true);
  if (refused.length === 0 || calls.some((r) => r.isError !== true)) return null;
  return {
    refused: refused.length,
    quoted: (refused[refused.length - 1].content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

/**
 * The steer, and every clause of it is deliberate.
 *
 * It QUOTES THE TOOL rather than paraphrasing it — the ghosted-ask steer's second rung hands the
 * model its own recorded words for the same reason. It states the consequence plainly ("Nothing was
 * delivered"), asks for the truth to reach the person, and it ORDERS NO SILENCE: ruling 10(d) means a
 * guard may never resolve a contradiction by asking the model to say less.
 */
export function refusedDeliverySteer(d: RefusedDelivery): string {
  return 'You told the user that went out, and the only tool this turn that could have sent it '
    + `REFUSED. Its own words: "${d.quoted}". Nothing was delivered. Tell them plainly what the `
    + 'state really is and what you can do about it — do not let the claim stand, and do not go silent.';
}
