// ════════════════════════════════════════════════════════════════════════════════════════
// THE CLAIMED-DELIVERY FLOOR'S TRIGGER — PHASE-4 T4, the owner's live fixture.
//
// ── WHAT WENT WRONG, IN PRODUCTION, ON THE OWNER'S OWN SERVER (2026-08-01) ───────────────
// He asked about a wedding transcript. The reply quoted it, the transcript said "told
// Michael" (Michael was the groom), and the floor fired. Twice more after that — once when
// he pasted the steer's own text back at the agent — and every fire carried "do it NOW",
// so the agent answered twice and re-did a delivery nobody had asked for. Three false
// accusations from one English word.
//
// The whole trigger was `detectUngroundedDeliveryClaim`, a regex over the model's prose.
// Research 21's binding caution names that class: **honesty floors are receipt-keyed, never
// prose-keyed** — the deliverable-claim floor was built on prose twice before and spiralled
// both times. This module is the rekey.
//
// ── WHAT THE TRIGGER IS NOW ─────────────────────────────────────────────────────────────
// Two ROWS, either of which lets the engine point at the thing it is accusing the model of:
//
//   ARM A — AN OWED OBLIGATION.  `work/store.ts owedSendObligations` — an ask this person
//           sent and never got answered, or a promise the agent recorded — still owed, with
//           no `result_delivery_id`, whose counterparty IS the recipient the reply named.
//           "You say you got back to Sam; Sam's message is still sitting open with nothing
//           delivered against it."
//   ARM B — A FAILED RECEIPT ON THIS TURN.  A `deliveries` row to that recipient THIS TURN
//           with `outcome <> 'delivered'`. The old guard could not see this at all: it stood
//           down the moment any delivery TOOL ran, so "I sent it" on top of a send the door
//           recorded as FAILED was invisible to it. That is a hole the rekey closes.
//
// The model's prose is still read — for ONE job, and it is not the trigger. It NARROWS: it
// says which recipient the claim names, so the ledger can be asked about that party rather
// than about the world. A narrowing cannot fire anything on its own; both arms require a row.
// Every fire therefore carries an id a human can look up, which is the difference between a
// floor and an accusation.
//
// ── THE ONCE-ONLY LATCH ─────────────────────────────────────────────────────────────────
// The owner's third fire was the same claim steered again. The latch key returned here is
// the ROW's id (the obligation, or the failed delivery), and it goes onto the steer queue
// entry (T3): one steer per obligation per turn, not one per phrase. Across turns the ledger
// itself is the latch — the moment the send lands, the obligation carries a delivery and
// neither arm can fire again. A boolean beside the loop could never have said that.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { recipientIdsMatch } from '../recipient-identity.js';
import { owedSendObligations, type OwedSendObligation } from '../../work/store.js';
import { detectUngroundedDeliveryClaim } from './classifiers/grounding.js';

const logger = createLogger('claimed-delivery');

/** Why the floor stood down. Every value is a fact about the LEDGER, not about the text. */
export type ClaimedDeliveryStandDown =
  | 'no-claim-in-text'          // the narrowing found no completed-delivery claim to a third party
  | 'a-delivery-tool-ran'       // a send tool ran this turn and the door did not record a failure
  | 'nothing-owed-to-them'      // ← THE OWNER'S CASE: no row says this agent owes that party anything
  | 'receipt-backs-the-claim';  // the ledger holds a real delivery to them (the pre-existing suppressor)

export interface ClaimedDeliveryFires {
  fires: true;
  /** The party the reply named. Comes from the narrowing; the ROW below is the authority. */
  recipient: string;
  /** ARM A: the obligation nobody delivered against. ARM B: null. */
  obligation: OwedSendObligation | null;
  /** ARM B: the delivery row whose own outcome contradicts the claim. ARM A: null. */
  failedDeliveryId: string | null;
  /** ARM B's recorded outcome, for the steer's own wording ('failed', 'held', …). */
  failedOutcome: string | null;
  /** The steer queue's latch key — the ROW's id, so one steer per obligation, not per phrase. */
  latchKey: string;
  basis: 'owed-obligation' | 'failed-receipt';
}

export interface ClaimedDeliveryStandsDown {
  fires: false;
  reason: ClaimedDeliveryStandDown;
  /** Present when the narrowing DID name somebody — the evidence a stand-down is deliberate. */
  recipient: string | null;
}

export type ClaimedDeliveryDecision = ClaimedDeliveryFires | ClaimedDeliveryStandsDown;

export interface ClaimedDeliveryInput {
  agentId: string;
  turnNumber: number | null;
  /** The terminal user-facing text about to stand. */
  responseText: string | null;
  /** Cumulative successful tool activity this turn (C5 — never just the last iteration). */
  toolCallsThisTurn: ReadonlyArray<{ name: string }>;
  counterpartyName?: string | null;
  /** The receipt suppressor, injected so the decision is testable without the ledger module:
   *  true when a REAL delivery to this recipient is already on record (24h). */
  hasDeliveryReceipt: (recipient: string) => boolean;
}

