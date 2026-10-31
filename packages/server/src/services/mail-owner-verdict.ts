// ════════════════════════════════════════════════════════════════════════════════════════
// services/mail-owner-verdict.ts — does the provider's own authentication result prove the
// sender is the owner?
//
// The owner's design (P44) reverses the "email never verifies an owner" ruling (t250,
// `tracker/owner-words.ts:27` — a From header is nobody-authenticated and can be forged)
// ONLY when the provider's own `Authentication-Results` shows a DMARC PASS aligned with the
// From domain AND the From address is one of the owner's own addresses. A forwarded or
// quoted copy inside another email never counts; a missing, failed or unaligned check is
// unconfirmed. This slice is only the decision function — the watchers and the owner-words
// door are wired later by the orchestrator.
//
// Pure + dependency-free on purpose, so it is unit-testable in isolation (no DB, network,
// logger). It reads the provider's header, never the message body, and never imports
// `addressesMatch` — the owner comparison is exact string equality, deliberately not fuzzy.
// ════════════════════════════════════════════════════════════════════════════════════════

import { outlookOwnerConfirmationOpen } from './outlook-owner-gate.js';

export interface MailHeader { name: string; value: string }

export type OwnerVerdict =
  | { verdict: 'owner' }
  | { verdict: 'unconfirmed'; reason: 'outlook_not_open' | 'no_owner_addresses' | 'from_not_single' | 'from_not_owner' | 'no_auth_header' | 'dmarc_not_pass' | 'dmarc_unaligned' };

/**
 * The ONE address in a raw From header, normalized (trimmed, lower-cased), or null when the
 * header does not hold exactly one address. Angle-bracket groups are the address; a header
 * with none counts its whole trimmed value as one; more than one group, more than one
 * comma-separated piece outside quotes, or no `@` all mean "not single".
 */
function singleAddress(from: string): string | null {
  const groups = Array.from(from.matchAll(/<([^>]*)>/g), (m) => m[1]);
  if (groups.length > 1) return null;
  const candidate = groups.length === 1 ? groups[0].trim() : from.trim();
  if (topLevelCommas(from) > 0) return null;
  if (!candidate.includes('@')) return null;
  return candidate.trim().toLowerCase();
}

/** Commas at the top level, ignoring commas inside a quoted display name. */
function topLevelCommas(value: string): number {
  let count = 0;
  let inQuotes = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) count++;
  }
  return count;
}

/** Is `id` Microsoft's own receiving server? Exchange Online stamps its result under an `*.outlook.com` host (or `mx.microsoft.com`). */
function isMicrosoftAuthservId(id: string): boolean {
  const host = id.toLowerCase();
  return host === 'mx.microsoft.com' || host === 'outlook.com' || host.endsWith('.outlook.com');
}

/** The first token of the header: the authserv-id (a `version` number may follow it). Comments cannot precede it. */
function authservId(value: string): string {
  return (value.split(';')[0].trim().split(/\s+/)[0] ?? '').replace(/^"|"$/g, '');
}

/**
 * The provider's own authentication result is the TOPMOST `Authentication-Results` header, the one the receiving provider
 * added last, and NOTHING BELOW IT IS EVER READ: every header below was written by someone upstream, sender included.
 * Gmail: the topmost must carry Google's own authserv-id `mx.google.com`; if it carries any other, or there is none, the
 * email is unconfirmed (a lower Google-looking header is never looked for). Outlook: see `outlook-owner-gate.ts`.
 */
function findProviderHeader(provider: 'gmail' | 'outlook', headers: readonly MailHeader[]): MailHeader | null {
  const top = headers.find((h) => h.name.toLowerCase() === 'authentication-results');
  if (!top) return null;
  const id = authservId(top.value);
  return (provider === 'gmail' ? id.toLowerCase() === 'mx.google.com' : isMicrosoftAuthservId(id)) ? top : null;
}

