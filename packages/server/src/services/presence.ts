// The in_dojo / away toggle, and whether the owner can be reached by iMessage: the switch is on and his address is known.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { isIMessageSwitchedOn, getDefaultSender } from './imessage-bridge.js';

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
  setConfigValue('user_presence', status);
  broadcast({ type: 'presence:changed', status });
}

/** The owner can be reached by iMessage: it is switched on in Settings and his address is known. */
export function isImessageConfigured(): boolean {
  return isIMessageSwitchedOn() && !!getDefaultSender();
}
