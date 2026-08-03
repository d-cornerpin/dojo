// ════════════════════════════════════════════════════════════════════════════
// UPDATE INTEGRITY, AND THE ROLLBACK PATH'S ORDERING CHECK (PHASE-5 T6B).
//
// ── WHAT WAS UNGUARDED, RE-DERIVED AT THIS HEAD ─────────────────────────────
// The self-update downloads a zip over the network and rsyncs it, with
// `--delete`, over the RUNNING install. Nothing checked the bytes first:
// `git grep "sha256|createHash|checksum" -- update.ts watchdog-refresh.ts`
// returned nothing, and `release.sh` computed no hashes and published no
// manifest. A truncated download, a proxy's error page saved as `.zip`, or any
// corrupted transfer was extracted and applied.
//
// ⚠ AND THE INHERITED COUNT WAS WRONG, WHICH CHANGED THE WORK. The premise this
// task inherited said THREE call sites, "all `curl -L` (no `--fail`)".
// `git grep -n "curl -L" -- packages/server/src` returns exactly TWO, both in
// `gateway/routes/update.ts` (apply and rollback). The third named site,
// `services/watchdog-refresh.ts`, downloads NOTHING — it rsyncs
// `~/.dojo/platform/watchdog-dist`, which arrived INSIDE the platform zip, into
// `~/.dojo/watchdog`. Its integrity is exactly the platform artifact's
// integrity, so it needs no second check and gets a recorded reason instead of
// one. The census clause below is what keeps that true: if a third download
// ever appears, it fails here rather than shipping unverified.
//
// ── WHAT THIS BUYS, STATED EXACTLY, AND WHAT IT DOES NOT ────────────────────
// A sha256 manifest published beside its own artifact proves the bytes ARRIVED
// INTACT. It does NOT prove who made them: anyone able to replace the zip on
// the release can replace the manifest next to it. That needs a signature the
// platform can check against a key it already holds, which is a different and
// larger job. What this closes is the corrupt / truncated / wrong-content
// download reaching `rsync --delete` over a working install — which is the
// failure mode that bricks a box.
//
// ── THE TRANSITION CASE, ANSWERED DELIBERATELY ──────────────────────────────
// Every artifact published before this change — including the build running on
// the owner's own machine — has no manifest. If a missing manifest were a
// refusal, the owner could not move backward to a release he already has, and
// rolling back is a recovery path. That is a narrowing, so the non-narrowing
// behaviour is what lands: NO MANIFEST → proceed, loudly recorded as
// unverified. MANIFEST PRESENT → it must verify, or nothing is swapped.
// Whether absence should become a refusal once every published release carries
// one is the owner's, and it is in the hand-ups.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_MANIFEST_ASSET,
  sha256OfFile,
  verifyArtifactAgainstManifest,
} from '../artifact-integrity.js';
import { authorizeRollbackTarget } from '../../gateway/routes/update.js';

let tmp: string;
let zip: string;
const BODY = 'this stands in for dojo-platform.zip';
let digest: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't6b-integrity-'));
  zip = path.join(tmp, 'dojo-platform.zip');
  fs.writeFileSync(zip, BODY);
  digest = crypto.createHash('sha256').update(BODY).digest('hex');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('the bytes are checked before anything is swapped', () => {
  it('accepts an artifact whose digest matches the published manifest', async () => {
    expect(await sha256OfFile(zip)).toBe(digest);
    const v = await verifyArtifactAgainstManifest(zip, `${digest}  dojo-platform.zip\n`);
    expect(v.outcome).toBe('verified');
  });

  it('REFUSES a tampered artifact — one byte is enough', async () => {
    const tampered = path.join(tmp, 'tampered.zip');
    fs.writeFileSync(tampered, `${BODY}!`);
    const v = await verifyArtifactAgainstManifest(tampered, `${digest}  dojo-platform.zip\n`);
    expect(v.outcome).toBe('refused');
    if (v.outcome === 'refused') {
      expect(v.expected).toBe(digest);
      expect(v.actual).not.toBe(digest);
    }
  });

  it('REFUSES a published manifest it cannot read — a manifest that exists must verify', async () => {
    const v = await verifyArtifactAgainstManifest(zip, 'Not Found');
    expect(v.outcome).toBe('refused');
  });

  it('reads the digest out of the shasum line format the release script writes', async () => {
    const v = await verifyArtifactAgainstManifest(zip, `${digest.toUpperCase()} *dojo-platform.zip`);
    expect(v.outcome).toBe('verified');
  });
});