/**
 * The header's top-level `;`-separated clauses with RFC 8601 comments `( ... )` removed and quoted strings
 * emptied: text the sender chose (an envelope address, a DKIM identity) can sit inside either, so nothing in
 * them is ever read as a method result or a property.
 */
function topLevelClauses(value: string): string[] {
  const clauses: string[] = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '\\' && depth > 0) { i++; continue; }
    if (depth > 0) { if (ch === '(') depth++; else if (ch === ')') depth--; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === '"') { quoted = true; cur += '""'; continue; }
    if (ch === ';') { clauses.push(cur); cur = ''; continue; }
    cur += ch;
  }
  clauses.push(cur);
  return clauses.map((c) => c.trim());
}

/**
 * The dmarc result word and its `header.from` domain, or null when the header does not hold EXACTLY ONE
 * top-level `dmarc=` result with at most one `header.from=` (any other count or shape is unconfirmed).
 * DKIM and SPF results are never used.
 */
function parseDmarc(headerValue: string): { result: string; headerFrom: string | null } | null {
  const dmarc = topLevelClauses(headerValue).slice(1).filter((c) => /^dmarc\s*=/i.test(c));
  if (dmarc.length !== 1) return null;
  const clause = dmarc[0];
  const result = clause.replace(/^dmarc\s*=\s*/i, '').match(/^[^\s;]*/)![0].toLowerCase();
  const froms = [...clause.matchAll(/(?:^|\s)header\.from\s*=\s*([^\s;]*)/gi)];
  if (froms.length > 1) return null;
  return { result, headerFrom: froms.length === 1 ? froms[0][1].replace(/^"|"$/g, '') : null };
}

/**
 * The owner verdict for a message the provider authenticated. Rules are checked in order,
 * and the first failure returns its reason: no owner addresses; the From header not holding
 * exactly one address; the address not exactly one of the owner's; no provider auth result;
 * a missing/not-pass dmarc; a pass not aligned with the From domain. Otherwise: owner.
 */
export function ownerEmailVerdict(input: {
  provider: 'gmail' | 'outlook';
  from: string;                      // the raw From header value
  headers: readonly MailHeader[];    // every header the provider returned, TOPMOST FIRST
  ownerAddresses: readonly string[];
}): OwnerVerdict {
  const owners = input.ownerAddresses
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a !== '');
  if (owners.length === 0) return { verdict: 'unconfirmed', reason: 'no_owner_addresses' };

  const address = singleAddress(input.from);
  if (address === null) return { verdict: 'unconfirmed', reason: 'from_not_single' };

  if (!owners.includes(address)) return { verdict: 'unconfirmed', reason: 'from_not_owner' };

  // The provider's own header list must hold ONE From, and it must be the address being judged (a second From, in any
  // letter case, is a message the provider's single-address check was not written for).
  const fromHeaders = input.headers.filter((h) => h.name.toLowerCase() === 'from');
  if (fromHeaders.length > 1 || (fromHeaders.length === 1 && singleAddress(fromHeaders[0].value) !== address)) {
    return { verdict: 'unconfirmed', reason: 'from_not_single' };
  }

  if (input.provider === 'outlook' && !outlookOwnerConfirmationOpen()) return { verdict: 'unconfirmed', reason: 'outlook_not_open' };

  const auth = findProviderHeader(input.provider, input.headers);
  if (!auth) return { verdict: 'unconfirmed', reason: 'no_auth_header' };

  const dmarc = parseDmarc(auth.value);
  if (!dmarc || dmarc.result !== 'pass') return { verdict: 'unconfirmed', reason: 'dmarc_not_pass' };

  const fromDomain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (!dmarc.headerFrom || dmarc.headerFrom.toLowerCase() !== fromDomain) {
    return { verdict: 'unconfirmed', reason: 'dmarc_unaligned' };
  }

  return { verdict: 'owner' };
}
