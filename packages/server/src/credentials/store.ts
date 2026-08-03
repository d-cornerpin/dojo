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
): { ok: true; record: CredentialRecord } | { ok: false; error: string } {
  const trimmedName = serviceName.trim();
  if (!trimmedName) return { ok: false, error: 'service_name is required.' };
  if (trimmedName.length > 100) return { ok: false, error: 'service_name must be 100 characters or fewer.' };

  const existing = getDb().prepare('SELECT id FROM agent_credentials WHERE service_name = ?').get(trimmedName);
  if (existing) {
    return { ok: false, error: `A credential for "${trimmedName}" already exists. Use credential_update to change its value, or credential_delete to remove it first.` };
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

  const row = getDb().prepare(
    `SELECT id, service_name, description, encrypted_credentials, iv, auth_tag,
            created_by_agent_id, created_at, updated_at,
            last_accessed_at, last_accessed_by_agent_id, access_count
     FROM agent_credentials WHERE id = ?`,
  ).get(id) as RawRow;
  return { ok: true, record: rowToRecord(row) };
}

export function updateCredential(
  serviceName: string,
  credentials: Record<string, unknown>,
  description: string | null | undefined,
  updatedByAgentId: string | null,
): { ok: true; record: CredentialRecord } | { ok: false; error: string } {
  const row = getDb().prepare(
    'SELECT id FROM agent_credentials WHERE service_name = ?',
  ).get(serviceName) as { id: string } | undefined;
  if (!row) return { ok: false, error: `No credential found for service "${serviceName}".` };

  const plaintext = JSON.stringify(credentials);
  const { ciphertext, iv, authTag } = sealSecret(plaintext);

  if (description === undefined) {
    getDb().prepare(
      `UPDATE agent_credentials
       SET encrypted_credentials = ?, iv = ?, auth_tag = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(ciphertext, iv, authTag, row.id);
  } else {
    getDb().prepare(
      `UPDATE agent_credentials
       SET encrypted_credentials = ?, iv = ?, auth_tag = ?, description = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(ciphertext, iv, authTag, description, row.id);
  }

  logger.info('Credential updated', { serviceName, updatedByAgentId });

  const updated = getDb().prepare(
    `SELECT id, service_name, description, encrypted_credentials, iv, auth_tag,
            created_by_agent_id, created_at, updated_at,
            last_accessed_at, last_accessed_by_agent_id, access_count
     FROM agent_credentials WHERE id = ?`,
  ).get(row.id) as RawRow;
  return { ok: true, record: rowToRecord(updated) };
}

export function deleteCredentialByService(
  serviceName: string,
  deletingAgentId: string | null,
): { ok: boolean; error?: string } {
  const result = getDb().prepare('DELETE FROM agent_credentials WHERE service_name = ?').run(serviceName);
  if (result.changes === 0) {
    return { ok: false, error: `No credential found for service "${serviceName}".` };
  }
  logger.info('Credential deleted', { serviceName, deletingAgentId });
  return { ok: true };
}

export function deleteCredentialById(
  id: string,
  deletingAgentId: string | null,
): { ok: boolean; error?: string } {
  const row = getDb().prepare('SELECT service_name FROM agent_credentials WHERE id = ?').get(id) as { service_name: string } | undefined;
  if (!row) return { ok: false, error: `No credential found with id "${id}".` };
  return deleteCredentialByService(row.service_name, deletingAgentId);
}
