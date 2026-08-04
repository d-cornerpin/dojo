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
import { createLogger } from '../logger.js';

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

// ════════════════════════════════════════════════════════════════════════════
// THE SINGLE-COLUMN ENVELOPE (PHASE-5 T10 / decision D1)
//
// WHY IT LIVES HERE AND NOT BESIDE ITS CALLERS. `twilio_config` was designed for
// encryption and got three columns for it (ciphertext / iv / tag). The OAuth
// token columns were not: `google_accounts.access_token` and its three siblings
// are ONE nullable TEXT column each, declared by migration 071, and they are read
// by a predicate (`migration/checks.ts`) and copied by the export package as
// opaque text. Widening them to three columns apiece would have been six new
// columns across two tables plus every reader taught the new shape — a schema
// change to hold a storage detail.
//
// So the sealed triple is serialised INTO the existing column. That is a second
// SHAPE for the same cipher, never a second cipher: `sealSecretToText` calls
// `sealSecret`, `openSecretFromText` calls `openSecret`, and there is still
// exactly one AES-256-GCM implementation in this tree — the census clause in
// `__tests__/secret-at-rest.test.ts` holds that, and it holds it over this file
// too.
//
// THE PREFIX IS LOAD-BEARING, AND IT IS WHY A PLAINTEXT VALUE IS NOT AN ERROR.
// A column that has always held plaintext cannot become ciphertext everywhere at
// once: the conversion runs at boot, a database imported from another machine
// arrives with whatever form that machine wrote, and the Stable Bridge carries
// boxes across the change. `isSealedText` is therefore the authority on which
// form a value is in, and the readers below pass an UNSEALED value through
// unchanged instead of throwing — an old value is a value to convert, not a
// value to lose. The conversion pass is what makes the passthrough temporary;
// nothing else may rely on it.
// ════════════════════════════════════════════════════════════════════════════

/** Version tag + field separator. A stored value starting with this is sealed. */
const TEXT_ENVELOPE_V1 = 'dojo.v1.';

/** True when `stored` carries the v1 envelope — i.e. it is ciphertext, not plaintext. */
export function isSealedText(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(TEXT_ENVELOPE_V1);
}

/** Seal a value into ONE text field: `dojo.v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function sealSecretToText(plaintext: string): string {
  const { ciphertext, iv, authTag } = sealSecret(plaintext);
  return TEXT_ENVELOPE_V1 + [iv, authTag, ciphertext].map(b => b.toString('base64url')).join('.');
}

/**
 * Open a value sealed by `sealSecretToText`. Throws on a malformed envelope or a
 * failed auth tag — a caller that would rather degrade than crash catches it and
 * says so in its own words, the way `twilio/auth.ts` already does.
 */
export function openSecretFromText(stored: string): string {
  if (!isSealedText(stored)) throw new Error('not a sealed value');
  const parts = stored.slice(TEXT_ENVELOPE_V1.length).split('.');
  if (parts.length !== 3) throw new Error('malformed sealed value');
  const [iv, authTag, ciphertext] = parts.map(p => Buffer.from(p, 'base64url'));
  return openSecret(ciphertext, iv, authTag);
}

// ── The nullable-column pair: ONE owner for how a secret TEXT column round-trips ──
//
// Both providers' account tables store their two tokens the same way, so the
// rules live once rather than twice. Each rule below is a behaviour that was
// measured on the live shape, not a preference:
//
//   * NULL stays NULL. "No token" is a distinct state from "a token"; the
//     reconnect-card query and every `if (!acc.refreshToken)` branch read it.
//   * EMPTY STRING stays EMPTY. `migration/checks.ts` enumerates reconnect cards
//     with `refresh_token IS NOT NULL AND refresh_token != ''`. Sealing '' would
//     produce a non-empty envelope and make a card appear for an account that has
//     no token — a visible change to what the owner SEES, from a storage detail.
//   * AN ALREADY-SEALED VALUE IS NOT SEALED AGAIN. The conversion pass and any
//     read-modify-write path would otherwise nest envelopes, and the second seal
//     is unrecoverable without knowing how many there were.
//   * A DECRYPT FAILURE DEGRADES, IT DOES NOT CRASH. A rotated master key makes
//     every sealed value unreadable; the platform's existing answer to that is
//     `twilio/auth.ts` — log it and behave as "not configured", so the owner is
//     asked to reconnect instead of watching the process die on boot.

const atRestLogger = createLogger('secret-at-rest');

/** Encode a nullable secret column for storage. Null/empty/already-sealed pass through. */
export function sealSecretColumn(value: string | null): string | null {
  if (value === null || value === '' || isSealedText(value)) return value;
  return sealSecretToText(value);
}

/**
 * Decode a nullable secret column. An unsealed value passes through — a column
 * that has not been converted yet holds a real, usable secret. `where` names the
 * call site in the log line; NO VALUE IS EVER LOGGED.
 */
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

