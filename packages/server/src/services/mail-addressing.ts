// ════════════════════════════════════════════════════════════════════════════════════════
// MAIL-ADDRESSING — two pure building blocks for the P44 notice: split a To/Cc
// address-list header into entries, and say where one mailbox sits in a To/Cc pair
// (to / cc / neither). Pure: no DB, network, logger or side effects.
// ════════════════════════════════════════════════════════════════════════════════════════

/** A parsed address-list entry. `address` is trimmed + lower-cased; `display` is
 *  the name with its surrounding quotes removed, or null when the entry had none. */
export interface MailAddress {
  address: string;
  display: string | null;
}

export type Placement = 'to' | 'cc' | 'neither';

/**
 * Split an address-list header into entries. Commas that sit inside double quotes
 * or inside <...> do not split. Each piece's address is the <...> contents when
 * present, else the whole piece; pieces with no @ are dropped, and duplicate
 * addresses (by lower-cased address, first occurrence kept) are removed.
 * null / undefined / empty give [].
 */
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

/**
 * Where does one of `ownAddresses` sit in the To/Cc pair? Compared by EXACT
 * equality of trimmed, lower-cased address strings — never fuzzy (a look-alike
 * such as `own-er@x.com` is not `owner@x.com`). To wins over Cc; when on neither,
 * 'neither'.
 */
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

// Parse one piece: peel a leading quoted name (so a <...> it contains is not
// mistaken for the address), then read the address from the final <...>; with no
// angle brackets the whole piece is the address and the display stays null.
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
