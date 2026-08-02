// ════════════════════════════════════════
// The DELIVERY boundary's `Outcome` (PHASE-4 T1 Step 2, cluster 2 of 3).
//
// §T0-PINS A pins the boundary as `outbound.ts`'s `withOutbound*` scope →
// `recordAtDoor` → `deliveries.ts:recordDelivery`. Every one of those answered
// `string | null`, and `null` meant THREE different things:
//
//   * this crossing folded into the row the scope already owns (one send, one
//     row — the designed, correct case);
//   * the work row an owner-close receipt was for does not exist (a refusal);
//   * the ledger write THREW and the delivery has no record at all (the failure
//     the whole ledger exists to prevent — `recordDelivery` is best-effort by
//     contract, "a delivery record must never break the delivery itself", so it
//     logs and returns null).
//
// A caller could not tell them apart, so nine door crossings simply discarded the
// answer. `work.done` requires a delivery to point at; a ledger write that failed
// silently is how a delivered answer leaves a ticket open forever, which is the
// exact defect research 03 measured and PHASE-2 T5 half-closed. This names the
// three.
//
// ── NAMES: `LedgerOutcome`, NOT `DeliveryOutcome` ──
// `DeliveryOutcome` is already taken, by `DeliveryInput['outcome']` — the value
// stored IN the row (`delivered | suppressed | failed | held | owner_closed`),
// which is what happened to the SEND. This type is what happened to the RECORD.
// Two different questions, deliberately two different names; collapsing them
// would put "the send failed" and "the bookkeeping failed" behind one word, and
// telling those apart is the point.
//
// ── `unknown` IS UNREPRESENTABLE HERE ──
// Built on `LiveOutcome`. A door records what it just observed on a live send;
// there is no non-live provenance in play, so there is nothing honest to say
// `unknown` about. The quarantine is the compiler's, not a convention's.
// ════════════════════════════════════════
import type { LiveOutcome, OutcomeApplied, OutcomeFailed, OutcomeNoChange, OutcomeRefused } from '@dojo/shared';
import { createLogger } from '../../logger.js';

const logger = createLogger('delivery-outcome');

/** What the ledger did with this crossing. */
export type LedgerOutcome =
  /** A `deliveries` row was written (or an idempotent one already stood). */
  | OutcomeApplied<{ readonly deliveryId: string }>
  /** One send, one row: a later crossing of the same scope enriched the row the
   *  first crossing wrote. Nothing new was created, and that is by design. */
  | (OutcomeNoChange<'folded-into-open-scope'> & { readonly deliveryId: string })
  /** An owner-close receipt for a work row that does not exist. G7 will refuse the
   *  close for the same reason, which is the correct answer for an id that does
   *  not resolve — but the caller should hear it from here first. */
  | OutcomeRefused<'no-such-work'>
  /** The write threw. There IS an outbound and the ledger has no record of it. */
  | OutcomeFailed<'ledger-write-failed'>;

/** Compile-time proof that this boundary cannot say `unknown`: the alias below is
 *  the four-way, and `LedgerOutcome`'s arms are assignable to it. Adding an
 *  `unknown` arm above breaks this line before it breaks anything else. */
export type LedgerOutcomeIsLive = LedgerOutcome extends LiveOutcome<{ deliveryId: string }, string>
  ? true : never;

/**
 * The row id, for the callers that link something to it.
 *
 * `null` still exists — some callers genuinely have nothing to link — but it is
 * now produced by a NAMED reader that had to look at the outcome to produce it,
 * rather than being the boundary's only vocabulary.
 */
export function deliveryIdOf(o: LedgerOutcome): string | null {
  if (o.kind === 'applied') return o.value.deliveryId;
  if (o.kind === 'no_change') return o.deliveryId;
  return null;
}

/**
 * CONSUME BY RECORDING, for a door with no branch to take — and hand back the id.
 *
 * Eleven transport crossings — Gmail, Outlook, the iMessage bridge, both Twilio
 * paths, the voice socket, the A2A relay, the settled-context hold — cross, record,
 * and move on. None of them can un-send what it just sent, so none has a recovery
 * to run; what they owe is that a ledger failure stops being invisible. Same shape
 * and same argument as `work/outcome.ts`'s `noteUnsettled`: a fold is normal and
 * silent, a refusal or a failure is a log line naming the door.
 *
 * It returns the id rather than `void` so a door that wants it and a door that does
 * not both use ONE function. The pure `deliveryIdOf` above stays for the two sites
 * that already handle the null themselves inside a `??` chain.
 */
export function recordedId(
  o: LedgerOutcome, where: string, ctx: Record<string, unknown> = {},
): string | null {
  if (o.kind === 'refused' || o.kind === 'failed') {
    logger.warn(`outbound NOT recorded in the delivery ledger: ${where}`, {
      ...ctx, reason: o.reason, detail: o.detail,
    });
  }
  return deliveryIdOf(o);
}
