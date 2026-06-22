// ════════════════════════════════════════
// One-time Google re-auth notice (broker migration)
//
// When an install first boots on the broker-based Google OAuth, any Google
// account that was connected under the previous OAuth client needs a ONE-TIME
// reconnect — its refresh token is bound to the old client and no longer works.
// This surfaces that clearly, exactly once, three ways:
//   1. a persistent dashboard toast (chat:error severity 'error' stays until the
//      user dismisses it),
//   2. a user-visible divider notice in the dojo chat, and
//   3. an agent-only [Engine hint: ...] so the agent can guide the user if asked.
//
// Google-only: the Microsoft client is unchanged, so MS accounts are unaffected.
// We deliberately do NOT add a separate migration iMessage — the existing
// per-account "connection expired" iMessage alerts fire naturally on the first
// failed refresh and reinforce this without piling on a duplicate.
//
// Guarded by a config flag so it runs once. The flag is set on the first boot of
// this version regardless of whether a notice was shown, so accounts connected
// LATER (already on the new client, perfectly healthy) never re-trigger it.
// ════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { listGoogleAccounts } from './accounts.js';
import { createLogger } from '../logger.js';

const logger = createLogger('google-reauth-notice');
const FLAG_KEY = 'google_broker_reauth_notified';
// The toast is a transient broadcast, so firing it at boot (before any dashboard
// is open — the common case right after an update restarts the server) would lose
// it. Instead we set this flag at boot and flush the toast on the next dashboard
// WS connect, then clear it. The divider + agent hint persist in the DB, so they
// survive regardless of connection timing.
const TOAST_PENDING_KEY = 'google_broker_reauth_toast_pending';

const TOAST_MESSAGE =
  'Action needed: reconnect your Google account(s) in Settings ▸ Channels ▸ Google. ' +
  'Do this on the computer running DOJO itself (not a phone or a remote browser), or ' +
  'the Google sign-in will fail. A security update changed how Google connects; nothing else is affected.';

export function notifyGoogleReauthOnce(): void {
  try {
    const db = getDb();
    const flag = db.prepare('SELECT value FROM config WHERE key = ?').get(FLAG_KEY) as
      | { value: string }
      | undefined;
    if (flag?.value) return; // this migration moment was already handled

    // Only previously-connected accounts (those carrying a refresh token) need a
    // reconnect; a fresh install with none needs no notice.
    const needsReconnect = listGoogleAccounts().some(a => !!a.refreshToken);

    if (needsReconnect) {
      const primaryId = getPrimaryAgentId();
      // Primary agent not ready yet — bail WITHOUT setting the flag so we retry
      // on the next boot.
      if (!primaryId) return;

      const now = new Date().toISOString();

      // 1. User-visible divider in the dojo chat (── label ── renders as a
      //    centered system notice in regular mode).
      const dividerId = uuidv4();
      const divider = '── Google reconnect needed (do it on the DOJO computer): Settings ▸ Channels ▸ Google ──';
      db.prepare(
        `INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`,
      ).run(dividerId, primaryId, divider);
      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: dividerId,
          agentId: primaryId,
          role: 'system' as const,
          content: divider,
          tokenCount: null,
          modelId: null,
          cost: null,
          latencyMs: null,
          createdAt: now,
        },
      });

      // 2. Agent-only guidance so the agent can help if the user asks.
      const hintId = uuidv4();
      const hint =
        '[Engine hint: A security update changed how DOJO connects to Google ' +
        '(the OAuth client now sits behind a broker). The user\'s previously-connected ' +
        'Google accounts need a ONE-TIME reconnect because their old credentials no longer ' +
        'apply. If the user asks why Google disconnected or how to fix it, explain it is a ' +
        'one-time security update and walk them to Settings > Channels > Google, where each ' +
        'account shows a Reconnect button. IMPORTANT: the reconnect must be done in a browser ' +
        'ON the computer running DOJO (open the dashboard via localhost there), NOT from a phone ' +
        'or a remote/tunneled browser, or Google will reject the sign-in. Nothing else is ' +
        'affected: Microsoft, iMessage, SMS, and phone are unchanged.]';
      db.prepare(
        `INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))`,
      ).run(hintId, primaryId, hint);

      // 3. Queue the persistent toast for the next dashboard connect (so it
      //    isn't lost when no dashboard is open at boot). Flushed by
      //    flushPendingGoogleReauthToast() from the WS connect handler.
      db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, '1', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`,
      ).run(TOAST_PENDING_KEY);

      logger.info('Queued one-time Google re-auth notice (chat divider + agent hint persisted, toast pending)');
    }

    // Set the flag on the first boot of this version whether or not a notice was
    // shown, so future (new-client) connects never re-trigger this.
    const stamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
    ).run(FLAG_KEY, stamp, stamp);
  } catch (err) {
    logger.error('Google re-auth notice failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Flush the queued re-auth toast when a dashboard connects. Called from the WS
 * connect handler. Fires once (clears the pending flag), so the first dashboard
 * to open after the migration shows the persistent toast; later opens rely on
 * the persisted chat divider.
 */
export function flushPendingGoogleReauthToast(): void {
  try {
    const db = getDb();
    const pending = db.prepare('SELECT value FROM config WHERE key = ?').get(TOAST_PENDING_KEY) as
      | { value: string }
      | undefined;
    if (!pending?.value) return;

    const primaryId = getPrimaryAgentId();
    if (!primaryId) return;

    // Persistent toast — severity 'error' stays until the user dismisses it.
    broadcast({
      type: 'chat:error',
      agentId: primaryId,
      error: TOAST_MESSAGE,
      code: 'AUTH_INVALID',
      severity: 'error',
    });

    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, '', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = '', updated_at = datetime('now')`,
    ).run(TOAST_PENDING_KEY);

    logger.info('Flushed pending Google re-auth toast on dashboard connect');
  } catch (err) {
    logger.error('Google re-auth toast flush failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
