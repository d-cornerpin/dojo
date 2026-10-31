// `--latest` RESTORES THE NEWEST RESTORE POINT — NOT THE COPY OF THE DATABASE IT JUST REPLACED.
// The real `deploy/scripts/restore-db.sh` is run (spawned with /bin/bash against a scratch HOME,
// with a stub `launchctl` first on PATH) against fixture databases built with better-sqlite3.
// `collect()` sorts every `*.db` in ~/.dojo/data/backups newest-first, `--latest` takes the first
// of that list, and before replacing the database the script copies the CURRENT one into that same
// folder as `dojo-replaced-<stamp>.db`. So right after a restore the "newest restore point" is the
// copy of the data the restore had just removed, and a second `--latest` silently undid the first.
// The safety copies must stay in the no-argument listing — that is how a person undoes a restore
// on purpose with `--from` — but `--latest` must pass them by.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/scripts/restore-db.sh');
const homes: string[] = [];

afterAll(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

// Scratch HOME with a stub `launchctl` first on PATH, so the live-server probe never talks to launchd.
function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'restore-db-sh-'));
  homes.push(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

// Pins the clock the script stamps its safety copy with, so two runs land in the same second.
function freezeClock(home: string): void {
  fs.writeFileSync(path.join(home, 'bin', 'date'), '#!/bin/sh\necho 2030-01-01T00-00-00\n', { mode: 0o755 });
}

function runRestore(home: string, ...args: string[]): { status: number | null; out: string } {
  const bin = path.join(home, 'bin');
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, DOJO_PORT: '1' },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// A fixture database with the migration chain the script reads before using anything, and a marker
// table naming which fixture this is. Fake data only.
function fixtureDb(file: string, marker: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('create table _migrations(name text)');
  db.exec("insert into _migrations values ('001_x')");
  db.exec('create table which(v text)');
  db.exec(`insert into which values ('${marker}')`);
  db.close();
}

const backupsDir = (home: string): string => path.join(home, '.dojo', 'data', 'backups');
const dbPath = (home: string): string => path.join(home, '.dojo', 'data', 'dojo.db');

function markerOf(home: string): string {
  const db = new Database(dbPath(home), { readonly: true });
  try {
    return (db.prepare('select v from which').get() as { v: string }).v;
  } finally {
    db.close();
  }
}

// The state a second `--latest` meets right after the first: two pre-update restore points, the
// current database, and the `dojo-replaced-*` copy of the data that was just replaced — NEWEST.
function boxRightAfterARestore(): string {
  const home = scratchHome();
  const pre = path.join(backupsDir(home), 'dojo-pre-a.db');
  const replaced = path.join(backupsDir(home), 'dojo-replaced-b.db');
  fixtureDb(pre, 'pre');
  fixtureDb(replaced, 'replaced');
  fixtureDb(dbPath(home), 'current');
  const t = Math.floor(Date.now() / 1000) - 3600;
  fs.utimesSync(pre, t, t);
  fs.utimesSync(replaced, t + 60, t + 60);
  return home;
}

describe('restore-db.sh --latest', () => {
  it('passes by the dojo-replaced-* copy and restores the real restore point', () => {
    const home = boxRightAfterARestore();
    const { status, out } = runRestore(home, '--latest', '--yes');
    expect(status).toBe(0);
    expect(out).toMatch(/Restored from.*dojo-pre-a\.db/);
    expect(markerOf(home)).toBe('pre');
  });

  it('refuses when the only file left is a safety copy, and changes nothing', () => {
    const home = boxRightAfterARestore();
    fs.rmSync(path.join(backupsDir(home), 'dojo-pre-a.db'));
    const { status, out } = runRestore(home, '--latest', '--yes');
    expect(status).toBe(1);
    expect(out).toContain('no pre-update restore points');
    expect(markerOf(home)).toBe('current');
  });

  it('with no arguments still lists the safety copies — they are how you undo on purpose', () => {
    const home = boxRightAfterARestore();
    const { status, out } = runRestore(home);
    expect(status).toBe(0);
    expect(out).toContain('dojo-pre-a.db');
    expect(out).toContain('dojo-replaced-b.db');
  });

  it('two restores in the same second keep BOTH safety copies (current data is never overwritten)', () => {
    const home = boxRightAfterARestore();
    fs.rmSync(path.join(backupsDir(home), 'dojo-replaced-b.db'));
    freezeClock(home);
    expect(runRestore(home, '--latest', '--yes').status).toBe(0);
    expect(markerOf(home)).toBe('pre');
    expect(runRestore(home, '--latest', '--yes').status).toBe(0);
    const copies = fs.readdirSync(backupsDir(home)).filter((n) => n.startsWith('dojo-replaced-') && n.endsWith('.db'));
    expect(copies.length).toBe(2);
    const markers = copies.map((n) => {
      const db = new Database(path.join(backupsDir(home), n), { readonly: true });
      try { return (db.prepare('select v from which').get() as { v: string }).v; } finally { db.close(); }
    }).sort();
    expect(markers).toEqual(['current', 'pre']);
  });
});
