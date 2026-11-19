// Event-driven healing of injured agents: when an agent enters 'error', a per-agent timer wakes the Healer
// after a grace period if it is still injured; the Healer is told when the agent recovers.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { sendAlert } from '../services/imessage-bridge.js';
import { classifyProviderErrorText } from '../agent/provider-error.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../agent/stream-patience.js';
import { broadcast } from '../gateway/ws.js';
import { clearAgentLastError } from '../agent/agent-status.js';
import { TRANSIENT_PROVIDER_ERROR_SQL } from './diagnostic.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../work/tracker-view.js';
import { workingExpr } from '../work/done/hold.js';
import * as told from './owner-notices.js'; // once per condition, and the owner's cards
import { brokenWords, noteNoticeOnce, readNotice } from '../agent/agent-owner-cards.js';

const logger = createLogger('injury-recovery');

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

// Broadcasts a chat:error so the dashboard surfaces every Healer outcome, including the silent return paths.
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
      cardClass: severity === 'error' ? 'action' : 'informational',   // the Healer broken or missing is the owner's to act on; the rest is news
      retryable: false,
    });
  } catch { /* best effort */ }
}

const AUTO_WAKE_DELAY_MS = 5 * 1000; // 5s, enough for DB writes to settle

// Grace period before the Healer is notified; transient errors (rate limit, network) wait longer because
// they may need an upstream window to tick over.
const GRACE_PERIOD_MS_TRANSIENT = 30 * 1000;
const GRACE_PERIOD_MS_NON_TRANSIENT = 5 * 1000;

// Recovery attempts per agent before backoff applies (see healerBackoffMs and healerSuppressedUntil).
const MAX_RECOVERY_ATTEMPTS = 3;

// Per-agent Healer backoff once attempts hit MAX: each further attempt moves one rung up the quiet-window
// ladder (10 min, 1 hr, 6 hr, 24 hr cap). Cleared by onAgentRecovered.
const HEALER_BACKOFF_LADDER_MS: number[] = [
  10 * 60 * 1000,        // 10 min after MAX
  60 * 60 * 1000,        // 1 hr after MAX+1
  6 * 60 * 60 * 1000,    // 6 hr after MAX+2
  24 * 60 * 60 * 1000,   // 24 hr cap
];
function healerBackoffMs(attempts: number): number {
  // attempts=MAX is index 0; any value past the ladder length uses the last entry.
  const idx = Math.min(attempts - MAX_RECOVERY_ATTEMPTS, HEALER_BACKOFF_LADDER_MS.length - 1);
  return HEALER_BACKOFF_LADDER_MS[Math.max(0, idx)];
}

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

// Durable count of distinct turns on which compact-and-redial already failed, kept in healer_state (one row per
// failed turn, keyed agentId:uuid so same-tick calls never collide). It backs criterion (a) of
// evaluateSessionResetGuard; onAgentRecovered clears the agent's rows on a recovery by evidence.
const DECLARED_PATIENCE_HONEST_FAIL_SCOPE = 'declared_patience_honest_fail';

function recordDeclaredPatienceHonestFail(agentId: string): void {
  writeHealerState(DECLARED_PATIENCE_HONEST_FAIL_SCOPE, `${agentId}:${uuidv4()}`, Date.now());
}

