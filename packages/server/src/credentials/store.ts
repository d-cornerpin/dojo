// ════════════════════════════════════════
// Agent Credentials Store (v2.7.21)
// Encrypted storage for credentials agents need to call third-party APIs
// from inside techniques. Separate from secrets.yaml (platform-managed)
// and vault entries (knowledge that can decay).
//
// Encryption: AES-256-GCM with a master key from secrets.yaml. Per-row
// random IV + auth tag. Never decays. Never appears in vault_search,
// vault listings, or Dreamer extraction.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { sealSecret, openSecret } from './at-rest.js';
import { createLogger } from '../logger.js';

const logger = createLogger('credentials');

export interface CredentialRecord {
  id: string;
  serviceName: string;
  description: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  lastAccessedByAgentId: string | null;
  accessCount: number;
}

/** A record with the encrypted blob decrypted and parsed. */
export interface CredentialRecordWithValue extends CredentialRecord {
  /** Arbitrary JSON shape - agent decides what fields go in. */
  credentials: Record<string, unknown>;
}

// ════════════════════════════════════════
// T83 — A CREDENTIAL IS NEVER SILENTLY OVERWRITTEN.
//
// THE DATA LOSS, measured not inferred. `agent_credentials.sendgrid` was created
// 2026-06-21 03:03:03 by the primary agent from a key the owner provisioned. At 2026-09-21 06:42:22 a
// battery-minted `sk-live-…` fake replaced it. The write was NOT `credential_add`, which
// already refused a duplicate name — it was `credential_update` (messages seq 79103), and
// the whole receipt was `Credential "sendgrid" updated.`. `credential_add`'s own refusal
// text is what routed the caller there: "use credential_update to change its value".
// `openweather` went the same way on 2026-09-20 23:29:08. Neither prior value is
// recoverable: one ciphertext column, overwritten in place, no version, no audit row.
//
// THE RULE, and it is one rule for every caller so no surface can be the quiet one: a write
// that would DESTROY a stored value refuses unless the caller passes `overwrite: true`. The
// refusal names what it is protecting — created when, by whom, last changed when — and names
// the flag. The flag is not a formality; it is the caller saying on the record which specific
// existing value it is ending; every authorised destruction BY AN AGENT leaves an audit row.
//
// The callers that are not an agent — the dashboard PATCH (the owner's own hand on their own
// row), the VNC rotate (the engine turning its own private slot), the T83 remediation purge —
// pass the flag EXPLICITLY at their sites rather than being exempted here by some actor sniff.
// A rule with an exception nobody can see is how this defect got in.
//
// FIX ROUND (review IMPORTANT B-1): the rule covers `credential_delete` too. It was the quiet
// surface — no flag, no statement of what it was ending, no audit row — and a delete-then-add
// reaches the same end state as a refused overwrite while leaving LESS record than an
// authorised one. A law with one unguarded door is a speed bump.
// ════════════════════════════════════════

/**
 * t120: `unchanged` is the one bit the tool layer needs to tell the caller the truth about what
 * its write did. It means the SEALED VALUE was not written because the payload already equalled
 * what the row held — so nothing was destroyed and no audit row was cut. `descriptionChanged`
 * rides along because a no-op on the value can still carry a new note.
 */
export type CredentialWriteResult =
  | { ok: true; record: CredentialRecord; unchanged?: boolean; descriptionChanged?: boolean }
  | { ok: false; error: string };

export interface CredentialWriteOptions {
  /** Authorise destroying the value currently stored under this service name. */
  readonly overwrite?: boolean;
}

/**
 * T83 FIX ROUND (review IMPORTANT B-1) — the same authorisation for the OTHER destroy door.
 *
 * `credential_delete` was the quiet surface the first cut left standing: an agent-callable
 * tool that removed a stored value with no flag, no statement of what it was ending, no audit
 * row and a five-word receipt. A delete-then-add reaches the same end state as a refused
 * overwrite while leaving LESS record than an authorised one — which makes the overwrite rule
 * a speed bump rather than a law. It is a separate word from `overwrite` because it is a
 * separate act, and the door text prints the exact call either way.
 */
