// The safe-sender records and the one answer to "who is the owner on iMessage", apart from
// `services/imessage-bridge.ts` (which re-exports every name); importing only the database, logger and
// recipient comparison lets a reader the bridge's graph would cycle with share it. "Which address do I send
// to?" (`ownerIMessageRecord`) is the starred record, else the legacy key. "Is this address the owner?"
// (`isOwnerIMessageRecipient`) is EVERY flagged record, and the legacy key only when no records are saved.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { recipientIdsMatch } from '../agent/recipient-identity.js';

const logger = createLogger('imessage');

// `imessage_approved_senders` holds a JSON array of records; `parseSafeSenders` also accepts the legacy bare
// string[] (first entry becomes primary), and every read goes through it.

export type SharingLevel = 'open_book' | 'dont_overshare' | 'cautious' | 'project_only';

export const SHARING_LEVELS: readonly SharingLevel[] = ['open_book', 'dont_overshare', 'cautious', 'project_only'] as const;

export interface SafeSender {
  address: string;
  name: string;
  description?: string;
  is_primary: boolean;
  sharing_level: SharingLevel;
  /** True for another Dojo agent (not a human); gates machine-to-machine behavior instead of `description`. */
  is_agent?: boolean;
}

function defaultSharingLevelFor(isPrimary: boolean): SharingLevel {
  return isPrimary ? 'open_book' : 'dont_overshare';
}

function normalizeSharingLevel(raw: unknown, isPrimary: boolean): SharingLevel {
  if (typeof raw === 'string' && (SHARING_LEVELS as readonly string[]).includes(raw)) {
    return raw as SharingLevel;
  }
  return defaultSharingLevelFor(isPrimary);
}

/** Scrub characters that would break the [SOURCE: IMESSAGE FROM ...] envelope (brackets, CR/LF, control chars). */
function sanitizeFramingField(value: string): string {
  return value
    .replace(/[\[\]\r\n\t\v\f\x00-\x1f\x7f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// A record saved before the `is_agent` flag only says "AI agent" in its description: when the flag is ABSENT
// (not merely false) and the description matches, treat it as an agent. An explicit `is_agent: false` wins.
const IS_AGENT_DESCRIPTION_RE = /\bAI agent\b/i;
// Logged once per address (parseSafeSenders runs on every poll).
const backfillHeuristicLogged = new Set<string>();

export function parseSafeSenders(raw: string | null | undefined): SafeSender[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const normalized: SafeSender[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item === 'string') {
      // Legacy entry: auto-promote, mark first as primary, copy address into name.
      const addr = item.trim();
      if (!addr) continue;
      const isPrimary = i === 0;
      normalized.push({
        address: addr,
        name: addr,
        description: undefined,
        is_primary: isPrimary,
        sharing_level: defaultSharingLevelFor(isPrimary),
        is_agent: false,
      });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const address = typeof obj.address === 'string' ? obj.address.trim() : '';
      if (!address) continue;
      // Strip brackets and control chars from name/description so a crafted entry cannot break the
      // [SOURCE: IMESSAGE FROM ...] envelope the agent parses out of inbound message text.
      const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
      const name = rawName ? (sanitizeFramingField(rawName) || address) : address;
      const rawDescription = typeof obj.description === 'string' ? obj.description.trim() : '';
      const cleanedDescription = rawDescription ? sanitizeFramingField(rawDescription) : '';
      const description = cleanedDescription || undefined;
      const is_primary = obj.is_primary === true;
      const sharing_level = normalizeSharingLevel(obj.sharing_level, is_primary);
      let is_agent: boolean;
      if (typeof obj.is_agent === 'boolean') {
        is_agent = obj.is_agent;
      } else if (rawDescription && IS_AGENT_DESCRIPTION_RE.test(rawDescription)) {
        is_agent = true;
        if (!backfillHeuristicLogged.has(address)) {
          backfillHeuristicLogged.add(address);
          logger.info('Safe-sender is_agent backfilled from description heuristic', {
            address, matched: 'AI agent',
          });
        }
      } else {
        is_agent = false;
      }
      normalized.push({ address, name, description, is_primary, sharing_level, is_agent });
    }
  }

  // At most one primary, never chosen by position: an unstarred list's owner is the entry the legacy key
  // names, if any (the dashboard clears that key when the owner entry is removed). If several are starred,
  // keep the first.
  const primaries = normalized.filter(s => s.is_primary);
  if (primaries.length === 0 && normalized.length > 0) {
    const legacyDefault = readLegacyDefaultSender();
    const promoteIdx = legacyDefault
      ? normalized.findIndex(s => addressesMatch(s.address, legacyDefault))
      : -1;
    // Never promote by position: no flag and no legacy-key match means no owner.
    if (promoteIdx >= 0) normalized[promoteIdx].is_primary = true;
  } else if (primaries.length > 1) {
    let seen = false;
    for (const s of normalized) {
      if (s.is_primary) {
        if (seen) s.is_primary = false;
        else seen = true;
      }
    }
  }
  return normalized;
}

export function readLegacyDefaultSender(): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = 'imessage_default_sender'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Tolerant address comparison: normalized forms equal, or one contains the other (country-code prefixes). */
export function addressesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring fallback only for "phone-ish" addresses (no @ on either side).
  // Email matching is exact to avoid alice@example.com matching alice.smith@example.com.
  if (na.includes('@') || nb.includes('@')) return false;
  return na.includes(nb) || nb.includes(na);
}

export function findSafeSenderByAddress(records: readonly SafeSender[], query: string): SafeSender | null {
  for (const r of records) {
    if (addressesMatch(r.address, query)) return r;
  }
  return null;
}

function storedSafeSenders(): SafeSender[] {
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    return parseSafeSenders(row?.value ?? null);
  } catch {
    return [];
  }
}

