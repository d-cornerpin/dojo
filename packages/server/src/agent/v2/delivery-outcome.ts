// The ledger's verdict on a crossing, not the send's; built on the shared outcome arms, so `unknown` is unrepresentable.
import type { LiveOutcome, OutcomeApplied, OutcomeFailed, OutcomeNoChange, OutcomeRefused } from '@dojo/shared';
import { createLogger } from '../../logger.js';

const logger = createLogger('delivery-outcome');

export type LedgerOutcome =
  /** A `deliveries` row was written (or an idempotent one already stood). */
  | OutcomeApplied<{ readonly deliveryId: string }>
  /** Nothing new was created, and that is by design: one send, one row. */
  | (OutcomeNoChange<'folded-into-open-scope'> & { readonly deliveryId: string })
  | OutcomeRefused<'no-such-work'>
  /** The write threw. There IS an outbound and the ledger has no record of it. */
  | OutcomeFailed<'ledger-write-failed'>;

// Compile-time proof that LedgerOutcome never says `unknown`: adding such an arm breaks this line first.
export type LedgerOutcomeIsLive = LedgerOutcome extends LiveOutcome<{ deliveryId: string }, string>
  ? true : never;

export function deliveryIdOf(o: LedgerOutcome): string | null {
  if (o.kind === 'applied') return o.value.deliveryId;
  if (o.kind === 'no_change') return o.deliveryId;
  return null;
}

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
