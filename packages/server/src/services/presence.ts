// The in_dojo / away toggle; iMessage delivery is a deliberate `imessage_send`, never an automatic forward.

import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { getIMBridgeStatus, getDefaultSender } from './imessage-bridge.js';

const logger = createLogger('presence');

export type PresenceStatus = 'in_dojo' | 'away';

// Presence is exactly what it was last set to, for as long as it was set. A user-visible setting must never
// change itself: the only writers are the user and the agent acting on their explicit ask (set_user_presence).

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
  broadcast({ type: 'presence:changed', status });
}

export function isImessageConfigured(): boolean {
  const status = getIMBridgeStatus();
  return (status.enabled || status.running) && !!getDefaultSender();
}

/** Stricter than isImessageConfigured: the bridge toggle is ON and a default sender exists. */
export function isImessageEnabled(): boolean {
  const status = getIMBridgeStatus();
  return status.enabled && !!getDefaultSender();
}
