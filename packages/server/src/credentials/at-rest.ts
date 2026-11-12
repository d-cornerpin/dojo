// The one AES-256-GCM cipher for platform secrets at rest. Keep each in its own table (any agent reads
// agent_credentials). migration/export.ts uses a password key: its package goes where this key is not.

import crypto from 'node:crypto';
import { getCredentialMasterKey } from '../config/loader.js';
import { createLogger } from '../logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Encrypt a secret for storage. Per-call random IV; never reuse one. */
export function sealSecret(plaintext: string): SealedSecret {
  const key = getCredentialMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/** Decrypt a stored secret. Throws on a bad auth tag (a rotated master key); callers report it. */
export function openSecret(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
  const key = getCredentialMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// The sealed triple serialised into one TEXT column (no schema change); isSealedText decides the form.
// Unsealed values pass through only until the boot conversion seals them; no new code may rely on that.

const TEXT_ENVELOPE_V1 = 'dojo.v1.';

export function isSealedText(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(TEXT_ENVELOPE_V1);
}

/** Seal a value into one text field: prefix, then iv, tag and ciphertext as dot-joined base64url. */
export function sealSecretToText(plaintext: string): string {
  const { ciphertext, iv, authTag } = sealSecret(plaintext);
  return TEXT_ENVELOPE_V1 + [iv, authTag, ciphertext].map(b => b.toString('base64url')).join('.');
}

export function openSecretFromText(stored: string): string {
  if (!isSealedText(stored)) throw new Error('not a sealed value');
  const parts = stored.slice(TEXT_ENVELOPE_V1.length).split('.');
  if (parts.length !== 3) throw new Error('malformed sealed value');
  const [iv, authTag, ciphertext] = parts.map(p => Buffer.from(p, 'base64url'));
  return openSecret(ciphertext, iv, authTag);
}

// Nullable columns: NULL and '' pass through (migration/checks.ts reads '' as no token), a sealed value
// is never sealed twice, and a failed decrypt logs and reads as absent so the owner can reconnect.
const atRestLogger = createLogger('secret-at-rest');

export function sealSecretColumn(value: string | null): string | null {
  if (value === null || value === '' || isSealedText(value)) return value;
  return sealSecretToText(value);
}

/** Decode a nullable secret column; unsealed passes through. `where` is logged, never the value. */
export function openSecretColumn(value: string | null, where: string): string | null {
  if (value === null || value === '' || !isSealedText(value)) return value;
  try {
    return openSecretFromText(value);
  } catch (err) {
    atRestLogger.error('Sealed column failed to open — treating it as absent', {
      where,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

