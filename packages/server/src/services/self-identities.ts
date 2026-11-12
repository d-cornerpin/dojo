// The email addresses of THIS platform's own agent mailboxes, so the watchers never wake the agent on its own
// outbound mail, even from one of its OTHER agent mailboxes. Only 'agent' accounts count: a 'user' account
// is the human's mailbox, and the owner mailing the agent must still wake it.

import { listGoogleAccountViews } from '../google/auth.js';
import { listMicrosoftAccountViews } from '../microsoft/auth.js';
import { addressesMatch } from './imessage-bridge.js';

// Provider-neutral view shared by the Google and Microsoft account views.
interface MailboxIdentityView {
  kind: 'agent' | 'user';
  connected: boolean;
  email: string | null;
}

/** Every connected agent-mailbox email across both providers, deduped case-insensitively. */
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

/** The identity email matching `address` (tolerant compare via addressesMatch), else null. */
export function matchSelfIdentity(address: string, identities: string[]): string | null {
  if (!address) return null;
  for (const identity of identities) {
    if (addressesMatch(address, identity)) return identity;
  }
  return null;
}
