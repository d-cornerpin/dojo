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

// Presence is EXACTLY what it was last set to, for as long as it was set.
// History: D21 added a 12-hour auto-expiry on manual "away" (a forgotten away
// diverted every reply to iMessage forever). REMOVED by owner ruling
// 2026-07-20: the owner kept finding "out of the Dojo" silently flipped back
// and never asked for a self-expiring setting. A user-visible setting must
// never change itself; the only writers are the user and the agent acting on
// the user's explicit ask (set_user_presence, kept as-is by the same ruling).

export function getPresence(): PresenceStatus {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'user_presence'").get() as { value: string } | undefined;
    return row?.value === 'away' ? 'away' : 'in_dojo';
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