// agents.id is a UUID today, but escape LIKE wildcards so a future id can never match another agent's rows.
function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function countDeclaredPatienceHonestFails(agentId: string): number {
  try {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS cnt FROM healer_state WHERE scope = ? AND key LIKE ? ESCAPE '\\'")
      .get(DECLARED_PATIENCE_HONEST_FAIL_SCOPE, `${escapeLikePrefix(agentId)}:%`) as { cnt: number };
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function clearDeclaredPatienceHonestFails(agentId: string): void {
  try {
    getDb()
      .prepare("DELETE FROM healer_state WHERE scope = ? AND key LIKE ? ESCAPE '\\'")
      .run(DECLARED_PATIENCE_HONEST_FAIL_SCOPE, `${escapeLikePrefix(agentId)}:%`);
  } catch { /* best-effort, matches every other clear in this section */ }
}

const healerSuppressedUntil = {
  get: (agentId: string): number | null => readHealerState('agent_suppression', agentId),
  set: (agentId: string, untilMs: number): void => writeHealerState('agent_suppression', agentId, untilMs),
  delete: (agentId: string): void => deleteHealerState('agent_suppression', agentId),
};

// Provider-wide dedup: once a provider pattern has been alerted (30 min window), later injuries on that provider
// skip Healer dispatch, because the first cycle's diagnostic report already sees them all.
const providerPatternAlerted = {
  get: (provider: string): number | null => readHealerState('provider_alert', provider),
  set: (provider: string, atMs: number): void => writeHealerState('provider_alert', provider, atMs),
  delete: (provider: string): void => deleteHealerState('provider_alert', provider),
};
const PROVIDER_PATTERN_WINDOW_MS = 30 * 60 * 1000;       // 30 min dedup
const PROVIDER_PATTERN_LOOKBACK_MS = 60 * 60 * 1000;     // count peers errored in last 1h
const PROVIDER_PATTERN_PEER_THRESHOLD = 2;               // 2 other agents = pattern (3 total)

/**
 * Returns the provider name when a recent pattern alert covers this agent's provider (the caller skips
 * per-agent Healer dispatch), else null.
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
 * Records a provider-wide pattern when enough peers are injured on the same provider; returns the
 * provider name if newly recorded, else null.
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

    // Peers must be currently injured and pass the outage detector's transient-error filter (the shared
    // TRANSIENT_PROVIDER_ERROR_SQL), so recovered agents with a stale last_error do not inflate the count.
    const lookbackSec = Math.floor(PROVIDER_PATTERN_LOOKBACK_MS / 1000);
    const peers = db.prepare(`
      SELECT COUNT(*) AS cnt FROM agents a
      JOIN models m ON m.id = a.model_id
      JOIN providers p ON p.id = m.provider_id
      WHERE p.name = ?
        AND a.id != ?
        AND a.status IN ('error', 'paused') AND instr(COALESCE(a.last_error, ''), '[budget_stop]') != 1 AND instr(COALESCE(a.last_error, ''), '[no_model_fits]') != 1
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

// Pending Healer-notification timers by agent ID; cancelled if the agent recovers within the grace period.
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const autoWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Classifies a persisted error string for the Healer's diagnostic. It holds only the string (the originating status
// is gone), so it reuses classifyProviderErrorText; the corruption and config buckets are dojo-specific.
function classifyError(error: string | null, code?: string): string {
  // Checked first: a declared-patience exhaustion arrives as a code on the live path, or after a restart as the literal
  // phrases agent/model.ts throws (first-chunk timeout, pre-dial refusal). The phrases are copied, not imported, since
  // model.ts is too heavy for this leaf module; checked before the prose table, where "timeout" would read as network.
  if (code === DECLARED_PATIENCE_EXCEEDED_CODE
    || (error ?? '').toLowerCase().includes('model first-chunk timeout')
    || (error ?? '').toLowerCase().includes('refused before any network dial')) {
    return 'declared_patience_exceeded';
  }

  if (!error) return 'unknown';
  const lower = error.toLowerCase();

  // Corruption and config first: our OWN vocabulary, no status, and 'invalid_request' would
  // otherwise be swallowed by the generic 4xx bucket below.
  if (lower.includes('tool_use_id') || lower.includes('tool_result') ||
      lower.includes('invalid_request') || lower.includes('malformed') ||
      lower.includes('messages.0') || lower.includes('content block')) return 'context_corruption';
  if (lower.includes('no model') || lower.includes('agent not found')) return 'config';

  switch (classifyProviderErrorText(error).class) {
    case 'rate_limit':
    case 'quota':
    case 'overloaded': return 'rate_limit';
    case 'network':
    case 'server': return 'network';
    case 'auth':
    case 'access_denied': return 'auth';
    // Generic 4xx is bucketed as provider_error rather than falling through to 'unknown'.
    case 'bad_request': return 'provider_error';
    default: break;
  }
  if (lower.includes('api key')) return 'auth';

  return 'unknown';
}

/**
 * Called when an agent enters 'error' or 'paused'. Starts the grace-period timer; if the agent is still injured
 * when it fires, the Healer is notified. `code` is the AgentError.code when the caller has one; rehydrateInjuredAgents
 * has only the persisted string, which classifyError still recognises.
 */
export function onAgentInjured(agentId: string, errorMessage: string, code?: string): void {
  // The Healer cannot heal itself (infinite loop): alert the owner directly by iMessage and on the dashboard.
  try {
    const db = getDb();
    const healerRow = db.prepare("SELECT value FROM config WHERE key = 'healer_agent_id'").get() as { value: string } | undefined;
    if (healerRow && agentId === healerRow.value) {
      logger.warn('Healer agent is injured, alerting user directly (cannot self-heal)', { agentId });
      // iMessage and dashboard share one plain-English wording; the raw provider error stays in logs.
      const userMsg = told.HEALER_BROKEN_WORDS;
      if (told.tellOwner('healer-broken', userMsg)) void sendAlert(userMsg, 'critical', { kind: 'broken-agent', agentId }); // until it recovers
      broadcastInjuryEvent(agentId, 'error', userMsg, 'HEALER_SELF_INJURED');
      return;
    }
  } catch { /* config not available */ }
  const broken = brokenWords(agentId, errorMessage); // only the owner can fix it: told at once, once per incident
  if (broken && noteNoticeOnce(agentId, 'broken_notice', broken)) void sendAlert(broken, 'notice', { kind: 'broken-agent', agentId });

  // Once attempts hit MAX the Healer backs off and may fire again after the window elapses. The owner is told once,
  // on first entry into backoff; injuries inside the window stay silent.
  const attempts = getAttempts(agentId);
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    const now = Date.now();
    const suppressedUntil = healerSuppressedUntil.get(agentId) ?? 0;

    if (suppressedUntil > now) {
      // In the backoff window: stay silent; the Healer gets a fresh shot when it elapses.
      logger.info('Healer in backoff for agent, skipping this injury', {
        agentId,
        attempts,
        suppressedUntilIso: new Date(suppressedUntil).toISOString(),
        remainingMs: suppressedUntil - now,
      });
      return;
    }

    // Backoff has elapsed (or this is the first entry): schedule the next window now so a re-injury during this
    // Healer cycle does not fire again immediately.
    const nextBackoffMs = healerBackoffMs(attempts);
    healerSuppressedUntil.set(agentId, now + nextBackoffMs);

    // Alert the owner only on first entry into backoff (attempts === MAX), not on every retry.
    if (attempts === MAX_RECOVERY_ATTEMPTS) {
      logger.warn('Max recovery attempts hit, entering Healer backoff', {
        agentId, attempts, max: MAX_RECOVERY_ATTEMPTS, nextRetryInMs: nextBackoffMs,
      });
      try {
        const db = getDb();
        const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        const userMsg = told.stuckWords(agent?.name ?? agentId);
        if (!readNotice(agentId, 'broken_notice') && told.tellOwner(`stuck:${agentId}`, userMsg)) void sendAlert(userMsg, 'notice', { kind: 'broken-agent', agentId }); // once per incident, not on top of BROKEN
        broadcastInjuryEvent(agentId, 'warning', userMsg, 'HEALER_SUPPRESSED_MAX_ATTEMPTS');
      } catch { /* best effort */ }
    } else {
      logger.info('Healer retry after backoff window, re-engaging', {
        agentId, attempts, nextRetryInMs: nextBackoffMs,
      });
    }
    // Fall through: the Healer attempts again; attempts++ happens in the normal flow below.
  }

  const existingHealer = pendingTimers.get(agentId);
  if (existingHealer) clearTimeout(existingHealer);
  const existingWake = autoWakeTimers.get(agentId);
  if (existingWake) clearTimeout(existingWake);

  // Transient errors (rate_limit, network) get the longer grace because they often resolve on their own; others
  // should engage the Healer almost immediately.
  const errorClass = classifyError(errorMessage, code);
  const isTransient = errorClass === 'rate_limit' || errorClass === 'network';
  const gracePeriodMs = isTransient ? GRACE_PERIOD_MS_TRANSIENT : GRACE_PERIOD_MS_NON_TRANSIENT;

  // Counted only when the live path passes `code`: rehydrateInjuredAgents and tryPlatformErrorRecovery pass none, so a
  // restart replaying a persisted declared-patience string never adds a row. One row per genuinely new failed chain.
  if (code === DECLARED_PATIENCE_EXCEEDED_CODE) {
    recordDeclaredPatienceHonestFail(agentId);
  }

  // Known-permanent errors (auth, config) and declared-patience exhaustion skip the engine auto-wake: a retry only
  // repeats paid calls with broken credentials, or re-sends the same un-finishable prompt to the same slow provider.
  const isKnownPermanent =
    errorClass === 'auth' ||
    errorClass === 'config' ||
    errorClass === 'declared_patience_exceeded' ||
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

  if (isKnownPermanent) {
    logger.info('Skipping auto-wake, error is known-permanent (will not self-clear)', {
      agentId, errorClass,
    });
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

  // After the auto-wake, notify the Healer once the grace period ends if the agent is still injured. Skip
  // dispatch when a provider-wide pattern is already being handled, since that report sees all the injuries.
  const alreadyHandledProvider = isProviderPatternHandled(agentId);
  if (alreadyHandledProvider) {
    logger.info('Skipping per-agent Healer dispatch, provider-wide pattern already in flight', {
      agentId,
      provider: alreadyHandledProvider,
    });
    // Still bump attempts so the per-agent backoff ladder progresses on repeat injuries.
    setAttempts(agentId, attempts + 1);
    return;
  }

  // Record an emerging pattern (enough peers on the same provider errored in the last hour) BEFORE scheduling,
  // so injuries during the dispatch window are deduped.
  maybeRecordProviderPattern(agentId);

  const timer = setTimeout(() => {
    pendingTimers.delete(agentId);
    setAttempts(agentId, attempts + 1);
    notifyHealerOfInjury(agentId, errorMessage);
  }, gracePeriodMs);

  pendingTimers.set(agentId, timer);
}

/**
 * Recovery basis: 'evidence' (a turn completed) clears everything on recovery; 'cooldown' (a clock) clears only
 * the Healer backoff window and timers, so the attempt ladder, last_error and honest-fail marker survive a clock.
 */
export type RecoveryBasis = 'evidence' | 'cooldown';

export function onAgentRecovered(agentId: string, basis: RecoveryBasis = 'evidence'): void {
  // Evidence only: the attempt ladder must keep escalating to the owner, so a clock may not reset it.
  if (basis === 'evidence') setAttempts(agentId, 0);

  // Evidence only: clear last_error, the human's only account of what went wrong. Not called on mid-turn retries,
  // so the diagnostic survives them.
  if (basis === 'evidence') {
    try { clearAgentLastError(agentId); } catch { /* best effort */ }
  }

  healerSuppressedUntil.delete(agentId);
  if (basis === 'evidence') told.ownerConditionsOnRecovery(agentId); // a clock is not evidence

  // Evidence only: this marker alone stops a second declared-patience cold-redial chain; a clock must not clear it.
  if (basis === 'evidence') clearDeclaredPatienceHonestFails(agentId);

  const wakeTimer = autoWakeTimers.get(agentId);
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    autoWakeTimers.delete(agentId);
  }

  try {
    const db = getDb();
    const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
    const name = agentRow?.name ?? agentId;
    broadcast({
      type: 'chat:error', cardClass: 'informational',
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

  // Recovered after the Healer was notified: tell it so it can close the loop. Not awaited (a recovery FYI must not
  // block the agent's turn) but tracked, so drainRecoveryNotices() can settle it.
  trackRecoveryNotice(notifyHealerOfRecovery(agentId));
}

const pendingRecoveryNotices = new Set<Promise<void>>();

function trackRecoveryNotice(p: Promise<void>): void {
  // catch at the source: a best-effort FYI must never become an unhandled rejection or reach a drain awaiter.
  const tracked = p.catch(() => undefined).finally(() => { pendingRecoveryNotices.delete(tracked); });
  pendingRecoveryNotices.add(tracked);
}

export async function drainRecoveryNotices(): Promise<void> {
  while (pendingRecoveryNotices.size > 0) {
    await Promise.all([...pendingRecoveryNotices]);
  }
}

async function notifyHealerOfInjury(agentId: string, errorMessage: string): Promise<void> {
  try {
    const db = getDb();

    const agent = db.prepare('SELECT id, name, status, classification, last_error FROM agents WHERE id = ?')
      .get(agentId) as { id: string; name: string; status: string; classification: string; last_error: string | null } | undefined;
    if (!agent || (agent.status !== 'error' && agent.status !== 'paused')) {
      logger.debug('Agent recovered before healer notification fired, skipping', { agentId });
      return;
    }

    // Tell the primary agent here, after the grace period, so it hears only about agents that genuinely need help.
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

    // Verify the Healer exists and is not terminated; otherwise alert the owner by iMessage and on the dashboard.
    const healer = db.prepare("SELECT id, status FROM agents WHERE id = ? AND status != 'terminated'")
      .get(healerId) as { id: string; status: string } | undefined;
    if (!healer) {
      logger.warn('Healer agent not available, cannot auto-recover injured agent', { agentId, healerId });
      // Plain language only on user-facing surfaces; the provider error is already logged above.
      const userMsg = told.healerMissingWords(agent.name);
      // A missing Healer is a true blocker (auto-recovery is off), so critical; told once until an injury finds it present.
      if (told.tellOwner(`healer-missing:${agentId}`, userMsg, 'healer-missing:')) void sendAlert(userMsg, 'critical', { kind: 'broken-agent', agentId });
      broadcastInjuryEvent(agentId, 'error', userMsg, 'HEALER_MISSING');
      return;
    }
    told.ownerConditionsOnHealerSeen(healer.status);

    const errorClass = classifyError(agent.last_error ?? errorMessage);
    const errorSnippet = (agent.last_error ?? errorMessage).slice(0, 400);

    interface StalledTask { id: string; title: string; status: string }
    const stalledTasks = db.prepare(`
      SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w', true)}
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
    if (errorClass === 'declared_patience_exceeded') {
      // Declared-patience exhaustion is compaction-first: this note says what the engine already tried and does not offer
      // reset_session as a first move (evaluateSessionResetGuard refuses it outside its criteria regardless of this text).
      parts.push(
        'This is a declared-patience exhaustion (the model could not be served fast enough for ' +
        'this request) — the engine already ran ONE forced compaction + redial automatically ' +
        'inside the failed turn (or could not, e.g. the agent is on the \'auto\' model sentinel), ' +
        'and it did not resolve.',
      );
      parts.push('Try, in this order:');
      parts.push(
        `1. Compaction-first: send_to_agent(agent="${agentId}", intent="QUESTION", payload="...") ` +
        'to wake the agent again. Its next turn runs the SAME forced-compaction-then-redial ' +
        'automatically if it hits the same exhaustion — reach for this BEFORE session reset.',
      );
      parts.push(
        `2. reset_session(agent_id="${agentId}") is available once compact-and-redial has ` +
        'already failed on 2 distinct turns for this agent. It will refuse otherwise, unless ' +
        'you pass reason="corruption" (you have diagnosed corrupted context) or ' +
        'owner_requested=true (the owner explicitly asked) — both are audit-logged.',
      );
    } else {
      parts.push('Please investigate and attempt recovery:');
      parts.push(`1. If the error is transient (network, rate limit): send_to_agent(agent="${agentId}", intent="QUESTION", payload="...") to poke them.`);
      parts.push(`2. If the error is context corruption: reset_session(agent_id="${agentId}") to clear their context.`);
      parts.push('3. If the error is a config issue: send an iMessage alert to the user via imessage_send.');
    }

    const content = parts.join('\n');

    // QUESTION wakes the Healer without auto-creating a tracker task; the audit trail lives in healer_actions.
    // A fresh thread per injury, so one thread's hop limit can never retire later alerts.
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
      broadcastInjuryEvent(
        agentId,
        'info',
        `${agent.name} hit an error. Auto-healer is investigating, give it a moment.`,
        'HEALER_DISPATCHED',
      );
    } else {
      logger.warn('Healer notification delivery failed', {
        healerId, injuredAgentId: agentId, reason: result.reason,
      });
      // SEMANTIC_DUPLICATE means the Healer already knows (dedup working): info. Other reasons stay a warning.
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

    // FYI on a fresh thread: the recovery notice must not wake the Healer; it sits as read-only context.
    const { deliverA2ANotice } = await import('../agent/a2a-notice.js');
    await deliverA2ANotice({
      intent: 'FYI',
      threadId: `recovery-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requiresResponse: false,
      payload: content,
      toAgent: healerId,
      fromAgent: 'system',
    }, 'Agent-recovery notice to the Healer', { agentId, agentName: agent.name });

    logger.info('Healer notified of agent recovery', { agentId, agentName: agent.name });
  } catch (err) {
    logger.debug('Failed to notify healer of recovery (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// SESSION-RESET GUARD: for declared-patience exhaustions, reset_session (agent/tools/cat/session.ts) proceeds
// only when compact-and-redial failed on >=2 distinct turns, corruption is diagnosed, or the owner asked.
// Other injuries are unaffected. The class is read from agents.last_error, cleared only by a recovery by evidence.

export interface SessionResetGuardArgs {
  /**
   * Pass 'corruption' (or any string containing it) when the target's context is diagnosed corrupted;
   * bypasses the count and is audit-logged.
   */
  reason?: string | null;
  /**
   * True only when relaying an explicit owner instruction to reset now; bypasses the count and is audit-logged.
   * Never inferred, only set.
   */
  ownerRequested?: boolean;
}

export interface SessionResetGuardResult {
  allowed: boolean;
  /** Present only when allowed=false: the text reset_session returns, naming what to do instead. */
  refusalText?: string;
}

/**
 * Whether reset_session may proceed against targetAgentId; called before any side effect. Non-size injuries (or none)
 * return { allowed: true } immediately.
 */
export function evaluateSessionResetGuard(
  targetAgentId: string,
  args: SessionResetGuardArgs,
): SessionResetGuardResult {
  try {
    const db = getDb();
    const row = db.prepare('SELECT name, last_error FROM agents WHERE id = ?')
      .get(targetAgentId) as { name: string; last_error: string | null } | undefined;
    const lastError = row?.last_error ?? null;
    const errorClass = classifyError(lastError);
    if (errorClass !== 'declared_patience_exceeded') {
      return { allowed: true }; // non-size injury, or no recent injury: unchanged (control)
    }
    const label = row?.name ?? targetAgentId;

    // (b) corruption diagnosed: bypasses the count, audit-logged.
    if (args.reason && /corrupt/i.test(args.reason)) {
      auditSessionResetBypass(targetAgentId, 'corruption', args.reason);
      return { allowed: true };
    }
    // (c) owner explicitly asked: bypasses the count, audit-logged.
    if (args.ownerRequested === true) {
      auditSessionResetBypass(targetAgentId, 'owner_requested', null);
      return { allowed: true };
    }
    // (a) compact-and-redial already failed on >=2 distinct turns for this agent.
    const failCount = countDeclaredPatienceHonestFails(targetAgentId);
    if (failCount >= 2) {
      return { allowed: true };
    }

    return {
      allowed: false,
      refusalText:
        `Session reset refused: ${label}'s most recent injury is a declared-patience exhaustion ` +
        `(the model could not be served fast enough for this request), not corrupted context. ` +
        `Compaction comes first for this injury class — the engine already runs one forced ` +
        `compaction + redial automatically inside a failed turn. Wake ${label} again with ` +
        `send_to_agent(agent="${targetAgentId}", intent="QUESTION", payload="...") and let that ` +
        `run before reaching for a reset. reset_session becomes available here once compact-and-` +
        `redial has failed on 2 distinct turns for this agent (currently ${failCount}); if you've ` +
        `diagnosed context corruption, call reset_session again with reason="corruption"; if the ` +
        `owner explicitly asked for a reset, call it with owner_requested=true. Both of those are ` +
        `audit-logged.`,
    };
  } catch (err) {
    // Fail open like every other best-effort guard here: the guard's own failure must not block the Healer's reset tool.
    logger.warn('Session-reset guard failed open (treating as allowed)', {
      targetAgentId, error: err instanceof Error ? err.message : String(err),
    });
    // A fail-open is a reset permitted outside the guard's policy, so it is audited in healer_actions like (b) and (c).
    auditSessionResetGuardFailOpen(targetAgentId, err);
    return { allowed: true };
  }
}

/**
 * Audits the guard failing open on its own error (not a policy bypass); same table as auditSessionResetBypass,
 * with a distinct action_taken.
 */
function auditSessionResetGuardFailOpen(targetAgentId: string, err: unknown): void {
  try {
    getDb().prepare(`
      INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
      VALUES (?, NULL, 'session_reset_guard', ?, ?, 'reset_permitted_fail_open', 'error', datetime('now'))
    `).run(
      uuidv4(),
      `The check before a session reset failed open on its own error, so the reset went ahead: ${err instanceof Error ? err.message : String(err)}`,
      targetAgentId,
    );
  } catch (auditErr) {
    logger.warn('Failed to audit-log a session-reset guard fail-open', {
      targetAgentId, error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }
}

/**
 * Audits the (b)/(c) bypasses into healer_actions; diagnostic_id is NULL (not tied to a diagnostic cycle).
 */
function auditSessionResetBypass(
  targetAgentId: string,
  kind: 'corruption' | 'owner_requested',
  detail: string | null,
): void {
  try {
    getDb().prepare(`
      INSERT INTO healer_actions (id, diagnostic_id, category, description, agent_id, action_taken, result, created_at)
      VALUES (?, NULL, 'session_reset_guard', ?, ?, 'reset_permitted_bypass', ?, datetime('now'))
    `).run(
      uuidv4(),
      `A session reset went ahead before compaction because ${kind === 'corruption' ? 'the conversation was damaged' : 'the owner asked for it'}${detail ? `: ${detail}` : ''}`,
      targetAgentId,
      kind,
    );
  } catch (err) {
    logger.warn('Failed to audit-log a session-reset guard bypass', {
      targetAgentId, kind, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Called at server startup to pick up agents injured before a restart: timers are lost on restart, so scan the DB
 * for error/paused agents and schedule Healer notifications for each.
 */
export function rehydrateInjuredAgents(): void {
  try {
    const db = getDb();
    // No last_error filter: error/paused is itself the durable record that a dispatch is owed, and a crash can leave
    // a NULL last_error.
    const injured = db.prepare(`
      SELECT id, last_error, recovery_attempts FROM agents
      WHERE status IN ('error', 'paused') AND instr(COALESCE(last_error, ''), '[budget_stop]') != 1 AND instr(COALESCE(last_error, ''), '[no_model_fits]') != 1  -- t148: a parked agent is not an injury
    `).all() as Array<{ id: string; last_error: string | null; recovery_attempts: number | null }>;

    if (injured.length > 0) {
      logger.info('Rehydrating injured agents after server restart', {
        count: injured.length,
        agentIds: injured.map(a => a.id),
      });
      for (const agent of injured) {
        // A restart is a fresh start: reset attempts and backoff so a stale ladder position does not send the agent
        // straight into the longest window.
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
