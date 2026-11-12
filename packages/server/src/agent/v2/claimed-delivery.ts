// THE CLAIMED-DELIVERY FLOOR'S TRIGGER. An ungrounded "I already sent it" fires only from ROWS, never
// prose: honesty floors are receipt-keyed. ARM A: an owed obligation with no result_delivery_id whose
// counterparty IS the named recipient. ARM B: a deliveries row to that recipient THIS TURN with outcome
// not 'delivered'. Prose only NARROWS (names the recipient), never fires alone. Every fire carries a row
// id a human can look up; the latch key is that ROW id, and across turns the ledger itself is the latch.

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { recipientIdsMatch } from '../recipient-identity.js';
import { owedSendObligations, type OwedSendObligation } from '../../work/store.js';
import { detectUngroundedDeliveryClaim } from './classifiers/grounding.js';

const logger = createLogger('claimed-delivery');

/** Why the floor stood down. Every value is a fact about the LEDGER, not about the text. */
export type ClaimedDeliveryStandDown =
  | 'no-claim-in-text'
  | 'a-delivery-tool-ran'
  | 'nothing-owed-to-them'
  | 'receipt-backs-the-claim';

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
  /** The steer queue's latch key: the ROW's id, so one steer per obligation, not per phrase. */
  latchKey: string;
  basis: 'owed-obligation' | 'failed-receipt';
}

export interface ClaimedDeliveryStandsDown {
  fires: false;
  reason: ClaimedDeliveryStandDown;
  /** Present when the narrowing DID name somebody, the evidence a stand-down is deliberate. */
  recipient: string | null;
}

export type ClaimedDeliveryDecision = ClaimedDeliveryFires | ClaimedDeliveryStandsDown;

export interface ClaimedDeliveryInput {
  agentId: string;
  turnNumber: number | null;
  responseText: string | null;
  /** Cumulative successful tool activity this turn (never just the last iteration). */
  toolCallsThisTurn: ReadonlyArray<{ name: string }>;
  counterpartyName?: string | null;
  /** Receipt suppressor, injected for testing: true when a REAL delivery to this recipient is on record. */
  hasDeliveryReceipt: (recipient: string) => boolean;
  /** The decision model's narrowing (`reply-claims.ts`); absent, the prose alone. It can confirm or take
   *  away the prose's hit, never add one: the ledger is asked about the party the prose NAMED. */
  claimInText?: (ruleSaid: boolean) => boolean;
}

// THIS turn only: an older failure may be legitimately narrated; a same-turn failure beside "I sent it"
// is the only shape where firing cannot cause a duplicate send.
function failedDeliveryThisTurn(
  agentId: string, turnNumber: number | null, recipient: string,
): { id: string; outcome: string } | null {
  if (turnNumber == null) return null;
  try {
    // The outcome list is ENUMERATED POSITIVELY, load-bearing: `owner_closed` is also not 'delivered' but is
    // the receipt an owner closing their own task writes; `outcome <> 'delivered'` would sweep it in.
    const rows = getDb().prepare(
      `SELECT id, outcome, recipient_id, recipient_display FROM deliveries
        WHERE agent_id = ? AND turn_number = ? AND outcome IN ('failed','suppressed','held')
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

export function obligationOwedTo(
  obligations: readonly OwedSendObligation[], recipient: string,
): OwedSendObligation | null {
  const hit = obligations.find((o) =>
    (o.counterpartyName !== null && recipientIdsMatch(recipient, o.counterpartyName)) ||
    (o.counterpartyId !== null && recipientIdsMatch(recipient, o.counterpartyId)));
  return hit ?? null;
}

export function decideClaimedDelivery(input: ClaimedDeliveryInput): ClaimedDeliveryDecision {
  const named = detectUngroundedDeliveryClaim({
    responseText: input.responseText,
    toolCallsThisTurn: input.toolCallsThisTurn,
    counterpartyName: input.counterpartyName,
  });
  if (!named.ungrounded || input.claimInText?.(true) === false) {
    return { fires: false, reason: 'no-claim-in-text', recipient: null };
  }
  const recipient = named.recipient;

  if (input.hasDeliveryReceipt(recipient)) {
    return { fires: false, reason: 'receipt-backs-the-claim', recipient };
  }

  // ARM B before ARM A: a failure the door recorded outranks an inference from absence.
  const failed = failedDeliveryThisTurn(input.agentId, input.turnNumber, recipient);
  if (failed) {
    return {
      fires: true, recipient, obligation: null,
      failedDeliveryId: failed.id, failedOutcome: failed.outcome,
      latchKey: `delivery:${failed.id}`, basis: 'failed-receipt',
    };
  }

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

export function claimedDeliverySteer(d: ClaimedDeliveryFires): string {
  if (d.basis === 'failed-receipt') {
    return (
      `[System: your reply says you got that to ${d.recipient}, but this turn's delivery record for ` +
      `${d.recipient} is "${d.failedOutcome}" — the send did NOT land. Either retry the send with the ` +
      `correct tool, or tell the person you are talking to plainly that it has not gone through yet. Do not leave a claim ` +
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
    `agent, imessage_send / the email-send tool for a person) before telling the person you are talking to it is done.]`
  );
}
