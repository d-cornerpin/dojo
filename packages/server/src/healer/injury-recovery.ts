// ════════════════════════════════════════
// Injury Recovery, Event-Driven Agent Healing
//
// When an agent enters 'error' status, the system schedules a delayed
// notification to the Healer agent. After a 5-minute grace period (to
// let transient errors resolve), if the agent is still injured, the
// Healer is woken with a diagnostic message and can use its tools to
// investigate and attempt recovery.
//
// When an agent recovers, the Healer is notified so it has full context.
//
// This replaces the polling approach, no interval timer, just
// event-driven setTimeout per injured agent.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';
import { broadcast } from '../gateway/ws.js';
import { TRANSIENT_PROVIDER_ERROR_SQL } from './diagnostic.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../work/tracker-view.js';

const logger = createLogger('injury-recovery');

// ── Persisted attempt counter ──
// The counter lives on agents.recovery_attempts (migration 035) so it
// survives restarts and can be inspected/reset. Pre-2026-04-29 it was
// in-memory only, which meant a long-running server could silently
// accumulate attempts past MAX_RECOVERY_ATTEMPTS and the healer would
// stop trying for that agent.
function getAttempts(agentId: string): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT recovery_attempts FROM agents WHERE id = ?').get(agentId) as { recovery_attempts: number | null } | undefined;
    return row?.recovery_attempts ?? 0;
  } catch { return 0; }
}
function setAttempts(agentId: string, value: number): void {
  try {
    const db = getDb();
    db.prepare("UPDATE agents SET recovery_attempts = ?, updated_at = datetime('now') WHERE id = ?").run(value, agentId);
  } catch { /* best effort */ }
}

// Broadcast a chat:error so the dashboard surfaces healer activity.
// Without this, every silent return path (max attempts hit, healer missing,
// agent already recovered) leaves the user staring at a stuck agent with no
// idea what's happening.
type HealerEventCode =
  | 'HEALER_DISPATCHED'
  | 'HEALER_SUPPRESSED_MAX_ATTEMPTS'
  | 'HEALER_MISSING'
  | 'HEALER_SELF_INJURED'
  | 'HEALER_DELIVERY_FAILED';
function broadcastInjuryEvent(agentId: string, severity: 'info' | 'warning' | 'error', message: string, code: HealerEventCode): void {
  try {
    broadcast({
      type: 'chat:error',
      agentId,
      error: message,
      code,
      severity,
      retryable: false,
    });
  } catch { /* best effort */ }
}

// Auto-wake delay, fires once before the Healer is involved. Functions as
// a free "are you ok?" poke: the engine just re-runs the agent's loop.
// If it succeeds (transient error cleared) or in-loop recovery handles it,
// the agent recovers without ever bothering the Healer. If it re-injures,
// the Healer dispatches at the (much shorter) grace period below.
const AUTO_WAKE_DELAY_MS = 5 * 1000; // 5s, enough for DB writes to settle

// Grace period before notifying the Healer. With the auto-wake step above,
// the Healer's job is now "agent is genuinely stuck after a free retry
// didn't fix it", not "let's wait and see if it self-resolves". Cut hard.
// Transient errors (rate limit, network) keep a longer grace because they
// may need an upstream window to tick over.
// History:
//   - pre-2026-04-29: single 5-minute period for everything
//   - 2026-04-29:     60s transient / 15s non-transient
//   - 2026-04-29 v2:  30s transient / 5s non-transient (this version,
//                     paired with engine auto-wake)
const GRACE_PERIOD_MS_TRANSIENT = 30 * 1000;
const GRACE_PERIOD_MS_NON_TRANSIENT = 5 * 1000;

// Max recovery attempts per agent before applying backoff. v2.3.19: this
// is no longer "permanent suppression", once the backoff window
// elapses, Healer fires again. See healerBackoffMs() and
// suppressedUntil below.
const MAX_RECOVERY_ATTEMPTS = 3;