/**
 * A `deliveries` row to this recipient on THIS turn whose outcome is not 'delivered'.
 *
 * Scoped to the turn deliberately. A failure yesterday is history the model may legitimately
 * be narrating; a failure in the same breath as "I sent it" is the claim itself being wrong,
 * and it is the only shape where firing cannot cause the duplicate send the owner reported.
 */
function failedDeliveryThisTurn(
  agentId: string, turnNumber: number | null, recipient: string,
): { id: string; outcome: string } | null {
  if (turnNumber == null) return null;
  try {
    const rows = getDb().prepare(
      `SELECT id, outcome, recipient_id, recipient_display FROM deliveries
        WHERE agent_id = ? AND turn_number = ? AND outcome <> 'delivered'
        ORDER BY created_at DESC`,
    ).all(agentId, turnNumber) as Array<{
      id: string; outcome: string; recipient_id: string | null; recipient_display: string | null;
    }>;
    const hit = rows.find((r) =>
      (r.recipient_id !== null && recipientIdsMatch(recipient, r.recipient_id)) ||
      (r.recipient_display !== null && recipientIdsMatch(recipient, r.recipient_display)));
    return hit ? { id: hit.id, outcome: hit.outcome } : null;
  } catch (err) {
    logger.warn('claimed-delivery: failed-receipt arm could not read the ledger (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/** The obligation owed to this named party, or null. Canonical identity, never substring. */
export function obligationOwedTo(
  obligations: readonly OwedSendObligation[], recipient: string,
): OwedSendObligation | null {
  const hit = obligations.find((o) =>
    (o.counterpartyName !== null && recipientIdsMatch(recipient, o.counterpartyName)) ||
    (o.counterpartyId !== null && recipientIdsMatch(recipient, o.counterpartyId)));
  return hit ?? null;
}

/**
 * The floor's whole decision. Reads rows; returns a stand-down with a REASON rather than a
 * bare false, so a red can say which ledger answered.
 */
export function decideClaimedDelivery(input: ClaimedDeliveryInput): ClaimedDeliveryDecision {
  // The narrowing. It answers "who does the reply name", nothing else — the two arms below
  // are the trigger, and neither of them can be satisfied by text.
  const named = detectUngroundedDeliveryClaim({
    responseText: input.responseText,
    // ARM B needs to survive a send tool having RUN, so the tool list is passed with the
    // failed calls filtered out by the caller (C5's cumulative successful set). A send whose
    // door recorded a failure is not a delivery, and the ledger below is what says so.
    toolCallsThisTurn: input.toolCallsThisTurn,
    counterpartyName: input.counterpartyName,
  });
  if (!named.ungrounded) {
    return { fires: false, reason: 'no-claim-in-text', recipient: null };
  }
  const recipient = named.recipient;

  // The pre-existing suppressor, kept verbatim in meaning: a real delivery to this party on
  // record grounds the claim, and a floor that fires into one produces the duplicate send it
  // exists to prevent.
  if (input.hasDeliveryReceipt(recipient)) {
    return { fires: false, reason: 'receipt-backs-the-claim', recipient };
  }

  // ARM B first: a failure the door itself recorded outranks an inference from absence.
  const failed = failedDeliveryThisTurn(input.agentId, input.turnNumber, recipient);
  if (failed) {
    return {
      fires: true, recipient, obligation: null,
      failedDeliveryId: failed.id, failedOutcome: failed.outcome,
      latchKey: `delivery:${failed.id}`, basis: 'failed-receipt',
    };
  }

  // ARM A: the obligation ledger. THE OWNER'S CASE STOPS HERE — a name quoted out of a
  // transcript belongs to nobody this agent owes anything, so there is nothing to contradict.
  const owed = obligationOwedTo(owedSendObligations(input.agentId), recipient);
  if (!owed) {
    return { fires: false, reason: 'nothing-owed-to-them', recipient };
  }
  return {
    fires: true, recipient, obligation: owed,
    failedDeliveryId: null, failedOutcome: null,
    latchKey: `work:${owed.id}`, basis: 'owed-obligation',
  };
}

/**
 * The steer text. It states the ROW, because a floor that cannot say what it is pointing at is
 * the floor the owner caught. "do it NOW" survives only where the ledger earns it.
 */
export function claimedDeliverySteer(d: ClaimedDeliveryFires): string {
  if (d.basis === 'failed-receipt') {
    return (
      `[System: your reply says you got that to ${d.recipient}, but this turn's delivery record for ` +
      `${d.recipient} is "${d.failedOutcome}" — the send did NOT land. Either retry the send with the ` +
      `correct tool, or tell the user plainly that it has not gone through yet. Do not leave a claim ` +
      `standing that the delivery record contradicts.]`
    );
  }
  const o = d.obligation!;
  const what = o.title && o.title.trim() ? ` ("${o.title.trim().slice(0, 80)}")` : '';
  return (
    `[System: your reply says you already got back to ${d.recipient}, and the platform still has an ` +
    `open ${o.kind === 'ask' ? 'message from them' : 'promise you recorded'}${what} with no delivery ` +
    `recorded against it (${o.id}). If you ALREADY sent it, say so plainly and carry on — the record ` +
    `will catch up. If you have NOT, send it now with the correct tool (send_to_agent for another ` +
    `agent, imessage_send / the email-send tool for a person) before telling the user it is done.]`
  );
}
