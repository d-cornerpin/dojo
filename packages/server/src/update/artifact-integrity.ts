// Checks the downloaded update zip against its published sha256 manifest before anything is swapped.
// The manifest proves the bytes arrived intact, not who made them. No manifest published: proceed,
// recorded as unverified (older releases have none, and rolling back to them must stay possible).
// Manifest published: it must verify or nothing is swapped. `services/watchdog-refresh.ts` downloads
// nothing: its tree arrived inside the verified zip.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('artifact-integrity');

/** The manifest asset `deploy/release.sh` publishes beside the platform zip. */
export const ARTIFACT_MANIFEST_ASSET = 'dojo-platform.zip.sha256';

export type IntegrityVerdict =
  | { outcome: 'verified'; digest: string }
  | { outcome: 'unverified'; reason: string }
  | { outcome: 'refused'; reason: string; expected: string | null; actual: string };

/** sha256 of a file, streamed (an update artifact is tens of megabytes). */
export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** The 64-hex digest out of a `shasum -a 256` line, or null when the body has none (e.g. an error page). */
function digestFromManifest(body: string): string | null {
  const m = /\b([a-fA-F0-9]{64})\b/.exec(body);
  return m ? m[1].toLowerCase() : null;
}

// A manifest is a few hundred bytes, so each attempt is bounded short and a failed attempt is retried.
const MANIFEST_FETCH_TIMEOUT_MS = 20_000;
const MANIFEST_FETCH_ATTEMPTS = 3;
const MANIFEST_RETRY_BACKOFF_MS = 2_000;

/** The published manifest: `null` if none was published, `''` if one was but could not be read (refused). */
export async function fetchArtifactManifest(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  // A transient failure is retried so a network blip never refuses a good release; `''` (refuse) is
  // returned only when every attempt fails or the status is not OK.
  let lastWhy = '';
  for (let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) });
      // A non-OK status is final (the manifest is not there), so it returns without retrying.
      if (!res.ok) {
        logger.warn('release manifest fetch returned a non-OK status — the release will be refused', {
          url, status: res.status, attempt,
        });
        return '';
      }
      return await res.text();
    } catch (err) {
      lastWhy = err instanceof Error ? err.message : String(err);
      if (attempt < MANIFEST_FETCH_ATTEMPTS) {
        await new Promise((r) => { const t = setTimeout(r, MANIFEST_RETRY_BACKOFF_MS * attempt); t.unref?.(); });
      }
    }
  }
  logger.error('release manifest UNREACHABLE after retries — refusing the release on absence of proof, NOT on a byte mismatch', {
    url, attempts: MANIFEST_FETCH_ATTEMPTS, lastError: lastWhy,
  });
  return '';
}

/** The verdict. Pure apart from reading the artifact off disk. */
export async function verifyArtifactAgainstManifest(
  artifactPath: string,
  manifestBody: string | null,
): Promise<IntegrityVerdict> {
  if (manifestBody === null) {
    const reason = `no ${ARTIFACT_MANIFEST_ASSET} manifest published for this release — bytes not verified`;
    logger.warn('Update artifact is UNVERIFIED', { artifactPath, reason });
    return { outcome: 'unverified', reason };
  }
  const expected = digestFromManifest(manifestBody);
  const actual = await sha256OfFile(artifactPath);
  if (!expected) {
    logger.error('Update artifact REFUSED: published manifest is unreadable', { artifactPath });
    return {
      outcome: 'refused',
      reason: `the release publishes ${ARTIFACT_MANIFEST_ASSET} but it could not be read — refusing to apply an artifact that cannot be confirmed`,
      expected: null,
      actual,
    };
  }
  if (expected !== actual) {
    logger.error('Update artifact REFUSED: digest mismatch', { artifactPath, expected, actual });
    return {
      outcome: 'refused',
      reason: `downloaded artifact does not match the published sha256 (expected ${expected}, got ${actual}) — nothing was installed`,
      expected,
      actual,
    };
  }
  logger.info('Update artifact verified against its published sha256', { artifactPath, digest: actual });
  return { outcome: 'verified', digest: actual };
}