export interface CredentialDeleteOptions {
  /** Authorise permanently removing this credential. */
  readonly confirm?: boolean;
}

interface ExistingRow {
  id: string;
  created_at: string;
  updated_at: string;
  created_by_agent_id: string | null;
  description: string | null;
  encrypted_credentials: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
}

function findExisting(serviceName: string): ExistingRow | undefined {
  return getDb().prepare(
    `SELECT id, created_at, updated_at, created_by_agent_id, description,
            encrypted_credentials, iv, auth_tag
     FROM agent_credentials WHERE service_name = ?`,
  ).get(serviceName) as ExistingRow | undefined;
}

/**
 * t120 — THE OTHER HALF OF THE POINTER RULE, found by the census rather than by the triage.
 *
 * `credential_get`'s miss path has always ended with somewhere to go ("Call credential_list to
 * see what is stored, or ask the user to provide one and save it with credential_add"). The
 * WRITE doors' miss path said only `No credential found for service "x".` — a dead end on the
 * one branch whose next call is obvious and different per door: an update that finds nothing
 * wants `credential_add`, a delete that finds nothing is already done. Same defect shape as the
 * no-op receipt above, pointing the opposite way, so it closes in the same lane.
 */
function missingRefusal(serviceName: string, verb: string): string {
  const next = verb === 'credential_update'
    ? `Nothing has been stored under that name yet, so there is no value to replace. If this is a ` +
      `credential the user has just handed you, store it with ` +
      `credential_add(service_name="${serviceName}", credentials={…}) — no overwrite flag is needed ` +
      `for a name that is free. If you expected it to exist, call credential_list to see the names ` +
      `that ARE stored; the name is case-sensitive.`
    : `Nothing is stored under that name, so there is nothing to remove and no further call is ` +
      `needed. If you expected it to exist, call credential_list to see the names that ARE ` +
      `stored; the name is case-sensitive.`;
  return `No credential found for service "${serviceName}". ${next}`;
}

/**
 * The DELETE door text (T83 fix round). Same discipline as the overwrite door below, plus the
 * one sentence that only belongs here: a caller who merely wants to replace a value is
 * redirected to `credential_update`, because a delete-then-add throws away the row's
 * provenance — which is the fact every future refusal is built out of.
 */
function deleteRefusal(serviceName: string, row: ExistingRow): string {
  const by = row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : '';
  const changed = row.updated_at !== row.created_at ? `, last changed ${row.updated_at}` : '';
  return (
    `"${serviceName}" is a stored credential — created ${row.created_at}${by}${changed}. ` +
    `Deleting it is permanent: the value is gone, there is no recycle bin and no prior version. ` +
    `If the user explicitly asked you to remove this credential, call ` +
    `credential_delete(service_name="${serviceName}", confirm=true) and the deletion will be recorded. ` +
    `If you are only replacing its value, do NOT delete it — call ` +
    `credential_update(service_name="${serviceName}", credentials={…}, overwrite=true) instead, which keeps ` +
    `the row's history of who created it and when. If you are unsure, ask the user before removing anything.`
  );
}

/**
 * The OVERWRITE door text. States what exists, says the prior value cannot be recovered, and
 * names the flag — in that order, because a caller who reads only the first sentence should
 * still have learned the thing that matters.
 */
function overwriteRefusal(serviceName: string, row: ExistingRow, verb: string): string {
  const by = row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : '';
  const changed = row.updated_at !== row.created_at ? `, last changed ${row.updated_at}` : '';
  return (
    `A credential is already stored under "${serviceName}" — created ${row.created_at}${by}${changed}. ` +
    `Replacing it destroys the stored value permanently; there is no prior version and no undo. ` +
    `If the user has genuinely handed you a replacement for THIS credential, call ` +
    `${verb}(service_name="${serviceName}", credentials={…}, overwrite=true) and the overwrite will be ` +
    `recorded. If you are storing a DIFFERENT service's key, pick a service_name that is not taken — ` +
    `credential_list shows which names are in use. ` +
    // t120: the third case, and the one the two failed draws were actually in — the caller is
    // re-sending a value that is ALREADY in this slot. Naming it here costs one sentence and is
    // the only branch whose right answer is "write nothing at all".
    `If you think the value already stored here is the same one you were about to write, do NOT ` +
    `write it again: call credential_get(service_name="${serviceName}") to confirm it is there. ` +
    `If you are unsure which of these this is, ask the user before writing anything.`
  );
}

