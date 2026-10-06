// ════════════════════════════════════════════════════════════════════════════
// ARTIFACT INTEGRITY — the bytes are checked before anything is swapped.
// PHASE-5 T6B (plan Task T6 Step 2).
//
// ── WHAT WAS UNGUARDED ──────────────────────────────────────────────────────
// The self-update downloads a zip and rsyncs it, with `--delete`, over the
// RUNNING install. Nothing looked at the bytes first: at the task's start
// `git grep "sha256\|createHash\|checksum" -- gateway/routes/update.ts
// services/watchdog-refresh.ts` returned nothing, and `deploy/release.sh`
// computed no hashes and published no manifest. A truncated transfer, a proxy's
// error page saved as `.zip`, or any corrupted download went straight into the
// install directory.
//
// ── WHAT THIS BUYS, EXACTLY, AND WHAT IT DOES NOT ───────────────────────────
// A sha256 manifest published beside its own artifact proves the bytes ARRIVED
// INTACT. It is NOT proof of who made them — whoever can replace the zip on a
// release can replace the manifest next to it. Real provenance needs a
// signature checked against a key the platform already holds, which is a
// different and larger job than this one. What this closes is the corrupt,
// truncated or wrong-content download reaching `rsync --delete` over a working
// install, which is the failure mode that bricks a box.
//
// ── THE TRANSITION CASE, DECIDED RATHER THAN DISCOVERED IN PRODUCTION ───────
// Every artifact published before this change — including the build running on
// the owner's own machine — carries no manifest. Refusing a manifest-less
// artifact would leave him unable to move backward to a release he already has,
// and rolling back is a recovery path, so that refusal would be a NARROWING and
// therefore his decision, not a worker's. So:
//
//     no manifest published  → PROCEED, recorded loudly as unverified
//     manifest published     → it must verify, or NOTHING is swapped
//
// Whether absence should itself become a refusal once every published release
// carries a manifest is on the record as an owner question.
//
// ── THE THIRD "CALL SITE" THAT ISN'T ONE ────────────────────────────────────
// The inherited premise named three verify-free download sites. Re-derived by
// command, `git grep -n "curl -L" -- packages/server/src` returns exactly TWO,
// both in `gateway/routes/update.ts`. (t114: those two are now ONE command builder,
// `curlDownloadCmd`, invoked at the same two sites — the census clause counts the invocations,
// and strips comments so this very paragraph is not mistaken for a third downloader.) The third, `services/watchdog-refresh.ts`,
// downloads nothing: it rsyncs `~/.dojo/platform/watchdog-dist`, which arrived
// INSIDE the platform zip this module just verified, into `~/.dojo/watchdog`.
// Its integrity IS the platform artifact's integrity, so a second check there
// would be verifying bytes we wrote ourselves. That is a measured reason, not a
// skipped step, and the census clause in `__tests__/artifact-integrity.test.ts`
// fails if a third downloader ever appears.
// ════════════════════════════════════════════════════════════════════════════

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

/** sha256 of a file, streamed — an update artifact is tens of megabytes. */
export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The digest out of a `shasum -a 256` line: `<64 hex>  <filename>` (or ` *name`
 * in binary mode, or an upper-case digest from some tools). Returns null when
 * the body carries no digest at all — an HTML error page, an empty body, a
 * truncated fetch.
 */
function digestFromManifest(body: string): string | null {
  const m = /\b([a-fA-F0-9]{64})\b/.exec(body);
  return m ? m[1].toLowerCase() : null;
}

// t114 (census U20): the per-attempt bound stays short because a manifest is a few hundred
// bytes; what was missing was any tolerance for an attempt FAILING.
const MANIFEST_FETCH_TIMEOUT_MS = 20_000;
const MANIFEST_FETCH_ATTEMPTS = 3;
const MANIFEST_RETRY_BACKOFF_MS = 2_000;

/**
 * Fetch the published manifest. `null` means NO MANIFEST WAS PUBLISHED (the
 * transition case). An empty string means one was published and could not be
 * read, which the verdict below treats as a refusal — a manifest that exists
 * and cannot be confirmed against is not a manifest that can be waved through.
 */
export async function fetchArtifactManifest(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  // ── t114 (census U20) — A NETWORK BLIP MUST NOT BE THE REASON A GOOD RELEASE IS REFUSED ──
  //
  // One flat 20s whose catch returned `''`, which the verdict below reads as "published and
  // unreadable" -> refused. So ordinary latency rejected a good release on the path whose job is
  // to protect an update. The POSTURE IS UNCHANGED — `''` still refuses, because a manifest that
  // cannot be confirmed must never be waved through; what changed is that one transient failure
  // no longer produces it. A manifest is a few hundred bytes: if it is reachable it arrives at
  // once, so one timeout reads as a hiccup, not as a bad release. The full argument and the
  // controls that pin the posture are in `__tests__/a-big-download-is-not-cut-mid-body.test.ts`.
  let lastWhy = '';
  for (let attempt = 1; attempt <= MANIFEST_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) });
      // A real HTTP answer is a real answer: 404 and friends mean the manifest is not there to be
      // read and retrying cannot change that, so it returns immediately as it always did.
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

/**
 * THE VERDICT. Pure apart from reading the artifact off disk, so the refusal is
 * proven against real files rather than against a mock.
 */
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
