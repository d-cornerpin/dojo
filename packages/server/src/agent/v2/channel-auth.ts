// ════════════════════════════════════════
// Channel Authorization (v3.0.9)
//
// The ONE place that decides whether an inbound message earns an auto-reply
// on its channel. Before this, every channel made the call in its own spot
// with subtly different rules — loop.ts for Teams/email, sms-inbound.ts for
// SMS, the bridge for iMessage. That scatter is how the email auto-reply
// gate drifted and broke twice. Centralizing it means every channel gates
// identically and a fix lands once.
//
// A message earns an auto-reply iff:
//   (a) it arrived on the agent's OWN channel (accountKind === 'agent').
//       Mail/DMs to a USER-owned account are the human's — the agent never
//       answers on their behalf, even from a safe sender; and
//   (b) the sender is on that channel's safe-sender allowlist.
//
// Phone is the deliberate exception: a live call is already connected, so
// the agent speaks back to whoever is on the line (handled by the caller,
// which passes channel !== 'phone' here). iMessage authorization is owned by
// the bridge (its own safe-sender parse + turn-anchored recipient); callers
// there have already vetted the sender.
// ════════════════════════════════════════
import {
  getGmailSafeSenders,
  getOutlookSafeSenders,
  getTeamsSafeSenders,
  getTwilioSmsSafeSenders,
} from '../../services/channel-safe-senders.js';
import { addressesMatch } from '../../services/imessage-bridge.js';

export type AuthChannel = 'imessage' | 'teams' | 'sms' | 'email';
export type AccountKind = 'agent' | 'user';

/**
 * Is `sender` (an email address / phone number / handle) authorized to
 * receive an auto-reply on `channel`? `accountKind` is the kind of account
 * that RECEIVED the message; only 'agent'-kind channels are auto-reply
 * eligible. For email, pass the service so the right allowlist is checked
 * (omit to check both).
 */
export function isSenderAuthorized(
  channel: AuthChannel,
  sender: string | null | undefined,
  accountKind: AccountKind = 'agent',
  opts?: { emailService?: 'gmail' | 'outlook' },
): boolean {
  // Never auto-reply on a user-owned account's behalf.
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
      // Bridge-owned: the caller has already vetted the sender against the
      // iMessage allowlist before reaching here.
      return true;
    default:
      return false;
  }
}
