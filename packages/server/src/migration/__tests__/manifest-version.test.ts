// ════════════════════════════════════════════════════════════════════════════
// THE EXPORT MANIFEST TELLS THE TRUTH ABOUT WHICH BUILD MADE IT.
// SWEEP CORE-2 item 6, rider (ii): `config.platform_version` had three readers
// and NO writer.
//
// ── THE MEASUREMENT, BEFORE THE FIX ─────────────────────────────────────────
// `grep -rn platform_version --include='*.ts' --include='*.tsx'` at `9d982a8`,
// excluding dist, returns three non-comment sites and they are not three
// readers:
//
//   packages/server/src/migration/manifest.ts:72   the ONE actual DB read
//   packages/server/src/migration/manifest.ts:15   the field on ExportManifest
//   packages/dashboard/src/components/PostMigrationBanner.tsx:13  the dashboard mirror
//
// Nothing in the tree has EVER written `config.platform_version` — that is the
// residue `release/release-steps.ts` recorded and refused to disturb. So
// `getPlatformVersion()` fell through to its `'1.0.0'` default on every box, and
// EVERY export manifest ever produced claims it was made by platform 1.0.0. The
// import side reads the field back and does nothing with it, so the lie has cost
// nothing yet — it would cost exactly when somebody is diagnosing a bad import
// and asks which build produced the file.
//
// ── THE DISPOSITION, DECIDED BY WHAT THE READER NEEDS ───────────────────────
// The reader needs "the version of the platform that produced this export".
// The tree already has ONE authority for that — `getCurrentVersion()`, read off
// the installed platform's package.json and used by the update path, the boot
// sentinel and `release-steps.ts`. So: RETIRE THE READER, do not wire a writer.
// Wiring one would mint a SECOND version authority that can disagree with the
// first, and add a write to the boot spine for a value already derivable. The
// config key is left exactly as unwritten as it was found — and now has zero
// readers as well, which is a fact this suite pins.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(abs, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(abs);
  }
  return out;
}

describe('export manifest platform_version (rider ii)', () => {
  it('the config key has NO reader left anywhere — it is unwritten AND unread', () => {
    const roots = ['packages/server/src', 'packages/dashboard/src'].map(r => path.join(REPO_ROOT, r));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const abs of sourceFiles(root)) {
        const rel = path.relative(REPO_ROOT, abs);
        if (rel.includes('__tests__')) continue;
        const src = fs.readFileSync(abs, 'utf-8');
        src.split('\n').forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
          // A DB read of the key — the thing that was returning a default for ever.
          if (/key\s*=\s*'platform_version'|key\s*=\s*"platform_version"|\bplatform_version\b.*\bconfig\b/.test(code)) {
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders, 'config.platform_version has no writer; a reader of it can only ever report a default').toEqual([]);
  });

  it('the manifest\'s version comes from the tree\'s ONE version authority', async () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/migration/manifest.ts'), 'utf-8');
    expect(src).toMatch(/getCurrentVersion/);
    const { generateManifest } = await import('../manifest.js');
    const { getCurrentVersion } = await import('../../gateway/routes/update.js');
    const m = generateManifest(1234, [], [], 0);
    expect(m.platform_version).toBe(getCurrentVersion());
    // And it is not the old lie.
    expect(m.platform_version).not.toBe('1.0.0');
    expect(m.platform_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('the field survives on the shipped manifest shape (both sides), because removing it would narrow a published format', () => {
    for (const rel of [
      'packages/server/src/migration/manifest.ts',
      'packages/dashboard/src/components/PostMigrationBanner.tsx',
    ]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(src, `${rel} must keep declaring platform_version on ExportManifest`).toMatch(/platform_version\s*:\s*string/);
    }
  });
});
