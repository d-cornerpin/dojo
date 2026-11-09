// ════════════════════════════════════════════════════════════════════════════════════════
// WHO A MESSAGE WENT TO: the one pure reader both mail watchers call to turn a message's headers or recipient lists
// into its To and Cc entries, where the agent's own mailbox sits (to / cc / neither), and the provider's own
// Authentication-Results. Pure: no DB, network, logger or side effects.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { InboundMeta } from '@dojo/shared';
import { decodeHtmlEntities } from '../agent/html-text.js';

/** A parsed address-list entry. `address` is trimmed + lower-cased; `display` is
 *  the name with its surrounding quotes removed, or null when the entry had none. */
export interface MailAddress {
  address: string;
  display: string | null;
}

export type Placement = 'to' | 'cc' | 'neither';

/** Split an address-list header into entries. Commas inside double quotes or <...> do not split; an entry's address is
 *  the <...> contents when present, else the whole piece; entries with no @ and repeated addresses are dropped. */
export function parseAddressList(header: string | null | undefined): MailAddress[] {
  if (!header) return [];
  const out: MailAddress[] = [];
  const seen = new Set<string>();
  for (const piece of splitTopLevelCommas(header)) {
    const entry = parseOne(piece);
    if (!entry) continue;
    if (!entry.address.includes('@')) continue;
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
  }
  return out;
}

/** Where one of `ownAddresses` sits in the To/Cc pair, by EXACT equality of trimmed, lower-cased addresses (a look-alike
 *  such as `own-er@x.com` is not `owner@x.com`). To wins over Cc. */
export function placeMailbox(
  ownAddresses: readonly string[],
  to: readonly MailAddress[],
  cc: readonly MailAddress[],
): Placement {
  const own = new Set(ownAddresses.map(normAddress));
  for (const a of to) if (own.has(normAddress(a.address))) return 'to';
  for (const a of cc) if (own.has(normAddress(a.address))) return 'cc';
  return 'neither';
}

// The canonical form every address is compared and deduped on.
function normAddress(a: string): string {
  return a.trim().toLowerCase();
}

// Split on commas that are neither inside "..." nor inside <...>.
function splitTopLevelCommas(header: string): string[] {
  const pieces: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngles = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '"') {
      // A quote toggles the quote state, but one inside <...> does not.
      if (!inAngles) inQuotes = !inQuotes;
    } else if (ch === '<' && !inQuotes) {
      inAngles = true;
    } else if (ch === '>' && !inQuotes) {
      inAngles = false;
    } else if (ch === ',' && !inQuotes && !inAngles) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  pieces.push(current);
  return pieces;
}

// One piece: a leading quoted name is peeled first (a <...> inside it is not the address), then the final <...> is the
// address; with no angle brackets the whole piece is the address.
function parseOne(piece: string): MailAddress | null {
  let s = piece.trim();
  if (s === '') return null;
  let display: string | null = null;
  if (s[0] === '"') {
    const close = findClosingQuote(s);
    if (close === -1) return null;
    display = s.slice(1, close).trim();
    s = s.slice(close + 1).trim();
  }
  const lt = s.indexOf('<');
  const gt = s.lastIndexOf('>');
  if (lt !== -1 && gt > lt) {
    const address = normAddress(s.slice(lt + 1, gt));
    if (display === null) {
      const name = s.slice(0, lt).trim();
      display = name === '' ? null : name;
    }
    return { address, display };
  }
  return { address: normAddress(s), display };
}

// Index of the unescaped closing quote of a name opening at s[0] === '"', or -1.
function findClosingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

export interface MailAddressingFacts {
  to: MailAddress[];
  cc: MailAddress[];
  placement: Placement;
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

/** The preview text of a Gmail message. Gmail HTML-escapes its `snippet` field (`&#39;`, `&amp;`), so it is decoded once here, for every reader. */
export function gmailSnippetText(snippet: string | undefined): string {
  return decodeHtmlEntities(snippet ?? '');
}
