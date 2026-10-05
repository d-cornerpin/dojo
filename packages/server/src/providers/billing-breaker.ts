// ════════════════════════════════════════════════════════════════════════════
// A PROVIDER THAT IS OUT OF MONEY IS NOT A PROVIDER HAVING A BAD MINUTE.
// (v3.2.3 incident, layer 3)
//
// ── THE INCIDENT, IN ITS OWN NUMBERS ──
// A user's box logged **3,604 provider errors over 27 hours** — every one an HTTP
// 402 from a cloud provider with no balance — and the platform kept dialling it,
// silently, for a day and a night. `recordProviderError`
// (`gateway/routes/services.ts`) counted them and flipped a Health CARD; nothing
// ever stopped a dial, because a counter with no consequence is a log line with
// extra steps. Meanwhile the summary writer used that same dead provider, so
// memory compaction re-attempted the entire backlog on every prompt (layer 1),
// and the auto-router kept offering the cheapest model — the dead one — first,
// which the public report measured at **+15-20 s of tax per turn**.
//
// ── THE ONE DISTINCTION THIS FILE ADDS ──
// The platform already classifies provider errors well: `classifyProviderErrorText`
// gives a class, and `classifyPlatformError` turns it into a `PlatformErrorKind`.
// What neither answers is **PERMANENCE** — will trying again in ten seconds help?
//
//   TRANSIENT: overloaded, rate-limited, a socket that died, a timeout. Retry is
//     the correct response and the cascade already handles it.
//   PERMANENT: no balance (402), a revoked or invalid key (401), a hard refusal
//     (403). Nothing the platform does changes the answer. Only the OWNER can.
//
// Retrying a permanent failure is not caution, it is a busy-wait against a wall —
// and because every retry costs a real round trip, it is also the mechanism that
// turned one billing problem into a frozen box.
//
// ── WHAT THE BREAKER IS, AND WHAT IT DELIBERATELY IS NOT ──
// After `PERMANENT_FAILURES_TO_BREAK` permanent failures a provider is OPEN: the
// router skips it, the summary writer refuses to use it, and the owner gets a card
// naming the provider and the two things they can do about it. It is NOT a health
// heuristic, NOT time-based decay, and NOT self-closing: a wall does not stop
// being a wall after five minutes. It closes when the owner says so
// (`clearProviderBreaker`, reached from the retry affordance) or when a call to
// that provider genuinely succeeds — which can only happen through a path the
// breaker does not gate, e.g. the owner's own "test connection" in Settings.
//
// ⚠ AND IT NEVER GATES THE LAST DOOR. `mayDialProvider` answers `true` when the
// caller says this is the only provider it has. A box with ONE provider must be
// told it is out of balance, not silently stopped — see `pauseInsteadOfRetrying`
// and the PM-agent case in the incident report. A breaker that made a
// single-provider box unusable would be a worse outage than the one it prevents.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import {
  classifyProviderErrorText, statusIsAnchored, type ProviderErrorFacts,
} from '../agent/provider-error.js';
import { getDb } from '../db/connection.js';

const logger = createLogger('billing-breaker');

/**
 * Two, not three, and not one. One is a flake (a 402 can be a race with a
 * top-up that just landed); three means a third full round trip bought nothing.
 * The incident's box would have tripped this inside the first minute instead of
 * dialling 3,604 times.
 */
export const PERMANENT_FAILURES_TO_BREAK = 2;

/** Why a provider is open, kept so the card and the log can name it. */
export type PermanentReason = 'no_balance' | 'credential_rejected' | 'access_refused';

export interface OpenBreaker {
  providerId: string;
  reason: PermanentReason;
  failures: number;
  since: string;
  /** The provider's own last words, for the card. Never a secret: this is its error text. */
  detail: string;
}

const permanentFailureCounts = new Map<string, number>();
const openBreakers = new Map<string, OpenBreaker>();

