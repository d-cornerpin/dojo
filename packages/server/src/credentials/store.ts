// Encrypted store for credentials agents use from techniques; separate from secrets.yaml and the vault.
// Sealed per row through at-rest.ts. Values never decay and never reach vault search or dreamer extraction.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { sealSecret, openSecret } from './at-rest.js';
// write-doors.ts owns the refusal texts and the is-this-a-change judgement; it imports nothing from here.
import {
  overwriteRefusal,
  deleteRefusal,
  missingRefusal,
  isUnchangedWrite,
  noteToApply,
  undecryptableRefusal,
} from './write-doors.js';
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

// A write that would destroy a stored value refuses unless the caller passes `overwrite: true` (a delete
// needs `confirm: true`). Non-agent callers pass the flag at their own sites; nothing is exempted here.

/**
 * `unchanged`: the payload equalled the stored value, so the sealed value was not rewritten and no audit row cut.
 * `descriptionChanged`: a no-op on the value can still carry a new note.
 */
export type CredentialWriteResult =
  | { ok: true; record: CredentialRecord; unchanged?: boolean; descriptionChanged?: boolean }
  | { ok: false; error: string };

export interface CredentialWriteOptions {
  /** Authorise destroying the value currently stored under this service name. */
  readonly overwrite?: boolean;
}

/** Delete authorisation; a separate word from `overwrite` because it is a separate act. */
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
 * Record an authorised overwrite or delete; never carries a value. audit_log.agent_id is NOT NULL,
 * so callers with no agent get only the warn line.
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

// The DB half of write-doors.ts's no-op decision: when the payload already matches the row, return a result
// without re-sealing or auditing; otherwise undefined and the ordinary write proceeds.
function noopWrite(
  serviceName: string,
  existing: ExistingRow,
  credentials: Record<string, unknown>,
  description: string | null | undefined,
  verb: string,
): { ok: true; record: CredentialRecord; unchanged: true; descriptionChanged: boolean } | undefined {
  if (!isUnchangedWrite(existing, credentials)) return undefined;
  const note = noteToApply(description, existing.description);
  if (note !== null) writeDescriptionOnly(existing.id, note);
  logger.info('Credential write changed nothing', { serviceName, verb, descriptionChanged: note !== null });
  return { ok: true, record: readRecord(existing.id), unchanged: true, descriptionChanged: note !== null };
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
    throw new Error(undecryptableRefusal(serviceName));
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

/** getCredentialByService by row id; the dashboard reveal route uses it. */
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
    if (!opts?.overwrite) return { ok: false, error: overwriteRefusal(trimmedName, existing, 'credential_add') };
    // An authorised overwrite with the same bytes destroys nothing, so it writes and records nothing.
    const noop = noopWrite(trimmedName, existing, credentials, description, 'credential_add');
    if (noop) return noop;
    // In place, never delete-and-reinsert: created_at and created_by_agent_id let the next refusal
    // name what it protects.
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

  if (!opts?.overwrite) return { ok: false, error: overwriteRefusal(serviceName, row, 'credential_update') };

  const noop = noopWrite(serviceName, row, credentials, description, 'credential_update');
  if (noop) return noop;

  auditDestroy(serviceName, row, updatedByAgentId, 'credential_update', 'overwrote');
  writeValue(row.id, credentials, description);
  logger.info('Credential updated', { serviceName, updatedByAgentId });

  return { ok: true, record: readRecord(row.id) };
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
