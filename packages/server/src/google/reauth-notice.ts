// One-time notice that Google accounts connected under the previous OAuth client must reconnect (their
// refresh tokens no longer work). Shown exactly once: a persistent toast, a chat divider, and an
// [Engine hint] row meant for the agent (it sits on the owner lane, so the owner sees it too).
// Google-only (Microsoft is unaffected). No extra message: each account's expired-sign-in card follows.
// A config flag makes it run once; it is set on first boot whether or not a notice was shown, so
// accounts connected later never re-trigger it.
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { insertMessage } from '../memory/message-store.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { listGoogleAccounts } from './accounts.js';
import { createLogger } from '../logger.js';
import { formatDivider, settingsPath } from '@dojo/shared';

const logger = createLogger('google-reauth-notice');
const FLAG_KEY = 'google_broker_reauth_notified';
// The toast is a transient broadcast, so at boot (no dashboard open yet) it is queued with this flag and
// flushed on the next dashboard WS connect. The divider and hint persist in the DB regardless.
const TOAST_PENDING_KEY = 'google_broker_reauth_toast_pending';

const TOAST_MESSAGE =
  `Action needed: reconnect your Google account(s) in ${settingsPath('agentGoogle')} and ${settingsPath('userGoogle')}. ` +
  'Do this on the computer running DOJO itself (not a phone or a remote browser), or ' +
  'the Google sign-in will fail. A security update changed how Google connects; nothing else is affected.';

export function notifyGoogleReauthOnce(): void {
  try {
    const db = getDb();
    const flag = db.prepare('SELECT value FROM config WHERE key = ?').get(FLAG_KEY) as
      | { value: string }
      | undefined;
    if (flag?.value) return; // this migration moment was already handled

    // Only previously-connected accounts (carrying a refresh token) need a reconnect.
    const needsReconnect = listGoogleAccounts().some(a => !!a.refreshToken);

    if (needsReconnect) {
      const primaryId = getPrimaryAgentId();
      // Primary agent not ready: return WITHOUT setting the flag so the next boot retries.
      if (!primaryId) return;

      const now = new Date().toISOString();

      // 1. User-visible divider in the dojo chat.
      const dividerId = uuidv4();
      const divider = formatDivider(`Google reconnect needed (do it on the DOJO computer): ${settingsPath('channels')}`);
      insertMessage({ id: dividerId, agentId: primaryId, role: 'system', content: divider });
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

      // 2. Hint so the agent can help if the user asks.
      const hintId = uuidv4();
      const hint =
        '[Engine hint: A security update changed how DOJO connects to Google ' +
        '(the OAuth client now sits behind a broker). The user\'s previously-connected ' +
        'Google accounts need a ONE-TIME reconnect because their old credentials no longer ' +
        'apply. If the person you are talking to asks why Google disconnected or how to fix it, explain it is a ' +
        'one-time security update and walk them to Settings → Channels (the Google cards), where each ' +
        'account shows a Reconnect button. IMPORTANT: the reconnect must be done in a browser ' +
        'ON the computer running DOJO (open the dashboard via localhost there), NOT from a phone ' +
        'or a remote/tunneled browser, or Google will reject the sign-in. Nothing else is ' +
        'affected: Microsoft, iMessage, SMS, and phone are unchanged.]';
      insertMessage({ id: hintId, agentId: primaryId, role: 'user', content: hint });
      // Broadcast so the hint appears live with the divider (history serves this owner-lane row on reload).
      // Moving it to lane 'events' with a NULL conv_key would make it a pending engine event (a spurious turn).
      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: hintId,
          agentId: primaryId,
          role: 'user' as const,
          content: hint,
          tokenCount: null,
          modelId: null,
          cost: null,
          latencyMs: null,
          createdAt: now,
        },
      });

      // 3. Queue the toast for the next dashboard connect (see flushPendingGoogleReauthToast).
      setConfigValue(TOAST_PENDING_KEY, '1');

      logger.info('Queued one-time Google re-auth notice (chat divider + agent hint persisted, toast pending)');
    }

    // Set the flag whether or not a notice was shown, so later connects never re-trigger this.
    const stamp = new Date().toISOString();
    setConfigValue(FLAG_KEY, stamp);
  } catch (err) {
    logger.error('Google re-auth notice failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Flush the queued re-auth toast on dashboard connect (called from the WS connect handler); fires once. */
export function flushPendingGoogleReauthToast(): void {
  try {
    const db = getDb();
    const pending = db.prepare('SELECT value FROM config WHERE key = ?').get(TOAST_PENDING_KEY) as
      | { value: string }
      | undefined;
    if (!pending?.value) return;

    const primaryId = getPrimaryAgentId();
    if (!primaryId) return;

    // Persistent toast: severity 'error' stays until the user dismisses it.
    broadcast({
      type: 'chat:error',
      agentId: primaryId,
      error: TOAST_MESSAGE,
      code: 'AUTH_INVALID',
      severity: 'error',
      cardClass: 'action',
    });

    setConfigValue(TOAST_PENDING_KEY, '');

    logger.info('Flushed pending Google re-auth toast on dashboard connect');
  } catch (err) {
    logger.error('Google re-auth toast flush failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
