// rollback.sh, run for real in a scratch HOME with a stub launchctl: when the data is ahead of the build
// it restores, it also puts back the data copy the update episode recorded, and the newer data is kept
// under a dated name. Nothing outside the scratch tree is read or written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROLLBACK_SH, makeTree, versionAt } from './safe-install-fixtures.js';

let home: string;
let dojo: string;
const data = (): string => path.join(dojo, 'data');

/** A build carrying the given migration files where an installed build keeps them. */
function build(dir: string, version: string, files: string[]): string {
  makeTree(dir, version);
  const mig = path.join(dir, 'packages', 'server', 'dist', 'db', 'migrations');
  fs.mkdirSync(mig, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(mig, f), '-- step\n');
  return dir;
}

function database(file: string, applied: string[], which: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY); CREATE TABLE which (v TEXT)');
  for (const n of applied) db.prepare('INSERT INTO _migrations VALUES (?)').run(n);
  db.prepare('INSERT INTO which VALUES (?)').run(which);
  db.close();
  return file;
}

const which = (file: string): string => {
  const db = new Database(file, { readonly: true });
  try { return (db.prepare('SELECT v FROM which').get() as { v: string }).v; } finally { db.close(); }
};
const setAside = (): string[] => fs.readdirSync(path.join(data(), 'backups')).filter((f) => f.startsWith('dojo-replaced-'));

function run(): { code: number | null; out: string } {
  const r = spawnSync('/bin/bash', [ROLLBACK_SH], {
    env: { PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, DOJO_HOME: home, DOJO_PORT: '1' },
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'rollback-data-'));
  dojo = path.join(home, '.dojo');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  // launchd's list follows load and unload, so restore-db.sh sees the platform stopped.
  fs.writeFileSync(path.join(home, 'bin', 'launchctl'), [
    '#!/bin/sh',
    'case "$1" in',
    `  list) [ -f "${home}/up" ] && printf '1\\t0\\tcom.dojo.platform\\n-\\t0\\tcom.dojo.watchdog\\n'; exit 0 ;;`,
    `  unload) rm -f "${home}/up" ;;`,
    `  load) touch "${home}/up" ;;`,
    'esac',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'up'), '');
  build(path.join(dojo, 'platform'), '3.5.0', ['218_a.sql', '902_b.sql']);
});

afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function episode(dataBackup: string | null): void {
  const backupDir = build(path.join(dojo, 'platform.backup-3.4.1'), '3.4.1', ['218_a.sql']);
  fs.writeFileSync(path.join(dojo, 'update-state.json'), JSON.stringify({
    phase: 'rolled-back', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir, dataBackup,
    migrationsRanDuringEpisode: true, rollbackCount: 1, writeSeq: 4,
  }));
}

describe('rollback with newer data restores the pre-update copy', () => {
  it('puts back the old build and the recorded copy, and keeps the newer data under a dated name', () => {
    database(path.join(data(), 'dojo.db'), ['218_a.sql', '902_b.sql'], 'newer');
    episode(database(path.join(data(), 'backups', 'dojo-pre-1-of-2-2026-11-16T10-00-00.db'), ['218_a.sql'], 'before'));
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(versionAt(path.join(dojo, 'platform'))).toBe('3.4.1');
    expect(which(path.join(data(), 'dojo.db'))).toBe('before');
    expect(setAside()).toHaveLength(1);
    expect(setAside()[0]).toMatch(/^dojo-replaced-\d{4}-\d{2}-\d{2}T/);
    expect(which(path.join(data(), 'backups', setAside()[0]))).toBe('newer');
  });

  it('leaves the data alone when the restored build can read it', () => {
    database(path.join(data(), 'dojo.db'), ['218_a.sql'], 'current');
    episode(database(path.join(data(), 'backups', 'dojo-pre-1-of-2-2026-11-16T10-00-00.db'), ['218_a.sql'], 'before'));
    expect(run().code).toBe(0);
    expect(versionAt(path.join(dojo, 'platform'))).toBe('3.4.1');
    expect(which(path.join(data(), 'dojo.db'))).toBe('current');
    expect(setAside()).toEqual([]);
  });

  it('changes nothing and says why when the data is ahead and no copy was recorded', () => {
    database(path.join(data(), 'dojo.db'), ['218_a.sql', '902_b.sql'], 'newer');
    episode(null);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no copy of your data from before the update/i);
    expect(versionAt(path.join(dojo, 'platform'))).toBe('3.5.0');
    expect(which(path.join(data(), 'dojo.db'))).toBe('newer');
  });
});