// v2.3.19 (error-handling-spec Phase 3), per-agent Healer backoff.
//
// Pre-spec: once recovery_attempts hit MAX, the Healer was suppressed
// PERMANENTLY for that agent until the user manually intervened
// (send message / reset_session / update_agent). User feedback
// was that this turned every transient escalation into a manual chore.
//
// New behavior: once attempts hit MAX, the Healer enters per-agent
// backoff. After backoff window elapses, Healer fires again on the next
// injury. Each consecutive attempt during/after backoff doubles the
// next window: 10 min → 1 hr → 6 hr → 24 hr (cap). Reset on any
// successful turn OR any applied Healer fix.
const HEALER_BACKOFF_LADDER_MS: number[] = [
  10 * 60 * 1000,        // 10 min after MAX
  60 * 60 * 1000,        // 1 hr after MAX+1
  6 * 60 * 60 * 1000,    // 6 hr after MAX+2
  24 * 60 * 60 * 1000,   // 24 hr cap
];
function healerBackoffMs(attempts: number): number {
  // attempts here is the count AFTER it was incremented past MAX. So
  // attempts=MAX is index 0, attempts=MAX+1 is index 1, etc. Cap at last
  // entry for any value past the ladder length.
  const idx = Math.min(attempts - MAX_RECOVERY_ATTEMPTS, HEALER_BACKOFF_LADDER_MS.length - 1);
  return HEALER_BACKOFF_LADDER_MS[Math.max(0, idx)];
}

// ── Durable Healer damping state (remediation Phase 4, S8.3) ──
// These used to be in-memory Maps, which reset on a process bounce: a
// crash-loop that survived a restart was re-hammered by the very backoff
// meant to damp it. Same .get/.set/.delete shape, DB-backed (durable means
// the DB; shared-state is process memory).
function readHealerState(scope: string, key: string): number | null {
  try {
    const row = getDb()
      .prepare('SELECT at_ms FROM healer_state WHERE scope = ? AND key = ?')
      .get(scope, key) as { at_ms: number } | undefined;
    return row?.at_ms ?? null;
  } catch {
    return null;
  }
}
function writeHealerState(scope: string, key: string, atMs: number): void {
  try {
    getDb().prepare(`
      INSERT INTO healer_state (scope, key, at_ms) VALUES (?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms, updated_at = datetime('now')
    `).run(scope, key, atMs);
  } catch { /* damping is best-effort; never block recovery */ }
}
function deleteHealerState(scope: string, key: string): void {
  try {
    getDb().prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?').run(scope, key);
  } catch { /* best-effort */ }
}

// Per-agent absolute timestamp before which Healer will NOT re-fire.
// Cleared on any successful turn (via onAgentRecovered).
const healerSuppressedUntil = {
  get: (agentId: string): number | null => readHealerState('agent_suppression', agentId),
  set: (agentId: string, untilMs: number): void => writeHealerState('agent_suppression', agentId, untilMs),
  delete: (agentId: string): void => deleteHealerState('agent_suppression', agentId),
};

// v2.3.19 (error-handling-spec Phase 4), provider-wide pattern dedup.
//
// When the same provider is hurting MULTIPLE agents (e.g. an OpenRouter
// outage), the pre-spec code spawned one Healer cycle per injured
// agent. Three agents → three diagnostic cycles → three duplicate
// Vitals proposals → wasted tokens + UI clutter.
//
// New behavior: once a provider-wide pattern is detected, mark it
// alerted for 30 minutes. Subsequent injuries on the same provider
// within that window skip the Healer dispatch (the pattern is already
// being handled by the cycle that fired for the first agent, which
// sees ALL three injuries in its diagnostic report).
//
// providerName → lastAlertTimestampMs (DB-backed via healer_state above)
const providerPatternAlerted = {
  get: (provider: string): number | null => readHealerState('provider_alert', provider),
  set: (provider: string, atMs: number): void => writeHealerState('provider_alert', provider, atMs),
  delete: (provider: string): void => deleteHealerState('provider_alert', provider),
};
const PROVIDER_PATTERN_WINDOW_MS = 30 * 60 * 1000;       // 30 min dedup
const PROVIDER_PATTERN_LOOKBACK_MS = 60 * 60 * 1000;     // count peers errored in last 1h
const PROVIDER_PATTERN_PEER_THRESHOLD = 2;               // 2 other agents = pattern (3 total)

/**
 * Decide whether this injury is part of a provider-wide outage already
 * being handled. Returns the provider name if a recent pattern alert
 * exists (in which case the caller should skip per-agent Healer
 * dispatch), or null if no active pattern.
 */