describe('the transition case: artifacts published before any manifest existed', () => {
  it('does NOT refuse when no manifest was published — that would end the rollback path', async () => {
    const v = await verifyArtifactAgainstManifest(zip, null);
    expect(v.outcome).toBe('unverified');
  });

  it('says so in a way a log reader can act on', async () => {
    const v = await verifyArtifactAgainstManifest(zip, null);
    if (v.outcome === 'unverified') expect(v.reason).toMatch(/no .*manifest/i);
  });
});

describe('a rollback goes to a version the platform can establish is an earlier one', () => {
  const CURRENT = '3.1.17-preflight.24';

  it('allows a legitimate rollback — the recovery path must keep working', () => {
    const r = authorizeRollbackTarget('v3.1.16', CURRENT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetVersion).toBe('3.1.16');
  });

  it('allows stepping back within the same prerelease train', () => {
    expect(authorizeRollbackTarget('v3.1.17-preflight.23', CURRENT).ok).toBe(true);
  });

  it('REFUSES a target that is not an earlier version', () => {
    expect(authorizeRollbackTarget('v3.1.18', CURRENT).ok).toBe(false);
    expect(authorizeRollbackTarget('v3.1.17-preflight.24', CURRENT).ok).toBe(false);
  });

  it('REFUSES a tag that is not a version at all — the shape gate', () => {
    // The tag was interpolated into the GitHub API URL unvalidated, so a
    // path-shaped tag selected a DIFFERENT artifact and it was rsynced over the
    // running install. Reaching another repository's zip through a crafted tag
    // was never a capability anyone granted.
    for (const bad of [
      '../../../other/releases/latest',
      'v3.1.16/../../evil',
      'latest',
      '',
      'v3.1.16 && curl evil',
    ]) {
      expect(authorizeRollbackTarget(bad, CURRENT).ok).toBe(false);
    }
  });

  it('names the way forward in its refusal instead of just saying no', () => {
    const r = authorizeRollbackTarget('v3.1.18', CURRENT);
    if (!r.ok) expect(r.error).toMatch(/update/i);
  });
});

describe('the check cannot be skipped by adding another download', () => {
  // A RECORDED measurement is not a HELD one. Both download sites are verified
  // today; this reads the source so a third one cannot ship unverified.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, '../..');

  function filesUnder(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        filesUnder(p, out);
      } else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('every artifact download in the server lives in ONE file, and that file verifies', () => {
    const downloaders = filesUnder(srcRoot)
      // The INVOCATION shape (`curl -L -o <file>`), not the words: this module's
      // own header quotes the grep that found them, and a census that counted
      // its own documentation would be measuring the wrong thing.
      .filter((f) => /curl\s+-L\s+-o/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcRoot, f))
      .sort();
    expect(downloaders).toEqual(['gateway/routes/update.ts']);

    const src = fs.readFileSync(path.join(srcRoot, 'gateway/routes/update.ts'), 'utf8');
    const downloads = (src.match(/curl\s+-L\s+-o/g) ?? []).length;
    const verifies = (src.match(/verifyArtifactAgainstManifest\s*\(/g) ?? []).length;
    expect(downloads).toBe(2);
    expect(verifies).toBe(downloads);
    // Calling the verifier and ignoring it is the shape this would otherwise
    // decay into, so the verdict must be ACTED ON as many times as it is asked.
    const acted = (src.match(/outcome === 'refused'/g) ?? []).length;
    expect(acted).toBe(verifies);
  });

  it('the release script publishes the manifest the verifier reads', () => {
    const release = fs.readFileSync(path.resolve(srcRoot, '../../../deploy/release.sh'), 'utf8');
    expect(release).toContain(ARTIFACT_MANIFEST_ASSET);
    expect(release).toMatch(/shasum -a 256|sha256sum/);
  });
});
