// Canonical recipient identity: resolve through the stores first (contacts, then iMessage
// safe-sender records) and compare by resolved ID, so one person in three formats agrees.
// An uncertain compare returns false: a possible duplicate reply, never a silent drop.
import { getDb } from '../db/connection.js';

// Strip formatting only for phone-like ids: hyphen-stripping emails made a-b@example.com and
// ab@example.com compare equal, suppressing a reply that should have been sent.
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

// Resolve a recipient string to a stable canonical identity, or null when no store
// knows it. Contacts win so both channels of one person converge on one id. A name two
// contacts answer to is no identity: which one is meant cannot be told, so it is not guessed.
export function resolveCanonicalRecipientId(raw: unknown): string | null {
  const norm = normRecipientId(raw);
  if (!norm) return null;
  try {
    const db = getDb();
    const contacts = db.prepare(
      'SELECT id, display_name, preferred_name, emails, phones, imessage_handles FROM contacts',
    ).all() as ContactIdentityRow[];
    const named: string[] = [];
    for (const c of contacts) {
      const addresses = [...parseArray(c.emails), ...parseArray(c.phones), ...parseArray(c.imessage_handles)];
      for (const a of addresses) {
        const an = normRecipientId(a);
        if (an === norm || phoneLikeEqual(an, norm)) return `contact:${c.id}`;
      }
      if (c.display_name.trim().toLowerCase() === norm || c.preferred_name?.trim().toLowerCase() === norm) {
        named.push(`contact:${c.id}`);
      }
    }
    if (named.length > 1) return null;
    if (named.length === 1) return named[0];
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
    // Store failures must not throw in the executor path: degrade to a null identity and
    // let callers fall to the string compare.
  }
  return null;
}

// Same target? Canonical store identity first, exact normalized string second, digit-tail
// phone tolerance only when neither side resolves. Uncertain compares return false.
export function recipientIdsMatch(a: unknown, b: unknown): boolean {
  const na = normRecipientId(a), nb = normRecipientId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = resolveCanonicalRecipientId(na), cb = resolveCanonicalRecipientId(nb);
  if (ca !== null && cb !== null) return ca === cb;
  if (ca === null && cb === null) return phoneLikeEqual(na, nb);
  // One side store-known, the other not: different identities; phone-tail tolerance stays.
  return phoneLikeEqual(na, nb);
}
