// v3.5 A2, REVIEW FOCUS — THE UNINSTALLER MUST NOT DELETE ~/.dojo WHEN ITS BACKUP FAILED. The
// uninstaller copies `dojo.db`, `secrets.yaml`, `prompts` and `techniques` with `|| true` and then
// `rm -rf "$DOJO_DIR"` no matter what, so a failed database copy (disk full, permissions) still
// deletes the person's agents and conversations. It also copies only `dojo.db`, not `dojo.db-wal`,
// so in WAL mode the newest writes are lost. Only the "# Backup data" block of the real
// `deploy/uninstall.sh` is run here (the text between "# Backup data" and "# Remove launchd
// plists", cut out of the file as shipped), prefixed with DOJO_DIR. The whole script must never
// run in a test: it removes /Applications/DOJO.app and ~/.dojo, and these tests only ever touch a
// scratch HOME.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const UNINSTALL_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/uninstall.sh');
let scratch = '';
let dojo = '';

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'uninstall-sh-'));
  dojo = path.join(scratch, '.dojo');
});
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function backupDirs(): string[] {
  return fs.readdirSync(scratch)
    .filter((name) => name.startsWith('dojo-backup-'))
    .map((name) => path.join(scratch, name));
}

function runBackupBlock(env: Record<string, string>): { status: number | null; out: string } {
  const script = fs.readFileSync(UNINSTALL_SH, 'utf-8');
  const from = script.indexOf('# Backup data');
  const to = script.indexOf('# Remove launchd plists');
  if (from < 0 || to <= from) throw new Error('uninstall.sh no longer has its backup block where this test cuts it');
  const cut = `DOJO_DIR="$HOME/.dojo"\nLAUNCH_DIR="$HOME/Library/LaunchAgents"\n${script.slice(from, to)}\necho BLOCK_PASSED`;
  const r = spawnSync('/bin/bash', ['-c', cut], {
    env: { ...env, HOME: scratch },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function failingShims(): { bin: string } {
  const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
  const shim = (name: string): void => {
    fs.writeFileSync(path.join(bin, name), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  };
  shim('cp');
  shim('sqlite3');
  return { bin };
}

function writeSecrets(): void {
  fs.mkdirSync(dojo, { recursive: true });
  fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'jwt_secret: x\n');
}

function openWalDb(rows: number): Database.Database {
  fs.mkdirSync(path.join(dojo, 'data'), { recursive: true });
  const db = new Database(path.join(dojo, 'data', 'dojo.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('create table t(a)');
  for (let i = 1; i <= rows; i++) db.prepare('insert into t values (?)').run(i);
  return db;
}

describe('the uninstaller keeps data unless it is backed up', () => {
  it('a healthy box backs up a WAL database, rows in the -wal included, and its secrets', () => {
    const db = openWalDb(3); // kept open through the run: the rows sit uncheckpointed in dojo.db-wal
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: process.env.PATH });
    db.close();
    expect(out).toContain('BLOCK_PASSED');
    expect(status).toBe(0);
    const dirs = backupDirs();
    expect(dirs).toHaveLength(1);
    const backup = dirs[0];
    const checkDir = fs.mkdtempSync(path.join(scratch, 'check-'));
    const copied = path.join(checkDir, 'dojo.db');
    fs.copyFileSync(path.join(backup, 'dojo.db'), copied);
    const ro = new Database(copied, { readonly: true });
    const row = ro.prepare('select count(*) from t').get() as { 'count(*)': number };
    ro.close();
    expect(row['count(*)']).toBe(3);
    expect(fs.existsSync(path.join(backup, 'secrets.yaml'))).toBe(true);
  });

  it('refuses to remove anything when the database copy fails', () => {
    const { bin } = failingShims();
    fs.mkdirSync(path.join(dojo, 'data'), { recursive: true });
    const db = new Database(path.join(dojo, 'data', 'dojo.db'));
    db.exec('create table t(a)');
    db.close();
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).toContain('could not be copied');
    expect(out).toContain('nothing was removed');
    expect(out).not.toContain('BLOCK_PASSED');
  });

  it('a box that never had a database is still uninstallable when its secrets copy succeeds', () => {
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: process.env.PATH });
    expect(out).toContain('BLOCK_PASSED');
    expect(status).toBe(0);
    const dirs = backupDirs();
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(path.join(dirs[0], 'secrets.yaml'))).toBe(true);
  });

  it('refuses to remove anything when the secrets copy fails', () => {
    const { bin } = failingShims();
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).toContain('nothing was removed');
    expect(out).toContain('secrets.yaml');
  });

  // Review FIX 1: a copy that is CUT SHORT (disk full) leaves a non-empty, broken file; every copy's
  // exit status counts, and the saved database must pass a check.
  it('refuses when the database copy writes half the file and then fails (disk full)', () => {
    const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
    fs.writeFileSync(path.join(bin, 'sqlite3'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'cp'),
      '#!/bin/bash\nfor last; do :; done\nsrc="${@: -2:1}"\n' +
      'case "$src" in */dojo.db) head -c 100 "$src" > "$last/dojo.db"; exit 1;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 });
    const db = openWalDb(50); db.close();
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).toContain('nothing was removed');
    expect(out).not.toContain('BLOCK_PASSED');
  });

  it('refuses when a saved database fails the integrity check, even though the copy exited 0', () => {
    const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
    // sqlite3: the backup command "succeeds" but writes a torn file; quick_check then reports damage.
    fs.writeFileSync(path.join(bin, 'sqlite3'),
      '#!/bin/bash\ncase "$*" in *quick_check*) echo "database disk image is malformed";; *) f="$(printf %s "$2" | sed "s/.*\'\\(.*\\)\'/\\1/")"; head -c 50 "$1" > "$f";; esac\nexit 0\n', { mode: 0o755 });
    const db = openWalDb(50); db.close();
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).toContain('nothing was removed');
  });

  it('refuses when the prompts folder cannot be copied', () => {
    const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
    fs.writeFileSync(path.join(bin, 'cp'),
      '#!/bin/bash\ncase "$*" in */prompts*) exit 1;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dojo, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'prompts', 'a.md'), 'x');
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).toContain('nothing was removed');
    expect(out).toContain('prompts');
  });

  it('refuses when the techniques folder cannot be copied', () => {
    const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
    fs.writeFileSync(path.join(bin, 'cp'),
      '#!/bin/bash\ncase "$*" in */techniques*) exit 1;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dojo, 'techniques'), { recursive: true });
    fs.writeFileSync(path.join(dojo, 'techniques', 'a.md'), 'x');
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).toContain('techniques');
  });

  it('refuses when the -wal file cannot be copied (fallback path)', () => {
    const bin = fs.mkdtempSync(path.join(scratch, 'bin-'));
    fs.writeFileSync(path.join(bin, 'sqlite3'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'cp'),
      '#!/bin/bash\ncase "$*" in *dojo.db-wal*) exit 1;; esac\nexec /bin/cp "$@"\n', { mode: 0o755 });
    const db = openWalDb(5);
    writeSecrets();
    const { status } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    db.close();
    expect(status).toBe(1);
  });

  // Review FIX 2: a refusal must leave Dojo and the watchdog RUNNING, and say so.
  it('on any refusal, loads both services again and says Dojo was started again', () => {
    const { bin } = failingShims();
    const log = path.join(scratch, 'launchctl.log');
    fs.writeFileSync(path.join(bin, 'launchctl'), launchctlStub(log, true), { mode: 0o755 });
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    const lines = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines.some((l) => l.includes('load') && l.includes('com.dojo.platform.plist'))).toBe(true);
    expect(lines.some((l) => l.includes('load') && l.includes('com.dojo.watchdog.plist'))).toBe(true);
    expect(out).toContain('Dojo has been started again; nothing was changed.');
  });

  // Review (combined) 4b: "started again" is checked against launchctl list, one rule everywhere.
  it('names a service launchd does not list after the reload instead of claiming Dojo is running', () => {
    const { bin } = failingShims();
    const log = path.join(scratch, 'launchctl.log');
    fs.writeFileSync(path.join(bin, 'launchctl'), launchctlStub(log, false), { mode: 0o755 });
    writeSecrets();
    const { status, out } = runBackupBlock({ PATH: `${bin}:/usr/bin:/bin` });
    expect(status).toBe(1);
    expect(out).not.toContain('Dojo has been started again');
    expect(out).toContain('did not start');
    expect(out).toContain('platform');
    expect(out).toContain('watchdog');
  });
});

/** Stateful stub: `load` lists the label when `loadTakes`; `list` prints the loaded labels. */
function launchctlStub(log: string, loadTakes: boolean): string {
  const st = path.join(scratch, 'ls');
  fs.mkdirSync(st, { recursive: true });
  return [
    '#!/bin/bash',
    `echo "$@" >> "${log}"`,
    'lab() { b="${1##*/}"; b="${b%.plist}"; echo "${b##*.}"; }',
    'case "$1" in',
    `  list) for l in "${st}"/*; do [ -e "$l" ] && printf "1\\t0\\tcom.dojo.%s\\n" "$(basename "$l")"; done ;;`,
    `  load) ${loadTakes ? `touch "${st}/$(lab "$2")"` : ':'} ;;`,
    `  unload) rm -f "${st}/$(lab "$2")" ;;`,
    'esac', 'exit 0', '',
  ].join('\n');
}