/**
 * Record an authorised DESTRUCTION — an overwrite or a deletion. NEVER carries a value.
 * `audit_log.agent_id` is NOT NULL, so the three agent-less doors — the dashboard PATCH, the
 * VNC rotate, the T83 remediation purge — get the warn line INSTEAD of a row, each being its
 * own record already. "An audit row on every destruction" is a claim about AGENTS only.
 */
function auditDestroy(
  serviceName: string, row: ExistingRow, actingAgentId: string | null, verb: string, act: 'overwrote' | 'deleted',
): void {
  const detail =
    `${verb} ${act} the credential stored under "${serviceName}" ` +
    `(created ${row.created_at}${row.created_by_agent_id ? ` by ${row.created_by_agent_id}` : ''}). ` +
    `The previous value is unrecoverable.`;
  logger.warn(act === 'deleted' ? 'Credential deleted' : 'Credential overwritten',
    { serviceName, actingAgentId, verb, createdAt: row.created_at });
  if (!actingAgentId) return;
  try {
    getDb().prepare(
      `INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
       VALUES (?, ?, 'tool_call', ?, 'success', ?, datetime('now'))`,
    ).run(uuidv4(), actingAgentId, `credential_${act === 'deleted' ? 'delete' : 'overwrite'}:${serviceName}`, detail);
  } catch (err) {
    logger.error('Failed to audit-log a credential destruction', {
      serviceName, act, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ════════════════════════════════════════
// t120 — A WRITE THAT CHANGES NOTHING SAYS SO.
//
// THE DEFECT, measured off the two failed account-setup draws rather than inferred. The
// triage's stated mechanism was `credential_add` refusing on an existing name and the model
// retrying `credential_update`. The run evidence says otherwise: in BOTH reds every credential
// write SUCCEEDED and no refusal was ever issued. What the model actually did was re-send the
// SAME payload to the SAME slot — byte-identical `credentials`, byte-identical description,
// `overwrite: true` — eight times in one attempt and thirteen in another, until the
// identical-call brake blocked calls 4, 5 and 6 and the turn tripped a SAFETY invariant.
//
// WHY it did that: the receipt. A successful re-write returned `Credential "x" updated.` —
// five words that do not say whether anything changed, do not say the credential is ready to
// use, and name no next call. So nothing in the loop ever told the model its write had landed,
// and the cheapest way to check was to write again. The N-1 messages that failed to teach here
// were SUCCESS messages, not refusals. T83's own header already recorded this receipt as the
// whole of what the caller got; it fixed the authorisation and left the text.
//
// THE PROPERTY, two halves that have to hold together:
//   1. A write whose payload equals what is already sealed in the row writes NOTHING — no
//      re-seal, no `updated_at` bump, and above all NO destruction audit row. The T83 ledger
//      exists to record that a specific stored value was ended; a no-op ended nothing, and a
//      ledger that claims three unrecoverable destructions for three writes of identical bytes
//      is lying in the one place this project cannot afford a lie.
//   2. The caller is TOLD, in the result, that the value was already there and what to call
//      next. That is the half that closes the loop.
//
// A row whose ciphertext cannot be opened (master key rotated) is treated as NOT identical, so
// the overwrite proceeds exactly as it does today: the recovery path must never be blocked by
// a comparison that cannot be made.
// ════════════════════════════════════════

/**
 * Is `credentials` byte-for-byte what this row already holds?
 *
 * Compared on the PLAINTEXT, canonically keyed — never on the ciphertext, which carries a
 * random IV per seal and so differs on every write of the same value.
 */
function storedValueEquals(row: ExistingRow, credentials: Record<string, unknown>): boolean {
  let plaintext: string;
  try {
    plaintext = openSecret(row.encrypted_credentials, row.iv, row.auth_tag);
  } catch {
    return false;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(plaintext);
  } catch {
    return false;
  }
  return canonicalJson(stored) === canonicalJson(credentials);
}

/** Stable key order, so `{a,b}` and `{b,a}` are the one value they are. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * The shared no-op branch for both write doors.
 *
 * Returns a result when the incoming payload is what the row already holds — meaning the caller
 * gets `unchanged: true` and the store performs no re-seal, no `updated_at` value bump and no
 * destruction audit. Returns `undefined` when this is a real change, and the caller proceeds
 * down the ordinary destroy-and-write path untouched.
 *
 * A no-op NEVER clears the existing note: `description` arrives as `null` from `credential_add`
 * whenever the caller simply omitted it, and a write that changed nothing has no business
 * dropping the one column that records what the slot is FOR. A deliberate clear goes through
 * `annotateCredential`, which is the door that says so.
 */
function noopWrite(
  serviceName: string,
  existing: ExistingRow,
  credentials: Record<string, unknown>,
  description: string | null | undefined,
  verb: string,
): { ok: true; record: CredentialRecord; unchanged: true; descriptionChanged: boolean } | undefined {
  if (!storedValueEquals(existing, credentials)) return undefined;
  const incomingNote = typeof description === 'string' && description.trim() !== '' ? description : null;
  const descriptionChanged = incomingNote !== null && incomingNote !== existing.description;
  if (descriptionChanged) writeDescriptionOnly(existing.id, incomingNote);
  logger.info('Credential write changed nothing', { serviceName, verb, descriptionChanged });
  return { ok: true, record: readRecord(existing.id), unchanged: true, descriptionChanged };
}

/** Replace ONLY the description column of an existing row. No re-seal, no value touched. */
function writeDescriptionOnly(id: string, description: string | null): void {
  getDb().prepare(
    `UPDATE agent_credentials SET description = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(description, id);
}

/** Replace the sealed value (and optionally the description) of a row that already exists. */
function writeValue(
  id: string,
  credentials: Record<string, unknown>,
  description: string | null | undefined,
): void {
  const { ciphertext, iv, authTag } = sealSecret(JSON.stringify(credentials));
  if (description === undefined) {
    getDb().prepare(
      `UPDATE agent_credentials
       SET encrypted_credentials = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(ciphertext, iv, authTag, id);
    return;
  }
  getDb().prepare(
    `UPDATE agent_credentials
     SET encrypted_credentials = ?, iv = ?, auth_tag = ?, description = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(ciphertext, iv, authTag, description, id);
}

// ── Crypto ──
// PHASE-5 T6C: the AES-256-GCM pair that used to live here is now
// `credentials/at-rest.ts`, shared with `twilio/auth.ts`. Same algorithm, same
// key, same wire shape — the extraction was proven value-preserving against
// every live row before it landed.

// ── CRUD ──

interface RawRow {
  id: string;
  service_name: string;
  description: string | null;
  encrypted_credentials: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  last_accessed_by_agent_id: string | null;
  access_count: number;
}

function rowToRecord(row: RawRow): CredentialRecord {
  return {
    id: row.id,
    serviceName: row.service_name,
    description: row.description,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    lastAccessedByAgentId: row.last_accessed_by_agent_id,
    accessCount: row.access_count,
  };
}

/** List all credentials WITHOUT values - safe for general UI / list endpoints. */
export function listCredentials(): CredentialRecord[] {
  const rows = getDb().prepare(
    `SELECT id, service_name, description, encrypted_credentials, iv, auth_tag,
            created_by_agent_id, created_at, updated_at,
            last_accessed_at, last_accessed_by_agent_id, access_count
     FROM agent_credentials
     ORDER BY service_name ASC`,
  ).all() as RawRow[];
  return rows.map(rowToRecord);
}

/** Get a credential record + decrypted value. Bumps last_accessed_at + access_count. */
export function getCredentialByService(
  serviceName: string,
  accessingAgentId: string | null,
): CredentialRecordWithValue | null {
  const row = getDb().prepare(
    `SELECT id, service_name, description, encrypted_credentials, iv, auth_tag,
            created_by_agent_id, created_at, updated_at,
            last_accessed_at, last_accessed_by_agent_id, access_count
     FROM agent_credentials WHERE service_name = ?`,
  ).get(serviceName) as RawRow | undefined;

  if (!row) return null;

  let plaintext: string;
  try {
    plaintext = openSecret(row.encrypted_credentials, row.iv, row.auth_tag);
  } catch (err) {
    logger.error('Failed to decrypt credential - master key likely rotated', {
      serviceName, error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Credential "${serviceName}" cannot be decrypted (master key likely rotated). Delete and re-add the credential.`);
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(plaintext);
  } catch {
    // Tolerate legacy/malformed entries by wrapping as a single 'value' field.
    credentials = { value: plaintext };
  }

  // Bump access tracking. Done in a separate UPDATE so the decrypt path
  // stays fast on hot reads.
  getDb().prepare(
    `UPDATE agent_credentials
     SET last_accessed_at = datetime('now'),
         last_accessed_by_agent_id = ?,
         access_count = access_count + 1
     WHERE id = ?`,
  ).run(accessingAgentId, row.id);

  logger.info('Credential read', { serviceName, accessingAgentId });

  return { ...rowToRecord(row), credentials };
}

/** Same as getCredentialByService but takes the row's id instead of name. Used by the dashboard "reveal" button. */
export function getCredentialById(
  id: string,
  accessingAgentId: string | null,
): CredentialRecordWithValue | null {
  const row = getDb().prepare(
    `SELECT service_name FROM agent_credentials WHERE id = ?`,
  ).get(id) as { service_name: string } | undefined;
  if (!row) return null;
  return getCredentialByService(row.service_name, accessingAgentId);
}

export function addCredential(
  serviceName: string,
  credentials: Record<string, unknown>,
  description: string | null,
  createdByAgentId: string | null,
  opts?: CredentialWriteOptions,
): CredentialWriteResult {
  const trimmedName = serviceName.trim();
  if (!trimmedName) return { ok: false, error: 'service_name is required.' };
  if (trimmedName.length > 100) return { ok: false, error: 'service_name must be 100 characters or fewer.' };

  const existing = findExisting(trimmedName);
  if (existing) {
    // T83: the refusal used to say only that the name was taken, and then hand the caller the
    // verb that overwrites without asking. It now says WHOSE value is there and how old it is,
    // and the only way past it is the flag.
    if (!opts?.overwrite) return { ok: false, error: overwriteRefusal(trimmedName, existing, 'credential_add') };
    // t120: an authorised overwrite whose payload is what is already sealed here destroys
    // nothing, so it writes nothing and records nothing. See the header above the comparison.
    const noop = noopWrite(trimmedName, existing, credentials, description, 'credential_add');
    if (noop) return noop;
    // IN PLACE, never delete-and-reinsert: `created_at` / `created_by_agent_id` are what make
    // the NEXT refusal able to name what it is protecting, and a reinsert launders exactly that.
    auditDestroy(trimmedName, existing, createdByAgentId, 'credential_add', 'overwrote');
    writeValue(existing.id, credentials, description);
    return { ok: true, record: readRecord(existing.id) };
  }

  const plaintext = JSON.stringify(credentials);
  const { ciphertext, iv, authTag } = sealSecret(plaintext);
  const id = uuidv4();

  getDb().prepare(
    `INSERT INTO agent_credentials
       (id, service_name, description, encrypted_credentials, iv, auth_tag, created_by_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, trimmedName, description, ciphertext, iv, authTag, createdByAgentId);

  logger.info('Credential added', { serviceName: trimmedName, createdByAgentId });

  return { ok: true, record: readRecord(id) };
}

export function updateCredential(
  serviceName: string,
  credentials: Record<string, unknown>,
  description: string | null | undefined,
  updatedByAgentId: string | null,
  opts?: CredentialWriteOptions,
): CredentialWriteResult {
  const row = findExisting(serviceName);
  if (!row) return { ok: false, error: missingRefusal(serviceName, 'credential_update') };

  // T83 — THIS IS THE DOOR THE DATA WENT OUT OF, so this is the door that closes. A rotate is
  // a real and common thing; what was missing is the caller saying it MEANT to end the value
  // that is there. Same rule, same door text as `addCredential` above.
  if (!opts?.overwrite) return { ok: false, error: overwriteRefusal(serviceName, row, 'credential_update') };

  // t120: the re-write loop that stormed the spin brake came through HERE, thirteen times in one
  // attempt, every call authorised and every call writing the bytes already in the row.
  const noop = noopWrite(serviceName, row, credentials, description, 'credential_update');
  if (noop) return noop;

  auditDestroy(serviceName, row, updatedByAgentId, 'credential_update', 'overwrote');
  writeValue(row.id, credentials, description);
  logger.info('Credential updated', { serviceName, updatedByAgentId });

  return { ok: true, record: readRecord(row.id) };
}

/**
 * Replace ONLY the description. No re-seal, no touch of the encrypted columns.
 *
 * Exists for the one job that must not go through `updateCredential`: telling the owner, on
 * the row itself, that the slot's value is junk and needs re-entering. The T83 remediation
 * annotates `sendgrid` and `openweather` this way rather than deleting them — a deleted row
 * takes the owner's only record of what the slot was FOR with it.
 */
export function annotateCredential(
  serviceName: string,
  description: string,
): { ok: boolean; error?: string } {
  const result = getDb().prepare(
    "UPDATE agent_credentials SET description = ?, updated_at = datetime('now') WHERE service_name = ?",
  ).run(description, serviceName);
  if (result.changes === 0) return { ok: false, error: `No credential found for service "${serviceName}".` };
  logger.info('Credential description annotated', { serviceName });
  return { ok: true };
}

function readRecord(id: string): CredentialRecord {
  return rowToRecord(getDb().prepare(
    `SELECT id, service_name, description, encrypted_credentials, iv, auth_tag,
            created_by_agent_id, created_at, updated_at,
            last_accessed_at, last_accessed_by_agent_id, access_count
     FROM agent_credentials WHERE id = ?`,
  ).get(id) as RawRow);
}

export function deleteCredentialByService(
  serviceName: string,
  deletingAgentId: string | null,
  opts?: CredentialDeleteOptions,
): { ok: boolean; error?: string } {
  const row = findExisting(serviceName);
  if (!row) return { ok: false, error: missingRefusal(serviceName, 'credential_delete') };

  // T83 FIX ROUND (review IMPORTANT B-1): THE SECOND DESTROY DOOR, closed with the same rule as
  // the first. This one took no confirmation at all, and a delete-then-add reaches the same end
  // state as a refused overwrite while leaving LESS record than an authorised one.
  if (!opts?.confirm) return { ok: false, error: deleteRefusal(serviceName, row) };

  auditDestroy(serviceName, row, deletingAgentId, 'credential_delete', 'deleted');
  getDb().prepare('DELETE FROM agent_credentials WHERE id = ?').run(row.id);
  logger.info('Credential deleted', { serviceName, deletingAgentId });
  return { ok: true };
}

export function deleteCredentialById(
  id: string,
  deletingAgentId: string | null,
  opts?: CredentialDeleteOptions,
): { ok: boolean; error?: string } {
  const row = getDb().prepare('SELECT service_name FROM agent_credentials WHERE id = ?').get(id) as { service_name: string } | undefined;
  if (!row) return { ok: false, error: `No credential found with id "${id}".` };
  return deleteCredentialByService(row.service_name, deletingAgentId, opts);
}
