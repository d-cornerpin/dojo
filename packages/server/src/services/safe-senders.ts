// ════════════════════════════════════════════════════════════════════════════════════════
// THE SAFE-SENDER RECORDS, AND THE ONE ANSWER TO "WHO IS THE OWNER ON IMESSAGE" (t146).
//
// Moved byte-for-byte out of `services/imessage-bridge.ts` (which re-exports every name, so no
// importer changed), because the owner question had THREE readers and two of them could not
// import the bridge: the told record (`work/validation-drive.ts`) sits under `work/store.ts`,
// which the bridge reaches through the outbound ledger — a cycle — so t142 wrote its own parse,
// and it disagreed with the bridge on a list with nobody starred and on a legacy bare-string
// list (the bridge texted an owner the record then refused). This module imports only the
// database, the logger and the recipient comparison, so every reader can share it.
//
// THE RULE (`ownerIMessageRecord`): the starred record — `parseSafeSenders` guarantees exactly
// one in any non-empty list (none starred → the record matching the legacy key, else the first;
// a legacy bare-string list → its first entry) — and, only when there are no records at all,
// the legacy `imessage_default_sender` key. Readers: the bridge's `getDefaultSender` (where
// every owner notice goes), the refusal gate's owner check, and the told record.
// ════════════════════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { recipientIdsMatch } from '../agent/recipient-identity.js';

const logger = createLogger('imessage');

// ── Safe-sender records ──────────────────────────────────────────────────
//
// The `imessage_approved_senders` config value used to be a bare JSON array
// of phone/Apple-ID strings, with the "primary user" tracked separately in
// `imessage_default_sender`. That made the agent unable to tell who actually
// sent an inbound message (the framing always said "FROM <owner>") and made
// the outbound tool's allowlist trivially bypassable.
//
// New shape, stored under the same config key for continuity:
//   [
//     { address: "+15551234567", name: "Alex", description: "Owner",
//       is_primary: true, sharing_level: "open_book" },
//     { address: "jordan@example.com", name: "Jordan", description:
//       "project collaborator", is_primary: false,
//       sharing_level: "project_only" },
//     ...
//   ]
//
// `parseSafeSenders` accepts BOTH the legacy (string[]) and new shapes,
// so existing installs keep working until the next Settings save migrates
// the value to the new shape on disk. Reads always go through this parser
// so callers never see the legacy form.

export type SharingLevel = 'open_book' | 'dont_overshare' | 'cautious' | 'project_only';

export const SHARING_LEVELS: readonly SharingLevel[] = ['open_book', 'dont_overshare', 'cautious', 'project_only'] as const;

export interface SafeSender {
  address: string;
  name: string;
  description?: string;
  is_primary: boolean;
  sharing_level: SharingLevel;
  /**
   * RC-4/RC-8: true when this safe-sender is another Dojo agent (not a human).
   * Lets the engine gate machine-to-machine behavior (skip start-acks, damp
   * content-free courtesy volleys) on structured data instead of free-text in
   * `description`. Optional + defaults false in parseSafeSenders so legacy
   * records and the config JSON need no migration.
   */
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

/**
 * Scrub characters that would break the [SOURCE: IMESSAGE FROM ...] framing
 * envelope: square brackets (close the envelope early), CR/LF (split lines),
 * and other control chars. Result is collapsed-whitespace-trimmed. Returns
 * an empty string if everything was stripped (caller can fall back).
 */
function sanitizeFramingField(value: string): string {
  return value
    .replace(/[\[\]\r\n\t\v\f\x00-\x1f\x7f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// RC-4/RC-8 one-time backfill: safe-sender records saved before the structured
// `is_agent` flag existed only say "AI agent" in their free-text description.
// When the flag is ABSENT (not merely false) and the description matches this,
// treat the sender as an agent so the machine-to-machine gates apply without a
// manual re-save. Explicit `is_agent: false` always wins (never re-promoted).
const IS_AGENT_DESCRIPTION_RE = /\bAI agent\b/i;
// Log the heuristic firing once per address (parseSafeSenders runs on every
// poll) so the info line is a one-time signal, not per-tick noise.
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
      // Strip brackets and control chars from name/description so a
      // crafted entry can't break the [SOURCE: IMESSAGE FROM ...] envelope
      // the agent parses out of inbound message text.
      const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
      const name = rawName ? (sanitizeFramingField(rawName) || address) : address;
      const rawDescription = typeof obj.description === 'string' ? obj.description.trim() : '';
      const cleanedDescription = rawDescription ? sanitizeFramingField(rawDescription) : '';
      const description = cleanedDescription || undefined;
      const is_primary = obj.is_primary === true;
      const sharing_level = normalizeSharingLevel(obj.sharing_level, is_primary);
      // is_agent: honor an explicit boolean; when the field is absent, apply
      // the one-time description heuristic (defaults false otherwise).
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

  // Guarantee exactly one primary. If none, promote the legacy default key's
  // match or the first record. If multiple, keep only the first marked.
  const primaries = normalized.filter(s => s.is_primary);
  if (primaries.length === 0 && normalized.length > 0) {
    const legacyDefault = readLegacyDefaultSender();
    const promoteIdx = legacyDefault
      ? normalized.findIndex(s => addressesMatch(s.address, legacyDefault))
      : -1;
    if (promoteIdx >= 0) normalized[promoteIdx].is_primary = true;
    else normalized[0].is_primary = true;
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

function readLegacyDefaultSender(): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = 'imessage_default_sender'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Tolerant address comparison. Phone numbers may come in as `+15551234567`,
 * `15551234567`, `(555) 123-4567`, etc; Apple IDs come in lowercase. Match
 * if the normalized forms are equal OR one contains the other (substring),
 * which handles country-code prefixes and formatting variations without
 * false-matching completely different addresses.
 */
export function addressesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring fallback only for "phone-ish" addresses (no @ on either side).
  // Email matching is exact to avoid alice@x.com matching alice.smith@x.com.
  if (na.includes('@') || nb.includes('@')) return false;
  return na.includes(nb) || nb.includes(na);
}

export function findSafeSenderByAddress(records: readonly SafeSender[], query: string): SafeSender | null {
  for (const r of records) {
    if (addressesMatch(r.address, query)) return r;
  }
  return null;
}

/** The records as stored (the bridge holds a running copy of the same config row). */
function storedSafeSenders(): SafeSender[] {
  try {
    const row = getDb().prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    return parseSafeSenders(row?.value ?? null);
  } catch {
    return [];
  }
}

/**
 * THE owner on iMessage: the starred record, or — only when there are no records — the legacy
 * key. Pass `records` when you hold a copy (the bridge's running list); otherwise the stored
 * records are read. Null when nothing names an owner.
 */
export function ownerIMessageRecord(records: readonly SafeSender[] = storedSafeSenders()): { address: string; name: string } | null {
  const starred = records.find((s) => s.is_primary);
  if (starred) return { address: starred.address, name: starred.name };
  const legacy = readLegacyDefaultSender();
  return legacy ? { address: legacy, name: legacy } : null;
}

/** Is `recipient` (an address, or the owner's record name) the owner on iMessage? Unknown means
 *  NOT the owner: phone- and case-tolerant through the canonical recipient comparison. */
export function isOwnerIMessageRecipient(recipient: string | null | undefined): boolean {
  if (!recipient) return false;
  try {
    const owner = ownerIMessageRecord();
    if (!owner) return false;
    return recipient === owner.address
      || recipientIdsMatch(recipient, owner.address)
      || recipientIdsMatch(recipient, owner.name);
  } catch {
    return false;
  }
}
