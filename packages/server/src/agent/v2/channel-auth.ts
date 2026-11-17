// The ONE place that decides whether an inbound message earns an auto-reply on its channel,
// so every channel gates identically and a fix lands once. A message earns one iff (a) it
// arrived on the agent's OWN account (accountKind === 'agent'); user-account mail is the
// human's, never answered even from a safe sender; and (b) the sender is on that channel's
// safe-sender allowlist. Phone is the exception: a live call is already connected (callers
// pass channel !== 'phone'); iMessage is owned by the bridge, whose callers vet the sender.
import { mailboxesSafeSenders, senderWakes } from '../../services/channel-safe-senders.js';
import { addressesMatch, findSafeSenderByAddress, getSafeSenders } from '../../services/imessage-bridge.js';
import { isOwnerAddress } from '../../services/owner-mailboxes.js';

export type AuthChannel = 'imessage' | 'teams' | 'sms' | 'email';
export type AccountKind = 'agent' | 'user';

export function isSenderAuthorized(
  channel: AuthChannel,
  sender: string | null | undefined,
  accountKind: AccountKind = 'agent',
  opts?: { emailService?: 'gmail' | 'outlook' },
): boolean {
  if (accountKind !== 'agent') return false;
  if (!sender) return false;
  const s = sender.toLowerCase();
  switch (channel) {
    case 'email': {
      // Every agent mailbox's list for the service (both when unknown): the recheck after the watcher's verdict.
      const services = opts?.emailService ? [opts.emailService] : (['gmail', 'outlook'] as const);
      return services.some((svc) => mailboxesSafeSenders(svc, 'agent').some(x => addressesMatch(x.address, s)));
    }
    case 'teams':
    case 'sms':
      return senderWakes(channel, null, s);
    case 'imessage':
      return true;
    default:
      return false;
  }
}

/** May the Dojo answer this address on this channel: the approved list, or the owner writing from one of his own
 *  connected mailboxes (provider-confirmed, agent mailbox only). Asked at inbound and again before each send. */
export function mayAnswer(
  channel: AuthChannel,
  sender: string,
  accountKind: AccountKind,
  opts?: { emailService?: 'gmail' | 'outlook'; fromOwner?: boolean },
): boolean {
  if (channel === 'imessage') return accountKind === 'agent' && findSafeSenderByAddress(getSafeSenders(), sender) !== null;
  if (channel === 'email' && accountKind === 'agent' && opts?.fromOwner
    && isOwnerAddress(sender)) return true;
  return isSenderAuthorized(channel, sender, accountKind, opts?.emailService ? { emailService: opts.emailService } : undefined);
}
