// ════════════════════════════════════════════════════════════════════════════
// SECRET-AT-REST ENCRYPTION — ONE OWNER (PHASE-5 T6C)
//
// THE REQUIREMENT: a platform secret written to the database is written as
// ciphertext, by ONE implementation, so that "how the dojo encrypts a secret at
// rest" is a single fact with a single place to read it and a single place to
// change it.
//
// WHAT THIS REPLACED: two byte-identical AES-256-GCM implementations —
// `credentials/store.ts` and `twilio/auth.ts` each carried its own `encrypt` /
// `decrypt` pair, the same algorithm, the same 96-bit IV, the same key source,
// differing only in a comment. The second copy's own header said "same shape as
// credentials/store.ts", which is a duplicate mechanism admitting to being one.
// Both call sites are now readers of this module and neither holds crypto.
//
// WHAT THIS IS NOT, and the distinction is load-bearing:
//
//   * It is NOT the agent-reachable credential store. `agent_credentials` is
//     reachable by every agent through `credential_list` / `credential_get`
//     (`agent/tools/surface.ts` pushes those definitions onto every agent's
//     surface unconditionally, and no gate row names them). A PLATFORM secret
//     encrypted through this module belongs in its own table, the way
//     `twilio_config` does — putting it in `agent_credentials` would hand it to
//     every agent by name. `credentials/__tests__/secret-at-rest.test.ts` holds
//     that boundary as a census over the source.
//
//   * It is NOT the migration package's encryption. `migration/export.ts` uses
//     AES-256-CBC with a key derived from the USER'S password (PBKDF2) because
//     that package travels to another machine, where this key does not exist.
//     Different key, different threat, different owner — deliberately not
//     folded in here, and the census clause records that as a decision rather
//     than an oversight.
//
// THE KEY: `credential_master_key` from `~/.dojo/secrets.yaml`, which cannot
// itself move into any store this module encrypts — it is the key that store
// is encrypted WITH. Rotating it makes every value written through this module
// undecryptable, which is why callers treat a decrypt failure as "re-enter the
// secret", never as data loss to paper over.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { getCredentialMasterKey } from '../config/loader.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM

/** The three columns a secret-at-rest value occupies: ciphertext, IV, auth tag. */
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

/**
 * Decrypt a stored secret. Throws when the auth tag does not verify — which is
 * what a rotated master key looks like, and the callers say so in their own
 * words rather than swallowing it.
 */
export function openSecret(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
  const key = getCredentialMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
