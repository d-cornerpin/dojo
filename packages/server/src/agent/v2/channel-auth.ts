// The ONE place that decides whether an inbound message earns an auto-reply on its channel,
// so every channel gates identically and a fix lands once. A message earns one iff (a) it
// arrived on the agent's OWN account (accountKind === 'agent'); user-account mail is the
// human's, never answered even from a safe sender; and (b) the sender is on that channel's
// safe-sender allowlist. Phone is the exception: a live call is already connected (callers
// pass channel !== 'phone'); iMessage is owned by the bridge, whose callers vet the sender.
import {
  getGmailSafeSenders,
  getOutlookSafeSenders,
  getTeamsSafeSenders,
  getTwilioSmsSafeSenders,
} from '../../services/channel-safe-senders.js';
import { addressesMatch } from '../../services/imessage-bridge.js';

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
      const list =
        opts?.emailService === 'outlook'
          ? getOutlookSafeSenders('agent')
          : opts?.emailService === 'gmail'
            ? getGmailSafeSenders('agent')
            : [...getGmailSafeSenders('agent'), ...getOutlookSafeSenders('agent')];
      return list.some(x => addressesMatch(x.address, s));
    }
    case 'teams':
      return getTeamsSafeSenders().some(x => addressesMatch(x.address, s));
    case 'sms':
      return getTwilioSmsSafeSenders().some(x => addressesMatch(x.address, s));
    case 'imessage':
      return true;
    default:
      return false;
  }
}
