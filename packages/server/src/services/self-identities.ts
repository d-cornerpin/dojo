// ════════════════════════════════════════
// Self-identities: the email addresses that belong to THIS platform's own
// agent mailboxes, across every connected provider (Google + Microsoft).
//
// The mailbox watchers use this to suppress waking the agent on its own
// outbound mail. The common case (sender == the watched account) is easy, but
// the agent can also send from one of its OTHER agent mailboxes (a different
// provider or slot) into a mailbox it ALSO watches; that mail is equally
// self-authored and must not wake it. Matching the sender against the full
// set of agent-mailbox identities catches both.
//
// Only kind === 'agent' accounts are included. A kind === 'user' account is
// the human's own mailbox: the owner mailing the agent MUST still wake it, so
// user addresses are deliberately excluded from this set.
// ════════════════════════════════════════

import { listGoogleAccountViews } from '../google/auth.js';
import { listMicrosoftAccountViews } from '../microsoft/auth.js';
import { addressesMatch } from './imessage-bridge.js';

// Provider-neutral shape shared by GoogleAccountView and MicrosoftAccountView.
interface MailboxIdentityView {
  kind: 'agent' | 'user';
  connected: boolean;
  email: string | null;
}

/**
 * Every connected agent-mailbox email across both providers, deduped
 * case-insensitively. Non-agent accounts, disconnected accounts, and null/empty
 * emails are excluded. Cheap to call per poll cycle; not per message.
 */
export function listAgentSelfIdentities(): string[] {
  const views: MailboxIdentityView[] = [
    ...listGoogleAccountViews(),
    ...listMicrosoftAccountViews(),
  ];
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const v of views) {
    if (v.kind !== 'agent' || !v.connected || !v.email) continue;
    const key = v.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(v.email);
  }
  return emails;
}

/**
 * If `address` matches any of `identities` (tolerant compare via the shared
 * addressesMatch), return the matched identity email; otherwise null. Callers
 * log the matched identity so it is clear WHICH mailbox the outbound came from.
 */
export function matchSelfIdentity(address: string, identities: string[]): string | null {
  if (!address) return null;
  for (const identity of identities) {
    if (addressesMatch(address, identity)) return identity;
  }
  return null;
}
