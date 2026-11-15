import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-backup');

// The pre-migration restore point, recorded and REQUIRED. Rollback after a migration is never automatic
// (old code on a new schema can brick a box), so this snapshot is the only way back to the old data.
// Every outcome is stored in `config` for a surface to show, and no snapshot means the chain does not run.
// Three deliberate exceptions: a database with nothing applied yet (fresh install) is never held up, a
// connection with no file on disk is out of scope, and an explicit override lets the chain through once.
// The snapshot goes beside the database it copies (`db.name`), never to a module-global path.

/** `config` key holding the last outcome, as JSON. Read by GET /api/update/db-backup. */
export const MIGRATION_BACKUP_CONFIG_KEY = 'migration_backup_last';

/** One-shot override file in the data directory. A file, not a setting, so it works when the server
 *  will not start; deleted when honoured so one "let me through" never becomes permanent. */
export const MIGRATION_BACKUP_OVERRIDE_FILE = 'allow-migration-without-backup';

/** The same permission for scripted and packaging boots, which have no data to lose. */
export const MIGRATION_BACKUP_OVERRIDE_ENV = 'DOJO_ALLOW_MIGRATION_WITHOUT_BACKUP';

/** Free space must hold this multiple of the live footprint (VACUUM INTO writes a full copy).
 *  Exported so update/disk-preflight.ts checks the same number this enforcer uses. */
export const MIGRATION_BACKUP_FREE_DISK_MULTIPLE = 2;
const FREE_DISK_MULTIPLE = MIGRATION_BACKUP_FREE_DISK_MULTIPLE;

export interface MigrationBackupOutcome {
  /** `written`: a restore point is at `path`; `skipped-low-disk`: the free-space guard refused to try;
   *  `failed`: the snapshot did not land; `not-applicable`: no file, or nothing applied yet. */
  status: 'written' | 'skipped-low-disk' | 'failed' | 'not-applicable';
  /** ISO timestamp of the decision. */
  at: string;
  /** True when the chain was allowed to run WITHOUT a restore point on someone's say-so. */
  overridden: boolean;
  pendingMigrations: number;
  path?: string;
  bytes?: number;
  durationMs?: number;
  freeBytes?: number;
  dbBytes?: number;
  neededBytes?: number;
  error?: string;
  reason?: string;
}

