// ════════════════════════════════════════
// Canonical recipient identity (lanes & lineage P5c).
//
// REKEY of the D16 last-10-digits recipient fuzz: "are these the same person"
// is answered by the canonical stores first, string heuristics last. A
// recipient string resolves to a stable identity through, in order:
//   1. the DOJO contacts store (emails / phones / imessage_handles arrays +
//      display/preferred name) -> `contact:<row id>`;
//   2. the iMessage safe-sender records (address or name) -> `im:<address>`.
// Two resolved identities compare by ID equality, so "Sam", "+1 (555)
// 123-4567" and "5551234567" agree when the store says they are one person.
// The digit-tail heuristic survives ONLY as the both-unresolved fallback (a
// formatting-tolerant compare for addresses no store knows), no longer as the
// identity itself.
//
// Direction of error is preserved from D16: an uncertain compare returns
// false, whose only cost is a possible duplicate reply, never a silent drop
// of the real sender's answer. Everything here is best-effort and must never
// throw in the executor path: store failures degrade to string compares.
// ════════════════════════════════════════
import { getDb } from '../db/connection.js';

/** Normalize a channel recipient id (phone / email / iMessage handle / chat
 *  id) for comparison, tolerating formatting differences. Strips formatting
 *  only for phone-like ids: stripping hyphens from emails/handles made
 *  distinct ids (a-b@x.com vs ab@x.com) compare equal, which would suppress a
 *  reply that should have been sent. */
export function normRecipientId(s: unknown): string {
  const raw = String(s ?? '').trim().toLowerCase();
  return /^[\d\s()+.-]+$/.test(raw) ? raw.replace(/[\s()+.-]/g, '') : raw;
}

function digitTail(s: string): string | null {
  const d = s.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

function phoneLikeEqual(a: string, b: string): boolean {
  const da = digitTail(a), db = digitTail(b);
  return da !== null && db !== null && da === db;
}

interface ContactIdentityRow {
  id: string;
  display_name: string;
  preferred_name: string | null;
  emails: string;
  phones: string;
  imessage_handles: string;
}

function parseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(x => String(x)) : [];
  } catch {
    return [];
  }
}

/** Resolve a recipient string to a stable canonical identity, or null when no
 *  store knows it. Contacts win over safe-sender records so both channels of
 *  one person converge on the same id when the contact row exists. */
export function resolveCanonicalRecipientId(raw: unknown): string | null {
  const norm = normRecipientId(raw);
  if (!norm) return null;
  try {
    const db = getDb();
    // 1. DOJO contacts store: address arrays (phones by digit tail) + names.
    const contacts = db.prepare(
      'SELECT id, display_name, preferred_name, emails, phones, imessage_handles FROM contacts',
    ).all() as ContactIdentityRow[];
    for (const c of contacts) {
      const addresses = [...parseArray(c.emails), ...parseArray(c.phones), ...parseArray(c.imessage_handles)];
      for (const a of addresses) {
        const an = normRecipientId(a);
        if (an === norm || phoneLikeEqual(an, norm)) return `contact:${c.id}`;
      }
      if (c.display_name.trim().toLowerCase() === norm || c.preferred_name?.trim().toLowerCase() === norm) {
        return `contact:${c.id}`;
      }
    }
    // 2. iMessage safe-sender records (address or name).
    const rawSenders = (db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'")
      .get() as { value: string } | undefined)?.value ?? null;
    if (rawSenders) {
      const senders = JSON.parse(rawSenders) as Array<{ address?: string; name?: string }>;
      if (Array.isArray(senders)) {
        for (const s of senders) {
          const an = normRecipientId(s.address);
          if (!an) continue;
          if (an === norm || phoneLikeEqual(an, norm)) return `im:${an}`;
          if (s.name && s.name.trim().toLowerCase() === norm) return `im:${an}`;
        }
      }
    }
  } catch {
    // Store unavailable: no canonical identity; callers fall to string compare.
  }
  return null;
}

/** Do two channel recipient ids refer to the same target? Canonical store
 *  identity first, exact normalized string second, digit-tail phone tolerance
 *  only when NEITHER side resolves. Conservative: uncertain compares return
 *  false (possible duplicate reply, never a silent drop). */
export function recipientIdsMatch(a: unknown, b: unknown): boolean {
  const na = normRecipientId(a), nb = normRecipientId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = resolveCanonicalRecipientId(na), cb = resolveCanonicalRecipientId(nb);
  if (ca !== null && cb !== null) return ca === cb;
  if (ca === null && cb === null) return phoneLikeEqual(na, nb);
  // One side known to a store, the other not: different identities as far as
  // anything can tell. Keep phone-tail tolerance so a known contact's number
  // still matches its raw formatted form if the store lookup missed it.
  return phoneLikeEqual(na, nb);
}
