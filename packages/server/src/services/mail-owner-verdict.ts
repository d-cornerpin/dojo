// Does the provider's own authentication result prove the sender is the owner? Pure and dependency-free (no DB,
// network or logger). Owner only when the provider's `Authentication-Results` shows a DMARC PASS aligned with the
// From domain AND the From is exactly one of the owner's addresses (exact equality, never `addressesMatch`).
// A forwarded or quoted copy never counts; a missing, failed or unaligned check is unconfirmed.

export interface MailHeader { name: string; value: string }

export type OwnerVerdict =
  | { verdict: 'owner' }
  | { verdict: 'unconfirmed'; reason: 'no_owner_addresses' | 'from_not_single' | 'from_not_owner' | 'no_auth_header' | 'dmarc_not_pass' | 'dmarc_unaligned' };

// The ONE address in a raw From header, normalized, or null when it is not exactly one (more than one `<>` group,
// an unquoted comma, or no `@`).
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

/** Exchange Online stamps its result under an `*.outlook.com` host (or `mx.microsoft.com`). */
function isMicrosoftAuthservId(id: string): boolean {
  const host = id.toLowerCase();
  return host === 'mx.microsoft.com' || host === 'outlook.com' || host.endsWith('.outlook.com');
}

function authservId(value: string): string {
  return (value.split(';')[0].trim().split(/\s+/)[0] ?? '').replace(/^"|"$/g, '');
}

// Only the TOPMOST `Authentication-Results` (the receiving provider's, added last) is ever read: everything below
// it was written upstream, sender included. Gmail needs authserv-id `mx.google.com`, Outlook Microsoft's;
// anything else, or no header, is unconfirmed.
function findProviderHeader(provider: 'gmail' | 'outlook', headers: readonly MailHeader[]): MailHeader | null {
  const top = headers.find((h) => h.name.toLowerCase() === 'authentication-results');
  if (!top) return null;
  const id = authservId(top.value);
  return (provider === 'gmail' ? id.toLowerCase() === 'mx.google.com' : isMicrosoftAuthservId(id)) ? top : null;
}

// Top-level `;` clauses with RFC 8601 comments removed and quoted strings emptied: sender-chosen text inside
// either must never be read as a result.
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

// The dmarc result and its `header.from`, or null unless there is EXACTLY ONE top-level `dmarc=` clause with at
// most one `header.from=`. DKIM and SPF are never used.
function parseDmarc(headerValue: string): { result: string; headerFrom: string | null } | null {
  const dmarc = topLevelClauses(headerValue).slice(1).filter((c) => /^dmarc\s*=/i.test(c));
  if (dmarc.length !== 1) return null;
  const clause = dmarc[0];
  const result = clause.replace(/^dmarc\s*=\s*/i, '').match(/^[^\s;]*/)![0].toLowerCase();
  const froms = [...clause.matchAll(/(?:^|\s)header\.from\s*=\s*([^\s;]*)/gi)];
  if (froms.length > 1) return null;
  return { result, headerFrom: froms.length === 1 ? froms[0][1].replace(/^"|"$/g, '') : null };
}

/** Owner verdict for a provider-authenticated message; the first failing rule returns its reason. */
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

  // The provider's own header list must hold ONE From, and it must be the address being judged.
  const fromHeaders = input.headers.filter((h) => h.name.toLowerCase() === 'from');
  if (fromHeaders.length > 1 || (fromHeaders.length === 1 && singleAddress(fromHeaders[0].value) !== address)) {
    return { verdict: 'unconfirmed', reason: 'from_not_single' };
  }

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
