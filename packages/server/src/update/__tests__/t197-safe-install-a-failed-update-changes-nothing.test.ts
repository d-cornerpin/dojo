// ════════════════════════════════════════════════════════════════════════════════════════
// t197 (v3.4 F2) — THE REAL `applyUpdate`, A DEPENDENCY INSTALL THAT FAILS, AND THE LIVE TREE.
//
// The behavioural RED for the defect, through the product's own door rather than a copy of
// it. The release's dependencies cannot be installed (the real `npm`, offline, refusing an
// engine requirement nobody meets — the same shape as a registry outage or a full disk, minus
// the network). At e63aa3d7 that failure arrived AFTER the new files had already been rsynced
// over `~/.dojo/platform`, so the box was left as new code over the old dependencies: neither
// the version the owner had nor the one he asked for. After the fix the failure happens in a
// staged tree beside the live one, and the live tree is byte-for-byte what it was.
//
// Only the edges a unit run cannot own are stood in for: GitHub's release metadata (`fetch`)
// and the download (`curl`, which copies a zip built here). Everything else is real.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTree, treeHash } from './t197-safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');
const work = path.join(home, 't197-apply');
const savedPath = process.env.PATH;

function cleanDojo(): void {
  for (const n of fs.existsSync(dojo) ? fs.readdirSync(dojo) : []) {
    if (n === 'platform' || n.startsWith('platform.') || n.startsWith('update-state') || n === 'rollback.lock') {
      fs.rmSync(path.join(dojo, n), { recursive: true, force: true });
    }
  }
}

beforeEach(() => {
  cleanDojo();
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  makeTree(platform, '3.3.3', { native: true });

  // The release: a whole platform tree whose dependencies cannot be installed.
  const rel = makeTree(path.join(work, 'zipsrc', 'dojo-platform', 'platform'), '3.4.0');
  fs.writeFileSync(path.join(rel, 'package.json'),
    JSON.stringify({ name: 'dojo-platform', version: '3.4.0', engines: { node: '<1' } }));
  fs.writeFileSync(path.join(rel, '.npmrc'), 'engine-strict=true\n');
  execFileSync('zip', ['-qr', path.join(work, 'release.zip'), 'dojo-platform'], { cwd: path.join(work, 'zipsrc') });

  // `curl -o <dest> <url>` stand-in: copies the zip built above.
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${path.join(work, 'release.zip')}" "$2"; shift; fi; shift; done\n`,
    { mode: 0o755 });
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  process.env.npm_config_offline = 'true';
  process.env.npm_config_update_notifier = 'false';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: 'v3.4.0', name: 'v3.4.0', published_at: '2026-10-17T00:00:00Z', body: '',
    assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/dojo-platform.zip', size: 1000 }],
  }), { status: 200 })));
});

afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.npm_config_offline;
  delete process.env.npm_config_update_notifier;
  vi.unstubAllGlobals();
  cleanDojo();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('an update whose dependencies cannot be installed changes nothing', () => {
  it('the live tree is byte-for-byte the tree it was, and the owner is told so', async () => {
    const before = treeHash(platform);
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    const r = await applyUpdate('stable');

    expect(r.ok, r.message).toBe(false);
    expect(treeHash(platform), 'the live tree must be exactly what it was — not new code over old dependencies')
      .toBe(before);
    expect(r.message).toMatch(/Nothing was changed/);
    expect(r.message).toContain('3.3.3');
    // Nothing half-prepared is left lying around to fill the disk.
    expect(fs.readdirSync(dojo).filter((n) => n.startsWith('platform.staging-'))).toEqual([]);
  }, 120_000);
});
