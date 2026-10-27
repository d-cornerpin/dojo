// ════════════════════════════════════════════════════════════════════════════════════════
// MAIL-INBOUND-FACTS — the one pure reader both mail watchers will call to turn a
// message's headers / recipient lists into who it went to and where the agent's own
// mailbox sits (to / cc / neither), plus the provider's own Authentication-Results.
// Pure: no DB, network, logger or side effects.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { InboundMeta } from '@dojo/shared';
import { parseAddressList, placeMailbox, type MailAddress } from './mail-addressing.js';

export interface MailAddressingFacts {
  to: MailAddress[];
  cc: MailAddress[];
  placement: 'to' | 'cc' | 'neither';
  authenticationResults: string[];
}

// Compile-time guard that this shape is exactly what InboundMeta stores:
const _fits: NonNullable<InboundMeta['mailAddressing']> = {} as MailAddressingFacts;
void _fits;

// The header names we read, compared case-insensitively and exactly.
const NAME_TO = 'to';
const NAME_CC = 'cc';
const NAME_AUTH = 'authentication-results';

/** Gmail: fold the To/Cc/Authentication-Results headers into one facts record. */
export function gmailAddressingFacts(
  headers: ReadonlyArray<{ name: string; value: string }>,
  ownAddresses: readonly string[],
): MailAddressingFacts {
  let toHeader = '';
  let ccHeader = '';
  const authenticationResults: string[] = [];
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === NAME_TO) {
      toHeader = toHeader === '' ? h.value : `${toHeader}, ${h.value}`;
    } else if (name === NAME_CC) {
      ccHeader = ccHeader === '' ? h.value : `${ccHeader}, ${h.value}`;
    } else if (name === NAME_AUTH) {
      const value = h.value.trim();
      if (value !== '') authenticationResults.push(value);
    }
  }
  const to = parseAddressList(toHeader);
  const cc = parseAddressList(ccHeader);
  return { to, cc, placement: placeMailbox(ownAddresses, to, cc), authenticationResults };
}

export interface OutlookRecipient {
  emailAddress?: { name?: string; address?: string };
}

/** Outlook: fold the toRecipients/ccRecipients lists into one facts record. */
export function outlookAddressingFacts(
  msg: { toRecipients?: OutlookRecipient[]; ccRecipients?: OutlookRecipient[] },
  ownAddresses: readonly string[],
): MailAddressingFacts {
  const to = outlookList(msg.toRecipients);
  const cc = outlookList(msg.ccRecipients);
  return { to, cc, placement: placeMailbox(ownAddresses, to, cc), authenticationResults: [] };
}

// One recipient list: lowercase+trim the address, drop entries with no @ or duplicate
// on a first-wins basis, and trim the display name (null when missing or blank).
function outlookList(recipients: readonly OutlookRecipient[] | undefined): MailAddress[] {
  const out: MailAddress[] = [];
  const seen = new Set<string>();
  for (const r of recipients ?? []) {
    const address = (r.emailAddress?.address ?? '').trim().toLowerCase();
    if (!address.includes('@')) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    const name = r.emailAddress?.name;
    out.push({ address, display: name ? name.trim() || null : null });
  }
  return out;
}
