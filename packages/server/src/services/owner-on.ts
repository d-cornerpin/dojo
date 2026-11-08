// Is this recipient the owner on this channel? One function, dispatching by channel: email by the
// owner's connected user mailboxes, the rest by the one phone/iMessage owner rule. Never a name.
import { isOwnerIMessageRecipient } from './safe-senders.js';
import { ownerEmailAddresses } from './owner-email-addresses.js';
import { ownerMailboxes } from './owner-mailboxes.js';

export function isOwnerOn(channel: string, recipient: string): boolean {
  try {
    if (channel === 'email') {
      const [clean] = ownerEmailAddresses([recipient]);
      return !!clean && ownerMailboxes().some((m) => m.address === clean);
    }
    return isOwnerIMessageRecipient(recipient);
  } catch { return false; }
}