/** Thrown to stop the migration chain when no restore point could be made. */
export class MigrationBackupRequiredError extends Error {
  readonly outcome: MigrationBackupOutcome;
  constructor(message: string, outcome: MigrationBackupOutcome) {
    super(message);
    this.name = 'MigrationBackupRequiredError';
    this.outcome = outcome;
  }
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** Store the outcome where a surface can read it. Never allowed to break a boot. */
function recordOutcome(db: Database.Database, outcome: MigrationBackupOutcome): void {
  try {
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(MIGRATION_BACKUP_CONFIG_KEY, JSON.stringify(outcome));
  } catch (err) {
    logger.warn('Could not record the pre-migration backup outcome', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The last thing this box did about a pre-migration restore point, or null if never. */
export function readLastMigrationBackup(db: Database.Database): MigrationBackupOutcome | null {
  try {
    const row = db.prepare('SELECT value FROM config WHERE key = ?')
      .get(MIGRATION_BACKUP_CONFIG_KEY) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as MigrationBackupOutcome;
  } catch {
    return null;
  }
}

/** Take the snapshot; never throws, it reports. What a miss means is `ensurePreChainBackup`'s call. */
function takeSnapshot(
  db: Database.Database,
  dbPath: string,
  allFiles: string[],
  pending: string[],
): MigrationBackupOutcome {
  const at = new Date().toISOString();
  const base = { at, overridden: false, pendingMigrations: pending.length };
  const dataDir = path.dirname(dbPath);
  const backupsDir = path.join(dataDir, 'backups');

  // Live footprint includes WAL and SHM: a busy box holds recent writes in the WAL until checkpoint.
  const dbBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);

  try {
    const stat = fs.statfsSync(dataDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const neededBytes = dbBytes * FREE_DISK_MULTIPLE;
    if (freeBytes < neededBytes) {
      return { ...base, status: 'skipped-low-disk', freeBytes, dbBytes, neededBytes };
    }
  } catch (err) {
    // statfs unavailable: proceed; a truly full disk makes VACUUM INTO fail and report `failed`.
    logger.debug('Free-disk check unavailable for pre-migration backup; proceeding', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    fs.mkdirSync(backupsDir, { recursive: true });

    // Progress is a position along the chain (applied count of chain length), never the highest number:
    // files numbered below an applied 9xx bridge file are added after it.
    const lastApplied = allFiles.length - pending.length;
    const target = allFiles.length;
    // Timestamped because VACUUM INTO refuses to overwrite an existing file.
    const stamp = at.replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupsDir, `dojo-pre-${lastApplied}-of-${target}-${stamp}.db`);
    try { fs.rmSync(backupPath, { force: true }); } catch { /* nothing to remove */ }

    const started = Date.now();
    // VACUUM INTO is an online, consistent snapshot including committed WAL frames; fs.copyFile on a
    // live WAL database would miss the un-checkpointed WAL.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const outcome: MigrationBackupOutcome = {
      ...base,
      status: 'written',
      path: backupPath,
      bytes: fileSize(backupPath),
      durationMs: Date.now() - started,
      dbBytes,
    };

    // Keep the newest 2 plus the update-in-progress baseline: of the snapshots whose target this box has not
    // reached yet, the one from the lowest applied level. A crash loop re-snapshots the broken state on every
    // boot and would otherwise prune the one good copy. A file whose name does not parse (a hand-made one, or
    // one named by number in the older `-to-` form) is never pinned and goes by age.
    const KEEP_NEWEST = 2;
    try {
      const backups = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('dojo-pre-') && f.endsWith('.db'))
        .map(f => {
          const full = path.join(backupsDir, f);
          const named = /^dojo-pre-(\d+)-of-(\d+)-/.exec(f);
          return {
            full,
            from: named ? Number(named[1]) : null,
            to: named ? Number(named[2]) : null,
            mtimeMs: fs.statSync(full).mtimeMs,
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const baseline = backups
        .filter(b => b.to !== null && b.to > lastApplied && b.from !== null)
        .reduce<(typeof backups)[number] | null>(
          (lowest, b) => (
            !lowest || b.from! < lowest.from!
              || (b.from === lowest.from && b.mtimeMs < lowest.mtimeMs)
          ) ? b : lowest,
          null,
        );
      for (const stale of backups.slice(KEEP_NEWEST)) {
        if (baseline && stale.full === baseline.full) continue;
        try { fs.rmSync(stale.full, { force: true }); }
        catch (err) {
          logger.debug('Failed to prune old pre-migration backup', {
            file: stale.full, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch { /* a prune problem is never worth losing the backup we just made */ }

    return outcome;
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      dbBytes,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when the override is present, without consuming it: the update pre-flight must not eat the
 *  one-shot file meant for the chain that runs after the restart. */
export function migrationBackupOverridePresent(dataDir: string): boolean {
  if (process.env[MIGRATION_BACKUP_OVERRIDE_ENV] === '1') return true;
  return fs.existsSync(path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE));
}

/** True when someone has explicitly said this chain may run with no way back. Consumes. */
function takeOverride(dataDir: string): boolean {
  if (process.env[MIGRATION_BACKUP_OVERRIDE_ENV] === '1') return true;
  const overridePath = path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE);
  if (!fs.existsSync(overridePath)) return false;
  // One-shot: consume it so the next update is protected again.
  try { fs.rmSync(overridePath, { force: true }); }
  catch (err) {
    logger.warn('Could not consume the migration-backup override file; it will be honoured again next boot', {
      path: overridePath, error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

function refusalMessage(outcome: MigrationBackupOutcome, dataDir: string): string {
  const n = outcome.pendingMigrations;
  const what = outcome.status === 'skipped-low-disk'
    ? `There is not enough free disk space to write it safely. `
      + `Writing the snapshot needs ${gb(outcome.neededBytes ?? 0)} free; this disk has `
      + `${gb(outcome.freeBytes ?? 0)} free. Your database is ${gb(outcome.dbBytes ?? 0)}.`
    : `Writing the snapshot failed: ${outcome.error ?? 'unknown error'}`;

  return [
    `Refusing to run ${n} database migration${n === 1 ? '' : 's'}: a backup of your data could not be made first.`,
    '',
    what,
    '',
    'Why this stops the update: these migrations change your data. Putting the old',
    'version of the app back does NOT undo them — only this backup can. Running them',
    'with no backup would leave you with no way back, so Dojo has changed nothing.',
    '',
    'What to do:',
    outcome.status === 'skipped-low-disk'
      ? `  1. Free up disk space (about ${gb(Math.max(0, (outcome.neededBytes ?? 0) - (outcome.freeBytes ?? 0)))} more), then start Dojo again.`
      : `  1. Fix the problem above in ${path.join(dataDir, 'backups')}, then start Dojo again.`,
    '     Dojo will make the backup itself and carry on.',
    '',
    '  2. Or, if you accept that you will not be able to go back, run this once and',
    '     start Dojo again:',
    `       touch ${path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE)}`,
  ].join('\n');
}

/** Snapshot before a pending chain applies. Returns when the chain may proceed; throws
 *  `MigrationBackupRequiredError` when it may not, with the reason in the message. */
export function ensurePreChainBackup(
  db: Database.Database,
  allFiles: string[],
  pending: string[],
): void {
  const at = new Date().toISOString();
  const dbPath = db.name;

  // No file on disk (`:memory:` or no path): nothing to snapshot and nowhere of its own to put it.
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) {
    recordOutcome(db, {
      status: 'not-applicable', at, overridden: false, pendingMigrations: pending.length,
      reason: 'this database has no file on disk',
    });
    return;
  }

  const dataDir = path.dirname(dbPath);

  // Nothing applied yet is a fresh install: no state to restore to, and refusing would brick a new box.
  const hasHistory = allFiles.some(f => !pending.includes(f));
  if (!hasHistory) {
    recordOutcome(db, {
      status: 'not-applicable', at, overridden: false, pendingMigrations: pending.length,
      reason: 'first run — no applied migrations to restore to',
    });
    return;
  }

  const outcome = takeSnapshot(db, dbPath, allFiles, pending);

  if (outcome.status === 'written') {
    recordOutcome(db, outcome);
    logger.info('Pre-migration DB backup written', {
      path: outcome.path, bytes: outcome.bytes,
      durationMs: outcome.durationMs, pendingMigrations: outcome.pendingMigrations,
    });
    return;
  }

  if (takeOverride(dataDir)) {
    const overridden = { ...outcome, overridden: true };
    recordOutcome(db, overridden);
    logger.warn(
      'Running the migration chain with NO database backup because an override was set. '
      + 'If this update goes wrong, the data cannot be put back.',
      { status: overridden.status, error: overridden.error,
        freeBytes: overridden.freeBytes, neededBytes: overridden.neededBytes,
        pendingMigrations: overridden.pendingMigrations },
    );
    return;
  }

  recordOutcome(db, outcome);
  const message = refusalMessage(outcome, dataDir);
  // Plain text to stderr too: launchd writes it to ~/.dojo/logs/platform.stderr.log, the one readable
  // copy (the logger's file holds it JSON-escaped on one line).
  process.stderr.write(`\n${message}\n\n`);
  logger.error('Refusing the migration chain: no database backup could be made', {
    status: outcome.status, error: outcome.error,
    freeBytes: outcome.freeBytes, neededBytes: outcome.neededBytes,
    dbBytes: outcome.dbBytes, pendingMigrations: outcome.pendingMigrations,
  });
  throw new MigrationBackupRequiredError(message, outcome);
}