function isProviderPatternHandled(agentId: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT p.name AS provider_name
      FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE a.id = ?
    `).get(agentId) as { provider_name: string } | undefined;
    if (!row?.provider_name) return null;

    const alertedAt = providerPatternAlerted.get(row.provider_name);
    if (!alertedAt) return null;
    if (Date.now() - alertedAt > PROVIDER_PATTERN_WINDOW_MS) {
      providerPatternAlerted.delete(row.provider_name);
      return null;
    }
    return row.provider_name;
  } catch {
    return null;
  }
}

/**
 * Mark a provider-wide pattern detected. Subsequent injuries on the same
 * provider within PROVIDER_PATTERN_WINDOW_MS will skip Healer dispatch.
 * Returns the provider name if a pattern was newly recorded, or null if
 * no pattern (fewer than threshold peers).
 */
function maybeRecordProviderPattern(agentId: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT p.name AS provider_name
      FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE a.id = ?
    `).get(agentId) as { provider_name: string } | undefined;
    if (!row?.provider_name) return null;

    // FA-X5: mirror the outage detector's transient-error filter AND require
    // the peer to be currently injured (status IN 'error'/'paused'). Pre-fix
    // this counted ANY same-provider agent with a non-null last_error in the
    // last hour, with no error-type filter and no status check, so agents that
    // had already RECOVERED (last_error is not cleared on every recovery path)
    // inflated the count and a genuinely distinct injury got deduped as part
    // of a "pattern" that no longer existed. The shared predicate keeps this
    // in lockstep with getProviderOutagePatterns so the two never drift.
    const lookbackSec = Math.floor(PROVIDER_PATTERN_LOOKBACK_MS / 1000);
    const peers = db.prepare(`
      SELECT COUNT(*) AS cnt FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE p.name = ?
        AND a.id != ?
        AND a.status IN ('error', 'paused')
        AND a.last_error IS NOT NULL
        AND a.last_error_at > datetime('now', '-${lookbackSec} seconds')
        AND ${TRANSIENT_PROVIDER_ERROR_SQL}
    `).get(row.provider_name, agentId) as { cnt: number };

    if (peers.cnt < PROVIDER_PATTERN_PEER_THRESHOLD) return null;

    providerPatternAlerted.set(row.provider_name, Date.now());
    logger.info('Provider-wide injury pattern detected, Healer will run ONE cycle for it', {
      provider: row.provider_name,
      triggeredBy: agentId,
      peerCount: peers.cnt,
      windowMinutes: PROVIDER_PATTERN_WINDOW_MS / 60_000,
    });
    return row.provider_name;
  } catch {
    return null;
  }
}

// Pending recovery timers, keyed by agent ID. Cancelled if the agent recovers
// within the grace period (no need to bother the healer).
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Pending auto-wake timers, same lifecycle as pendingTimers but for the
// engine-level "are you ok?" poke that fires before the Healer is involved.
const autoWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Classify the error for the healer's diagnostic context
function classifyError(error: string | null): string {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();

  if (lower.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit') ||
      lower.includes('overloaded') || lower.includes('529')) return 'rate_limit';
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('etimedout') ||
      lower.includes('fetch failed') || lower.includes('network') || lower.includes('socket') ||
      lower.includes('timeout') || lower.includes('timed out') ||
      lower.includes('503') || lower.includes('502') || lower.includes('500')) return 'network';
  if (lower.includes('tool_use_id') || lower.includes('tool_result') ||
      lower.includes('invalid_request') || lower.includes('malformed') ||
      lower.includes('messages.0') || lower.includes('content block')) return 'context_corruption';
  if (lower.includes('no model') || lower.includes('agent not found')) return 'config';
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') ||
      lower.includes('invalid_api_key') || lower.includes('api key')) return 'auth';
  // Phase 8 F1 fix: bucket generic 4xx provider errors instead of falling
  // through to 'unknown'. The user-facing toast went "(error: unknown)" for
  // anything not matched above, even when the message was clearly a 400.
  if (lower.includes('400') || lower.includes('404') || lower.includes('422')) return 'provider_error';

  return 'unknown';
}

