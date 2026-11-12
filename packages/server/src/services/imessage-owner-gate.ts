// True when the safe-sender list names a human owner; the legacy single-recipient key alone does not count.
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
