// Circuit breaker for PERMANENT provider failures (402 no balance, 401 rejected key, 403 refused), which
// retrying cannot fix. After PERMANENT_FAILURES_TO_BREAK of them the provider is OPEN: the router and summary
// writer skip it and the owner gets one card. It never decays; it closes only on a genuine success.
// It never gates the last door: `mayDialProvider` admits a caller whose only provider this is,
// so a single-provider box is told it is out of balance instead of going silent.

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import {
  classifyProviderErrorText, statusIsAnchored, type ProviderErrorFacts,
} from '../agent/provider-error.js';

const logger = createLogger('billing-breaker');

/** One failure can be a 402 racing a fresh top-up; a third buys nothing. */
export const PERMANENT_FAILURES_TO_BREAK = 2;

export type PermanentReason = 'no_balance' | 'credential_rejected' | 'access_refused';

export interface OpenBreaker {
  providerId: string;
  reason: PermanentReason;
  failures: number;
  since: string;
  /** The provider's own error text, shown on the card; never a secret. */
  detail: string;
}

const permanentFailureCounts = new Map<string, number>();
const openBreakers = new Map<string, OpenBreaker>();

/** Maps a classified error to a permanent reason; null (including unclassifiable) is not permanent. */
function reasonForClass(c: ProviderErrorFacts['class']): PermanentReason | null {
  switch (c) {
    case 'quota': return 'no_balance';
    case 'auth': return 'credential_rejected';
    case 'access_denied': return 'access_refused';
    default: return null;
  }
}

export function permanentFailureReason(
  errText: string, facts?: ProviderErrorFacts,
): PermanentReason | null {
  const text = errText ?? '';
  const f = facts ?? classifyProviderErrorText(text);
  const reason = reasonForClass(f.class);
  if (!reason) return null;

  // The class alone is not enough: it comes from a substring match on the status number, so digits in a
  // model name, progress ratio, URL or retry counter would read as permanent. Require one of three proofs:
  const permanent = (
    // 1. The SDK's own status or body field (a real error object, not prose).
    ((f.basis === 'status' || f.basis === 'body') && f.status !== null)
    // 2. The number sits where a status goes (leading, or after error/status/code).
    || (f.status !== null && statusIsAnchored(text, f.status))
    // 3. The words alone carry it: with digits stripped, the one classifier gives the same class.
    || reasonForClass(classifyProviderErrorText(text.replace(/\d/g, '#')).class) === reason
  );

  // Uncertain means TRANSIENT: a missed latch costs retries on one call, a false latch takes a working
  // provider off the board.
  return permanent ? reason : null;
}

function cardText(providerId: string, reason: PermanentReason): string {
  switch (reason) {
    case 'no_balance':
      return `Provider "${providerId}" is out of balance — it refused every call (HTTP 402). `
        + 'Top up that account or switch this agent to another provider in Settings → Providers. '
        + 'Nothing will be retried against it until you do; your agents keep working on any other provider.';
    case 'credential_rejected':
      return `Provider "${providerId}" rejected its credential (HTTP 401). `
        + 'The key is missing, expired or revoked — paste a fresh one in Settings → Providers. '
        + 'Nothing will be retried against it until you do.';
    case 'access_refused':
      return `Provider "${providerId}" refused access to this model (HTTP 403). `
        + 'Check the account has that model enabled, or switch this agent to another provider. '
        + 'Nothing will be retried against it until you do.';
  }
}

/** Records one PERMANENT failure; returns the breaker when this call opened it. Once open, never re-carded. */
export function recordPermanentFailure(
  providerId: string, reason: PermanentReason, detail: string, agentId?: string,
): OpenBreaker | null {
  const already = openBreakers.get(providerId);
  if (already) {
    already.failures += 1;
    return null;
  }
  const n = (permanentFailureCounts.get(providerId) ?? 0) + 1;
  permanentFailureCounts.set(providerId, n);
  logger.warn('Permanent provider failure recorded', {
    providerId, reason, failures: n, threshold: PERMANENT_FAILURES_TO_BREAK,
  }, agentId);
  if (n < PERMANENT_FAILURES_TO_BREAK) return null;

  const open: OpenBreaker = {
    providerId, reason, failures: n, since: new Date().toISOString(),
    detail: (detail ?? '').slice(0, 300),
  };
  openBreakers.set(providerId, open);
  logger.error('Provider breaker OPEN: permanent failures, no further dials until the owner acts', {
    providerId, reason, failures: n,
  }, agentId);
  try {
    // The same chat:error frame the context gate uses; QUOTA_EXHAUSTED means the user must act.
    broadcast({
      type: 'chat:error',
      agentId: agentId ?? '',
      error: cardText(providerId, reason),
      code: 'QUOTA_EXHAUSTED',
      severity: 'error',
      cardClass: 'action',   // the owner tops up or changes the key
      retryable: false,
    });
  } catch { /* a card nobody could be shown is not a reason to keep dialling */ }
  return open;
}

export function noteProviderFailure(
  providerId: string, errText: string, agentId?: string, facts?: ProviderErrorFacts,
): OpenBreaker | null {
  const reason = permanentFailureReason(errText, facts);
  if (!reason) return null;   // transient: the recovery cascade owns it, unchanged
  return recordPermanentFailure(providerId, reason, errText, agentId);
}

export function noteProviderSuccess(providerId: string): void {
  permanentFailureCounts.delete(providerId);
  if (openBreakers.delete(providerId)) {
    logger.info('Provider breaker closed by a successful call', { providerId });
  }
}

export function providerBreaker(providerId: string): OpenBreaker | null {
  return openBreakers.get(providerId) ?? null;
}

/** `isOnlyOption` is the last-door carve-out: a caller with no alternative is admitted. */
export function mayDialProvider(providerId: string, isOnlyOption = false): boolean {
  const open = openBreakers.get(providerId);
  if (!open) return true;
  if (isOnlyOption) {
    logger.warn('Dialling an OPEN provider because it is the only one this caller has', {
      providerId, reason: open.reason,
    });
    return true;
  }
  return false;
}

export function __resetBreakersForTests(): void {
  permanentFailureCounts.clear();
  openBreakers.clear();
}
