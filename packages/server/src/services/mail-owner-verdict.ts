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

export interface MailHeader { name: string; value: string }

export type OwnerVerdict =
  | { verdict: 'owner' }
  | { verdict: 'unconfirmed'; reason: 'no_owner_addresses' | 'from_not_single' | 'from_not_owner' | 'no_auth_header' | 'dmarc_not_pass' | 'dmarc_unaligned' };

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

/**
 * The provider's own authentication result, TOPMOST FIRST. For gmail only the topmost
 * `Authentication-Results` whose authserv-id is exactly `mx.google.com` counts; headers
 * further down, or with another authserv-id, are ignored (a sender or forwarder could forge
 * them). Exchange (outlook) writes its one header with no authserv-id, so its topmost
 * `Authentication-Results` is the answer.
 */
function findProviderHeader(provider: 'gmail' | 'outlook', headers: readonly MailHeader[]): MailHeader | null {
  for (const header of headers) {
    if (header.name.toLowerCase() !== 'authentication-results') continue;
    if (provider === 'outlook') return header;
    const authservId = header.value.split(';')[0].trim();
    if (authservId.toLowerCase() === 'mx.google.com') return header;
  }
  return null;
}

/**
 * The dmarc result word and its `header.from` domain from one header value, or null when no
 * segment starts with `dmarc=`. Only DMARC is read — DKIM and SPF results are never used.
 */
function parseDmarc(headerValue: string): { result: string; headerFrom: string | null } | null {
  for (const segment of headerValue.split(';')) {
    const s = segment.trim();
    if (!s.startsWith('dmarc=')) continue;
    const resultMatch = s.slice('dmarc='.length).match(/^\s*([^\s;]+)/);
    const result = resultMatch ? resultMatch[1].toLowerCase() : '';
    return { result, headerFrom: headerFromDomain(s) };
  }
  return null;
}

/** The domain after `header.from=` in the dmarc segment, or null when it is absent. The
 *  value may be followed by whitespace or `)` (a trailing `;` is already split away). */
function headerFromDomain(segment: string): string | null {
  const marker = 'header.from=';
  const idx = segment.indexOf(marker);
  if (idx < 0) return null;
  const rest = segment.slice(idx + marker.length);
  const match = rest.match(/^\s*([^\s);]+)/);
  return match ? match[1] : null;
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
