// restore-db.sh step 5: the copy of the CURRENT database is accepted only when every copy step
// succeeded AND the copy is whole. A copy cut short by a full disk must never let the restore go
// on: the script deletes the partial copy, refuses, and changes nothing.
// The REAL script runs against a scratch HOME with stub `launchctl`, a `sqlite3` wrapper whose
// `VACUUM INTO` fails (as on a full disk) and a `cp` wrapper that can write half a file and fail.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/scripts/restore-db.sh');
const homes: string[] = [];
afterAll(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
const realSqlite = spawnSync('/bin/sh', ['-c', 'command -v sqlite3'], { encoding: 'utf-8' }).stdout.trim();

function fixtureDb(file: string, marker: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('create table _migrations(name text); insert into _migrations values (\'001_x\'); create table which(v text)');
  db.exec(`insert into which values ('${marker}')`);
  // Enough rows that half the file is visibly not the whole file.
  db.exec('create table pad(x text)');
  const ins = db.prepare('insert into pad values (?)');
  for (let i = 0; i < 400; i++) ins.run('x'.repeat(200));
  db.close();
}

function scratch(opts: { vacuumFails: boolean; cpMode: 'real' | 'half-then-fail' | 'fail-on-wal' }): string {
  const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'restore-whole-'));
  homes.push(home);
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sqlite3'),
    `#!/bin/sh\ncase "$*" in *"VACUUM INTO"*) ${opts.vacuumFails ? 'exit 1' : `exec "${realSqlite}" "$@"`};; esac\nexec "${realSqlite}" "$@"\n`, { mode: 0o755 });
  const cp = opts.cpMode === 'half-then-fail'
    ? 'for last; do :; done\ncase "$last" in */dojo-replaced-*) n=$(wc -c < "$2"); head -c $((n/2)) "$2" > "$last"; exit 1;; esac\nexec /bin/cp "$@"\n'
    : opts.cpMode === 'fail-on-wal'
      ? 'for last; do :; done\ncase "$last" in *-wal) exit 1;; esac\nexec /bin/cp "$@"\n'
      : 'exec /bin/cp "$@"\n';
  fs.writeFileSync(path.join(bin, 'cp'), `#!/bin/sh\n${cp}`, { mode: 0o755 });
  const data = path.join(home, '.dojo', 'data');
  fixtureDb(path.join(data, 'backups', 'dojo-pre-a.db'), 'pre');
  fixtureDb(path.join(data, 'dojo.db'), 'current');
  return home;
}

function run(home: string): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [SCRIPT, '--latest', '--yes'], {
    env: { PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, HOME: home, DOJO_PORT: '1' },
    encoding: 'utf-8', timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const marker = (home: string): string => {
  const db = new Database(path.join(home, '.dojo', 'data', 'dojo.db'), { readonly: true });
  try { return (db.prepare('select v from which').get() as { v: string }).v; } finally { db.close(); }
};
const copies = (home: string): string[] =>
  fs.readdirSync(path.join(home, '.dojo', 'data', 'backups')).filter((n) => n.startsWith('dojo-replaced-'));

describe('restore-db.sh keeps a WHOLE copy of the current database or refuses', () => {
  it('a plain copy cut short (disk full) is deleted and the restore refuses, changing nothing', () => {
    const home = scratch({ vacuumFails: true, cpMode: 'half-then-fail' });
    const r = run(home);
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSING');
    expect(r.out).not.toContain('DONE');
    expect(marker(home)).toBe('current');
    expect(copies(home)).toEqual([]);
  });

  it('a failed copy of the write-ahead file also refuses', () => {
    const home = scratch({ vacuumFails: true, cpMode: 'fail-on-wal' });
    fs.writeFileSync(path.join(home, '.dojo', 'data', 'dojo.db-wal'), 'tail');
    const r = run(home);
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSING');
    expect(marker(home)).toBe('current');
    expect(copies(home)).toEqual([]);
  });

  it('control: snapshot refused but the plain copy is whole, so the restore goes on and keeps that copy', () => {
    const home = scratch({ vacuumFails: true, cpMode: 'real' });
    const r = run(home);
    expect(r.status).toBe(0);
    expect(marker(home)).toBe('pre');
    const kept = copies(home);
    expect(kept.length).toBe(1);
    const db = new Database(path.join(home, '.dojo', 'data', 'backups', kept[0]), { readonly: true });
    expect((db.prepare('select v from which').get() as { v: string }).v).toBe('current');
    db.close();
  });

  it('control: a normal snapshot passes the check and the restore goes on', () => {
    const home = scratch({ vacuumFails: false, cpMode: 'real' });
    expect(run(home).status).toBe(0);
    expect(marker(home)).toBe('pre');
  });
});

// Two restores started at once used to share one safety name and one of them deleted the other's good
// copy. The restore now takes the same lock rollback.sh uses, so the second run refuses.
describe('restore-db.sh takes the shared lock', () => {
  it('two runs at once: one refuses, and the copy holding the current data survives', async () => {
    const home = scratch({ vacuumFails: false, cpMode: 'real' });
    // The snapshot step of every run is slow enough for the second run to start inside it.
    fs.writeFileSync(path.join(home, 'bin', 'sqlite3'),
      `#!/bin/sh\ncase "$*" in *"VACUUM INTO"*) sleep 1;; esac\nexec "${realSqlite}" "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, HOME: home, DOJO_PORT: '1' };
    const go = (): Promise<{ status: number | null; out: string }> => new Promise((resolve) => {
      const c = spawn('/bin/bash', [SCRIPT, '--latest', '--yes'], { env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
      c.on('close', (status) => resolve({ status, out }));
    });
    const a = go();
    await new Promise((r) => setTimeout(r, 300));
    const b = go();
    const [ra, rb] = await Promise.all([a, b]);
    const refused = [ra, rb].filter((r) => r.status === 1);
    expect(refused.length).toBe(1);
    expect(refused[0].out).toContain('another restore');
    expect(marker(home)).toBe('pre');
    const kept = copies(home);
    expect(kept.length).toBe(1);
    const db = new Database(path.join(home, '.dojo', 'data', 'backups', kept[0]), { readonly: true });
    expect((db.prepare('select v from which').get() as { v: string }).v).toBe('current');
    db.close();
    expect(fs.existsSync(path.join(home, '.dojo', 'rollback.lock'))).toBe(false);
  });

  it('a lock left by a dead process is cleared and the restore goes on', () => {
    const home = scratch({ vacuumFails: false, cpMode: 'real' });
    const lock = path.join(home, '.dojo', 'rollback.lock');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), '2147483646');
    expect(run(home).status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
