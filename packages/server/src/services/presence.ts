// ════════════════════════════════════════
// User Presence, In the Dojo / Away
// Exposes the in_dojo / away toggle. Chat→iMessage auto-forwarding was
// removed in v2.7.22; iMessage delivery is now a deliberate act via the
// `imessage_send` tool. The prompt assembler injects an away-presence
// override block when getPresence() === 'away' so the agent knows the
// dashboard is invisible and must use imessage_send to reach the user.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getIMBridgeStatus, getDefaultSender } from './imessage-bridge.js';

const logger = createLogger('presence');

export type PresenceStatus = 'in_dojo' | 'away';

// D21: a manual "away" that the owner forgets to clear used to divert every
// dashboard/proactive reply to iMessage FOREVER. Auto-expire it after this TTL
// so presence self-heals; the owner can always re-toggle away.
const AWAY_TTL_MS = 12 * 60 * 60 * 1000;

export function getPresence(): PresenceStatus {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value, updated_at FROM config WHERE key = 'user_presence'").get() as { value: string; updated_at: string } | undefined;
    if (row?.value !== 'away') return 'in_dojo';
    // Auto-expire a stale 'away' (updated_at is UTC 'YYYY-MM-DD HH:MM:SS').
    const setAt = Date.parse(row.updated_at.replace(' ', 'T') + 'Z');
    if (Number.isFinite(setAt) && Date.now() - setAt > AWAY_TTL_MS) {
      try {
        db.prepare("UPDATE config SET value = 'in_dojo', updated_at = datetime('now') WHERE key = 'user_presence'").run();
      } catch { /* best effort */ }
      logger.info('Away presence auto-expired after TTL, reverting to in_dojo');
      return 'in_dojo';
    }
    return 'away';
  } catch {
    return 'in_dojo';
  }
}

export function setPresence(status: PresenceStatus): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('user_presence', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(status, status);
  logger.info('User presence changed', { status });
}

export function isImessageConfigured(): boolean {
  const status = getIMBridgeStatus();
  // "Configured" means senders are set up, the bridge doesn't need to be actively running
  return (status.enabled || status.running) && !!getDefaultSender();
}

/**
 * Stricter than isImessageConfigured: the bridge's enable toggle is actually ON
 * (not merely set up or lingering as running) AND a default sender exists.
 * Gates the composer's in-dojo/away presence toggle so "away" only appears when
 * messages can really forward via iMessage, if the bridge is disabled, the
 * toggle is hidden entirely.
 */
export function isImessageEnabled(): boolean {
  const status = getIMBridgeStatus();
  return status.enabled && !!getDefaultSender();
}
