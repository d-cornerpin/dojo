// The uninstaller saved only dojo.db, secrets.yaml, prompts/ and techniques/ and then deleted all of
// ~/.dojo, so uploads/ (and the rest of data/, memory files, custom voice imports, loose technique
// scripts) were lost. Now every user-data folder is copied into the dojo-backup-* folder first, and
// if any of it cannot be copied nothing is removed. Only the "# Backup data" block of the real
// deploy/uninstall.sh is run, in a scratch HOME (the whole script removes /Applications/DOJO.app).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNINSTALL_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/uninstall.sh');
let scratch = '';
let dojo = '';

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'uninstall-data-'));
  dojo = path.join(scratch, '.dojo');
  const put = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(dojo, rel)), { recursive: true });
    fs.writeFileSync(path.join(dojo, rel), body);
  };
  put('secrets.yaml', 'jwt_secret: x\n');
  put('uploads/a/photo.png', 'png');
  put('data/notes.json', '{}');
  put('memory/m.md', 'memory');
  put('voice/custom/mine.wav', 'wav');
  put('voice/models/big.bin', 'weights');
  put('tools/build_deck.py', 'print(1)');
  put('tools/doc.md', 'regenerated');
  put('platform/package.json', '{}');
  put('platform.backup-3.1.17/package.json', '{}');
  put('watchdog/index.js', '//');
  put('logs/x.log', 'log');
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function runBlock(extraPath = ''): { status: number | null; out: string; backup: string | null } {
  const script = fs.readFileSync(UNINSTALL_SH, 'utf-8');
  const from = script.indexOf('# Backup data');
  const to = script.indexOf('# Remove launchd plists');
  const cut = `DOJO_DIR="$HOME/.dojo"\n${script.slice(from, to)}\necho BLOCK_PASSED`;
  const r = spawnSync('/bin/bash', ['-c', cut], {
    env: { PATH: `${extraPath}${extraPath ? ':' : ''}/usr/bin:/bin`, HOME: scratch }, encoding: 'utf-8', timeout: 20_000,
  });
  const dirs = fs.readdirSync(scratch).filter((n) => n.startsWith('dojo-backup-'));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, backup: dirs[0] ? path.join(scratch, dirs[0]) : null };
}

describe('the uninstaller keeps the person\'s uploads and other data', () => {
  it('copies uploads, other data files, memory files, custom voices and loose technique scripts', () => {
    const { status, out, backup } = runBlock();
    expect(status).toBe(0);
    expect(out).toContain('BLOCK_PASSED');
    expect(backup).not.toBeNull();
    const has = (rel: string): boolean => fs.existsSync(path.join(backup!, rel));
    expect(has('uploads/a/photo.png')).toBe(true);
    expect(has('data/notes.json')).toBe(true);
    expect(has('memory/m.md')).toBe(true);
    expect(has('voice/custom/mine.wav')).toBe(true);
    expect(has('tools/build_deck.py')).toBe(true);
    expect(has('secrets.yaml')).toBe(true);
  });

  it('does not copy app code, update backups, logs, re-downloadable models or regenerated docs', () => {
    const { backup } = runBlock();
    const has = (rel: string): boolean => fs.existsSync(path.join(backup!, rel));
    expect(has('platform')).toBe(false);
    expect(has('platform.backup-3.1.17')).toBe(false);
    expect(has('watchdog')).toBe(false);
    expect(has('logs')).toBe(false);
    expect(has('voice/models')).toBe(false);
    expect(has('tools/doc.md')).toBe(false);
  });

  it('refuses to remove anything, and says which folder, when the uploads cannot be copied', () => {
    const bin = path.join(scratch, 'shim');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'cp'),
      '#!/bin/bash\nfor a in "$@"; do case "$a" in */uploads) exit 1;; esac; done\nexec /bin/cp "$@"\n', { mode: 0o755 });
    const { status, out } = runBlock(bin);
    expect(status).toBe(1);
    expect(out).toContain('uploads');
    expect(out).toContain('nothing was removed');
    expect(out).not.toContain('BLOCK_PASSED');
  });
});
