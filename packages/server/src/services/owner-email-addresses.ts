// ════════════════════════════════════════
// services/owner-email-addresses.ts — the one cleaner for email addresses that stand for the owner.
//
// Its input is the email column of the owner's connected Google and Microsoft accounts of kind 'user'
// (`owner-mailboxes.ts`; owner ruling 2026-10-27 — NOT free-form saved details). Each candidate is cleaned the
// same way every time so the owner-email check can compare EXACTLY with a message's From address: trimmed,
// lowercased, and kept only when the WHOLE string is a bare email address. No fuzzy matching and no stripped
// punctuation — 'own-er@x.com' and 'owner@x.com' are two different addresses.
//
// Pure + dependency-free on purpose, so it is unit-testable in isolation.
// ════════════════════════════════════════

/**
 * The whole-string shape of a bare email address: one @, a dot after it, and
 * no spaces, angle brackets, commas or semicolons anywhere.
 */
const BARE_EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Pick the email-shaped entries out of a list of free-form contact strings.
 * Each candidate is skipped unless it is a string that, once trimmed and
 * lowercased, matches BARE_EMAIL in full. Duplicates collapse to their first
 * occurrence; input order is kept.
 */
export function ownerEmailAddresses(
  candidates: ReadonlyArray<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    // null, undefined and anything non-string (a number slipped in by
    // mistake) simply do not count as a candidate.
    if (typeof candidate !== 'string') continue;
    const address = candidate.trim().toLowerCase();
    if (!BARE_EMAIL.test(address)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}