/** The owner on iMessage: the starred record, else the legacy key. Pass `records` when you hold a copy. */
export function ownerIMessageRecord(records: readonly SafeSender[] = storedSafeSenders()): { address: string; name: string } | null {
  const starred = records.find((s) => s.is_primary);
  if (starred) return { address: starred.address, name: starred.name };
  const legacy = readLegacyDefaultSender();
  return legacy ? { address: legacy, name: legacy } : null;
}

/**
 * Every address that IS the owner on iMessage (`ownerIMessageRecord` is the one to send to): every record
 * flagged `is_primary`, plus a legacy bare-address list's first address, else the legacy key. No object
 * record is ever made owner by position.
 */
export function ownerIMessageRecords(): Array<{ address: string; name: string }> {
  const out: Array<{ address: string; name: string }> = [];
  let raw: string | null = null;
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    raw = row?.value ?? null;
  } catch { /* unreadable config: nobody is known */ }
  const records = parseSafeSenders(raw);
  for (const r of records) if (r.is_primary) out.push({ address: r.address, name: r.name });
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        const rec = r as { address?: unknown; name?: unknown; is_primary?: unknown } | null;
        if (rec && rec.is_primary === true && typeof rec.address === 'string' && !out.some((o) => o.address === rec.address)) {
          out.push({ address: rec.address, name: typeof rec.name === 'string' && rec.name ? rec.name : rec.address });
        }
      }
    }
  } catch { /* not JSON: the parsed list above is the answer */ }
  if (out.length === 0) {
    const legacy = readLegacyDefaultSender();
    if (legacy) out.push({ address: legacy, name: legacy });
  }
  return out;
}

/** Is `recipient` (an address, or an owner record's name) an owner? Unknown means NOT the owner. */
export function isOwnerIMessageRecipient(recipient: string | null | undefined): boolean {
  if (!recipient) return false;
  try {
    return ownerIMessageRecords().some((owner) => recipient === owner.address
      || recipientIdsMatch(recipient, owner.address)
      || recipientIdsMatch(recipient, owner.name));
  } catch {
    return false;
  }
}

/** Who a message went to or came from, for a log line: the kind of person, never the address or number. */
export function recipientKind(recipient: string): string {
  return isOwnerIMessageRecipient(recipient) ? 'the owner' : 'an approved sender';
}