/**
 * Called when an agent enters 'error' or 'paused' (error loop) status.
 * Starts a grace period timer. If the agent is still injured after the
 * grace period, notifies the Healer agent.
 */
export function onAgentInjured(agentId: string, errorMessage: string): void {
  // The healer cannot heal itself, that would create an infinite loop.
  // Instead, alert the user directly via iMessage AND broadcast to the
  // dashboard so the user sees the alert without needing iMessage.
  try {
    const db = getDb();
    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healerRow && agentId === healerRow.value) {
      logger.warn('Healer agent is injured, alerting user directly (cannot self-heal)', { agentId });
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
      // v2.3.19 (error-handling-spec Phase 2): both iMessage and dashboard
      // toast use the same plain-English wording. Raw provider error stays
      // in logs only (logged at line ~135 above). No JSON, no field paths,
      // no "Error: ..." dump.
      const userMsg = `The Healer agent is broken and can't auto-fix itself. Open the Healer's detail page to investigate, or restart it from Settings.`;
      sendAlert(userMsg, 'critical');
      broadcastInjuryEvent(agentId, 'error', userMsg, 'HEALER_SELF_INJURED');
      return;
    }
  } catch { /* config not available */ }

  // v2.3.19 (error-handling-spec Phase 3), per-agent Healer backoff.
  //
  // Once attempts hit MAX, we enter backoff. The Healer can fire again
  // after the backoff window elapses (10 min → 1 hr → 6 hr → 24 hr cap).
  // The user gets a one-time iMessage on the FIRST entry into backoff;
  // subsequent injuries within the window stay silent (the user already
  // knows). This replaces the pre-spec permanent suppression that
  // required manual unsticking.
  const attempts = getAttempts(agentId);
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    const now = Date.now();
    const suppressedUntil = healerSuppressedUntil.get(agentId) ?? 0;

    if (suppressedUntil > now) {
      // Still in backoff window, silent. Healer will get a fresh shot
      // when the timer elapses.
      logger.info('Healer in backoff for agent, skipping this injury', {
        agentId,
        attempts,
        suppressedUntilIso: new Date(suppressedUntil).toISOString(),
        remainingMs: suppressedUntil - now,
      });
      return;
    }

    // Backoff window has elapsed (or this is the first entry into
    // backoff). Schedule the NEXT backoff window now so we don't fire
    // again immediately on a re-injury during this Healer cycle.
    const nextBackoffMs = healerBackoffMs(attempts);
    healerSuppressedUntil.set(agentId, now + nextBackoffMs);

    // Only alert the user on the FIRST entry into the backoff cycle
    // (attempts === MAX). Subsequent re-tries should be silent so the
    // user isn't pinged every few minutes for a slow-resolving issue.
    if (attempts === MAX_RECOVERY_ATTEMPTS) {
      logger.warn('Max recovery attempts hit, entering Healer backoff', {
        agentId, attempts, max: MAX_RECOVERY_ATTEMPTS, nextRetryInMs: nextBackoffMs,
      });
      try {
        const db = getDb();
        const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        const userMsg = `${agent?.name ?? agentId} has been stuck for a few tries and auto-recovery isn't unsticking it. I'll keep trying in the background. You can also send a message or reset its session from the detail page.`;
        sendAlert(userMsg, 'warning');
        broadcastInjuryEvent(agentId, 'warning', userMsg, 'HEALER_SUPPRESSED_MAX_ATTEMPTS');
      } catch { /* best effort */ }
    } else {
      logger.info('Healer retry after backoff window, re-engaging', {
        agentId, attempts, nextRetryInMs: nextBackoffMs,
      });
    }
    // Fall through, Healer attempts again. attempts++ happens later in
    // the normal flow.
  }

  // Cancel any existing timers for this agent (rapid re-injury)
  const existingHealer = pendingTimers.get(agentId);
  if (existingHealer) clearTimeout(existingHealer);
  const existingWake = autoWakeTimers.get(agentId);
  if (existingWake) clearTimeout(existingWake);

  // Classify error and pick the matching grace period. Transient errors
  // (rate_limit, network) get a longer grace because they often resolve on
  // their own. Non-transient errors are unlikely to self-resolve, so the
  // healer should engage almost immediately.
  const errorClass = classifyError(errorMessage);
  const isTransient = errorClass === 'rate_limit' || errorClass === 'network';
  const gracePeriodMs = isTransient ? GRACE_PERIOD_MS_TRANSIENT : GRACE_PERIOD_MS_NON_TRANSIENT;

  // v2.3.19, known-permanent errors (auth, config) should NOT auto-wake.
  // The pre-spec auto-wake was useful for transient flakes, but firing it
  // on a 401 just spams paid model calls every 5 seconds with the same
  // broken credentials. Tier D conditions get the Healer's attention but
  // skip the engine-level retry.
  const isKnownPermanent =
    errorClass === 'auth' ||
    errorClass === 'config' ||
    /\[auth_invalid\]|\[access_denied\]|\[quota_exhausted\]|\[no_models_available\]|invalid_api_key|\bunauthorized\b|api key/i.test(errorMessage);

  logger.info('Agent injured, scheduling auto-wake + healer notification', {
    agentId,
    errorClass,
    isTransient,
    isKnownPermanent,
    autoWakeDelayMs: isKnownPermanent ? 0 : AUTO_WAKE_DELAY_MS,
    gracePeriodMs,
    attempt: attempts + 1,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
  });

  // Step 1, engine-level auto-wake. Fires first. Just re-runs the agent's
  // loop without involving the Healer (no LLM cost). If transient errors
  // cleared or in-loop recovery handles the failure, the agent recovers
  // here and onAgentRecovered cancels the Healer timer below.
  //
  // v2.3.19, skip auto-wake entirely for known-permanent errors. The
  // Healer is still scheduled below (it can audit, propose, log), but no
  // wasteful model retry.
  if (isKnownPermanent) {
    logger.info('Skipping auto-wake, error is known-permanent (will not self-clear)', {
      agentId, errorClass,
    });
    // Still schedule the Healer notification below, fall through.
  } else {
  const wakeTimer = setTimeout(async () => {
    autoWakeTimers.delete(agentId);
    try {
      const db = getDb();
      const stillInjured = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as { status: string } | undefined;
      if (!stillInjured || (stillInjured.status !== 'error' && stillInjured.status !== 'paused')) {
        logger.debug('Auto-wake skipped, agent already recovered', { agentId });
        return;
      }
      // Don't auto-wake paused agents, that's the error-loop signal.
      if (stillInjured.status === 'paused') {
        logger.debug('Auto-wake skipped, agent is paused (error loop)', { agentId });
        return;
      }
      const { getAgentRuntime } = await import('../agent/runtime.js');
      logger.info('Auto-wake firing, engine re-running injured agent before Healer is involved', { agentId });
      getAgentRuntime().handleMessage(agentId, '').catch(err => {
        logger.warn('Auto-wake handleMessage threw', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.warn('Auto-wake step failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, AUTO_WAKE_DELAY_MS);
  autoWakeTimers.set(agentId, wakeTimer);
  } // end of "not known-permanent" auto-wake block

  // Step 2, Healer notification. Fires after the grace period if the
  // agent is still injured. With the auto-wake above, this only fires
  // when the agent is genuinely stuck.
  //
  // v2.3.19 (error-handling-spec Phase 4), pattern-aware dispatch:
  // before scheduling, check if this injury is part of a provider-wide
  // pattern that's ALREADY being handled by a recent Healer dispatch.
  // If yes, skip, the existing cycle sees all the injuries in its
  // diagnostic report and there's no point spawning another.
  const alreadyHandledProvider = isProviderPatternHandled(agentId);
  if (alreadyHandledProvider) {
    logger.info('Skipping per-agent Healer dispatch, provider-wide pattern already in flight', {
      agentId,
      provider: alreadyHandledProvider,
    });
    // We still bump the attempts counter so the per-agent backoff
    // ladder progresses correctly on repeat injuries.
    setAttempts(agentId, attempts + 1);
    return;
  }

  // No active pattern yet, but is this injury part of a NEW emerging
  // pattern (≥2 peers on the same provider already errored in last 1h)?
  // If so, record it BEFORE scheduling so subsequent injuries on the
  // same provider during the dispatch window get deduped.
  maybeRecordProviderPattern(agentId);

  const timer = setTimeout(() => {
    pendingTimers.delete(agentId);
    setAttempts(agentId, attempts + 1);
    notifyHealerOfInjury(agentId, errorMessage);
  }, gracePeriodMs);

  pendingTimers.set(agentId, timer);
}

/**
 * Called when an agent recovers (transitions from error/paused to idle/working).
 * Cancels the grace period timer if still pending, and notifies the Healer
 * that the agent recovered.
 */
export function onAgentRecovered(agentId: string): void {
  // Clear recovery attempt counter, the agent is healthy again.
  // If it errors again later, the counter starts fresh. Persisted to DB
  // so a future restart sees a clean state.
  setAttempts(agentId, 0);

  // FA-A2: this is the deliberate-recovery chokepoint (a clean turn end with
  // prior attempts, and the Tier-1 auto-fix reset which flips status via a raw
  // UPDATE that does NOT route through setAgentStatus). last_error now survives
  // the 'working' transition, so clear it HERE too, otherwise an auto-fixed agent
  // would carry a stale diagnostic that re-trips the injury readers. Not called
  // on mid-turn retries, so "diagnostic survives retries" is preserved.
  try {
    getDb().prepare(
      "UPDATE agents SET last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(agentId);
  } catch { /* best effort */ }

  // v2.3.19, also clear the Healer backoff window so the next injury
  // gets full attention again (don't carry a "muted Healer" state across
  // a successful turn).
  healerSuppressedUntil.delete(agentId);

  // Cancel the engine auto-wake timer if it's still pending, agent recovered
  // before we needed to poke them.
  const wakeTimer = autoWakeTimers.get(agentId);
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    autoWakeTimers.delete(agentId);
  }

  // Phase 8 F1 fix: emit an info-severity AGENT_RECOVERED broadcast so the
  // dashboard can auto-dismiss the lingering injury error toast. Most
  // provider 4xx errors are transient (auto-recovered within 5s), without
  // this signal the user sees a red banner from a problem that already
  // resolved.
  try {
    const db = getDb();
    const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const name = agentRow?.name ?? agentId;
    broadcast({
      type: 'chat:error',
      agentId,
      error: `${name} recovered and is back to work.`,
      code: 'AGENT_RECOVERED',
      severity: 'info',
      retryable: false,
    });
  } catch { /* best effort */ }

  const timer = pendingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(agentId);
    logger.info('Agent recovered within grace period, healer not notified', { agentId });
    return; // Recovered before the healer needed to know
  }

  // Agent recovered AFTER the healer was notified, let the healer know
  // so it can close the loop in its records.
  notifyHealerOfRecovery(agentId);
}

async function notifyHealerOfInjury(agentId: string, errorMessage: string): Promise<void> {
  try {
    const db = getDb();

    // Verify the agent is still injured (might have recovered between timer start and fire)
    const agent = db.prepare('SELECT id, name, status, classification, last_error FROM agents WHERE id = ?')
      .get(agentId) as { id: string; name: string; status: string; classification: string; last_error: string | null } | undefined;
    if (!agent || (agent.status !== 'error' && agent.status !== 'paused')) {
      logger.debug('Agent recovered before healer notification fired, skipping', { agentId });
      return;
    }

    // Notify the primary agent in parallel with the Healer. Pre-2026-04-30
    // the primary was alerted at the moment of injury, before auto-wake
    // and grace period had a chance to clear transient errors, so a
    // momentary 429 would fire a misleading "they will not recover on
    // their own" message even though the agent self-resolved seconds
    // later. Doing it here means the primary only hears about agents that
    // genuinely need help.
    try {
      const { getAgentRuntime } = await import('../agent/runtime.js');
      const pausedByLoop = agent.status === 'paused';
      await getAgentRuntime().notifyPrimaryOfInjury(agentId, agent.last_error ?? errorMessage, pausedByLoop);
    } catch (err) {
      logger.warn('Primary-agent injury notification failed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      });
    }

    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'")
      .get() as { value: string } | undefined;
    const healerId = healerRow?.value ?? 'healer';

    // Verify the healer exists and is not terminated. Pre-2026-04-29 this
    // returned silently, leaving an injured agent stuck with no surface
    // signal. Now we alert via iMessage AND broadcast to the dashboard so
    // the user actually finds out.
    const healer = db.prepare("SELECT id, status FROM agents WHERE id = ? AND status != 'terminated'")
      .get(healerId) as { id: string; status: string } | undefined;
    if (!healer) {
      logger.warn('Healer agent not available, cannot auto-recover injured agent', { agentId, healerId });
      // v2.3.19 (error-handling-spec Phase 2): plain language only on
      // user-facing surfaces. Provider error already logged above.
      const userMsg = `${agent.name} is stuck and the Healer agent is missing. Restore the Healer in Settings → Sensei, or send a message to unstick the agent manually.`;
      // v2.3.19, Healer missing is a true blocker (auto-recovery
      // entirely off until restored). Critical.
      try { sendAlert(userMsg, 'critical'); } catch { /* best effort */ }
      broadcastInjuryEvent(agentId, 'error', userMsg, 'HEALER_MISSING');
      return;
    }

    const errorClass = classifyError(agent.last_error ?? errorMessage);
    const errorSnippet = (agent.last_error ?? errorMessage).slice(0, 400);

    // Find tasks stalled on this agent
    interface StalledTask { id: string; title: string; status: string }
    const stalledTasks = db.prepare(`
      SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state IN ('claimed', 'on_deck')
      ORDER BY w.updated_at DESC LIMIT 5
    `).all(agentId) as StalledTask[];

    const parts: string[] = [];
    parts.push(`[INJURY ALERT] ${agent.name} (${agent.classification}, ID: ${agentId}) is injured and has not recovered on its own within the grace period.`);
    parts.push('');
    parts.push(`Status: ${agent.status}`);
    parts.push(`Error type: ${errorClass}`);
    parts.push(`Error: ${errorSnippet}`);

    if (stalledTasks.length > 0) {
      parts.push('');
      parts.push('Tasks stalled on this agent:');
      for (const t of stalledTasks) {
        parts.push(`  - ${t.title} (${t.status}, ID: ${t.id.slice(0, 8)})`);
      }
    }

    parts.push('');
    parts.push('Please investigate and attempt recovery:');
    parts.push(`1. If the error is transient (network, rate limit): send_to_agent(agent="${agentId}", intent="QUESTION", payload="...") to poke them.`);
    parts.push(`2. If the error is context corruption: reset_session(agent_id="${agentId}") to clear their context.`);
    parts.push('3. If the error is a config issue: send an iMessage alert to the user via imessage_send.');

    const content = parts.join('\n');

    // Deliver via A2A transport, ASSIGN intent wakes the healer to act.
    //
    // v2.3.19, fresh thread per injury. Pre-spec, all injuries for the
    // same agent shared a single deterministic thread ID
    // (`injury-${agentId}`), which meant the 8-message hop limit
    // permanently retired the thread after enough flapping. Subsequent
    // injuries got HOP_LIMIT_EXCEEDED and the Healer never saw them.
    // Each injury notification now opens its own thread, correct
    // because each injury IS a separate event the Healer should
    // diagnose freshly. Recovery notices below still get a fresh
    // thread too (they're informational, not part of the conversation).
    // Use QUESTION (not ASSIGN) so the A2A transport does NOT auto-create
    // a tracker task. Injury alerts wake the Healer to act once; the
    // audit trail lives in healer_log_action, not the kanban. Pre-fix
    // (intent='ASSIGN') every injury left an on_deck task on the Healer's
    // tracker view that nothing ever closed, they piled up forever and
    // polluted the user's tracker (until we also hid Healer's tasks from
    // the dashboard). QUESTION wakes the receiver identically (see
    // a2a-transport.ts open-thread branch) but skips the auto-task.
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    const result = await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: `injury-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requiresResponse: true,
      payload: content,
      toAgent: healerId,
      fromAgent: 'system', // System-generated, not from another agent
    });

    if (result.delivered) {
      logger.info('Healer notified of injured agent', {
        healerId,
        injuredAgentId: agentId,
        injuredName: agent.name,
        errorClass,
        stalledTaskCount: stalledTasks.length,
      });
      // Surface to the dashboard so the user can see the healer kicked in.
      // Without this, the healer's actions happen invisibly, the user is
      // left wondering whether anything is happening at all.
      broadcastInjuryEvent(
        agentId,
        'info',
        // User-facing: brief and reassuring. Tech detail (errorClass +
        // errorSnippet) was previously surfaced here but it's clutter for
        // users, it's already in logs and on the agent's detail page.
        `${agent.name} hit an error. Auto-healer is investigating, give it a moment.`,
        'HEALER_DISPATCHED',
      );
    } else {
      // Delivery failed (semantic dedup, hop limit, etc.), surface so the
      // user knows the healer wasn't reached and can act manually.
      logger.warn('Healer notification delivery failed', {
        healerId, injuredAgentId: agentId, reason: result.reason,
      });
      // Phase 8 F1 fix: SEMANTIC_DUPLICATE means the Healer was already informed
      // about this exact issue. That's the dedup working as designed, not a
      // failure. Show as info ("already aware"), not error. Other reasons
      // (hop limit, healer down, etc.) stay as warning since the user may
      // need to intervene.
      const isDedup = result.reason === 'SEMANTIC_DUPLICATE';
      broadcastInjuryEvent(
        agentId,
        isDedup ? 'info' : 'warning',
        isDedup
          ? `${agent.name} hit the same error again, auto-healer was already notified. Skipping a duplicate message.`
          : `${agent.name} is stuck and auto-healer couldn't be reached. Send a message or reset the session from the agent's detail page to unstick it.`,
        'HEALER_DELIVERY_FAILED',
      );
    }
  } catch (err) {
    logger.error('Failed to notify healer of injury', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function notifyHealerOfRecovery(agentId: string): Promise<void> {
  try {
    const db = getDb();

    const agent = db.prepare('SELECT name FROM agents WHERE id = ?')
      .get(agentId) as { name: string } | undefined;
    if (!agent) return;

    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'")
      .get() as { value: string } | undefined;
    const healerId = healerRow?.value ?? 'healer';

    const healer = db.prepare("SELECT id, status FROM agents WHERE id = ? AND status != 'terminated'")
      .get(healerId) as { id: string; status: string } | undefined;
    if (!healer) return;

    const content = `${agent.name} (ID: ${agentId}) has recovered from its injured state and is back online. No further action needed.`;

    // Deliver via A2A transport, FYI intent does NOT wake the healer.
    // The recovery notice sits as read-only context, no tokens spent.
    // v2.3.19, fresh thread (matches the injury-alert change above).
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    await deliverA2AMessage({
      intent: 'FYI',
      threadId: `recovery-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requiresResponse: false,
      payload: content,
      toAgent: healerId,
      fromAgent: 'system',
    });

    logger.info('Healer notified of agent recovery', { agentId, agentName: agent.name });
  } catch (err) {
    logger.debug('Failed to notify healer of recovery (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Called at server startup to pick up agents that were injured before a
 * restart. In-memory timers are lost on restart, so we scan the DB for
 * agents in error/paused status and schedule healer notifications for each.
 */
export function rehydrateInjuredAgents(): void {
  try {
    const db = getDb();
    const injured = db.prepare(`
      SELECT id, last_error, recovery_attempts FROM agents
      WHERE status IN ('error', 'paused')
        AND status != 'terminated'
        AND last_error IS NOT NULL
    `).all() as Array<{ id: string; last_error: string | null; recovery_attempts: number | null }>;

    if (injured.length > 0) {
      logger.info('Rehydrating injured agents after server restart', {
        count: injured.length,
        agentIds: injured.map(a => a.id),
      });
      for (const agent of injured) {
        // v2.3.19, a server restart is a meaningful "fresh start"
        // signal. Pre-spec, recovery_attempts persisted across restarts,
        // so an agent that hit attempt 12 before a restart picked up at
        // attempt 13, instantly into the longest backoff window with
        // no chance to actually heal naturally. Reset to 0 on rehydrate
        // and clear any in-memory backoff suppression. The Healer gets
        // a fresh shot.
        const prevAttempts = agent.recovery_attempts ?? 0;
        if (prevAttempts > 0) {
          setAttempts(agent.id, 0);
          healerSuppressedUntil.delete(agent.id);
          logger.info('Reset stale recovery_attempts on rehydrate', {
            agentId: agent.id, prevAttempts,
          });
        }
        onAgentInjured(agent.id, agent.last_error ?? 'Unknown error (pre-restart)');
      }
    }
  } catch (err) {
    logger.warn('Failed to rehydrate injured agents', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
