// The owner's mailboxes (owner ruling 2026-10-27): the addresses of the connected Google and
// Microsoft accounts of kind 'user'. Read from the account tables every time, never stored twice.
import { listGoogleAccounts } from '../google/accounts.js';
import { listMicrosoftAccounts } from '../microsoft/accounts.js';
import { ownerEmailAddresses } from './owner-email-addresses.js';

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
      const address = ownerEmailAddresses([a.email])[0];
      if (!address || seen.has(address)) continue;
      seen.add(address);
      out.push({ address, provider, accountId: a.id });
    }
  };
  add(google, 'google');
  add(microsoft, 'microsoft');
  return out;
}

/** A disconnected account is not the owner's mailbox any more: P44 trusts these addresses to recognise the owner's email. */
export function ownerMailboxes(): OwnerMailbox[] {
  return ownerMailboxesFrom(listGoogleAccounts('user').filter((a) => a.connected), listMicrosoftAccounts('user').filter((a) => a.connected));
}