/**
 * IS THIS FAILURE PERMANENT, AND WHY?
 *
 * Delegates the hard part — reading a provider's status, structured type and
 * transport code without matching digits inside a token count — to
 * `classifyProviderErrorText`, which exists and was written for exactly that trap
 * (a 400 "prompt is too long: 204015 tokens" once read as `auth_invalid` on the
 * "401" inside the number). This function adds only the permanence verdict.
 *
 * `null` means "not permanent" — which includes "not classifiable". The default
 * direction is deliberately TRANSIENT: a breaker that opens on an unrecognised
 * string would take a working provider off the board on a bad parse.
 */
function reasonForClass(c: ProviderErrorFacts['class']): PermanentReason | null {
  switch (c) {
    // 402 / "insufficient balance" / "credit". The wall this incident hit.
    case 'quota': return 'no_balance';
    // 401 and prose-named revoked keys. A retry cannot mint a credential.
    case 'auth': return 'credential_rejected';
    // 403. The owner must change something on the provider's side.
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

  // ⚠ THE CLASS IS NOT ENOUGH. (v3.2.3 review, H2 — this gate is the whole finding.)
  //
  // The classes above are reached through a substring match on the status number, and a hyphen or
  // a space is a word boundary. The review measured five innocent strings — a model name, a
  // progress ratio, a URL path, a quoted upstream status, a retry counter — every one of which
  // arrived here as PERMANENT and would have taken a provider that was working perfectly well off
  // the board. That is the exact failure this module's header forbids.
  //
  // A latch therefore needs evidence stronger than *the digits are somewhere in the sentence*. Any
  // ONE of three qualifies, and they are in order of how much they are worth:
  const permanent = (
    // 1. THE SDK SAID SO. `basis: 'status' | 'body'` means `classifyProviderError` read the number
    //    out of a real field on a real error object, not out of prose. Nothing beats that.
    ((f.basis === 'status' || f.basis === 'body') && f.status !== null)
    // 2. THE NUMBER IS WHERE A STATUS GOES — leading, or introduced by `error`/`status`/`code`.
    || (f.status !== null && statusIsAnchored(text, f.status))
    // 3. THE WORDS SAY IT WITHOUT THE NUMBER. Strip every digit and ask the one classifier again:
    //    if it still lands on the same permanent class, the prose carried the verdict by itself
    //    (`insufficient balance`, `invalid_api_key`, `forbidden`) and the number was never load-
    //    bearing. Re-asking rather than keeping a second phrase list here is deliberate: there is
    //    one implementation of what these words mean, and it cannot drift from itself.
    || reasonForClass(classifyProviderErrorText(text.replace(/\d/g, '#')).class) === reason
  );

  // Uncertain ⇒ TRANSIENT. The recovery cascade retries and the owner is never lied to about a
  // provider being dead. A missed latch costs retries on one call; a false latch costs the box.
  return permanent ? reason : null;
}

/** The card text per reason. Plain words, an action, and no jargon. */
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

/**
 * Record one PERMANENT failure and open the breaker at the threshold.
 *
 * Returns the open breaker when this call is what opened it (so the caller can
 * stop what it was doing), or `null` while it is still counting. Idempotent once
 * open: a provider already open is not re-carded, which is the difference between
 * "one card the owner acts on" and "3,604 toasts the owner learns to ignore".
 */
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
    // The REAL card machinery: the same `chat:error` frame the context gate and the
    // healer already surface as a dashboard toast. `QUOTA_EXHAUSTED` is an existing
    // Tier-D code whose whole meaning is "the engine cannot proceed and the user must
    // act" — exactly this, so no new frame type is invented for it.
    broadcast({
      type: 'chat:error',
      agentId: agentId ?? '',
      error: cardText(providerId, reason),
      code: 'QUOTA_EXHAUSTED',
      severity: 'error',
      retryable: false,
    });
  } catch { /* a card nobody could be shown is not a reason to keep dialling */ }
  return open;
}

/** Classify, then record. The one call site a caller with an error string needs. */
export function noteProviderFailure(
  providerId: string, errText: string, agentId?: string, facts?: ProviderErrorFacts,
): OpenBreaker | null {
  const reason = permanentFailureReason(errText, facts);
  if (!reason) return null;   // transient: the recovery cascade owns it, unchanged
  return recordPermanentFailure(providerId, reason, errText, agentId);
}

