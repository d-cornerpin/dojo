// Has the human set an iMessage owner IN THE LIST? True when a stored record is flagged as the
// owner, or the list is the older bare-address form (first address = owner, written only by the
// Settings screen). The older single-recipient key alone is not enough: adding any entry to an
// empty list would end the bridge's fallback that keeps that owner reachable. The agent's
// add_safe_sender asks this before it writes.
import { getDb } from '../db/connection.js';
import { parseSafeSenders } from './safe-senders.js';

export function iMessageListHasHumanOwner(): boolean {
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    return parseSafeSenders(row?.value ?? null).some((s) => s.is_primary);
  } catch {
    return false;
  }
}
