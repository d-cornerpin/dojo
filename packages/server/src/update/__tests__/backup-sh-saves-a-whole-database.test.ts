// BACKUP.SH SAVES A WHOLE DATABASE, OR SAYS IT DID NOT. The real `deploy/scripts/backup.sh` is run
// (spawned with /bin/bash against a scratch HOME) against fixture databases built with better-sqlite3.
// A box with no database used to get "✅ Backup complete" and an empty folder, and a running WAL
// database used to get three pieces copied at three different moments; a person relying on the folder
// learned it only when the restore failed.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/scripts/backup.sh');
const homes: string[] = [];

afterAll(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'backup-sh-'));
  homes.push(home);
  fs.mkdirSync(path.join(home, '.dojo'));
  return home;
}

function runBackup(home: string): { status: number | null; out: string } {
  const r = spawnSync('/bin/bash', [SCRIPT], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// A fixture database with three rows that only exist in the WAL until the handle closes.
function openWalDb(home: string): Database.Database {
  const data = path.join(home, '.dojo', 'data');
  fs.mkdirSync(data, { recursive: true });
  const db = new Database(path.join(data, 'dojo.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('create table t(a)');
  db.exec('insert into t values (1),(2),(3)');
  return db;
}

// The same fixture, closed before the run — the way a stopped box has its database.
function restingDb(home: string): void {
  let db: Database.Database | undefined;
  try {
    db = openWalDb(home);
  } finally {
    db?.close();
  }
}

// The backup folder is the single directory the script left under <home>/.dojo/backups.
function theBackupDir(home: string): string {
  const entries = fs.readdirSync(path.join(home, '.dojo', 'backups'));
  expect(entries).toHaveLength(1);
  return path.join(home, '.dojo', 'backups', entries[0]);
}

describe('backup.sh saves a whole database', () => {
  it('a box with no database is told nothing was backed up, and leaves no empty folder behind', () => {
    const home = scratchHome();
    const { status, out } = runBackup(home);
    expect(status).toBe(1);
    expect(out).toContain('nothing was backed up');
    expect(out).not.toContain('Backup complete');
    expect(fs.readdirSync(path.join(home, '.dojo', 'backups'))).toEqual([]);
  });

  it('a running WAL database is saved as one whole file, not as three torn pieces', () => {
    const home = scratchHome();
    const readBack = path.join(home, 'read-back.db');
    let status: number | null = null;
    let backupDir = '';
    const db = openWalDb(home);
    try {
      status = runBackup(home).status;
      backupDir = theBackupDir(home);
      expect(fs.existsSync(path.join(backupDir, 'dojo.db'))).toBe(true);
      expect(fs.existsSync(path.join(backupDir, 'dojo.db-wal'))).toBe(false);
      expect(fs.existsSync(path.join(backupDir, 'dojo.db-shm'))).toBe(false);
      fs.copyFileSync(path.join(backupDir, 'dojo.db'), readBack);
    } finally {
      db.close();
    }
    expect(status).toBe(0);
    const check = new Database(readBack, { readonly: true });
    try {
      expect((check.prepare('select count(*) as n from t').get() as { n: number }).n).toBe(3);
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      check.close();
    }
  });

  it('the secrets and prompts are still copied next to the database', () => {
    const home = scratchHome();
    fs.writeFileSync(path.join(home, '.dojo', 'secrets.yaml'), 'jwt_secret: x');
    fs.mkdirSync(path.join(home, '.dojo', 'prompts'));
    fs.writeFileSync(path.join(home, '.dojo', 'prompts', 'a.md'), 'hi');
    restingDb(home);
    const { status } = runBackup(home);
    expect(status).toBe(0);
    const backupDir = theBackupDir(home);
    expect(fs.readFileSync(path.join(backupDir, 'secrets.yaml'), 'utf-8')).toBe('jwt_secret: x');
    expect(fs.readFileSync(path.join(backupDir, 'prompts', 'a.md'), 'utf-8')).toBe('hi');
  });

  it('the keep-10 pruning is unchanged: the new folder and the nine newest olds survive', () => {
    const home = scratchHome();
    const backups = path.join(home, '.dojo', 'backups');
    restingDb(home);
    fs.mkdirSync(backups);
    const oldest = Math.floor(Date.now() / 1000) - 3 * 86_400;
    for (let i = 1; i <= 11; i++) {
      const dir = path.join(backups, `old-${String(i).padStart(2, '0')}`);
      fs.mkdirSync(dir);
      const t = oldest + i * 60;
      fs.utimesSync(dir, t, t);
    }
    const { status } = runBackup(home);
    expect(status).toBe(0);
    const entries = fs.readdirSync(backups);
    expect(entries).toHaveLength(10);
    expect(entries.filter((e) => /^\d{8}-\d{6}$/.test(e))).toHaveLength(1);
    expect(entries).not.toContain('old-01');
    expect(entries).not.toContain('old-02');
  });
});
