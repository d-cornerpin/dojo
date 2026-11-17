// The owner's mailboxes: the addresses of the connected Google and Microsoft accounts of kind 'user'. Read from the
// account tables every time, never stored twice.
import { listGoogleAccounts } from '../google/accounts.js';
import { listMicrosoftAccounts } from '../microsoft/accounts.js';

/** One bare email address (one @, a dot after it, no spaces, angle brackets, commas or semicolons). */
const BARE_EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
/** The address, trimmed and lowercased, when the WHOLE string is a bare email address; else null. No fuzzy matching:
 *  'own-er@example.com' and 'owner@example.com' are two addresses, so a From address compares exactly. */
export function cleanEmailAddress(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const address = candidate.trim().toLowerCase();
  return BARE_EMAIL.test(address) ? address : null;
}

export type MailboxProvider = 'google' | 'microsoft';

export interface OwnerMailbox {
  readonly address: string;
  readonly provider: MailboxProvider;
  readonly accountId: string;
}

interface AccountLike {
  readonly id: string;
  readonly email: string | null;
}

export function ownerMailboxesFrom(
  google: ReadonlyArray<AccountLike>,
  microsoft: ReadonlyArray<AccountLike>,
): OwnerMailbox[] {
  const out: OwnerMailbox[] = [];
  const seen = new Set<string>();
  const add = (accounts: ReadonlyArray<AccountLike>, provider: MailboxProvider): void => {
    for (const a of accounts) {
      const address = cleanEmailAddress(a.email);
      if (!address || seen.has(address)) continue;
      seen.add(address);
      out.push({ address, provider, accountId: a.id });
    }
  };
  add(google, 'google');
  add(microsoft, 'microsoft');
  return out;
}

/** Is this one of the owner's connected mailbox addresses. */
export function isOwnerAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  return ownerMailboxes().some((mb) => mb.address === a);
}

/** A disconnected account is not the owner's mailbox any more: P44 trusts these addresses to recognise the owner's email. */
export function ownerMailboxes(): OwnerMailbox[] {
  return ownerMailboxesFrom(listGoogleAccounts('user').filter((a) => a.connected), listMicrosoftAccounts('user').filter((a) => a.connected));
}
