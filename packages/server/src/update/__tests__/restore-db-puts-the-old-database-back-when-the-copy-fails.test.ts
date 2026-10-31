// RESTORE-DB.SH PUTS THE OLD DATABASE BACK WHEN THE COPY FAILS. Step 6 deletes dojo.db-wal and
// dojo.db-shm and then copies the chosen backup over dojo.db. A cp that dies part-way (disk full)
// left a cut-off file in place, printed "Your database is unchanged", and exited — while the copy
// step 5 saved aside went unused. The REAL script runs against a scratch HOME with stub `launchctl`
// and `cp`. Needs macOS: the script reads file facts with `stat -f`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(path.resolve(HERE, '../../../../..'), 'deploy/scripts/restore-db.sh');

let home: string;
let binDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'rd-cpfail-'));
  fs.mkdirSync(path.join(home, '.dojo', 'data', 'backups'), { recursive: true });
  binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A database with a migration row and a marker row, the way the platform's snapshots look. */
function makeDb(file: string, marker: string): void {
  const db = new Database(file);
  db.exec('create table _migrations(name text)');
  db.exec("insert into _migrations values ('001_x')");
  db.exec('create table which(v text)');
  db.exec(`insert into which values ('${marker}')`);
  db.close();
}

/** cp that writes a cut-off file and fails when a dojo-pre-* backup is copied onto .../data/dojo.db; otherwise the real cp. */
function installFailingCp(): void {
  fs.writeFileSync(path.join(binDir, 'cp'),
    '#!/bin/sh\n' +
    'for last; do :; done\n' +
    'src="$1"; case "$src" in -*) src="$2";; esac\n' +
    'case "$(basename "$src")" in dojo-pre-*) case "$last" in */data/dojo.db) printf partial > "$last"; exit 1;; esac;; esac\n' +
    'exec /bin/cp "$@"\n', { mode: 0o755 });
}

function runRestore(from: string): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [SCRIPT, '--from', from, '--yes'], {
    env: { PATH: `${binDir}:${process.env.PATH}`, HOME: home, DOJO_PORT: '1' },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function liveMarker(): string {
  const db = new Database(path.join(home, '.dojo', 'data', 'dojo.db'), { readonly: true });
  try {
    return (db.prepare('select v from which').get() as { v: string }).v;
  } finally {
    db.close();
  }
}

const BACKUP = (): string => path.join(home, '.dojo', 'data', 'backups', 'dojo-pre-a.db');

describe('restore-db.sh when the copy of the backup fails part-way', () => {
  it('puts the previous database back from the safety copy, and never says it is unchanged', () => {
    makeDb(BACKUP(), 'backup');
    makeDb(path.join(home, '.dojo', 'data', 'dojo.db'), 'current');
    installFailingCp();
    const { status, out } = runRestore(BACKUP());
    expect(status).toBe(1);
    expect(out).not.toContain('is unchanged');
    expect(out).toContain('put back from');
    expect(liveMarker()).toBe('current');
  });

  it('control: a working cp puts the backup in place and exits 0', () => {
    makeDb(BACKUP(), 'backup');
    makeDb(path.join(home, '.dojo', 'data', 'dojo.db'), 'current');
    const { status } = runRestore(BACKUP());
    expect(status).toBe(0);
    expect(liveMarker()).toBe('backup');
  });
});