/** A successful call is the only evidence that beats a recorded wall. */
export function noteProviderSuccess(providerId: string): void {
  permanentFailureCounts.delete(providerId);
  if (openBreakers.delete(providerId)) {
    logger.info('Provider breaker closed by a successful call', { providerId });
  }
}

export function providerBreaker(providerId: string): OpenBreaker | null {
  return openBreakers.get(providerId) ?? null;
}

export function openBreakers_readonly(): readonly OpenBreaker[] {
  return [...openBreakers.values()];
}

/**
 * MAY THIS CALL BE DIALLED?
 *
 * `isOnlyOption` is the last-door carve-out described in the header: a caller that
 * has nowhere else to go is allowed through, because a single-provider box must
 * fail with an explanation rather than fall silent. Everything with an alternative
 * — the router, the summary writer — passes `false` and gets skipped past.
 */
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

/**
 * The owner's manual retry: clear the wall and try again.
 *
 * Returns whether anything was open, so the route can answer honestly instead of
 * always saying "cleared". The counter goes too — otherwise one more failure
 * re-opens it instantly and the retry looks like it did nothing.
 */
export function clearProviderBreaker(providerId: string): boolean {
  permanentFailureCounts.delete(providerId);
  const wasOpen = openBreakers.delete(providerId);
  logger.info('Provider breaker cleared by the owner', { providerId, wasOpen });
  return wasOpen;
}

/**
 * THE SINGLE-PROVIDER CASE: pause with a status, never retry-for-ever.
 *
 * The incident's PM agent had one provider. With the breaker open and no
 * alternative, the honest answer is a sentence the owner can act on — which is
 * what this returns, for the caller to put where its user will see it. A caller
 * that gets a string here must STOP, not loop.
 */
export function pauseInsteadOfRetrying(providerId: string): string | null {
  const open = openBreakers.get(providerId);
  if (!open) return null;
  return `Paused: ${cardText(open.providerId, open.reason)}`;
}

/**
 * THE SUMMARY WRITER'S OWN DOOR (the incident's inner loop).
 *
 * Takes a MODEL id because that is what compaction holds, resolves its provider, and
 * records a permanent failure against it. Returns the reason when the failure was
 * permanent (so the caller can log which kind it was), `null` when it was transient
 * and the existing retry behaviour is correct.
 *
 * ⚠ AND IT TAKES THE SDK'S OWN FACTS, or it is decorative (t87b review I1, measured on main
 * 2026-10-05). `agent/model.ts` WRAPS every failure before the summary writer sees it, and
 * `OpenAI call failed: 402 Payment Required` classifies `unknown`/`basis:'none'` — `failed:` is
 * not one of `statusIsAnchored`'s introducers and the number is no longer leading — so arms 2
 * and 3 below both decline and the breaker never opened on the incident's own door. Every throw
 * site already attaches `provider: facts` with `basis:'status'`, which arm 1 takes without
 * reading prose at all. OPTIONAL: absent is exactly today's behaviour, so no caller changes.
 *
 * Deliberately swallows its own lookup errors: a breaker that throws inside a catch
 * block would turn a provider outage into a crash, which is a worse failure than the
 * one it exists to bound.
 */
export function noteSummaryWriterFailure(
  modelId: string | undefined, errText: string, agentId?: string, facts?: ProviderErrorFacts,
): PermanentReason | null {
  const reason = permanentFailureReason(errText, facts);
  if (!reason || !modelId) return reason;
  try {
    const row = getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined;
    if (row?.provider_id) recordPermanentFailure(row.provider_id, reason, errText, agentId);
  } catch { /* see the note above: never throw from inside somebody's catch */ }
  return reason;
}

/** Test-only reset. Module state is per-process and the suite runs many boxes. */
export function __resetBreakersForTests(): void {
  permanentFailureCounts.clear();
  openBreakers.clear();
}
